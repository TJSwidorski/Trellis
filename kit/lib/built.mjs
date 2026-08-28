// Which nodes are done, derived rather than hand-authored.
//
// Before this file existed, .trellis/built.json was written by NOBODY in the
// kit — one read (cmdSlice), zero writes, and the 06_triage contract asked the
// orchestrator to hand-write it. Two failure modes followed directly:
//
//   - A node that landed but was never listed got re-planned from scratch —
//     the runner would attempt work already sitting on the base branch.
//   - A node listed but not actually landed (a stale entry, a typo, a session
//     that wrote the file before finishing) was skipped forever, regardless
//     of its real status.
//
// The fix is not "remember to write it correctly" — it is to stop writing it
// by hand at all. Everything nextSlice needs to know is already recorded
// somewhere more trustworthy than a model's memory of what happened.

import fs from "node:fs";
import path from "node:path";
import * as ledger from "./ledger.mjs";
import * as st from "./state.mjs";

export function builtPath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "built.json");
}

function manualPath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "built.manual.json");
}

/**
 * Which nodes count as built, in order of trust.
 *
 *   1. The ledger — "the only thing in Trellis that survives a run" (its own
 *      docblock), one record per node per run, already carrying `status`.
 *   2. The CURRENT run's state.json, for nodes that landed but have not been
 *      appended to the ledger yet (the append happens at triage, not at
 *      merge — see cmdRun/cmdAuto).
 *   3. .trellis/built.manual.json, the one hand-authored input left, and it
 *      is additive-only: a human asserting "count this as done" for a case
 *      the mechanical sources cannot see (an out-of-band merge, a node built
 *      before this file existed). Never subtractive — there is no manual way
 *      to un-build a node; that is what `trellis reject` is for.
 */
export function builtNodes(root, cfg) {
  const ids = new Set();

  for (const rec of ledger.read(root, cfg)) {
    if (st.LANDED.has(rec.status)) ids.add(rec.nodeId);
  }

  const state = st.loadState(root, cfg);
  if (state) {
    for (const [id, s] of Object.entries(state.nodes ?? {})) {
      if (st.LANDED.has(s.status)) ids.add(id);
    }
  }

  const mp = manualPath(root, cfg);
  if (fs.existsSync(mp)) {
    try {
      const manual = JSON.parse(fs.readFileSync(mp, "utf8"));
      for (const id of manual.nodes ?? []) ids.add(id);
    } catch { /* a malformed manual file adds nothing rather than crashing slice */ }
  }

  return [...ids].sort();
}

/** Write the derived cache, and report what changed since the last write. */
export function writeBuilt(root, cfg) {
  const p = builtPath(root, cfg);
  const before = fs.existsSync(p)
    ? (() => { try { return JSON.parse(fs.readFileSync(p, "utf8")).nodes ?? []; } catch { return []; } })()
    : [];
  const nodes = builtNodes(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), nodes }, null, 2) + "\n");
  const beforeSet = new Set(before);
  const added = nodes.filter((id) => !beforeSet.has(id));
  const nodesSet = new Set(nodes);
  const removed = before.filter((id) => !nodesSet.has(id));
  return { nodes, added, removed };
}
