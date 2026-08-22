#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, tierKey } from "../lib/config.mjs";
import { loadGraph, validateGraph, indexNodes, levels } from "../lib/graph.mjs";
import { repoRoot, git, currentBranch, isClean, removeWorktree, syncWorkspaceFile, mergeNode } from "../lib/worktree.mjs";
import { listModels } from "../lib/provider.mjs";
import * as st from "../lib/state.mjs";
import * as log from "../lib/log.mjs";
import { run } from "../lib/runner.mjs";
import { writeReport } from "../lib/report.mjs";
import { verifyTests } from "../lib/verify.mjs";
import { normalizeNode } from "../lib/graph.mjs";
import * as ledger from "../lib/ledger.mjs";
import { explain as explainRouting } from "../lib/routing.mjs";
import {
  loadProductGraph,
  validateProductGraph,
  promotable,
  nextSlice,
  nodeFingerprint,
  PRODUCT_GRAPH_DEFAULT,
} from "../lib/product.mjs";
import { STAGES, DEFAULT_CHAIN, runSession, recordSession, sessionStats, isRetryable, sleep, currentRunId } from "../lib/driver.mjs";
import { actionable, unknownCodes, kindActionable, kindByTier, writeProposal, classify } from "../lib/evolve.mjs";
import { loadCodes, allCodes, groupSimilar, bucketOf, normaliseCode, CODES_DOC } from "../lib/codes.mjs";
import * as friction from "../lib/friction.mjs";
import {
  loadRegistry, resolveActive, materialise, blockedByAudit, missingPlugins,
  recordActivation, readActivations, neverActivated,
} from "../lib/skills.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const flagVal = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    die(`--${name} needs a value after it. You wrote "--${name}" with nothing following.`);
  }
  return v;
};
const flagInt = (name, { min = 1 } = {}) => {
  const raw = flagVal(name);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    die(`--${name} must be a whole number >= ${min}. Got "${raw}".`);
  }
  return n;
};

function ctx() {
  const root = repoRoot();
  if (!root) die("Not inside a git repository. Trellis needs git worktrees to isolate workers.");
  const cfg = loadConfig(root, flagVal("config"));
  return { root, cfg };
}

function die(msg) {
  log.fail(msg);
  process.exit(1);
}

// ---------------------------------------------------------------- validate

function cmdValidate({ requireTests = !flags.has("--plan") } = {}) {
  const { root, cfg } = ctx();
  const graph = loadGraph(root, flagVal("graph") || cfg.paths.graph);
  const { errors, warnings } = validateGraph(graph, cfg, root, { requireTests });

  for (const w of warnings) log.warn(w);
  if (errors.length) {
    for (const e of errors) log.fail(e);
    log.info("");
    die(`${errors.length} problem(s). Fix graph.json, then re-run.`);
  }

  const depth = levels(graph);
  const byLevel = new Map();
  for (const [id, d] of depth) {
    if (!byLevel.has(d)) byLevel.set(d, []);
    byLevel.get(d).push(id);
  }
  const byId = indexNodes(graph);

  log.ok(`Graph valid: ${graph.nodes.length} nodes, ${byLevel.size} level(s) deep, hash ${graph.__hash}`);
  log.info("");
  for (const d of [...byLevel.keys()].sort((a, b) => a - b)) {
    const ids = byLevel.get(d);
    log.info(log.bold(`  level ${d}`) + log.dim(`  (up to ${Math.min(ids.length, cfg.concurrency)} in parallel)`));
    for (const id of ids) {
      const n = byId.get(id);
      const risk = n.risk === "high" ? log.yellow(" [review]") : "";
      log.info(`    ${log.blue(id.padEnd(10))} ${n.title}${risk}`);
      log.info(log.dim(`    ${" ".repeat(10)} writes ${(n.write || []).join(", ")}`));
    }
  }
  log.info("");
  const untested = graph.nodes.filter((n) => !(n.tests || []).length).length;
  if (untested) log.warn(`${untested} node(s) have no frozen tests. Those gates prove less than you think.`);
  if (!requireTests) log.info(log.dim("--plan: missing test files reported as warnings. Drop the flag before running."));
  return 0;
}

// ------------------------------------------------------------------ doctor

// Doctor is the one command that must survive a broken environment — reporting
// what is wrong IS its job, so it cannot die on the first thing it finds. It used
// to call ctx(), which exits when there is no git repo; that meant the kit's own
// checkout could never verify its model slugs, and the tier probe (the check with
// nothing to do with git, and the one whose failure costs a whole run) was
// unreachable. Everything below degrades instead of exiting.
async function cmdDoctor() {
  const root = repoRoot();
  let cfg, cfgError = null;
  try {
    cfg = loadConfig(root ?? process.cwd(), flagVal("config"));
  } catch (e) {
    cfgError = e.message;
  }

  let problems = 0;
  const say = (ok, msg) => {
    ok ? log.ok(msg) : (problems++, log.fail(msg));
  };

  log.info(log.bold("Environment"));
  say(Number(process.versions.node.split(".")[0]) >= 20, `node ${process.versions.node} (need >= 20)`);
  say(git(process.cwd(), ["--version"]).ok, `git available`);
  if (root) {
    say(currentBranch(root) === cfg?.baseBranch, `on base branch "${cfg?.baseBranch}" (currently "${currentBranch(root)}")`);
    say(isClean(root), `working tree clean`);
    say(git(root, ["worktree", "list"]).ok, `git worktree supported`);
  } else {
    // Not fatal here. Worker isolation needs a repo; probing a model slug does not.
    problems++;
    log.fail(`not inside a git repository — \`trellis run\` needs one for worktrees`);
    log.info(log.dim(`      the checks below do not, so they still ran`));
  }

  if (cfgError) {
    problems++;
    log.fail(cfgError);
    log.info("");
    die(`${problems} problem(s) found.`);
  }

  // Env the PROJECT needs, as opposed to env Trellis needs. Discovering a missing
  // GITHUB_TOKEN at node 40 costs a run; discovering it here costs nothing.
  const required = cfg.requiredEnv ?? [];
  if (required.length) {
    log.info("");
    log.info(log.bold("Project environment"));
    for (const entry of required) {
      const { name, why } = typeof entry === "string" ? { name: entry, why: null } : entry;
      say(Boolean(process.env[name]), `${name} is set${why ? log.dim(` — ${why}`) : ""}`);
    }
  }

  log.info("");
  log.info(log.bold("Tiers"));
  for (const tier of cfg.tiers) {
    const key = tierKey(tier);
    if (tier.apiKeyEnv && !key) {
      problems++;
      log.fail(`${tier.name}: ${tier.apiKeyEnv} is not set`);
      continue;
    }
    process.stdout.write(log.dim(`  probing ${tier.name} (${tier.model})...\n`));
    try {
      const ids = await listModels(cfg, tier);
      if (!ids.length) {
        log.warn(`${tier.name}: provider returned no model list; cannot verify "${tier.model}"`);
      } else if (ids.includes(tier.model)) {
        log.ok(`${tier.name}: ${tier.model} available`);
      } else {
        problems++;
        const stem = tier.model.split("/").pop().split(/[-.]/)[0];
        const near = ids.filter((i) => i.toLowerCase().includes(stem.toLowerCase())).slice(0, 6);
        log.fail(`${tier.name}: "${tier.model}" is not offered by this provider.`);
        if (near.length) log.info(log.dim(`      closest: ${near.join(", ")}`));
      }
    } catch (e) {
      problems++;
      log.fail(`${tier.name}: ${e.message}`);
    }
  }

  log.info("");
  const graphPath = root ? path.join(root, cfg.paths.graph) : null;
  if (!graphPath) {
    log.warn(`Skipping graph validation — it is resolved against the repo root.`);
  } else if (fs.existsSync(graphPath)) {
    log.info(log.bold("Graph"));
    try { cmdValidate(); } catch (e) { problems++; log.fail(e.message); }
  } else {
    log.warn(`No graph yet at ${cfg.paths.graph}. Run /trellis-plan in Claude Code.`);
  }

  log.info("");
  if (problems) die(`${problems} problem(s) found.`);
  log.ok("Ready.");
  return 0;
}

