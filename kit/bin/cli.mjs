#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, tierKey } from "../lib/config.mjs";
import { loadGraph, validateGraph, indexNodes, levels } from "../lib/graph.mjs";
import { repoRoot, git, currentBranch, isClean, removeWorktree, syncWorkspaceFile, mergeNode, changedPaths } from "../lib/worktree.mjs";
import { norm } from "../lib/paths.mjs";
import { listModels } from "../lib/provider.mjs";
import * as st from "../lib/state.mjs";
import * as log from "../lib/log.mjs";
import { run } from "../lib/runner.mjs";
import { writeReport } from "../lib/report.mjs";
import { verifyTests, SOFT_FINDINGS } from "../lib/verify.mjs";
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
import { STAGES, DEFAULT_CHAIN, EVOLVE_TOP, runSession, recordSession, sessionStats, isRetryable, sleep, currentRunId } from "../lib/driver.mjs";
import { actionable, unknownCodes, kindActionable, kindByTier, writeProposal, classify, shortlist, triageRows } from "../lib/evolve.mjs";
import { loadCodes, allCodes, groupSimilar, bucketOf, normaliseCode, CODES_DOC } from "../lib/codes.mjs";
import * as friction from "../lib/friction.mjs";
import * as triage from "../lib/triage.mjs";
import { currentCycle, beginCycle, cycleIdFor } from "../lib/cycle.mjs";
import { builtNodes, writeBuilt } from "../lib/built.mjs";
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

  const hard = findings.filter((f) => !SOFT_FINDINGS.has(f.kind));
  const soft = findings.filter((f) => SOFT_FINDINGS.has(f.kind));

  log.info("");
  for (const f of soft) log.warn(`${f.nodeId} [${f.kind}]: ${f.message}`);
  for (const f of hard) log.fail(`${f.nodeId} [${f.kind}]: ${f.message}`);

  log.info("");
  if (hard.length) {
    die(`${hard.length} node(s) have tests that cannot be trusted as an acceptance oracle.`);
  }

  // Do not claim more than was established. A run where every node was skipped
  // for language reasons used to print the same success line as one where every
  // gate was actually proven to reject a stub — and `process.exitCode` staying
  // 0 meant `driver.mjs`'s stage-04 verify, which shells out to this exact
  // command and checks only its exit code, scraped this warning line into its
  // own success `detail`. Reserved for nodes.size > 0: an empty graph has
  // nothing to prove and is not the failure this guards against.
  const unchecked = new Set(soft.map((f) => f.nodeId));
  const proven = nodes.size - unchecked.size;
  if (proven === 0 && nodes.size > 0) {
    log.warn(`No node's non-vacuity was established (${unchecked.size} unchecked). Nothing here is proven.`);
    process.exitCode = 1;
  } else if (unchecked.size) {
    log.ok(`${proven} of ${nodes.size} node(s) reject a null stub; ${unchecked.size} could not be checked.`);
  } else {
    log.ok("Every gate rejects a null stub. Tests are non-vacuous.");
  }
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
 * RUNNING and BLOCKED are interrupted-mid-run statuses, never a rest state a
 * node should be resumed INTO. A node stuck RUNNING means the process died
 * while it was live; one stuck BLOCKED reflects a dependency graph that has
 * since moved on. Left alone, that node is invisible to everything: readySet
 * only looks at PENDING, markBlocked only reconsiders PENDING, and neither
 * its dependants nor a human staring at `trellis status` can tell it apart
 * from one still legitimately in flight.
 *
 * Both callers of resumeOrInit's two branches must normalise the same way —
 * the salvage branch used to copy state.nodes[id] verbatim, including
 * status, so a RUNNING node whose contract had not changed stayed RUNNING
 * forever after a graph edit, and the run reported "finished" with a whole
 * subtree silently unbuilt.
 */
