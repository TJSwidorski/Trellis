// The session driver.
//
// One session does one job, in a fresh context, and proves it finished by leaving
// an artifact on disk. The driver never reads the transcript to decide whether a
// session succeeded — that is how a quota-exhausted run reports completion while
// having written three of forty test files.
//
// What this CANNOT do, and why the design compensates:
//
//   There is no way to query remaining subscription quota from a script. Session
//   cap, weekly cap, and credit balance are visible in the status bar during an
//   active session and nowhere else. So the driver does not predict whether the
//   next session fits. It runs, verifies, and on failure backs off and retries the
//   same session — which is safe because every session is idempotent.
//
//   If ANTHROPIC_API_KEY is set, headless runs use it in preference to the
//   subscription credential. That trades opaque caps for documented limits and
//   retryable 429s, which is the configuration this driver handles best.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJsonOrNull, parseJsonl } from "./paths.mjs";
import * as friction from "./friction.mjs";
import * as evolve from "./evolve.mjs";
import * as ledger from "./ledger.mjs";
import { currentCycle } from "./cycle.mjs";
import { killTree, DETACH_FOR_TREE_KILL } from "./proc.mjs";

// --------------------------------------------------------------- stage table

// Each stage: the prompt that starts it, and the mechanical proof it finished.
// `verify` returns { ok, detail }. It reads disk. It does not read stdout.
export const STAGES = [
  {
    id: "01_ingest",
    prompt: "Read sessions/01_ingest/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => ingestCurrentForSpec(root, cfg),
    // Nothing to commit: ingest.json / product-graph.derived.json are working
    // state, not a deliverable — no docs anywhere ask the operator to commit
    // them by hand either.
    commits: () => [],
  },
  {
    id: "02_slice",
    prompt: "Read sessions/02_slice/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => sliceAssembledTaskGraph(root, cfg),
    // Only the two JSON files this stage's own verify inspects. The contract
    // ALSO tells the session to commit any interface file it writes — on
    // purpose left off this list. If one is left uncommitted, auto halting
    // on "unexpected" modifications is the correct behaviour: it means the
    // session did not do what its contract said, and that is worth a human
    // looking rather than auto silently sweeping it in.
    commits: (root, cfg) => [statePath(cfg, "plan.json"), statePath(cfg, "graph.json")],
  },
  {
    id: "03_cases",
    prompt: "Read sessions/03_cases/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => casesCoverPlan(root, cfg),
    commits: (root, cfg) => [statePath(cfg, "cases.json")],
  },
  {
    id: "04_tests",
    prompt: "Read sessions/04_tests/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => testsExistAndAreNonVacuous(root, cfg),
    // The declared test paths are the whole point of this stage, and they are
    // the only thing known ahead of time — read from THIS cycle's graph.json.
    commits: (root, cfg) => {
      const graph = readJson(root, statePath(cfg, "graph.json"));
      return (graph?.nodes ?? []).flatMap((n) => n.tests ?? []);
    },
  },
  {
    id: "05_build",
    prompt: null, // no model: the deterministic runner owns this stage
    run: "runner",
    verify: (root, cfg) => buildFinishedThisCycle(root, cfg),
    // The runner commits each node's work itself as it merges (commitWorktree,
    // one commit per landed node) — there is nothing left for auto to batch.
    commits: () => [],
  },
  {
    id: "06_triage",
    prompt: "Read sessions/06_triage/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => triageRecordedEvidence(root, cfg),
    commits: (root, cfg) => [
      statePath(cfg, "triage.json"), statePath(cfg, "triage.jsonl"),
      statePath(cfg, "friction.jsonl"), statePath(cfg, "built.json"),
    ],
  },
  {
    id: "07_evolve",
    // Not in the default chain. Evolution should run rarely and deliberately —
    // every pass costs an expensive session, and the evidence it reads only
    // changes across many runs. `trellis auto --stage 07_evolve` reaches it.
    periodic: true,
    prompt: "Read sessions/07_evolve/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => evolveConsideredEverything(root, cfg),
    commits: (root, cfg) => {
      const j = readJson(root, statePath(cfg, "evolve.json"));
      return [statePath(cfg, "evolve.json"), ...(j?.proposals ?? [])];
    },
  },
];