// ------------------------------------------------------------- verify-tests

async function cmdVerifyTests() {
  const { root, cfg } = ctx();
  const graph = loadGraph(root, flagVal("graph") || cfg.paths.graph);
  const { errors } = validateGraph(graph, cfg, root);
  if (errors.length) {
    for (const e of errors) log.fail(e);
    die("Graph is invalid; fix it before verifying tests.");
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, normalizeNode(n, cfg)]));

  log.info(log.bold(`Verifying frozen tests for ${nodes.size} node(s)`));
  log.info(log.dim("syntax, then: does the gate FAIL against a stub whose exports all return null?"));
  log.info("");

  const { ok, findings } = await verifyTests(cfg, graph, nodes, root, {
    log: (id, msg) => log.node(id, log.green(msg)),
  });

  const hard = findings.filter((f) => f.kind !== "no-tests" && f.kind !== "unstubbable");
  const soft = findings.filter((f) => f.kind === "no-tests" || f.kind === "unstubbable");

  log.info("");
  for (const f of soft) log.warn(`${f.nodeId}: ${f.message}`);
  for (const f of hard) log.fail(`${f.nodeId} [${f.kind}]: ${f.message}`);

  log.info("");
  if (hard.length) {
    die(`${hard.length} node(s) have tests that cannot be trusted as an acceptance oracle.`);
  }
  log.ok("Every gate rejects a null stub. Tests are non-vacuous.");
  log.info(log.dim("Mutation checks run automatically after each node passes during `run`."));
  return 0;
}

// ------------------------------------------------------------------ ledger