function normaliseResumedStatus(root, cfg, id, s, { retryFailed = false } = {}) {
  // BUDGET joins RUNNING/BLOCKED, not the retryFailed branch below: a
  // budget-stopped node was never actually attempted, only skipped because a
  // ceiling was hit — runner.mjs's own comment already claims "--resume
  // picks it up", which nothing here was doing until now.
  if (s.status === st.STATUS.RUNNING || s.status === st.STATUS.BLOCKED || s.status === st.STATUS.BUDGET) {
    s.status = st.STATUS.PENDING;
    s.reason = null;
  }
  if (s.status === st.STATUS.EXHAUSTED && retryFailed) {
    s.status = st.STATUS.PENDING;
    s.attempts = [];
    s.reason = null;
    removeWorktree(root, cfg, id, { quiet: true });
  }
  return s;
}

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
      normaliseResumedStatus(root, cfg, id, s, { retryFailed });
    }
    log.info(log.dim(`Resuming run ${state.runId}`));
    return state;
  }
  // The graph changed. Salvage everything the change did not invalidate rather
  // than throwing the run away: a single edited contract used to send every
  // merged node back to pending, rebuilding them all at real cost, behind one
  // warning line.
  if (state && resume && !st.resumable(state, graph)) {
    const { dirty, keep, gone } = st.resumePlan(state, graph, { root });
    if (keep.length) {
      // Not always state.runId: if a NEW cycle began since state.json was
      // last written (beginCycle minted a fresh id), this salvage is for the
      // new cycle, and its runId must roll with it. If no new cycle began,
      // cycleIdFor() returns the SAME id state.runId already holds — this is
      // still just a same-cycle contract fix, and behaves exactly as before.
      const runId = cycleIdFor(root, cfg);
      const fresh = st.initState(root, cfg, graph, { runId });
      fresh.startedAt = runId === state.runId ? state.startedAt : fresh.startedAt;
      for (const id of keep) {
        if (state.nodes[id]) {
          fresh.nodes[id] = normaliseResumedStatus(
            root, cfg, id, { ...state.nodes[id], hash: fresh.nodes[id].hash }, { retryFailed }
          );
        }
      }
      log.warn(`graph.json changed. Keeping ${keep.length} node(s); rebuilding ${dirty.length}.`);
      if (dirty.length) log.info(log.dim(`  rebuilding: ${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? "…" : ""}`));
      if (gone.length) log.info(log.dim(`  no longer in the graph: ${gone.join(", ")}`));
      log.info(log.dim("  A node is rebuilt when its own contract changed, or when one it depends on did."));
      // Its worktree and branch are stale for anything being rebuilt.
      for (const id of dirty) removeWorktree(root, cfg, id, { quiet: true });
      return fresh;
    }
    log.warn("graph.json changed and no node survived the change — starting a fresh run.");
  } else if (state && !st.resumable(state, graph)) {
    log.warn("graph.json changed since the last run — starting a fresh run.");
    log.info(log.dim("  Pass --resume to keep the nodes the change did not invalidate."));
  }
  return st.initState(root, cfg, graph, { runId: cycleIdFor(root, cfg) });
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
/**
 * `accept`'s restriction (review|weak-tests|audit only) is invariant 1: a node
 * that never passed a gate must not be acceptable. But refusing with just
 * "not awaiting review" is a dead end — it names the wall without naming the
 * door. Each other status has a real next command.
 */
function acceptVerbFor(status, id) {
  if (status === st.STATUS.EXHAUSTED) {
    return `Nothing to accept — it never passed a gate. Use \`trellis reject ${id}\` to rebuild it, ` +
      `or \`trellis run --resume --retry-failed\` to retry in place.`;
  }
  if (status === st.STATUS.CONFLICT) {
    return `Its merge conflicted and nothing landed. Resolve the conflict manually, or ` +
      `\`trellis reject ${id}\` to rebuild it from a clean tree.`;
  }
  if (status === st.STATUS.BUDGET) {
    return `The run's budget stopped before this node was attempted. ` +
      `\`trellis run --resume\` picks it up once the ceiling is raised or the run allows it.`;
  }
  if (st.LANDED.has(status)) {
    return `It is already merged into the base branch. Nothing to accept — there is no review pending.`;
  }
  return `\`trellis status\` shows what is pending.`;
}