/** Stages that run on an ordinary `trellis auto`. */
export const DEFAULT_CHAIN = STAGES.filter((s) => !s.periodic);

// -------------------------------------------------------------- verification

function readJson(root, rel) {
  return readJsonOrNull(path.resolve(root, rel));
}

/**
 * Every artifact this file checks lives under `cfg.paths.state`, which
 * defaults to ".trellis" but is a real, documented config knob (see
 * trellis.config.json's `paths` block) — `forgedTriageRuns` below already
 * honoured it; every OTHER path in this file was a literal ".trellis/..."
 * string. Set `paths.state` to anything else and the runner writes there
 * while this file kept reading the old default: every stage failed with
 * "state.json has no runId to attribute triage to", or read a stale
 * left-over `.trellis/` directory from before the config changed instead of
 * the one the run actually just wrote to.
 */
function statePath(cfg, rel) {
  return `${cfg?.paths?.state ?? ".trellis"}/${rel}`;
}

function artifactExists(root, rel, check) {
  const p = path.resolve(root, rel);
  if (!fs.existsSync(p)) return { ok: false, detail: `${rel} was not written` };
  if (!check) return { ok: true, detail: rel };
  const j = readJson(root, rel);
  if (j === null) return { ok: false, detail: `${rel} is not parseable JSON` };
  return check(j)
    ? { ok: true, detail: rel }
    : { ok: false, detail: `${rel} exists but is incomplete` };
}

/**
 * Stage 02 produces TWO artifacts, and only one of them is the session's work.
 *
 * `trellis slice` writes plan.json mechanically — the cut is not a judgement.
 * The judgement is graph.json: write scopes, read lists, gate commands, tags,
 * mutations, and any interface file two nodes would otherwise agree on by
 * coincidence. Verifying plan.json alone meant the stage passed on the strength
 * of the file the CLI wrote, so `auto` would skip the session that does the
 * actual work and fail at 03 with no graph to read.
 *
 * The cross-stage check is the contract's own, quoted from it: every node id in
 * plan.json must appear in graph.json. A node dropped between the two files is
 * silently descoped work.
 */
/**
 * Re-ingesting a product graph that has not changed is pure waste, so this
 * checks a hash of the SOURCE file (stamped by `cmdIngest` itself, not by a
 * session) rather than just "does ingest.json exist and say zero errors".
 * Missing `specHash` — an ingest.json from before this field existed — is
 * treated as stale rather than crashing, so an old artifact does not wedge
 * the stage; it just re-runs once.
 */
function ingestCurrentForSpec(root, cfg) {
  const base = artifactExists(root, statePath(cfg, "ingest.json"), (j) => j.errors?.length === 0);
  if (!base.ok) return base;
  const j = readJson(root, statePath(cfg, "ingest.json"));
  const specPath = path.resolve(root, j.source ?? "");
  if (!j.source || !fs.existsSync(specPath)) {
    return { ok: false, detail: `ingest.json names a spec that no longer exists: ${j.source}` };
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(specPath)).digest("hex").slice(0, 16);
  if (j.specHash !== actual) {
    return { ok: false, detail: `${j.source} changed since it was last ingested — re-run \`trellis ingest\`` };
  }
  return { ok: true, detail: `${j.source} unchanged since last ingest (${actual})` };
}

/**
 * The runner is code, not a session — REPORT.md existing at all used to be
 * the whole check, which a stale report from a PREVIOUS cycle satisfies just
 * as well as a fresh one. state.json.runId is the cycle id (see cycle.mjs),
 * so comparing it is the same run-stamp discipline 06/07 already use.
 */