function cmdLedger() {
  const { root, cfg } = ctx();
  const records = ledger.read(root, cfg);
  if (!records.length) return log.warn("Ledger is empty. It fills after your first run.");

  if (flags.has("--routing")) {
    log.info(log.bold("Tier performance by tag") + log.dim("  (what routing decides from)"));
    log.info("");
    log.info(`  ${"tag".padEnd(18)}${"tier".padEnd(10)}${"seen".padEnd(6)}${"landed".padEnd(8)}rate`);
    for (const r of explainRouting(cfg, records)) {
      const flag = r.rate < (cfg.routing.minSuccessRate ?? 0.15) && r.seen >= (cfg.routing.minObservations ?? 5)
        ? log.yellow("  <- would be skipped") : "";
      log.info(`  ${r.tag.padEnd(18)}${r.tier.padEnd(10)}${String(r.seen).padEnd(6)}${String(r.landed).padEnd(8)}${(r.rate * 100).toFixed(0)}%${flag}`);
    }
    return;
  }

  const byTag = ledger.summarise(records);
  const runs = new Set(records.map((r) => r.runId)).size;
  log.info(log.bold(`${records.length} node record(s) across ${runs} run(s)`));
  log.info("");
  for (const [tag, s] of [...byTag].sort((a, b) => b[1].nodes - a[1].nodes)) {
    const pct = ((s.landed / s.nodes) * 100).toFixed(0);
    log.info(`  ${log.bold(tag.padEnd(18))} ${s.landed}/${s.nodes} landed (${pct}%)  ${log.dim(`${s.attempts} attempts, ${s.tokens.toLocaleString()} tok`)}`);
    const tiers = Object.entries(s.tiers).map(([t, n]) => `${t}:${n}`).join(" ");
    if (tiers) log.info(log.dim(`  ${" ".repeat(18)} landed on  ${tiers}`));
    const kinds = Object.entries(s.kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}:${n}`).join(" ");
    if (kinds) log.info(log.dim(`  ${" ".repeat(18)} failures    ${kinds}`));
  }
  log.info("");
  log.info(log.dim("`--routing` shows the per-tier table routing decides from."));
}

// --------------------------------------------------------------------- run

/**
 * Load prior state and apply resume semantics, or start fresh.
 *
 * Shared by `run` and `auto` on purpose. These two drifted once — `auto` called
 * the runner with an options object where the config belongs — and the only
 * durable fix is that there is one way to reach the runner, not two.
 */
function resumeOrInit(root, cfg, graph, { resume = false, retryFailed = false } = {}) {
  const state = st.loadState(root, cfg);
  if (state && st.resumable(state, graph) && resume) {
    for (const [id, s] of Object.entries(state.nodes)) {
      if (s.status === st.STATUS.RUNNING || s.status === st.STATUS.BLOCKED) {
        s.status = st.STATUS.PENDING;
        s.reason = null;
      }
      if (s.status === st.STATUS.EXHAUSTED && retryFailed) {
        s.status = st.STATUS.PENDING;
        s.attempts = [];
        s.reason = null;
        removeWorktree(root, cfg, id, { quiet: true });
      }
    }
    log.info(log.dim(`Resuming run ${state.runId}`));
    return state;
  }
  if (state && !st.resumable(state, graph)) {
    log.warn("graph.json changed since the last run — starting a fresh run.");
  }
  return st.initState(root, cfg, graph);
}

async function cmdRun() {
  const { root, cfg } = ctx();
  const graph = loadGraph(root, flagVal("graph") || cfg.paths.graph);
  const { errors } = validateGraph(graph, cfg, root);
  if (errors.length) {
    for (const e of errors) log.fail(e);
    die("Graph is invalid. Nothing was run.");
  }

  const conc = flagInt("concurrency");
  if (conc !== null) cfg.concurrency = conc;

  let only = null;
  if (flagVal("only") !== null) {
    only = flagVal("only").split(",").map((s) => s.trim()).filter(Boolean);
    if (!only.length) die(`--only needs at least one node id, comma separated.`);
    const known = new Set(graph.nodes.map((n) => n.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length) die(`--only names node(s) not in the graph: ${unknown.join(", ")}`);
  }

  const stateDir = path.join(root, cfg.paths.state);
  const logPath = log.openRunLog(stateDir);

  let state = resumeOrInit(root, cfg, graph, {
    resume: flags.has("--resume"),
    retryFailed: flags.has("--retry-failed"),
  });

  log.info(log.bold(`Trellis — ${state.project}`));
  log.info(log.dim(`${graph.nodes.length} nodes · concurrency ${cfg.concurrency} · tiers ${cfg.tiers.map((t) => t.name).join(" → ")}`));
  log.info("");

  const history = ledger.read(root, cfg);
  if (cfg.routing?.enabled && history.length) {
    log.info(log.dim(`routing informed by ${history.length} prior node record(s)`));
  }

  const started = Date.now();
  const { reportPath } = await run(cfg, graph, state, { only, history });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const { counts, total, done, stuck } = st.rollup(state);
  log.info("");
  log.info(log.bold(`Done in ${secs}s — ${done}/${total} landed`));
  log.info(log.dim(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join("  ")));
  log.info(log.dim(`report: ${path.relative(root, reportPath)}`));
  log.info(log.dim(`log:    ${path.relative(root, logPath)}`));
  log.closeRunLog();

  process.exitCode = stuck ? 1 : 0;
}

// ------------------------------------------------------- accept / reject

/**
 * Close the review loop. A held node is reviewed by a human outside the tool,
 * so state has no way to learn the outcome — without this, `--resume` sees the
 * node as still `review`, its dependants never become ready, and the run quietly
 * does nothing.
 */
function cmdAccept() {
  const { root, cfg } = ctx();
  const state = st.loadState(root, cfg);
  if (!state) die("No run to accept against.");
  const ids = argv.slice(1).filter((a) => !a.startsWith("--"));
  if (!ids.length) die("Name at least one node: trellis accept <nodeId> [...] [--merge]");

  for (const id of ids) {
    const s = state.nodes[id];
    if (!s) die(`No node "${id}" in the current run.`);
    if (![st.STATUS.REVIEW, st.STATUS.WEAK_TESTS, st.STATUS.AUDIT].includes(s.status)) {
      die(`Node "${id}" is ${s.status}, not awaiting review. Nothing to accept.`);
    }
    const branch = s.branch || `trellis/${id}`;

    const isMerged = git(root, ["merge-base", "--is-ancestor", branch, cfg.baseBranch]).ok;
    if (!isMerged) {
      if (!flags.has("--merge")) {
        die(`Branch ${branch} is not yet merged into ${cfg.baseBranch}.
` +
            `      Merge it yourself, or re-run with --merge to let Trellis do it:
` +
            `        node kit/bin/cli.mjs accept ${id} --merge`);
      }
      const r = mergeNode(root, cfg, id);
      if (!r.ok) die(`Could not merge ${branch}: ${r.message}`);
      log.ok(`merged ${branch} into ${cfg.baseBranch}`);
    }

    s.status = st.STATUS.MERGED;
    s.reason = "accepted after review";
    s.acceptedAt = new Date().toISOString();
    removeWorktree(root, cfg, id, { quiet: true });
    log.ok(`${id} accepted — dependants can now run`);
  }

  st.saveState(root, cfg, state);
  syncWorkspaceFile(root, cfg, []);
  const graph = loadGraph(root, cfg.paths.graph);
  writeReport(root, cfg, graph, state);
  log.info("");
  log.info(log.dim("Next: node kit/bin/cli.mjs run --resume"));
}

/** Send a reviewed node back to be rebuilt, optionally after you changed its contract. */
function cmdReject() {
  const { root, cfg } = ctx();
  const state = st.loadState(root, cfg);
  if (!state) die("No run to reject against.");
  const ids = argv.slice(1).filter((a) => !a.startsWith("--"));
  if (!ids.length) die("Name at least one node: trellis reject <nodeId> [...]");

  for (const id of ids) {
    const s = state.nodes[id];
    if (!s) die(`No node "${id}" in the current run.`);
    const branch = s.branch || `trellis/${id}`;
    const isMerged = git(root, ["merge-base", "--is-ancestor", branch, cfg.baseBranch]).ok;
    if (isMerged) {
      die(`Branch ${branch} is already merged into ${cfg.baseBranch}. ` +
          `Revert that merge first — Trellis will not rewrite your history.`);
    }
    s.status = st.STATUS.PENDING;
    s.attempts = [];
    s.tier = null;
    s.reason = null;
    s.survivingMutations = [];
    removeWorktree(root, cfg, id, { quiet: true });
    git(root, ["branch", "-D", branch]);
    log.ok(`${id} reset to pending — it will be rebuilt on the next run`);
  }
  st.saveState(root, cfg, state);
  log.info("");
  log.info(log.dim("If you changed its contract, run validate first, then run --resume."));
}

// ------------------------------------------------------------------ status

function cmdStatus() {
  const { root, cfg } = ctx();
  const state = st.loadState(root, cfg);
  if (!state) return log.warn("No run yet.");
  const graph = loadGraph(root, cfg.paths.graph);
  const byId = indexNodes(graph);
  const color = {
    merged: log.green, review: log.yellow, exhausted: log.red,
    conflict: log.red, blocked: log.dim, running: log.blue, pending: log.dim,
  };
  log.info(log.bold(`${state.project} — run ${state.runId.slice(0, 8)}`));
  for (const [id, s] of Object.entries(state.nodes)) {
    const c = color[s.status] || ((x) => x);
    log.info(`  ${c(s.status.padEnd(10))} ${id.padEnd(10)} ${byId.get(id)?.title || ""}`);
  }
  const { done, total, stuck } = st.rollup(state);
  log.info("");
  log.info(`${done}/${total} landed${stuck ? `, ${stuck} need attention` : ""}`);
}

// ------------------------------------------------------------------- clean

function cmdClean() {
  const { root, cfg } = ctx();
  const list = git(root, ["worktree", "list", "--porcelain"]).out;
  const dirs = [...list.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]);
  let n = 0;
  for (const d of dirs) {
    if (!path.resolve(d).includes(path.resolve(root, cfg.paths.worktrees))) continue;
    const id = path.basename(d);
    removeWorktree(root, cfg, id, { quiet: true });
    n++;
  }
  git(root, ["worktree", "prune"]);
  if (flags.has("--branches")) {
    const branches = git(root, ["branch", "--list", "trellis/*", "--format=%(refname:short)"]).out.split("\n").filter(Boolean);
    for (const b of branches) git(root, ["branch", "-D", b]);
    log.info(`Deleted ${branches.length} trellis/* branch(es).`);
  }
  syncWorkspaceFile(root, cfg, []);
  log.ok(`Removed ${n} worktree(s).`);
}

// ------------------------------------------------------------------ ingest

function cmdIngest() {
  const { root } = ctx();
  const rel = flagVal("product") || PRODUCT_GRAPH_DEFAULT;
  const graph = loadProductGraph(root, rel);
  const { errors, warnings, graph: derived } = validateProductGraph(graph);

  for (const w of warnings) log.warn(w);

  const out = {
    at: new Date().toISOString(),
    source: rel,
    errors,
    warnings,
    counts: errors.length
      ? null
      : {
          total: derived.nodes.length,
          v1: derived.nodes.filter((n) => n.version === "v1").length,
          v2: derived.nodes.filter((n) => n.version === "v2").length,
          high_risk: derived.nodes.filter((n) => n.risk_level === "high").length,
          audit: derived.nodes.filter((n) => n.risk_level === "audit").length,
        },
    fingerprints: errors.length
      ? {}
      : Object.fromEntries(derived.nodes.map((n) => [n.id, nodeFingerprint(n)])),
  };

  fs.mkdirSync(path.resolve(root, ".trellis"), { recursive: true });
  fs.writeFileSync(path.resolve(root, ".trellis/ingest.json"), JSON.stringify(out, null, 2));

  if (errors.length) {
    for (const e of errors) log.fail(e);
    die(`${errors.length} error(s). The product graph is authored outside Trellis; fix it there and re-run.`);
  }

  fs.writeFileSync(
    path.resolve(root, ".trellis/product-graph.derived.json"),
    JSON.stringify(derived, null, 2)
  );

  log.ok(
    `${out.counts.total} nodes — ${out.counts.v1} in v1, ${out.counts.v2} in v2, ` +
      `${out.counts.high_risk} high risk, ${out.counts.audit} audit.`
  );
  for (const n of derived.nodes.filter((x) => x.risk_level !== "low")) {
    log.info(`  ${n.risk_level.padEnd(6)} ${n.id.padEnd(24)} ${n.risk_reasons.join("; ")}`);
  }
}

// ----------------------------------------------------------------- promote

function cmdPromote() {
  const { root } = ctx();
  const graph = loadProductGraph(root, flagVal("product") || PRODUCT_GRAPH_DEFAULT);
  const { errors, graph: derived } = validateProductGraph(graph);
  if (errors.length) die("Run `trellis ingest` first — the graph does not validate.");

  const list = promotable(derived);
  if (!list.length) {
    log.info("No v2 node is unblocked. Every one of them depends on other v2 work.");
    return;
  }
  log.ok(`${list.length} v2 node(s) could ship in v1 — nothing blocks them:`);
  for (const n of list) {
    log.info(`  ${n.id.padEnd(28)} ${n.title}`);
  }
  log.info("");
  log.info("This is a suggestion. Promoting means editing the source product graph by hand.");
}

// ------------------------------------------------------------------- slice

function cmdSlice() {
  const { root } = ctx();
  const graph = loadProductGraph(root, flagVal("product") || PRODUCT_GRAPH_DEFAULT);
  const { errors, graph: derived } = validateProductGraph(graph);
  if (errors.length) die("Run `trellis ingest` first — the graph does not validate.");

  const statePath = path.resolve(root, ".trellis/built.json");
  const built = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")).nodes ?? [] : [];
  const max = flagInt("max") ?? 25;
  const version = flagVal("version") || "v1";

  const slice = nextSlice(derived, { version, built, maxNodes: max });
  if (!slice.nodes.length) {
    log.ok(`Nothing left to build in ${version}.`);
    return;
  }

  const plan = {
    at: new Date().toISOString(),
    version,
    built_before: built,
    nodes: slice.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      deps: n.deps ?? [],
      acceptance: n.acceptance,
      high_risk: n.high_risk,
      risk_level: n.risk_level,
      risk_reasons: n.risk_reasons,
      lenses: n.lenses ?? [],
      scale_tier: n.scale_tier,
      notes: n.notes ?? "",
      fingerprint: nodeFingerprint(n),
    })),
    remaining: slice.remaining,
    invariants: derived.invariants ?? [],
    non_goals: derived.non_goals ?? [],
  };

  fs.mkdirSync(path.resolve(root, ".trellis"), { recursive: true });
  fs.writeFileSync(path.resolve(root, ".trellis/plan.json"), JSON.stringify(plan, null, 2));

  log.ok(`Slice of ${plan.nodes.length} node(s); ${slice.remaining.length} left in ${version}.`);
  if (slice.high_risk.length) {
    log.warn(`High risk in this slice (Opus reviews these regardless of gates): ${slice.high_risk.join(", ")}`);
  }
}

// -------------------------------------------------------------------- auto

async function cmdAuto() {
  const { root, cfg } = ctx();
  if (!cfg.driver?.enabled) {
    die("driver.enabled is false in trellis.config.json. Read the driver section before turning this on.");
  }

  // Periodic stages are reachable only by name. Without this, adding one would
  // silently make every ordinary run spend an extra expensive session.
  const only = flagVal("stage");
  const stages = only ? STAGES.filter((s) => s.id === only) : DEFAULT_CHAIN;
  if (!stages.length) die(`Unknown stage ${only}. One of: ${STAGES.map((s) => s.id).join(", ")}`);

  const stats = sessionStats(root);
  if (Object.keys(stats).length) {
    log.info("Observed cost per stage (from your own runs, not an estimate):");
    for (const [stage, s] of Object.entries(stats)) {
      log.info(`  ${stage.padEnd(12)} median $${s.median.toFixed(2)}  p90 $${s.p90.toFixed(2)}  (${s.runs} runs)`);
    }
  }

  for (const stage of stages) {
    const pre = stage.verify(root, cfg);
    if (pre.ok && !flags.has("--force")) {
      log.ok(`${stage.id} already satisfied (${pre.detail}) — skipping.`);
      continue;
    }

    // Gate the arsenal for this stage before the session starts. Mechanical, and
    // costs zero model tokens — the session simply finds fewer, more relevant
    // skills in .claude/skills/ than if the whole catalogue were always present.
    const skills = applySkills(root, cfg, stage.id, { dryRun: stage.run === "runner" });
    if (stage.run !== "runner") {
      log.info(log.dim(`  skills: ${skills.active.map((a) => a.name).join(", ") || "none"}`));
      if (skills.blocked.length) {
        log.warn(`  ${skills.blocked.length} unaudited entr${skills.blocked.length === 1 ? "y" : "ies"} withheld: ${skills.blocked.map((b) => b.name).join(", ")}`);
      }
    }

    let attempt = 0;
    let done = false;

    while (attempt < cfg.driver.maxAttempts && !done) {
      attempt++;
      log.info(`${stage.id} — attempt ${attempt}/${cfg.driver.maxAttempts}`);

      let result;
      if (stage.run === "runner") {
        // The build stage is the existing deterministic runner. No model here.
        // Same entry point as `trellis run` — see resumeOrInit for why.
        const graph = loadGraph(root, cfg.paths.graph);
        const { errors } = validateGraph(graph, cfg, root);
        if (errors.length) {
          for (const e of errors) log.fail(e);
          die("Graph is invalid. Nothing was run.");
        }
        const state = resumeOrInit(root, cfg, graph, { resume: true });
        // run() writes REPORT.md itself; a second writeReport here would be
        // both redundant and wrong.
        await run(cfg, graph, state, { history: ledger.read(root, cfg) });
        result = { exitCode: 0, costUsd: 0 };
      } else {
        result = await runSession(root, stage, cfg);
        if (result.spawnFailed) {
          die(`Could not spawn "${cfg.driver.command}". Is Claude Code on PATH?`);
        }
      }

      const check = stage.verify(root, cfg);
      recordSession(root, {
        stage: stage.id,
        attempt,
        exitCode: result.exitCode,
        costUsd: result.costUsd,
        sessionId: result.sessionId ?? null,
        verified: check.ok,
        detail: check.detail,
      });

      if (check.ok) {
        log.ok(`${stage.id} verified — ${check.detail}`);
        done = true;
        break;
      }

      // The session claimed nothing; the disk decided. Distinguish "ran out of
      // room" from "produced wrong output" only to pick a backoff, not to decide
      // success — both are incomplete and both re-run the same idempotent stage.
      const throttled = isRetryable(result.stderr ?? "") || isRetryable(result.raw ?? "");
      log.warn(`${stage.id} incomplete — ${check.detail}`);

      if (attempt >= cfg.driver.maxAttempts) break;

      const wait = throttled
        ? cfg.driver.throttleBackoffMs * attempt
        : cfg.driver.retryBackoffMs;
      log.info(`  ${throttled ? "throttled" : "retrying"}; waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }

    if (!done) {
      die(
        `${stage.id} did not complete after ${cfg.driver.maxAttempts} attempts.\n` +
          `Nothing was corrupted — the stage is idempotent, so re-run \`trellis auto --stage ${stage.id}\` ` +
          `when you have room, or run that session by hand.`
      );
    }
  }

  log.ok("All stages verified.");
}

// ------------------------------------------------------------------ evolve

function cmdEvolve() {
  const { root, cfg } = ctx();
  const minRuns = flagInt("min-runs") ?? cfg.evolve?.minRuns ?? 3;

  if (flags.has("--unknown")) return reportUnknown(root, cfg, minRuns);
  if (flags.has("--retire")) return reportRetire(root, cfg, minRuns);
  if (flags.has("--json")) return emitShortlist(root, cfg, minRuns);

  const scope = flags.has("--all-nodes") ? "all" : "costly";
  const found = actionable(root, cfg, { minRuns });
  const kinds = kindActionable(root, cfg, { minRuns, scope });

  if (!found.length && !kinds.length) {
    log.info(
      `Nothing has appeared in ${minRuns}+ distinct runs yet — not a rejection code, ` +
        `not a failure kind. Self-improvement stays inert until there is evidence.`
    );
    return;
  }

  if (found.length) {
    log.ok(`${found.length} rejection pattern(s) with enough evidence to act on:`);
    for (const f of found) {
      log.info(`  ${f.code.padEnd(30)} ${f.runs} runs, ${f.count} rejections, ${f.nodes.length} distinct nodes`);
    }
    log.info("");
  }

  if (kinds.length) {
    log.ok(`${kinds.length} failure-kind pattern(s) on nodes that cost something:`);
    for (const k of kinds) {
      const lift = k.baseline > 0 ? ` (${(k.share / k.baseline).toFixed(1)}x baseline)` : "";
      log.info(`  ${`${k.kind}|${k.tag}`.padEnd(38)} ${k.runs} runs, ${k.attempts} attempts${lift}`);
    }

    // A kind that clusters on ONE tier is a fact about the prompt or the extract
    // format, not about the product. Different signal, different fix.
    const perTier = [...kindByTier(root, cfg, { scope }).values()].filter((t) => t.runs >= minRuns);
    if (perTier.length) {
      log.info("");
      log.info("  by tier — a kind that only one tier emits is about the prompt, not the product:");
      for (const t of perTier) log.info(`    ${`${t.kind}|${t.tier}`.padEnd(36)} ${t.runs} runs, ${t.attempts} attempts`);
    }
    log.info("");
    if (scope === "costly") {
      log.info(`  Scoped to exhausted / strong-tier / mutation-surviving nodes. --all-nodes widens it,`);
      log.info(`  which mostly shows the ladder working: retries that later landed.`);
      log.info("");
    }
  }

  reportFriction(root, cfg, minRuns);

  log.info("Opus writes the proposal from these in the triage session. It may not touch:");
  log.info("  MISSION.md, gate/verify/mutate/worktree, kit/schema/, kit/regression/, .claude/hooks/");
}

/**
 * Self-reported friction, plus the contradictions that keep it honest.
 *
 * Bucketed codes are excluded from the actionable list here for the same reason
 * they are excluded from rejections: a code nobody agreed on cannot trigger work.
 */
function reportFriction(root, cfg, minRuns) {
  const counts = friction.counts(root, cfg);
  const ripe = Object.values(counts)
    .filter((f) => !f.code.startsWith("other:") && f.runs >= minRuns)
    .sort((a, b) => b.runs - a.runs);

  if (ripe.length) {
    log.ok(`${ripe.length} friction pattern(s) reported across ${minRuns}+ runs:`);
    for (const f of ripe) {
      const where = f.targets.length ? `  on ${f.targets.slice(0, 3).join(", ")}` : "";
      log.info(`  ${f.code.padEnd(30)} ${f.runs} runs, ${f.count} occurrences${where}`);
    }
    log.info("");
  }

  // The teeth behind `--none`. Counted across runs, never held against a session:
  // a triage session can legitimately have a smooth time on a bad run.
  const contradicted = friction.contradictions(root, cfg, {
    ledgerRecords: ledger.read(root, cfg),
    triageRows: readTriageRows(root, cfg),
  });
  const byStage = {};
  for (const c of contradicted) (byStage[c.stage] ??= new Set()).add(c.run);
  const stale = Object.entries(byStage).filter(([, runs]) => runs.size >= minRuns);

  if (stale.length) {
    log.warn(`friction.unreported-suspected in ${stale.length} stage(s):`);
    for (const [stage, runs] of stale) {
      log.info(`  ${stage.padEnd(30)} asserted 'none' on ${runs.size} runs that had exhausted nodes or rejections`);
    }
    log.info("  Not an accusation about any one session. A pattern this size means the");
    log.info("  friction prompt is not landing, which is a contract problem.");
    log.info("");
  }
}

function readTriageRows(root, cfg) {
  const p = path.join(root, cfg.paths?.state ?? ".trellis", "triage.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * The whole input to stage 07, and the reason its token budget is bounded by
 * construction rather than by an instruction telling a model to be brief.
 *
 * A handful of rows of scalars. No prose, no logs, no transcripts. `--top` caps
 * it; the default of 5 is a deliberate ceiling on how much can be considered in
 * one pass, not a display convenience.
 */
function emitShortlist(root, cfg, minRuns) {
  const top = flagInt("top") ?? 5;
  const scope = flags.has("--all-nodes") ? "all" : "costly";

  const rows = [
    ...actionable(root, cfg, { minRuns }).map((f) => ({
      source: "rejection",
      code: f.code,
      runs: f.runs,
      occurrences: f.count,
      nodes: f.nodes.length,
    })),
    ...kindActionable(root, cfg, { minRuns, scope }).map((k) => ({
      source: "attempt-kind",
      code: `${k.kind}|${k.tag}`,
      runs: k.runs,
      occurrences: k.attempts,
      nodes: k.nodes,
    })),
    ...Object.values(friction.counts(root, cfg))
      .filter((f) => !f.code.startsWith("other:") && f.runs >= minRuns)
      .map((f) => ({
        source: "friction",
        code: f.code,
        runs: f.runs,
        occurrences: f.count,
        targets: f.targets.slice(0, 3),
      })),
  ]
    .sort((a, b) => b.runs - a.runs || b.occurrences - a.occurrences)
    .slice(0, top);

  // Suspects come from the vocabulary, so the stage has somewhere to start
  // without reading anything else.
  const codes = loadCodes(root);
  for (const r of rows) {
    const entry = codes.rejection?.[r.code] ?? codes.friction?.[r.code];
    if (entry?.suspects?.length) r.suspects = entry.suspects;
  }

  process.stdout.write(JSON.stringify({ minRuns, scope, top, patterns: rows }, null, 2) + "\n");
}

/**
 * Vocabulary pressure.
 *
 * Nothing here can trigger a proposal no matter how often it recurs — that is the
 * point. It is a list for a human to read and decide whether to name.
 */
function reportUnknown(root, cfg, minRuns) {
  const unknown = unknownCodes(root, cfg);
  if (!unknown.length) {
    log.info("No unrecognised rejection codes. Everything recorded so far is in the vocabulary.");
    return;
  }

  log.info(`${unknown.length} unrecognised code(s), bucketed and never actionable:`);
  for (const u of unknown) {
    const ready = u.runs >= minRuns ? "  <- clears the threshold" : "";
    log.info(`  ${u.code.padEnd(34)} ${u.runs} runs, ${u.count} rejections${ready}`);
  }

  // Display-only grouping. Deliberately not folded into the counts above: if
  // near-matches counted as one code, a threshold could be reached by varying
  // spelling, which is the manipulation the run-count discipline exists to stop.
  const groups = groupSimilar(unknown.map((u) => u.code)).filter((g) => g.members.length > 1);
  if (groups.length) {
    log.info("");
    log.info("Possibly the same idea spelled differently (shown, never summed):");
    for (const g of groups) log.info(`  ${g.members.join("  ~  ")}`);
  }

  const ripe = unknown.filter((u) => u.runs >= minRuns);
  if (ripe.length) {
    log.info("");
    log.warn(`${ripe.length} bucket(s) clear ${minRuns} runs. To make one actionable, a human adds it to:`);
    log.info(`  ${CODES_DOC}   (prose section + an entry in the codes:begin block)`);
  }
}

/**
 * The other half of self-improvement: what should stop existing.
 *
 * A loop that can only add is not a loop. Every skill taxes selection accuracy in
 * every session it is eligible for, and that cost appears in no per-node metric —
 * so nothing else in the system will ever notice it.
 *
 * Zero activations is the one deletion signal that needs no judgement: the rules
 * never matched, so the skill provably never entered a context window.
 */
function reportRetire(root, cfg, minRuns) {
  const registry = loadRegistry(root);
  const activations = readActivations(root, cfg);
  const { ready, runs, skills, unreachable } = neverActivated(registry, activations, { minRuns });

  // Reachability is a registry bug, not a usage fact, so it is reported whether
  // or not there is enough run data to say anything about usage.
  if (unreachable.length) {
    log.warn(`${unreachable.length} entr(y/ies) can never activate at all — no automatic rule, no manual opt-in:`);
    for (const u of unreachable) log.info(`  ${u.name.padEnd(28)} ${u.kind}`);
    log.info("  That is a registry bug rather than dead weight: give it a rule or drop it.");
    log.info("");
  }

  if (!ready) {
    log.info(
      `Only ${runs} run(s) of activation data. Retirement needs ${minRuns}+ distinct runs — ` +
        `a skill that happened not to match once is not a fact about the skill.`
    );
    return;
  }

  if (!skills.length) {
    log.ok(`Every automatically-activating entry fired at least once across ${runs} runs.`);
    return;
  }

  log.warn(`${skills.length} entr(y/ies) never activated across ${runs} runs:`);
  for (const s of skills) log.info(`  ${s.name.padEnd(28)} ${s.kind}, ${s.rules.join("+")}`);
  log.info("");
  log.info("These have provably never entered a context window. Either the activation rules are");
  log.info("wrong, or the entry is dead weight. Both are worth a proposal against SKILLS/REGISTRY.json.");
  log.info(log.dim("Manual-only entries are excluded: they activate when named, so silence is by design."));
}

/**
 * Record work the session did by hand.
 *
 * A command rather than a file the session appends to, for one reason: `ts` and
 * `run` are stamped here. Those are the two fields cross-run counting depends on
 * and the two a hand-written line gets wrong.
 */
function cmdFriction() {
  const { root, cfg } = ctx();
  const stage = flagVal("stage");
  if (!stage) die("Usage: trellis friction --stage <id> (--none | --kind <k> --code <c> [--target p] [--count n] [--note s])");

  const run = currentRunId(root);
  if (!run) die("No runId in .trellis/state.json. Friction is recorded against a run, or not at all.");

  const rec = flags.has("--none")
    ? { stage, kind: "none" }
    : {
        stage,
        kind: flagVal("kind"),
        code: normaliseCode(flagVal("code"), loadCodes(root), "friction"),
        target: flagVal("target") ?? undefined,
        count: flagInt("count") ?? undefined,
        note: flagVal("note") ?? undefined,
      };

  let row;
  try {
    row = friction.append(root, cfg, rec, { run });
  } catch (e) {
    die(e.message);
  }

  if (row.kind === "none") {
    log.ok(`${stage}: asserted no friction for run ${run}.`);
    return;
  }
  log.ok(`${stage}: recorded ${row.kind}/${row.code}${row.target ? ` on ${row.target}` : ""}.`);
  if (row.code?.startsWith("other:")) {
    log.info(log.dim(`  bucketed — visible under 'evolve --unknown', never actionable until named in ${CODES_DOC}`));
  }
}

/**
 * Write a proposal through code rather than by formatting markdown.
 *
 * That is what makes the protected-path refusal, the tier derivation, the
 * numbering, and the retirement-condition requirement actually binding. A model
 * hand-writing a file under evolution/proposals/ bypasses all four.
 *
 * Long fields are read from files rather than argv, because a shell argument is
 * the wrong place for three paragraphs.
 */
function cmdPropose() {
  const { root } = ctx();
  const title = flagVal("title");
  const targets = (flagVal("targets") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!title || !targets.length) {
    die('Usage: trellis propose --title "..." --targets a,b --kind mechanism|tooling|retirement ' +
        "--evidence <file> [--change <file>] [--alternatives <file>] [--cost <file>] [--reversal <file>]");
  }

  const fromFile = (name) => {
    const v = flagVal(name);
    if (!v) return undefined;
    const p = path.resolve(root, v);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    return v; // short values inline are fine
  };

  let result;
  try {
    result = writeProposal(root, {
      title,
      targets,
      kind: flagVal("kind") ?? "mechanism",
      evidence: fromFile("evidence") ?? "_(no evidence attached — this proposal is incomplete)_",
      rationale: fromFile("rationale"),
      change: fromFile("change"),
      mechanism: fromFile("mechanism"),
      alternatives: fromFile("alternatives"),
      cost: fromFile("cost"),
      reversal: fromFile("reversal"),
      fromEvolveStage: flags.has("--from-evolve-stage"),
    });
  } catch (e) {
    die(e.message);
  }

  log.ok(`wrote ${result.file}`);
  log.info(`  kind: ${result.kind}   tier: ${result.tier}`);
  log.info(`  ${result.tier === "advisory" && !result.held
    ? "auto-applies once regression is green"
    : "waits for a human merge"}`);
}

function cmdCodes() {
  const { root } = ctx();
  const codes = loadCodes(root);
  if (codes.missing) die(`${CODES_DOC} not found. That file is the vocabulary.`);

  const one = flagVal("explain");
  if (one) {
    const family = Object.hasOwn(codes.rejection, one)
      ? "rejection"
      : Object.hasOwn(codes.friction, one)
        ? "friction"
        : null;
    if (!family) {
      log.fail(`"${one}" is not in the vocabulary.`);
      log.info(`Use it anyway if nothing fits — it records as other:${bucketOf(`other:${one}`)} and shows up under 'evolve --unknown'.`);
      process.exit(1);
    }
    log.ok(`${one}  (${family})`);
    const prose = explainFromDoc(root, one);
    if (prose) log.info(prose);
    const suspects = codes[family][one]?.suspects ?? [];
    if (suspects.length) {
      log.info("");
      log.info(`Probably indicts: ${suspects.join(", ")}`);
    }
    return;
  }

  for (const family of ["rejection", "friction"]) {
    const names = Object.keys(codes[family] ?? {});
    if (!names.length) continue;
    log.info(`${family} codes (${names.length}):`);
    for (const n of names) log.info(`  ${n}`);
    log.info("");
  }

  // A code defined in the block with no prose beside it is unexplained, and an
  // unexplained code gets guessed at. Report both directions.
  const defined = new Set(allCodes(codes));
  const undocumented = [...defined].filter((c) => !codes.documented.has(c));
  const orphaned = [...codes.documented].filter((c) => !defined.has(c));
  if (undocumented.length) log.warn(`defined but not explained in prose: ${undocumented.join(", ")}`);
  if (orphaned.length) log.warn(`explained in prose but not defined: ${orphaned.join(", ")}`);

  log.info(`If nothing fits, use your own words. It buckets as other:<slug> and a human decides later.`);
}

/** The prose paragraph under `### <code>` in the doc, for --explain. */
function explainFromDoc(root, code) {
  const p = path.join(root, CODES_DOC);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8");
  const m = new RegExp(`^###\\s+${code}\\s*$([\\s\\S]*?)(?=^###\\s|^---\\s*$)`, "m").exec(text);
  return m ? m[1].trim() : null;
}

function cmdClassifyPath() {
  const p = flagVal("path") || argv[1];
  if (!p) die("Usage: trellis classify <repo-relative-path>");
  const c = classify(p);
  log.info(`${p} -> ${c}`);
  if (c === "protected") log.warn("No proposal may touch this.");
  if (c === "unclassified") log.warn("Treated as load-bearing (fail closed).");
}

// ---------------------------------------------------------------- sessions

function cmdSessions() {
  const { root } = ctx();
  const stats = sessionStats(root);
  if (!Object.keys(stats).length) {
    log.info("No sessions recorded yet. `trellis auto` writes .trellis/sessions.jsonl as it goes.");
    return;
  }
  log.ok("Cost per stage, measured:");
  for (const [stage, s] of Object.entries(stats)) {
    log.info(`  ${stage.padEnd(12)} median $${s.median.toFixed(2)}  p90 $${s.p90.toFixed(2)}  (${s.runs} runs)`);
  }
  log.info("");
  log.info("There is no API for remaining subscription quota. Use this against `/usage` by hand.");
}

// ------------------------------------------------------------------ skills

/**
 * The product-graph nodes in the current slice, for `applies_to` resolution.
 *
 * Empty is a correct answer, not an error: before `02_slice` there is no slice,
 * so only `always` and `stage` rules can fire. Skill gating must never be the
 * reason a stage cannot start.
 */
function sliceNodes(root) {
  const plan = readJsonOrNull(path.resolve(root, ".trellis/plan.json"));
  const derived =
    readJsonOrNull(path.resolve(root, ".trellis/product-graph.derived.json")) ??
    readJsonOrNull(path.resolve(root, ".trellis/product-graph.json"));
  if (!plan || !derived) return [];
  const want = new Set((plan.nodes ?? []).map((n) => (typeof n === "string" ? n : n.id)));
  return (derived.nodes ?? []).filter((n) => want.has(n.id));
}

function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** Compute and apply the active skill set for a stage. Zero model tokens. */
function applySkills(root, cfg, stage, { dryRun = false } = {}) {
  const registry = loadRegistry(root);
  const opts = { stage, sliceNodes: sliceNodes(root), manual: cfg.skills?.manual ?? [] };
  const active = resolveActive(registry, opts);
  const changes = materialise(root, active, { dryRun });
  // Only a real stage transition is evidence. A dry run is somebody asking what
  // would happen, and recording it would make an unused skill look exercised.
  if (!dryRun) {
    recordActivation(root, cfg, { run: currentRunId(root), stage, active });
  }
  return { active, changes, blocked: blockedByAudit(registry, opts), registry };
}

async function cmdSkills() {
  const { root, cfg } = ctx();
  const stage = flagVal("stage");
  const explain = flags.has("--explain");
  const apply = flags.has("--apply");

  const { active, changes, blocked } = applySkills(root, cfg, stage, { dryRun: !apply });

  log.info(log.bold(`Active skills${stage ? ` for ${stage}` : " (no stage given)"}`));
  if (!active.length) log.info(log.dim("  none"));
  for (const a of active) {
    log.info(`  ${a.name}${explain ? log.dim(`  ← ${a.reason}`) : ""}`);
  }

  if (blocked.length) {
    log.info("");
    log.warn(`${blocked.length} entr${blocked.length === 1 ? "y" : "ies"} would activate but ${blocked.length === 1 ? "is" : "are"} not audited:`);
    for (const b of blocked) log.info(log.dim(`  ${b.name} (${b.status})`));
    log.info(log.dim("  Audit them before use. A skill is an instruction file read by the orchestrator."));
  }

  // Plugins are user-scoped and cannot travel inside the kit. Saying so is the
  // difference between a smaller arsenal you know about and one you do not.
  const absent = missingPlugins(loadRegistry(root));
  if (absent.length) {
    log.info("");
    log.warn(`${absent.length} registry plugin(s) not installed on this machine:`);
    for (const m of absent) log.info(log.dim(`  ${m.name.padEnd(24)} ${m.install}`));
  }

  log.info("");
  if (apply) {
    log.ok(`.claude/skills synced — ${changes.added.length} added, ${changes.removed.length} removed, ${changes.kept.length} kept`);
  } else {
    log.info(log.dim(`Would add ${changes.added.length}, remove ${changes.removed.length}. Re-run with --apply to sync .claude/skills.`));
  }
}

// -------------------------------------------------------------- regression

async function cmdRegression() {
  const { spawnSync } = await import("node:child_process");
  // fileURLToPath, not URL.pathname — the latter yields "/C:/Users/..." on
  // Windows, which path.resolve turns into a bogus drive-relative path.
  const suite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../regression/run.mjs");
  const r = spawnSync(process.execPath, [suite], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// -------------------------------------------------------------------- main

const HELP = `
trellis — Claude Code orchestrates, open-source models do the work.

  trellis validate [--plan]   Cycles, write collisions, spec coverage, tag hygiene
                                --plan: tests not yet written, so downgrade that to a warning
  trellis verify-tests        Prove each gate rejects a null stub (no model calls)
  trellis doctor              Check env, git state, and that every model slug resolves
  trellis ledger [--routing]  Cross-run performance by tag; what routing decides from
  trellis run                 Execute the graph headless (this is the whole loop)
    --resume                    Continue a previous run
    --retry-failed              With --resume, also retry exhausted nodes
    --only n01,n02              Run just these nodes
    --concurrency 4             Override parallelism
  trellis accept <id> [--merge]  Mark a reviewed node accepted so dependants unblock
  trellis reject <id>         Reset a reviewed node to pending for a rebuild
  trellis status              Per-node status of the last run
  trellis clean [--branches]  Remove worktrees (and optionally trellis/* branches)

Product graph — authored outside Trellis, handed in complete:
  trellis ingest              Validate the product graph, derive high-risk nodes
  trellis promote             Which v2 nodes are unblocked and could ship in v1
  trellis slice [--max 25]    Cut the next buildable slice into .trellis/plan.json
    --version v1|v2             Which release to slice from (default v1)

Autonomy and evolution:
  trellis auto [--stage id]   Drive the session pipeline headless, verifying on disk
                                07_evolve is periodic: reachable only by --stage
    --force                     Re-run a stage even if its artifact already exists
  trellis sessions            Measured cost per stage from your own runs
  trellis evolve              Rejection codes and failure kinds with enough evidence
    --unknown                   Unrecognised codes: vocabulary pressure, never actionable
    --min-runs <n>              Override the threshold (default: config evolve.minRuns)
    --all-nodes                 Include nodes that failed then landed (mostly noise)
    --retire                    Skills that never once activated: the deletion signal
  trellis codes               The vocabulary triage records in
    --explain <code>            What it means and which artifact it probably indicts
  trellis friction --stage <id>   Record work you did by hand (or --none)
    --kind <k> --code <c>       manual-edit | repeated-read | missing-tool | ...
    --target <path> --count <n> --note "<=140 chars"
    --none                      Explicitly assert there was none. Never fails a stage.
  trellis propose             Write a proposal through code (enforces the refusals)
    --kind tooling              Requires alternatives, cost, and a retirement condition
  trellis classify <path>     Is this path protected, load-bearing, or advisory
  trellis regression          Fixtures that must still pass after any kit change
  trellis skills              Which skills load in a session, and why
    --stage <id>                Resolve for that stage (else only always/manual rules fire)
    --explain                   Show what activated each one
    --apply                     Sync .claude/skills to match (the driver does this per stage)

Flags: --config <path>  --graph <path>  --product <path>
`.trim();

const table = {
  validate: cmdValidate,
  "verify-tests": cmdVerifyTests,
  ledger: cmdLedger,
  doctor: cmdDoctor,
  run: cmdRun,
  accept: cmdAccept,
  reject: cmdReject,
  status: cmdStatus,
  clean: cmdClean,
  ingest: cmdIngest,
  promote: cmdPromote,
  slice: cmdSlice,
  auto: cmdAuto,
  sessions: cmdSessions,
  evolve: cmdEvolve,
  codes: cmdCodes,
  friction: cmdFriction,
  propose: cmdPropose,
  classify: cmdClassifyPath,
  regression: cmdRegression,
  skills: cmdSkills,
};

try {
  const fn = table[cmd];
  if (!fn) {
    log.info(HELP);
    process.exit(cmd ? 1 : 0);
  }
  await fn();
} catch (e) {
  die(e.message);
}
