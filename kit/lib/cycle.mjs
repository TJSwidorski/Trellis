// The unit "distinct run" is supposed to mean: slice, build, triage, once.
//
// Before this file existed, `runId` never rolled across a second pass at the
// same product graph. `resumeOrInit` preserves it on resume (correct — a
// resume within one pass IS one run) and even across a graph edit mid-pass
// (also correct — a contract fix within a pass is not a new pass). But
// nothing ever minted a NEW id when the operator came back and cut a second
// slice, because nothing distinguished "still working on this pass" from
// "starting the next one". Two consequences, both silent:
//
//   - Every threshold in evolve.mjs and friction.mjs counts "distinct runs".
//     Two real passes at the graph, weeks apart, counted as one observation.
//   - The stage-06/07 verify predicates compare an artifact's stamped `run`
//     against `currentRunId(root)`. Since that never changed, a stage that
//     was satisfied by pass 1's artifacts stayed "satisfied" forever — a
//     second `trellis auto` printed six "already satisfied, skipping" lines
//     and exited, having done nothing.
//
// `.trellis/cycle.json` is the one place a NEW pass is deliberately declared,
// and `runId` is minted from it. Nothing else needed to change: every
// existing run-stamp check inherits the fix by depending on `state.runId`,
// which is exactly the coupling worth having.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJsonOrNull } from "./paths.mjs";

export function cyclePath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "cycle.json");
}

export function currentCycle(root, cfg) {
  return readJsonOrNull(cyclePath(root, cfg));
}

/**
 * Declare a new pass. This is the only place `cycle` increments and the only
 * place a fresh `id` is minted — deliberately not automatic on every `run`,
 * because "am I continuing what I was doing, or starting over" is exactly the
 * distinction the whole file exists to make honest.
 */
export function beginCycle(root, cfg, { version = "v1", builtBefore = [] } = {}) {
  const prior = currentCycle(root, cfg);
  const cycle = {
    cycle: (prior?.cycle ?? 0) + 1,
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    version,
    builtBefore,
  };
  const p = cyclePath(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cycle, null, 2) + "\n");
  return cycle;
}

/**
 * The id a fresh `state.json` should be minted with: the current cycle's, or
 * a brand new cycle 1 if the operator never ran `trellis cycle` and just
 * typed `trellis run` — plain manual use must keep working without requiring
 * a new command first.
 */
export function cycleIdFor(root, cfg) {
  return (currentCycle(root, cfg) ?? beginCycle(root, cfg, {})).id;
}