function buildFinishedThisCycle(root, cfg) {
  const base = artifactExists(root, statePath(cfg, "REPORT.md"));
  if (!base.ok) return base;
  const cyc = currentCycle(root, cfg);
  const state = readJson(root, statePath(cfg, "state.json"));
  if (!cyc) return { ok: false, detail: `no ${statePath(cfg, "cycle.json")} — run \`trellis cycle\` first` };
  if (!state) return { ok: false, detail: "state.json missing — the runner has not produced one yet" };
  if (state.runId !== cyc.id) {
    return { ok: false, detail: `REPORT.md is from a different cycle than the current one (${cyc.cycle}) — run \`trellis run\` again` };
  }
  if (!state.finishedAt) return { ok: false, detail: "the run has not finished yet" };
  return { ok: true, detail: `run finished ${state.finishedAt} (cycle ${cyc.cycle})` };
}

function sliceAssembledTaskGraph(root, cfg) {
  const base = artifactExists(root, statePath(cfg, "plan.json"), (j) => Array.isArray(j.nodes) && j.nodes.length > 0);
  if (!base.ok) return base;

  // The plan is cut mechanically by `trellis slice`, which stamps `cycle`
  // itself — no session involved, so this is checked before anything else.
  // Without it, a stage that was satisfied by a PREVIOUS pass's plan.json
  // stayed "satisfied" forever, and a second `trellis auto` printed six
  // "already satisfied, skipping" lines and did nothing.
  const cyc = currentCycle(root, cfg);
  const plan0 = readJson(root, statePath(cfg, "plan.json"));
  if (!cyc) return { ok: false, detail: `no ${statePath(cfg, "cycle.json")} — run \`trellis cycle\` first` };
  if (plan0?.cycle !== cyc.id) {
    return { ok: false, detail: `plan.json belongs to a different cycle than the current one (${cyc.cycle}) — re-run \`trellis slice\`` };
  }

  const graph = readJson(root, statePath(cfg, "graph.json"));
  if (graph === null) {
    return {
      ok: false,
      detail:
        `${statePath(cfg, "graph.json")} was not written — \`trellis slice\` cuts the plan, but the task graph ` +
        "(write scopes, gate commands, mutations) is assembled by the session",
    };
  }
  if (!Array.isArray(graph.nodes) || !graph.nodes.length) {
    return { ok: false, detail: `${statePath(cfg, "graph.json")} declares no nodes` };
  }
  // graph.json IS the session's work, so its cycle stamp has to come from the
  // session actually writing one — sessions/02_slice/CONTEXT.md instructs it.
  if (graph.cycle !== cyc.id) {
    return { ok: false, detail: `graph.json is not stamped with the current cycle (${cyc.cycle}) — the session must write "cycle": "${cyc.id}" into it` };
  }

  const plan = readJson(root, statePath(cfg, "plan.json"));
  const planned = (plan.nodes ?? []).map((n) => (typeof n === "string" ? n : n.id));
  const built = new Set(graph.nodes.map((n) => n.id));
  const dropped = planned.filter((id) => !built.has(id));
  if (dropped.length) {
    return {
      ok: false,
      detail: `${dropped.length} planned node(s) missing from graph.json: ${dropped.slice(0, 5).join(", ")}`,
    };
  }

  // A node with no write scope or no gate cannot be dispatched at all — the
  // shape of a graph a session abandoned midway.
  const incomplete = graph.nodes
    .filter((n) => !(n.write ?? []).length || !n.gate)
    .map((n) => n.id);
  if (incomplete.length) {
    return {
      ok: false,
      detail: `${incomplete.length} node(s) have no write scope or no gate: ${incomplete.slice(0, 5).join(", ")}`,
    };
  }

  return { ok: true, detail: `${planned.length} planned node(s), all present in graph.json` };
}