function cmdAccept() {
  const { root, cfg } = ctx();

  // Real enforcement is guard-bash.mjs, which runs outside this process and
  // cannot be argued with. This is defence in depth for the paths that reach
  // here without it: hooks not configured, or TRELLIS_STAGE forwarded past a
  // shell that stripped it before the guard saw the string. Bypassable with
  // `env -u TRELLIS_STAGE`, which is exactly why it is not the only layer.
  if (process.env.TRELLIS_STAGE) {
    die(
      `accept is a human decision (MISSION.md: one-way doors get human eyes), and this is running ` +
        `inside stage "${process.env.TRELLIS_STAGE}". Use \`trellis apply-triage\` for reversible ` +
        `verdicts; anything needing accept belongs in .trellis/checkpoint.json for a human to run.`
    );
  }
  if (!process.stdout.isTTY) {
    log.warn(
      "accept is running non-interactively (stdout is not a TTY). If this is a headless session, stop " +
        "— accepting a node is a human decision. If it's a script you wrote yourself, ignore this."
    );
  }

  const state = st.loadState(root, cfg);
  if (!state) die("No run to accept against.");
  const ids = argv.slice(1).filter((a) => !a.startsWith("--"));
  if (!ids.length) die("Name at least one node: trellis accept <nodeId> [...] [--merge]");

  for (const id of ids) {
    const s = state.nodes[id];
    if (!s) die(`No node "${id}" in the current run.`);
    if (![st.STATUS.REVIEW, st.STATUS.WEAK_TESTS, st.STATUS.AUDIT].includes(s.status)) {
      die(`"${id}" is ${s.status}, not awaiting review. ` + acceptVerbFor(s.status, id));
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
    // The status, not git ancestry, decides whether this branch was actually
    // merged. commitWorktree only runs on a passing gate (worker.mjs), so an
    // EXHAUSTED node's branch never diverged from the base tip — it is
    // trivially an "ancestor" of main with zero commits on it, and the old
    // `git merge-base --is-ancestor` check refused to reject it with
    // "already merged, revert that merge first" for a node that had nothing
    // to revert. st.LANDED is exactly "merged/audit/weak-tests", the
    // statuses where the node's code is genuinely on the base branch.
    if (st.LANDED.has(s.status)) {
      die(`"${id}" is ${s.status} — its code is on ${cfg.baseBranch}. ` +
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
  log.info(log.dim("A resume keeps every node the change did not invalidate, and rebuilds only"));
  log.info(log.dim("the ones whose contract moved plus anything downstream of them."));
}

// -------------------------------------------------------------- apply-triage

const REJECT_VERDICTS = new Set(["reject", "re-decompose", "rewrite-contract"]);
const RECORD_ONLY_VERDICTS = new Set(["cut", "defer"]);

/**
 * Mechanises the reversible half of triage.json's decisions, instead of the
 * orchestrator running accept/reject one CLI call at a time for every node.
 *
 * This never merges anything a human has not already looked at — MISSION.md's
 * one-way-door non-goal is not a suggestion here, it is the whole reason the
 * table below has a "never applied" row instead of an "apply anyway" one.
 *
 *   verdict is reject-like, node not LANDED  -> reset to pending (cmdReject's logic)
 *   verdict is reject-like, node LANDED      -> refuse; list for a human, nothing reverted
 *   verdict is accept,      node LANDED      -> bookkeeping only: mark merged, land nothing new
 *   verdict is accept,      node held/review -> NEVER applied; appended to checkpoint.json
 *   anything else (cut, defer, blocked, ...) -> recorded, no state change
 *
 * `--dry-run` is the default. `--apply` is required to write anything.
 *
 * Factored out of the command so `trellis auto` can call the identical logic
 * automatically right after 06_triage verifies — the whole point of a
 * one-command cycle is that the operator does not separately remember to run
 * this. Returns `null` (rather than dying) when there is nothing to apply, so
 * the auto loop can treat "no triage yet" as "nothing to do" instead of a
 * hard stop.
 */
function applyTriageCore(root, cfg, { apply, quiet = false } = {}) {
  const log2 = quiet ? { info() {}, ok() {}, warn() {}, bold: (s) => s, dim: (s) => s } : log;
  const state = st.loadState(root, cfg);
  if (!state) return null;

  const triagePath = path.resolve(root, ".trellis/triage.json");
  if (!fs.existsSync(triagePath)) return null;
  let triage;
  try { triage = JSON.parse(fs.readFileSync(triagePath, "utf8")); } catch { return null; }
  const decisions = Array.isArray(triage.decisions) ? triage.decisions : [];
  if (!decisions.length) return null;

  const rows = { reset: [], refused: [], accepted: [], checkpoint: [], recorded: [], unknown: [] };

  for (const d of decisions) {
    const id = d?.node;
    const verdict = String(d?.verdict || "");
    const s = id ? state.nodes[id] : null;
    if (!id || !s) { rows.unknown.push(d); continue; }

    if (REJECT_VERDICTS.has(verdict)) {
      if (st.LANDED.has(s.status)) { rows.refused.push({ id, status: s.status, reason: d.reason }); continue; }
      rows.reset.push(id);
      continue;
    }

    if (verdict === "accept") {
      if (st.LANDED.has(s.status)) { rows.accepted.push(id); continue; }
      if (s.status === st.STATUS.REVIEW) { rows.checkpoint.push({ id, reason: d.reason, code: d.code }); continue; }
      rows.recorded.push({ id, verdict, why: `status is ${s.status}, not review or landed — nothing to accept` });
      continue;
    }

    rows.recorded.push({ id, verdict, why: RECORD_ONLY_VERDICTS.has(verdict) ? "recorded only" : "no mechanised action for this verdict" });
  }

  log2.info(log2.bold(`triage decisions: ${decisions.length}`));
  if (rows.reset.length) log2.ok(`${rows.reset.length} rejected node(s) to reset: ${rows.reset.join(", ")}`);
  if (rows.accepted.length) log2.ok(`${rows.accepted.length} landed node(s) to mark accepted (bookkeeping only): ${rows.accepted.join(", ")}`);
  if (rows.refused.length) {
    log2.warn(`${rows.refused.length} rejected but already landed — a merge revert is a human decision, not applying:`);
    for (const r of rows.refused) log2.info(`  ${r.id} (${r.status})${r.reason ? `: ${r.reason}` : ""}`);
  }
  if (rows.checkpoint.length) {
    log2.warn(`${rows.checkpoint.length} accepted but held for review — never auto-applied, written to checkpoint:`);
    for (const c of rows.checkpoint) log2.info(`  ${c.id}${c.reason ? `: ${c.reason}` : ""}`);
  }
  if (rows.recorded.length) log2.info(log2.dim(`${rows.recorded.length} decision(s) recorded, no action: ${rows.recorded.map((r) => r.id).join(", ")}`));
  if (rows.unknown.length) log2.warn(`${rows.unknown.length} decision(s) named a node not in this run's state — skipped.`);

  if (!apply) {
    log2.info("");
    log2.info(log2.dim("Dry run. Nothing was changed. Re-run with --apply to write these."));
    return { rows, applied: false };
  }

  for (const id of rows.reset) {
    const s = state.nodes[id];
    const branch = s.branch || `trellis/${id}`;
    s.status = st.STATUS.PENDING;
    s.attempts = [];
    s.tier = null;
    s.reason = null;
    s.survivingMutations = [];
    removeWorktree(root, cfg, id, { quiet: true });
    git(root, ["branch", "-D", branch]);
  }
  for (const id of rows.accepted) {
    const s = state.nodes[id];
    s.status = st.STATUS.MERGED;
    s.reason = "accepted via apply-triage (was already landed)";
    s.acceptedAt = new Date().toISOString();
  }

  st.saveState(root, cfg, state);
  // Accepting or resetting nodes changes what counts as built; refresh the
  // derived cache rather than leave it showing the pre-apply picture.
  writeBuilt(root, cfg);

  // Written unconditionally, including an empty `nodes: []`. Writing it only
  // when rows.checkpoint is non-empty left a PRIOR run's checkpoint on disk
  // forever once every node in it was finally accepted — `trellis auto`
  // reads this file unconditionally, so the loop kept reporting the same
  // stale checkpoint after the nodes it named were already merged.
  const checkpointPath = path.resolve(root, ".trellis/checkpoint.json");
  fs.writeFileSync(checkpointPath, JSON.stringify({ at: new Date().toISOString(), nodes: rows.checkpoint }, null, 2) + "\n");

  log2.info("");
  log2.ok(`applied: ${rows.reset.length} reset, ${rows.accepted.length} bookkept, ${rows.checkpoint.length} sent to checkpoint`);
  if (rows.checkpoint.length) {
    log2.info(log2.dim(`See .trellis/checkpoint.json. Review those branches, then:`));
    log2.info(log2.dim(`  node kit/bin/cli.mjs accept ${rows.checkpoint.map((c) => c.id).join(" ")} --merge`));
  }
  if (rows.reset.length) log2.info(log2.dim("Next: node kit/bin/cli.mjs run --resume"));
  return { rows, applied: true };
}

function cmdApplyTriage() {
  const { root, cfg } = ctx();
  const result = applyTriageCore(root, cfg, { apply: flags.has("--apply") });
  if (!result) die("No run, or no .trellis/triage.json with decisions — nothing to apply.");
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

  // A hash of the source file, not of anything derived — re-ingesting an
  // unchanged spec every cycle is pure waste, and this is what lets `auto`
  // skip 01_ingest on a second pass without skipping it on a first.
  const specHash = errors.length
    ? null
    : crypto.createHash("sha256").update(fs.readFileSync(path.resolve(root, rel))).digest("hex").slice(0, 16);

  const out = {
    at: new Date().toISOString(),
    source: rel,
    specHash,
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

// ------------------------------------------------------------------- cycle

/**
 * Declare a new pass at the product graph, explicitly. Plain `trellis run`
 * keeps working without this — it lazily begins cycle 1 the first time
 * nothing exists yet — but coming back for a SECOND pass has to be a
 * deliberate act, or nothing can tell "still working on this one" from
 * "starting the next one", and the entire evidence-arithmetic in `evolve`
 * depends on being able to tell them apart.
 */
function cmdCycle() {
  const { root, cfg } = ctx();
  const prior = currentCycle(root, cfg);
  if (prior && !flags.has("--force")) {
    log.info(`Currently on cycle ${prior.cycle} (${prior.id}), started ${prior.startedAt}.`);
    log.info(log.dim("Pass --force to begin a new one anyway."));
    return;
  }
  const version = flagVal("version") || prior?.version || "v1";
  const c = beginCycle(root, cfg, { version });
  log.ok(`Cycle ${c.cycle} begun (${c.id}), version ${version}.`);
  log.info(log.dim("Next: node kit/bin/cli.mjs slice --max 25"));
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

// ------------------------------------------------------------------- built

/**
 * The derived cache, written for human inspection — `trellis slice` calls
 * builtNodes() directly and never reads this file, so nothing downstream
 * depends on it being fresh. This exists so you can SEE what the ledger and
 * state.json currently say is done, and what changed since last time.
 */
function cmdBuilt() {
  const { root, cfg } = ctx();
  const { nodes, added, removed } = writeBuilt(root, cfg);
  log.ok(`${nodes.length} node(s) built.`);
  if (added.length) log.info(`  + ${added.join(", ")}`);
  if (removed.length) log.warn(`  - ${removed.join(", ")} (no longer counts as built — was this a reject?)`);
}

// ------------------------------------------------------------------- slice

function cmdSlice() {
  const { root, cfg } = ctx();
  const graph = loadProductGraph(root, flagVal("product") || PRODUCT_GRAPH_DEFAULT);
  const { errors, graph: derived } = validateProductGraph(graph);
  if (errors.length) die("Run `trellis ingest` first — the graph does not validate.");

  // Derived from the ledger and state.json, not read from a hand-authored
  // file — see kit/lib/built.mjs for why nobody ever wrote that file
  // correctly. A node that landed cannot be re-planned; a node that did not
  // land cannot be skipped by a stale entry, because there is no entry to
  // go stale.
  const built = builtNodes(root, cfg);
  const max = flagInt("max") ?? 25;
  const version = flagVal("version") || "v1";

  const slice = nextSlice(derived, { version, built, maxNodes: max });
  if (!slice.nodes.length) {
    log.ok(`Nothing left to build in ${version}.`);
    return;
  }

  const plan = {
    at: new Date().toISOString(),
    // Stamped mechanically here rather than left for a session to remember,
    // the way triage's `run` field has to be — this command is code, not a
    // model, so there is no reason to trust anything less than 100%. This is
    // the field 02_slice's stage verify checks to tell "cut for this pass"
    // from "cut for a previous one and never re-sliced".
    cycle: cycleIdFor(root, cfg),
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

/**
 * `auto` spawns headless sessions with `permissionMode: acceptEdits` and an
 * unrestricted Bash tool. Without `.claude/hooks/guard-bash.mjs` registered on
 * a `Bash` matcher, nothing stops a stage session from running
 * `cli.mjs accept --merge` on a high-risk node — the exact one-way door
 * MISSION.md says must stay a human's. This is a preflight refusal, the same
 * shape as `doctor`'s checks: fail loudly before spending anything, not after.
 */
function requireBashGuard(root) {
  const p = path.resolve(root, ".claude/settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    die(
      `${p} is missing or unreadable. \`auto\` refuses to start without the Bash guard configured — ` +
        `see .claude/hooks/guard-bash.mjs.`
    );
  }
  const pre = settings.hooks?.PreToolUse ?? [];
  const guarded = pre.some(
    (h) => String(h.matcher || "").split("|").includes("Bash") &&
      (h.hooks || []).some((x) => /guard-bash\.mjs/.test(x.command || ""))
  );
  if (!guarded) {
    die(
      "No PreToolUse hook matches Bash in .claude/settings.json. A headless stage session's Bash tool " +
        "is unrestricted without it, which means nothing stops `accept --merge` on a high-risk node — " +
        "the one-way door MISSION.md says must stay a human's. Register guard-bash.mjs on a \"Bash\" " +
        "matcher before running auto."
    );
  }
}

/**
 * 05_build's session cost was hardcoded to 0 — worker spend is real money and
 * was invisible to `trellis sessions` and to any budget decision about
 * whether a multi-cycle `--cycles N` run is affordable. Computed from the
 * same per-tier usage the ledger already tracks, against the cost-per-1k
 * fields already in trellis.config.json.
 */
function runnerCostUsd(state, cfg) {
  const usage = st.usageByTier(state);
  let total = 0;
  for (const [tierName, u] of Object.entries(usage)) {
    const tier = cfg.tiers.find((t) => t.name === tierName);
    if (!tier) continue;
    total += (u.prompt / 1000) * (tier.costPer1kInput ?? 0);
    total += (u.completion / 1000) * (tier.costPer1kOutput ?? 0);
  }
  return total;
}

/**
 * Commit what a stage was declared to produce, and refuse to guess about
 * anything else. `stage.commits(root, cfg)` names the paths; anything the
 * git tree shows modified OUTSIDE that list halts the whole loop rather than
 * being swept in — the failure mode this avoids is exactly the one from
 * hand-running `git add -A` mid-session: the wrong file ends up in the wrong
 * commit. If a session's contract says IT commits something (02_slice's
 * interface files), and it did not, that is the halt surfacing exactly the
 * thing a human needs to look at.
 *
 * Uses changedPaths() (worktree.mjs) rather than re-parsing `git status
 * --porcelain` here — that function's own docblock documents at length why a
 * second hand-rolled parse of porcelain output silently drops the first
 * character of the first path (an unstaged-modification record starts with a
 * LEADING SPACE, and the untrimmed `raw: true` form is required to see it).
 */
function commitStageOutput(root, cfg, stage) {
  const declared = (stage.commits ? stage.commits(root, cfg) : [])
    .filter((p) => fs.existsSync(path.resolve(root, p)));

  if (declared.length) git(root, ["add", "--", ...declared]);

  const declaredSet = new Set(declared.map((p) => norm(p)));
  const unexpected = changedPaths(root).filter((f) => !declaredSet.has(f));

  if (unexpected.length) {
    return { ok: false, unexpected };
  }
  if (!declared.length) return { ok: true, committed: false };

  const cyc = currentCycle(root, cfg);
  const r = git(root, ["commit", "-m", `trellis(${stage.id}): cycle ${cyc?.cycle ?? "?"}`]);
  if (!r.ok) return { ok: false, unexpected: [], commitFailed: true, message: r.err };
  return { ok: true, committed: true, paths: declared };
}

/**
 * Replaces a hard die() on stage exhaustion. The stage is idempotent — that
 * was already true — so the new part is leaving a machine-readable artifact
 * saying exactly where things stopped and what to type next, instead of only
 * a console line that scrolled away. In `--cycles` mode this is also what
 * stops the outer loop from rolling to a cycle that never finished this one.
 */
function writeHandback(root, cfg, { cycle, stage, attempts, detail }) {
  const p = path.resolve(root, ".trellis/handback.json");
  const nextCommand = `node kit/bin/cli.mjs auto --stage ${stage}`;
  fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), cycle, stage, attempts, detail, nextCommand }, null, 2) + "\n");
  log.fail(`${stage} did not complete after ${attempts} attempts — ${detail}`);
  log.info(log.dim(`Nothing was corrupted — the stage is idempotent. See .trellis/handback.json. Next:`));
  log.info(log.dim(`  ${nextCommand}`));
  process.exitCode = 1;
}

/** Runs one stage chain (the default chain, or a single --stage) to completion. */
async function runStageChain(root, cfg, stages) {
  for (const stage of stages) {
    const pre = stage.verify(root, cfg);
    if (pre.ok && !flags.has("--force")) {
      log.ok(`${stage.id} already satisfied (${pre.detail}) — skipping.`);
      continue;
    }

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
        const graph = loadGraph(root, cfg.paths.graph);
        const { errors } = validateGraph(graph, cfg, root);
        if (errors.length) {
          for (const e of errors) log.fail(e);
          die("Graph is invalid. Nothing was run.");
        }
        const state = resumeOrInit(root, cfg, graph, { resume: true });
        await run(cfg, graph, state, { history: ledger.read(root, cfg) });
        result = { exitCode: 0, costUsd: runnerCostUsd(state, cfg) };
      } else {
        result = await runSession(root, stage, cfg);
        if (result.spawnFailed) {
          die(`Could not spawn "${cfg.driver.command}". Is Claude Code on PATH?`);
        }
      }

      const check = stage.verify(root, cfg);
      recordSession(root, {
        stage: stage.id,
        cycle: currentCycle(root, cfg)?.cycle ?? null,
        attempt,
        exitCode: result.exitCode,
        costUsd: result.costUsd,
        sessionId: result.sessionId ?? null,
        durationMs: result.durationMs ?? null,
        numTurns: result.numTurns ?? null,
        verified: check.ok,
        detail: check.detail,
      });

      if (check.ok) {
        log.ok(`${stage.id} verified — ${check.detail}`);
        const committed = commitStageOutput(root, cfg, stage);
        if (!committed.ok) {
          if (committed.commitFailed) die(`Could not commit ${stage.id}'s output: ${committed.message}`);
          log.fail(`${stage.id} verified, but the tree has changes outside what this stage declares:`);
          for (const line of committed.unexpected) log.info(`  ${line}`);
          log.info(log.dim(
            `If the session was supposed to commit these itself, check its contract. ` +
              `Otherwise commit or revert them by hand, then re-run.`
          ));
          process.exitCode = 1;
          return { ok: false, haltedAt: stage.id };
        }
        if (committed.committed) log.info(log.dim(`  committed: ${committed.paths.join(", ")}`));
        done = true;
        break;
      }

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
      writeHandback(root, cfg, {
        cycle: currentCycle(root, cfg)?.cycle ?? null,
        stage: stage.id,
        attempts: attempt,
        detail: `did not complete after ${cfg.driver.maxAttempts} attempts`,
      });
      return { ok: false, haltedAt: stage.id };
    }
  }
  return { ok: true };
}

function cmdAutoDryRun(root, cfg, only) {
  const stages = only ? STAGES.filter((s) => s.id === only) : DEFAULT_CHAIN;
  const stats = sessionStats(root);
  log.info(log.bold("Stage plan:"));
  for (const stage of stages) {
    const pre = stage.verify(root, cfg);
    const s = stats[stage.id];
    const cost = s ? `  observed median $${s.median.toFixed(2)}, p90 $${s.p90.toFixed(2)} (${s.runs} runs)` : "";
    log.info(`  ${pre.ok ? "skip  " : "run   "} ${stage.id.padEnd(12)} ${pre.ok ? `already satisfied (${pre.detail})` : pre.detail}${cost}`);
  }
  log.info("");
  log.info(log.dim("Nothing was run. Drop --dry-run to execute this plan."));
}

/**
 * One command driving a whole cycle — plan, build, triage — stopping only at
 * the checkpoint MISSION.md requires: a high-risk node held for a human.
 * `--cycles N` repeats this across N passes, beginning a new cycle each time,
 * for as long as nothing needs a human and nothing gets stuck.
 */
async function cmdAuto() {
  const { root, cfg } = ctx();
  if (!cfg.driver?.enabled) {
    die("driver.enabled is false in trellis.config.json. Read the driver section before turning this on.");
  }
  requireBashGuard(root);

  // Periodic stages are reachable only by name. Without this, adding one would
  // silently make every ordinary run spend an extra expensive session.
  const only = flagVal("stage");
  if (only && !STAGES.some((s) => s.id === only)) die(`Unknown stage ${only}. One of: ${STAGES.map((s) => s.id).join(", ")}`);

  if (flags.has("--dry-run")) return cmdAutoDryRun(root, cfg, only);

  const stats = sessionStats(root);
  if (Object.keys(stats).length) {
    log.info("Observed cost per stage (from your own runs, not an estimate):");
    for (const [stage, s] of Object.entries(stats)) {
      log.info(`  ${stage.padEnd(12)} median $${s.median.toFixed(2)}  p90 $${s.p90.toFixed(2)}  (${s.runs} runs)`);
    }
  }

  // A single --stage invocation is one pass, not a loop — it is how you drive
  // one thing by hand (including 07_evolve, which must never be swept into a
  // --cycles loop). Only the default chain cycles.
  const maxCycles = only ? 1 : Math.max(1, flagInt("cycles") ?? 1);

  for (let i = 0; i < maxCycles; i++) {
    const stages = only ? STAGES.filter((s) => s.id === only) : DEFAULT_CHAIN;

    if (!only) {
      // First iteration: reuse an in-progress cycle if one exists (resuming
      // after a handback), or lazily begin cycle 1. Every iteration after the
      // first is, by construction, a NEW pass — begin one explicitly.
      if (i === 0) cycleIdFor(root, cfg);
      else beginCycle(root, cfg, { version: currentCycle(root, cfg)?.version ?? "v1" });
      log.info(log.bold(`\n=== cycle ${currentCycle(root, cfg)?.cycle} ===`));
    }

    const result = await runStageChain(root, cfg, stages);
    if (!result.ok) return; // handback already written; exitCode already set

    if (only) { log.ok(`${only} verified.`); return; }

    // The checkpoint: MISSION.md's one non-negotiable stop. apply-triage
    // mechanises everything reversible automatically; anything it could not
    // apply — a high-risk node still held for review — stops the loop here,
    // unconditionally, regardless of how many cycles were requested.
    applyTriageCore(root, cfg, { apply: true });
    const checkpointPath = path.resolve(root, ".trellis/checkpoint.json");
    if (fs.existsSync(checkpointPath)) {
      let cp;
      try { cp = JSON.parse(fs.readFileSync(checkpointPath, "utf8")); } catch { cp = null; }
      if (cp?.nodes?.length) {
        const remaining = maxCycles - i - 1;
        log.warn(`\nCycle ${currentCycle(root, cfg)?.cycle} built. ${cp.nodes.length} high-risk node(s) need your eyes:`);
        for (const n of cp.nodes) log.info(`  ${n.id.padEnd(24)} git show trellis/${n.id}`);
        log.info("");
        log.info("When you have reviewed them:");
        log.info(`  node kit/bin/cli.mjs accept ${cp.nodes.map((n) => n.id).join(" ")} --merge`);
        if (remaining > 0) log.info(`  node kit/bin/cli.mjs auto --cycles ${remaining}`);
        return;
      }
    }

    log.ok(`Cycle ${currentCycle(root, cfg)?.cycle} complete.`);
  }
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
    triageRows: triageRows(root, cfg),
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

/**
 * The whole input to stage 07, and the reason its token budget is bounded by
 * construction rather than by an instruction telling a model to be brief.
 *
 * A handful of rows of scalars. No prose, no logs, no transcripts. `--top` caps
 * it; the default of 5 is a deliberate ceiling on how much can be considered in
 * one pass, not a display convenience.
 */
function emitShortlist(root, cfg, minRuns) {
  // The cap must match what the 07_evolve verify predicate enumerates, or the
  // stage is asked to account for patterns it was never shown. Both call
  // evolve.shortlist(); EVOLVE_TOP is the number the predicate holds it to.
  const top = flagInt("top") ?? EVOLVE_TOP;
  const scope = flags.has("--all-nodes") ? "all" : "costly";
  const patterns = shortlist(root, cfg, { minRuns, scope, top });

  if (top !== EVOLVE_TOP) {
    process.stderr.write(
      `note: --top ${top} differs from the ${EVOLVE_TOP} the 07_evolve gate checks; ` +
        `the stage is still held to ${EVOLVE_TOP}.\n`
    );
  }
  process.stdout.write(JSON.stringify({ minRuns, scope, top, patterns }, null, 2) + "\n");
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

  log.warn(`${skills.length} entr(y/ies) never activated:`);
  for (const s of skills) {
    log.info(`  ${s.name.padEnd(28)} ${s.kind}, ${s.rules.join("+")} — 0 of ${s.runs} eligible run(s)`);
  }
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

// ------------------------------------------------------------------- triage

/**
 * Record one triage decision through code, stamping `run` here rather than
 * accepting it — see kit/lib/triage.mjs for why. `sessions/06_triage/
 * CONTEXT.md` calls this once per node reviewed instead of hand-formatting
 * `.trellis/triage.jsonl`.
 */
function cmdTriage() {
  const { root, cfg } = ctx();
  const node = flagVal("node");
  const verdict = flagVal("verdict");
  const reason = flagVal("reason");
  if (!node || !verdict || !reason) {
    die('Usage: trellis triage --node <id> --verdict reject|accept|hold|take --reason "..." [--code <c>]');
  }

  const run = currentRunId(root);
  if (!run) die("No runId in .trellis/state.json. Triage is recorded against a run, or not at all.");

  const rawCode = flagVal("code");
  const dec = {
    node,
    verdict,
    reason,
    code: rawCode ? normaliseCode(rawCode, loadCodes(root), "rejection") : undefined,
  };

  let row;
  try {
    row = triage.append(root, cfg, dec, { run });
  } catch (e) {
    die(e.message);
  }

  log.ok(`${row.node}: ${row.verdict}${row.code ? ` (${row.code})` : ""} — ${row.reason}`);
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
      // The driver stamps TRELLIS_STAGE when it spawns a session, so this is
      // decided by the harness rather than attested by the session it binds.
      // The flag stays as an override for a human writing one by hand.
      fromEvolveStage:
        flags.has("--from-evolve-stage") || process.env.TRELLIS_STAGE === "07_evolve",
    });
  } catch (e) {
    die(e.message);
  }

  log.ok(`wrote ${result.file}`);
  log.info(`  kind: ${result.kind}   tier: ${result.tier}`);
  // No apply mechanism exists yet — this only classifies what WOULD be
  // eligible for one if it did. Every proposal, advisory or load-bearing,
  // currently waits for a human to read it and act.
  log.info(`  ${result.tier === "advisory" && !result.held
    ? "advisory, eligible for auto-apply once that mechanism exists — waits for a human for now"
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
  if (c === "invalid") {
    log.warn("Not a usable target. Name paths as plain repo-relative paths —");
    log.warn("no leading slash or drive letter, and no '..' segments.");
    process.exit(1);
  }
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
  trellis apply-triage        Mechanise the reversible verdicts in triage.json
    --apply                      Write changes (default is a dry run)
  trellis status              Per-node status of the last run
  trellis clean [--branches]  Remove worktrees (and optionally trellis/* branches)

Product graph — authored outside Trellis, handed in complete:
  trellis ingest              Validate the product graph, derive high-risk nodes
  trellis promote             Which v2 nodes are unblocked and could ship in v1
  trellis built                What the ledger + state.json currently say is done
  trellis cycle                Declare a new pass — begins cycle 1 lazily if you skip this
    --force                     Begin a new cycle even if the current one is unfinished
    --version v1|v2              Which release this cycle targets
  trellis slice [--max 25]    Cut the next buildable slice into .trellis/plan.json
    --version v1|v2             Which release to slice from (default v1)

Autonomy and evolution:
  trellis auto [--stage id]   Drive one whole cycle headless, verifying every stage on disk
                                07_evolve is periodic: reachable only by --stage
    --cycles N                   Drive N cycles back to back (ignored with --stage)
                                  Stops early, unconditionally, at any high-risk checkpoint
    --dry-run                    Print the stage plan and estimated cost; run nothing
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
  trellis triage --node <id> --verdict <v> --reason "..."   Record one triage decision
    --verdict reject|accept|hold|take
    --code <c>                  Required for --verdict reject; see 'trellis codes' for the vocabulary
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
  "apply-triage": cmdApplyTriage,
  status: cmdStatus,
  clean: cmdClean,
  built: cmdBuilt,
  cycle: cmdCycle,
  ingest: cmdIngest,
  promote: cmdPromote,
  slice: cmdSlice,
  auto: cmdAuto,
  sessions: cmdSessions,
  evolve: cmdEvolve,
  codes: cmdCodes,
  friction: cmdFriction,
  triage: cmdTriage,
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
