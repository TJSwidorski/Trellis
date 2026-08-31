// Held-out acceptance scoring for the A/B harness, plus Arm B's self-grade.
//
// This file SHELLS OUT to a test suite that lives in another repo entirely —
// the held-out acceptance suite that NEITHER arm is allowed to see. `npm test`
// for this repo is fully offline and stays that way, so nothing on that path
// (kit/selftest/*, kit/regression/*) imports this module. Its only importer is
// kit/bench/run.mjs, which `npm test` never loads.
//
// Everything here returns null rather than throwing when its input is missing.
// By the time scoring runs, a real A/B has already spent a subscription
// window; a parsing miss or an absent suite should degrade section 4 of the
// report to "—", not lose the run.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LANDED, PASSED_GATE } from "../lib/state.mjs";

const round = (n) => Number(n.toFixed(3));

/**
 * Parse a pass/total pair out of a test runner's summary text.
 *
 * Tolerant by design: the held-out suite is authored independently from the
 * arms and could be any of the common runners. Recognised, in priority order:
 *
 *   node:test   "# pass 33" + ("# tests 188" | "# fail 155")
 *   mocha/jest  "33 passing" + optional "155 failing"
 *   bare TAP    "1..188" plan with "ok" / "not ok" lines
 *
 * Returns { pass, total, passRate } (passRate in 0..1), or null when nothing
 * parses.
 */
export function parseSuiteTotals(text) {
  const s = String(text);

  // node:test's TAP-ish trailer.
  const np = /^# pass (\d+)$/m.exec(s);
  const nf = /^# fail (\d+)$/m.exec(s);
  const nt = /^# tests (\d+)$/m.exec(s);
  if (np && (nt || nf)) {
    const pass = Number(np[1]);
    const total = nt ? Number(nt[1]) : pass + Number(nf[1]);
    if (total > 0) return { pass, total, passRate: round(pass / total) };
  }

  // mocha / jest.
  const mp = /(\d+) passing/.exec(s);
  if (mp) {
    const mf = /(\d+) failing/.exec(s);
    const pass = Number(mp[1]);
    const fail = mf ? Number(mf[1]) : 0;
    const total = pass + fail;
    if (total > 0) return { pass, total, passRate: round(pass / total) };
  }

  // Bare TAP.
  const plan = /^1\.\.(\d+)$/m.exec(s);
  if (plan) {
    const total = Number(plan[1]);
    const ok = (s.match(/^ok /gm) || []).length;
    const notOk = (s.match(/^not ok /gm) || []).length;
    if (total > 0 && ok + notOk > 0) return { pass: ok, total, passRate: round(ok / total) };
  }

  return null;
}

/**
 * Run the held-out acceptance suite against one arm's built repo.
 *
 * Invoked exactly as prompts.json's `scoring.invoke` documents: from the suite
 * directory, with SCAN_CMD pointing at the arm's entrypoint. Returns
 * { pass, total, passRate, scanCmd } or null when the suite is absent or its
 * output does not parse.
 */
export function scoreHeldOut(armRepoDir, {
  suitePath,
  scanEntrypoint = "bin/scan.mjs",
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  if (!suitePath || !fs.existsSync(suitePath)) return null;
  const scanCmd = `node ${path.join(armRepoDir, scanEntrypoint)}`;
  const r = spawnSync("npm", ["test", "--silent"], {
    cwd: suitePath,
    env: { ...process.env, SCAN_CMD: scanCmd },
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: timeoutMs,
  });
  const parsed = parseSuiteTotals(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  return parsed ? { ...parsed, scanCmd } : null;
}

/**
 * Arm B's own gate results, read from its .trellis/state.json.
 *
 * `mergedNodes` is compare()'s denominator for every per-node figure.
 * `passRate` feeds the self-grade gap — Arm B's own pass rate minus its
 * held-out pass rate — which is the single most informative number the
 * experiment produces. Returns null when there is no state to read.
 */
export function armSelfGrade(armRepoDir, { stateRel = ".trellis/state.json" } = {}) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(armRepoDir, stateRel), "utf8"));
  } catch {
    return null;
  }
  const nodes = Object.values(state.nodes ?? {});
  if (!nodes.length) return null;
  const attempted = nodes.filter((n) => (n.attempts ?? []).length > 0).length;
  const passed = nodes.filter((n) => PASSED_GATE.has(n.status)).length;
  return {
    mergedNodes: nodes.filter((n) => LANDED.has(n.status)).length,
    passRate: attempted ? round(passed / attempted) : null,
  };
}