// The cases file must have an entry for every node in the plan. A session that
// died halfway leaves a well-formed file covering the first eight nodes; this is
// the check that catches it.
function casesCoverPlan(root, cfg) {
  const plan = readJson(root, statePath(cfg, "plan.json"));
  const cases = readJson(root, statePath(cfg, "cases.json"));
  if (!plan) return { ok: false, detail: "plan.json missing" };
  if (!cases) return { ok: false, detail: "cases.json missing or unparseable" };
  const cyc = currentCycle(root, cfg);
  if (!cyc) return { ok: false, detail: `no ${statePath(cfg, "cycle.json")} — run \`trellis cycle\` first` };
  if (cases.cycle !== cyc.id) {
    return { ok: false, detail: `cases.json is not stamped with the current cycle (${cyc.cycle}) — the session must write "cycle": "${cyc.id}" into it` };
  }
  const want = new Set(plan.nodes.map((n) => n.id ?? n));
  const have = new Set(Object.keys(cases.nodes ?? {}));
  const missing = [...want].filter((id) => !have.has(id));
  if (missing.length) {
    return { ok: false, detail: `no cases for ${missing.length} node(s): ${missing.slice(0, 5).join(", ")}` };
  }
  const empty = [...have].filter((id) => !(cases.nodes[id]?.cases ?? []).length);
  if (empty.length) return { ok: false, detail: `empty case list for ${empty.join(", ")}` };
  return { ok: true, detail: `${have.size} nodes covered` };
}

// Every test file the graph declares must exist with real content. Emptiness and
// truncation are the signatures of a session that ran out of budget mid-write.
function testsExistAndAreNonVacuous(root, cfg) {
  const graph = readJson(root, statePath(cfg, "graph.json"));
  if (!graph) return { ok: false, detail: "graph.json missing" };

  // Every node, not the flattened total. `flatMap` over all nodes meant a
  // 40-node graph where 39 declared nothing passed on the strength of the 40th.
  const bare = graph.nodes.filter((n) => !(n.tests ?? []).length).map((n) => n.id);
  if (bare.length) {
    return { ok: false, detail: `${bare.length} node(s) declare no tests: ${bare.slice(0, 5).join(", ")}` };
  }

  const declared = graph.nodes.flatMap((n) => n.tests ?? []);
  const missing = [];
  const thin = [];
  for (const rel of declared) {
    const p = path.resolve(root, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    if (fs.statSync(p).size < 120) thin.push(rel);
  }
  if (missing.length) return { ok: false, detail: `${missing.length} test file(s) not written: ${missing.slice(0, 4).join(", ")}` };
  if (thin.length) return { ok: false, detail: `${thin.length} test file(s) suspiciously small: ${thin.slice(0, 4).join(", ")}` };

  // The function is named testsExistAndAreNonVacuous and its success string used
  // to read "(run verify-tests for non-vacuity)" — it never ran it. In the
  // headless `auto` chain that meant non-vacuity was established nowhere at all,
  // by anything, while the stage reported it finished. Run the real check.
  const cli = path.resolve(fileURLToPath(import.meta.url), "../../bin/cli.mjs");
  const r = spawnSync(process.execPath, [cli, "verify-tests"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    timeout: (cfg?.gate?.timeoutMs ?? 300000) * 2,
  });
  if (r.status !== 0) {
    const why = String(r.stdout || "").split("\n").filter((l) => /\[/.test(l)).slice(0, 3).join("; ");
    return { ok: false, detail: `verify-tests rejected these gates: ${why || String(r.stderr || "").slice(0, 200)}` };
  }
  // Report what was actually proven, including when the answer is "not much".
  const summary = String(r.stdout || "").split("\n").find((l) => /null stub|Nothing here is proven|could not be checked/.test(l));
  return { ok: true, detail: summary?.replace(/\[\d+m/g, "").replace(/^[+!]\s*/, "").trim() || `${declared.length} test files verified` };
}

/**
 * Read the JSONL lines belonging to the current run.
 *
 * `run` comes from state.json rather than from the session, so a line stamped
 * with someone else's run id — or with none — cannot satisfy a stage.
 */
export function currentRunId(root, cfg) {
  return readJson(root, statePath(cfg, "state.json"))?.runId ?? null;
}

function jsonlRowsForRun(root, rel, run) {
  const p = path.resolve(root, rel);
  if (!fs.existsSync(p)) return null;
  const rows = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.run === run) rows.push(row);
    } catch { /* a torn last line is not evidence of anything */ }
  }
  return rows;
}

