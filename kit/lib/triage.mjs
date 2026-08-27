// The triage record: what happened to each node the orchestrator reviewed
// this run, in a form self-improvement can count.
//
// sessions/06_triage/CONTEXT.md used to tell the orchestrator to append the
// cross-run JSONL line BY HAND, including the `run` field copied out of
// state.json. evolve.mjs's rejectionCounts dedups on `row.run`, and the
// driver's stage verify only checked that AT LEAST ONE row carried the
// current runId — so three hand-typed lines reading `run: "a"`, `"b"`, `"c"`
// in a single session cleared `minRuns: 3` on their own.
//
// friction.mjs already solved exactly this problem, for exactly the same
// reason: stamp `run` in code so it is not attested by the party it
// constrains. This mirrors that module's shape rather than inventing a
// second pattern for the same evidence discipline.

import fs from "node:fs";
import path from "node:path";
import { triagePath as jsonlPath } from "./evolve.mjs";

/** The closed set of verdicts a triage decision may carry. */
export const VERDICTS = Object.freeze(new Set(["reject", "accept", "hold", "take"]));

export function summaryPath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "triage.json");
}

/**
 * Validate a decision before it is written.
 *
 * Note what is NOT checked: whether the verdict was the right call. This
 * rejects decisions that cannot be counted — no node named, an unknown
 * verdict, a reject with no code — and nothing else.
 */
export function validate(dec) {
  const errors = [];
  if (!dec || typeof dec !== "object") return ["not an object"];
  if (!dec.node) errors.push("node is required — a decision naming no node cannot be counted");
  if (!VERDICTS.has(dec.verdict)) {
    errors.push(`verdict "${dec.verdict}" is not one of: ${[...VERDICTS].join(", ")}`);
  }
  if (dec.verdict === "reject" && !dec.code) {
    errors.push("code is required for a reject verdict — prose here means self-improvement learns nothing");
  }
  if (!dec.reason) errors.push("reason is required — a decision with no reason cannot be reviewed later");
  return errors;
}

/**
 * Every decision this run's lines in triage.jsonl carry, in the order
 * written. triage.jsonl is the source of truth; nothing else is kept.
 */
export function readForRun(root, cfg, run) {
  const p = jsonlPath(root, cfg);
  if (!fs.existsSync(p)) return [];
  const decisions = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.run !== run || !Array.isArray(row.decisions)) continue;
    decisions.push(...row.decisions);
  }
  return decisions;
}

/**
 * Append one decision, stamping `ts` and `run` here rather than accepting
 * them — the whole reason this goes through code instead of a model
 * appending JSONL by hand. Also rewrites `.trellis/triage.json`, the per-run
 * summary the driver's stage verify and a human reading the run both use, as
 * a materialised view of this run's rows in triage.jsonl: the .jsonl file is
 * the one source of truth, so there is nothing to keep in sync separately
 * and nothing that can drift from it.
 */
export function append(root, cfg, dec, { run }) {
  const errors = validate(dec);
  if (errors.length) throw new Error(errors.join("; "));
  if (!run) throw new Error("no runId available to stamp this decision against");

  const row = {
    ts: new Date().toISOString(),
    run,
    decisions: [
      {
        node: dec.node,
        verdict: dec.verdict,
        ...(dec.code ? { code: dec.code } : {}),
        reason: dec.reason,
      },
    ],
  };

  const p = jsonlPath(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + "\n");

  const decisions = readForRun(root, cfg, run);
  fs.writeFileSync(summaryPath(root, cfg), JSON.stringify({ decisions }, null, 2) + "\n");

  return row.decisions[0];
}
