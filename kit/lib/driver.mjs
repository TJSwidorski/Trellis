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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as friction from "./friction.mjs";
import * as evolve from "./evolve.mjs";

// --------------------------------------------------------------- stage table

// Each stage: the prompt that starts it, and the mechanical proof it finished.
// `verify` returns { ok, detail }. It reads disk. It does not read stdout.
export const STAGES = [
  {
    id: "01_ingest",
    prompt: "Read sessions/01_ingest/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root) => artifactExists(root, ".trellis/ingest.json", (j) => j.errors?.length === 0),
  },
  {
    id: "02_slice",
    prompt: "Read sessions/02_slice/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root) => artifactExists(root, ".trellis/plan.json", (j) => Array.isArray(j.nodes) && j.nodes.length > 0),
  },
  {
    id: "03_cases",
    prompt: "Read sessions/03_cases/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root) => casesCoverPlan(root),
  },
  {
    id: "04_tests",
    prompt: "Read sessions/04_tests/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => testsExistAndAreNonVacuous(root, cfg),
  },
  {
    id: "05_build",
    prompt: null, // no model: the deterministic runner owns this stage
    run: "runner",
    verify: (root) => artifactExists(root, ".trellis/REPORT.md"),
  },
  {
    id: "06_triage",
    prompt: "Read sessions/06_triage/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => triageRecordedEvidence(root, cfg),
  },
  {
    id: "07_evolve",
    // Not in the default chain. Evolution should run rarely and deliberately —
    // every pass costs an expensive session, and the evidence it reads only
    // changes across many runs. `trellis auto --stage 07_evolve` reaches it.
    periodic: true,
    prompt: "Read sessions/07_evolve/CONTEXT.md and do exactly what it says. Nothing else.",
    verify: (root, cfg) => evolveConsideredEverything(root, cfg),
  },
];

/** Stages that run on an ordinary `trellis auto`. */
export const DEFAULT_CHAIN = STAGES.filter((s) => !s.periodic);

// -------------------------------------------------------------- verification

function readJson(root, rel) {
  const p = path.resolve(root, rel);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
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

// The cases file must have an entry for every node in the plan. A session that
// died halfway leaves a well-formed file covering the first eight nodes; this is
// the check that catches it.
function casesCoverPlan(root) {
  const plan = readJson(root, ".trellis/plan.json");
  const cases = readJson(root, ".trellis/cases.json");
  if (!plan) return { ok: false, detail: "plan.json missing" };
  if (!cases) return { ok: false, detail: "cases.json missing or unparseable" };
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
  const graph = readJson(root, ".trellis/graph.json");
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
export function currentRunId(root) {
  return readJson(root, ".trellis/state.json")?.runId ?? null;
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
  const base = artifactExists(root, ".trellis/triage.json", (j) => Array.isArray(j.decisions));
  if (!base.ok) return base;

  const run = currentRunId(root);
  if (!run) return { ok: false, detail: "state.json has no runId to attribute triage to" };

  const rows = jsonlRowsForRun(root, ".trellis/triage.jsonl", run);
  if (rows === null) return { ok: false, detail: ".trellis/triage.jsonl was not written" };
  if (!rows.length) {
    return { ok: false, detail: `.trellis/triage.jsonl has no line stamped run "${run}"` };
  }
  const decisions = rows.flatMap((r) => (Array.isArray(r.decisions) ? r.decisions : []));
  if (!decisions.length) {
    return { ok: false, detail: `.trellis/triage.jsonl line for run "${run}" carries no decisions` };
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
 * The evolve stage must account for every pattern it was shown.
 *
 * Stage 06's rule, transplanted: silence on a stuck node is not acceptance, and
 * silence on a shortlisted pattern is not a decline. Without this a pass can
 * quietly ignore the evidence it would rather not act on, and every artifact it
 * leaves behind still looks complete.
 */
function evolveConsideredEverything(root, cfg) {
  const base = artifactExists(root, ".trellis/evolve.json", (j) => Array.isArray(j.consideredCodes));
  if (!base.ok) return base;

  const j = readJson(root, ".trellis/evolve.json");

  // Attribute the artifact to this run, the way triage is attributed. Without
  // it a stale evolve.json from an earlier pass satisfies the stage forever —
  // and cmdAuto pre-checks verify and skips, so the stage would never run again.
  const run = currentRunId(root);
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
export function runSession(root, stage, cfg) {
  return new Promise((resolve) => {
    const args = [
      "-p", stage.prompt,
      "--output-format", "json",
      "--max-turns", String(cfg.driver.maxTurns),
    ];
    if (cfg.driver.permissionMode) args.push("--permission-mode", cfg.driver.permissionMode);
    if (cfg.driver.model) args.push("--model", cfg.driver.model);

    const child = spawn(cfg.driver.command, args, {
      cwd: root,
      // TRELLIS_STAGE lets a command know which stage invoked it without the
      // session having to say so. `trellis propose` uses it to decide that a
      // proposal is model-authored and must wait for a human — a decision that
      // was previously made by a CLI flag the session was merely asked to pass,
      // i.e. attested by exactly the party it constrains.
      env: { ...process.env, TRELLIS_STAGE: stage.id },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const killer = setTimeout(() => child.kill("SIGTERM"), cfg.driver.sessionTimeoutMs);

    child.on("error", (e) =>
      resolve({ exitCode: -1, costUsd: 0, raw: "", stderr: String(e.message), spawnFailed: true })
    );

    child.on("close", (code) => {
      clearTimeout(killer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* text before json, or truncated */ }
      resolve({
        exitCode: code,
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
export function recordSession(root, entry) {
  const dir = path.resolve(root, ".trellis");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "sessions.jsonl");
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function sessionStats(root) {
  const p = path.resolve(root, ".trellis/sessions.jsonl");
  if (!fs.existsSync(p)) return {};
  const rows = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

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