/**
 * Triage must leave the cross-run record, not just this run's summary.
 *
 * `triage.json` is what the next slice reads; `triage.jsonl` is the only thing
 * self-improvement ever sees. Verifying only the former let a stage pass having
 * written no evidence at all — which is how `trellis evolve` could stay inert
 * forever while every stage reported success.
 */
function triageRecordedEvidence(root, cfg) {
  const base = artifactExists(root, statePath(cfg, "triage.json"), (j) => Array.isArray(j.decisions));
  if (!base.ok) return base;

  const run = currentRunId(root, cfg);
  if (!run) return { ok: false, detail: "state.json has no runId to attribute triage to" };

  const triageJsonl = statePath(cfg, "triage.jsonl");
  const rows = jsonlRowsForRun(root, triageJsonl, run);
  if (rows === null) return { ok: false, detail: `${triageJsonl} was not written` };
  if (!rows.length) {
    return { ok: false, detail: `${triageJsonl} has no line stamped run "${run}"` };
  }
  const decisions = rows.flatMap((r) => (Array.isArray(r.decisions) ? r.decisions : []));
  if (!decisions.length) {
    return { ok: false, detail: `${triageJsonl} line for run "${run}" carries no decisions` };
  }

  // The `run` field is what the whole minRuns discipline in evolve.mjs counts
  // on — rejectionCounts dedups on it, one distinct value per line. `trellis
  // triage` stamps it from state.json the way friction.append does, but
  // triage.jsonl is a plain file (MISSION invariant 5) that a hand-formatted
  // session, or a gate command running unsandboxed code, can also append to
  // directly. A fabricated run id is indistinguishable from a real one to
  // rejectionCounts, so cross-check every distinct run this file has EVER
  // claimed — not just this run's rows — against runIds the ledger actually
  // recorded. The ledger gets its entry for the current run during 05_build,
  // which always precedes 06_triage in the chain, so the current run is
  // legitimately present there by the time this check runs.
  const forged = forgedTriageRuns(root, cfg, run);
  if (forged.length) {
    return {
      ok: false,
      detail:
        `${triageJsonl} claims run(s) the ledger never recorded: ${forged.join(", ")}. ` +
        `Every line must come from \`trellis triage\`, never hand-appended.`,
    };
  }

  // Friction is a separate claim from the triage decisions and gets checked
  // separately. `--none` satisfies it: what is required is a statement, not a
  // grievance. Verifying that a statement exists is the most a driver can do —
  // whether it is TRUE is settled across runs, in evolve, and never here.
  const f = assertedFriction(root, cfg, { run, stage: "06_triage" });
  if (!f.ok) return f;

  return {
    ok: true,
    detail: `triage.json + ${decisions.length} decision(s) for run ${run}; friction: ${f.detail}`,
  };
}

/**
 * Every distinct `run` value triage.jsonl has ever claimed, checked against
 * runIds the ledger actually recorded. `currentRun` is always trusted even if
 * the ledger somehow lags — it came from state.json, not from the file under
 * suspicion — so this can never fail a stage on its own run.
 */
function forgedTriageRuns(root, cfg, currentRun) {
  const p = path.resolve(root, statePath(cfg, "triage.jsonl"));
  if (!fs.existsSync(p)) return [];
  const claimed = new Set();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.run) claimed.add(row.run);
    } catch { /* a torn last line is not evidence of anything */ }
  }
  if (!claimed.size) return [];
  const known = new Set(ledger.read(root, cfg).map((r) => r.runId).filter(Boolean));
  if (currentRun) known.add(currentRun);
  return [...claimed].filter((r) => !known.has(r));
}

/**
 * The evolve stage must account for every pattern it was shown.
 *
 * Stage 06's rule, transplanted: silence on a stuck node is not acceptance, and
 * silence on a shortlisted pattern is not a decline. Without this a pass can
 * quietly ignore the evidence it would rather not act on, and every artifact it
 * leaves behind still looks complete.
 */
