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
import { spawn } from "node:child_process";

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
    verify: (root) => testsExistAndAreNonVacuous(root),
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
    verify: (root) => triageRecordedEvidence(root),
  },
];

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
function testsExistAndAreNonVacuous(root) {
  const graph = readJson(root, ".trellis/graph.json");
  if (!graph) return { ok: false, detail: "graph.json missing" };
  const declared = graph.nodes.flatMap((n) => n.tests ?? []);
  if (!declared.length) return { ok: false, detail: "graph declares no test files" };
  const missing = [];
  const thin = [];
  for (const rel of declared) {
    const p = path.resolve(root, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    if (fs.statSync(p).size < 120) thin.push(rel);
  }
  if (missing.length) return { ok: false, detail: `${missing.length} test file(s) not written: ${missing.slice(0, 4).join(", ")}` };
  if (thin.length) return { ok: false, detail: `${thin.length} test file(s) suspiciously small: ${thin.slice(0, 4).join(", ")}` };
  return { ok: true, detail: `${declared.length} test files present (run verify-tests for non-vacuity)` };
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
function triageRecordedEvidence(root) {
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
  return { ok: true, detail: `triage.json + ${decisions.length} decision(s) recorded for run ${run}` };
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
      env: process.env,
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