function evolveConsideredEverything(root, cfg) {
  const base = artifactExists(root, statePath(cfg, "evolve.json"), (j) => Array.isArray(j.consideredCodes));
  if (!base.ok) return base;

  const j = readJson(root, statePath(cfg, "evolve.json"));

  // Attribute the artifact to this run, the way triage is attributed. Without
  // it a stale evolve.json from an earlier pass satisfies the stage forever —
  // and cmdAuto pre-checks verify and skips, so the stage would never run again.
  const run = currentRunId(root, cfg);
  if (!run) return { ok: false, detail: "state.json has no runId to attribute the evolve pass to" };
  if (j.run !== run) {
    return { ok: false, detail: `evolve.json is stamped run "${j.run}", not this run "${run}"` };
  }

  const considered = new Set(j.consideredCodes);
  const proposals = Array.isArray(j.proposals) ? j.proposals : [];
  const declined = Array.isArray(j.declined) ? j.declined : [];

  const minRuns = cfg?.evolve?.minRuns ?? 3;
  const shortlist = evolveShortlistCodes(root, cfg, minRuns);
  const ignored = shortlist.filter((c) => !considered.has(c));
  if (ignored.length) {
    return {
      ok: false,
      detail: `shortlisted but never considered: ${ignored.join(", ")}. Deciding to do nothing is a decline, not an omission.`,
    };
  }

  // A decline has to say what it declined, or the arithmetic below is satisfied
  // by any array of the right length — `declined: [1,2,3]` used to pass.
  const badDeclines = declined.filter((d) => !d || typeof d !== "object" || !d.code || !d.why);
  if (badDeclines.length) {
    return {
      ok: false,
      detail: `${badDeclines.length} decline(s) lack a code and a reason; a decline must name what it declined`,
    };
  }
  const declinedCodes = new Set(declined.map((d) => d.code));
  if (declinedCodes.size !== declined.length) {
    return { ok: false, detail: "the same code was declined more than once" };
  }
  const strayDeclines = [...declinedCodes].filter((c) => !considered.has(c));
  if (strayDeclines.length) {
    return { ok: false, detail: `declined codes that were never considered: ${strayDeclines.join(", ")}` };
  }

  if (considered.size !== proposals.length + declined.length) {
    return {
      ok: false,
      detail:
        `${considered.size} code(s) considered but ${proposals.length} proposal(s) + ` +
        `${declined.length} decline(s) accounts for ${proposals.length + declined.length}`,
    };
  }

  // A proposal is a file writeProposal made, in the place it makes them. Any
  // readable path used to count: `proposals: ["references/CODES.md"]` passed.
  const badProposals = [];
  for (const p of proposals) {
    const n = evolve.normaliseTarget(p);
    if (!n.ok) { badProposals.push(`${p} (${n.reason})`); continue; }
    if (!n.rel.startsWith("evolution/proposals/") || !n.rel.endsWith(".md")) {
      badProposals.push(`${p} (not a proposal under evolution/proposals/)`);
      continue;
    }
    if (!fs.existsSync(path.resolve(root, n.rel))) badProposals.push(`${p} (does not exist)`);
  }
  if (badProposals.length) {
    return { ok: false, detail: `evolve.json names things that are not written proposals: ${badProposals.join(", ")}` };
  }

  return {
    ok: true,
    detail: `${considered.size} pattern(s) accounted for; ${proposals.length} proposal(s), ${declined.length} declined`,
  };
}

/**
 * Exactly the codes the stage was shown — same builder, same cap.
 *
 * This used to enumerate the whole shortlist while the contract fed the stage
 * `--json --top N`. With more than N actionable patterns the stage was required
 * to account for codes it could not see, and could never pass. Both now call
 * evolve.shortlist(), so a cap change cannot desynchronise them again.
 */
export const EVOLVE_TOP = 5;

function evolveShortlistCodes(root, cfg, minRuns) {
  return evolve.shortlist(root, cfg, { minRuns, top: EVOLVE_TOP }).map((r) => r.code);
}

/** Thin seam so the stage table does not import friction.mjs directly. */
function assertedFriction(root, cfg, { run, stage }) {
  return friction.assertedFor(root, cfg ?? { paths: { state: ".trellis" } }, { run, stage });
}

// ------------------------------------------------------------------- spawning

const RETRYABLE = [
  /rate.?limit/i,
  /\b429\b/,
  /quota/i,
  /usage limit/i,
  /overloaded/i,
  /\b529\b/,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN/,
];

export function isRetryable(text = "") {
  return RETRYABLE.some((re) => re.test(text));
}

// Runs one headless Claude Code session and returns structured metadata.
// Never throws on a failed session — the driver decides what a failure means.
// Windows resolves a globally-installed npm CLI's bare name (the shape
// `driver.command` is in — "claude", not "claude.cmd") to a `.cmd`/`.ps1`
// shim trio, and Node's own CVE-2024-27980 fix refuses to exec a `.cmd`/
// `.bat` directly with `shell:false` (throws EINVAL, synchronously, before
// any listener attaches) — the bare name alone fares no better, since
// `spawn` does not do PATHEXT resolution itself and just reports ENOENT.
// `shell:true` is the fix `kit/lib/gate.mjs`'s `exec()` already uses for the
// identical reason ("npm test -- foo and Windows .cmd shims both work"),
// but that call passes one pre-assembled command STRING; this one passes an
// `args` ARRAY, and `shell:true` on Windows joins array elements with plain
// spaces and does not escape them (Node's own DEP0190 warning) — a
// multi-word `stage.prompt` would otherwise arrive at the child torn into
// several argv entries instead of one. Quoting each element restores the
// argv boundaries `shell:false` gave for free. Every element here is either
// a hardcoded `STAGES[].prompt` or operator-set config
// (driver.command/model/permissionMode), never runtime or model output, so
// shell-metacharacter injection is not the risk this addresses — argv
// corruption is.
//
// POSIX shims are shebang scripts the kernel already execs correctly under
// `shell:false`; `shell:true` there would only inherit the unescaped-concat
// caveat above for no benefit, so this is gated to win32 specifically.
const IS_WINDOWS = process.platform === "win32";
function winQuote(a) {
  return `"${String(a).replace(/"/g, '""')}"`;
}

export function runSession(root, stage, cfg) {
  return new Promise((resolve) => {
    const args = [
      "-p", stage.prompt,
      "--output-format", "json",
      "--max-turns", String(cfg.driver.maxTurns),
    ];
    if (cfg.driver.permissionMode) args.push("--permission-mode", cfg.driver.permissionMode);
    if (cfg.driver.model) args.push("--model", cfg.driver.model);

    let child;
    try {
      // The executable itself needs the same quoting as `args` when
      // shell:true is in play — confirmed empirically: spawn(command, args,
      // {shell:true}) on Windows concatenates `command` and `args` into one
      // command line for cmd.exe the same unescaped way, so a driver.command
      // resolving to a path containing a space ("C:\Program Files\...", or a
      // Windows username with a space in it) silently fails to launch
      // without this — a bare word like "claude" still resolves via PATH
      // fine when quoted, so this is unconditional on win32, not narrowed to
      // "only when it has a space".
      const command = IS_WINDOWS ? winQuote(cfg.driver.command) : cfg.driver.command;
      child = spawn(command, IS_WINDOWS ? args.map(winQuote) : args, {
        cwd: root,
        // TRELLIS_STAGE lets a command know which stage invoked it without the
        // session having to say so. `trellis propose` uses it to decide that a
        // proposal is model-authored and must wait for a human — a decision that
        // was previously made by a CLI flag the session was merely asked to pass,
        // i.e. attested by exactly the party it constrains.
        env: { ...process.env, TRELLIS_STAGE: stage.id },
        stdio: ["ignore", "pipe", "pipe"],
        shell: IS_WINDOWS,
        // See killTree's docblock in proc.mjs: on Windows, `shell:true` above
        // makes `child` the cmd.exe wrapping the actual session, and a plain
        // kill of just that process orphans the session underneath it,
        // holding these very stdio pipes open forever. `detached` is a
        // POSIX-only flag (a harmless no-op key on Windows) that lets
        // killTree signal the whole process group there instead of just one
        // process — on POSIX there's no shell in the way today, so this is
        // pure hardening against a claude-code invocation that spawns its
        // own children, not a currently-confirmed live bug on that platform.
        detached: DETACH_FOR_TREE_KILL,
      });
    } catch (e) {
      // A synchronous throw (the pre-shell:true EINVAL case, and anything
      // else spawn can throw before it ever hands back a child) used to
      // escape this Promise's executor and reject it outright — losing the
      // `spawnFailed` shape `cli.mjs` matches on for its "Is Claude Code on
      // PATH?" hint, and surfacing as a bare, unhelpful thrown error instead.
      resolve({ exitCode: -1, costUsd: 0, raw: "", stderr: String(e.message), spawnFailed: true });
      return;
    }

    let out = "";
    let err = "";
    // Per-stream decoders, not the implicit `d.toString()` a bare `out += d`
    // coercion does per chunk: a multi-byte UTF-8 character in the session's
    // JSON output landing on a pipe chunk boundary decoded each half
    // independently to U+FFFD, so `JSON.parse(out)` below could throw on
    // perfectly well-formed JSON whose only fault was arriving in two reads —
    // silently recorded as costUsd:0/sessionId:null via the bare catch, not
    // as the parse failure it actually was. See gate.mjs's exec() for the
    // identical fix and reasoning.
    const outDecoder = new TextDecoder("utf-8");
    const errDecoder = new TextDecoder("utf-8");
    child.stdout.on("data", (d) => (out += outDecoder.decode(d, { stream: true })));
    child.stderr.on("data", (d) => (err += errDecoder.decode(d, { stream: true })));

    // A plain SIGTERM used to be the whole timeout mechanism: on Windows this
    // signals only the cmd.exe wrapper (see the spawn options above), and even
    // where it does reach the real process directly (POSIX today), SIGTERM is
    // a request the target can ignore — exactly the wedged-session case this
    // timeout exists to end. killTree() forces the issue: SIGKILL on the whole
    // process group on POSIX, `taskkill /T /F` walking the real process tree
    // on Windows. gate.mjs's exec() reaches the identical conclusion for the
    // identical reason.
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; killTree(child); }, cfg.driver.sessionTimeoutMs);

    child.on("error", (e) =>
      resolve({ exitCode: -1, costUsd: 0, raw: "", stderr: String(e.message), spawnFailed: true })
    );

    child.on("close", (code) => {
      clearTimeout(killer);
      // Flush whatever a decoder is still holding — at most 3 bytes of a
      // not-yet-complete UTF-8 sequence — before JSON.parse ever sees `out`.
      out += outDecoder.decode();
      err += errDecoder.decode();
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* text before json, or truncated */ }
      resolve({
        exitCode: code,
        timedOut,
        costUsd: parsed?.total_cost_usd ?? parsed?.cost?.total_cost ?? 0,
        sessionId: parsed?.session_id ?? null,
        durationMs: parsed?.duration_ms ?? null,
        numTurns: parsed?.num_turns ?? null,
        raw: out,
        stderr: err,
      });
    });
  });
}

// ------------------------------------------------------------- session ledger

// Actual cost per stage across runs. After a dozen runs this is a real
// distribution, which beats asking a model to estimate its own consumption.
export function recordSession(root, cfg, entry) {
  const p = path.resolve(root, statePath(cfg, "sessions.jsonl"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function sessionStats(root, cfg) {
  const p = path.resolve(root, statePath(cfg, "sessions.jsonl"));
  if (!fs.existsSync(p)) return {};
  const rows = parseJsonl(fs.readFileSync(p, "utf8")).filter(Boolean);

  const by = {};
  for (const r of rows) {
    (by[r.stage] ??= []).push(r.costUsd ?? 0);
  }
  const out = {};
  for (const [stage, costs] of Object.entries(by)) {
    const sorted = costs.slice().sort((a, b) => a - b);
    out[stage] = {
      runs: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0,
    };
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
