import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  MERGED: "merged",
  REVIEW: "review",
  CONFLICT: "conflict",
  EXHAUSTED: "exhausted",
  BLOCKED: "blocked",
  AUDIT: "audit",
  WEAK_TESTS: "weak-tests",
  BUDGET: "budget-stopped",
};

export const TERMINAL = new Set([
  STATUS.MERGED, STATUS.REVIEW, STATUS.AUDIT, STATUS.WEAK_TESTS,
  STATUS.CONFLICT, STATUS.EXHAUSTED, STATUS.BLOCKED,
]);

/** Statuses that count as the node having landed on the base branch. */
export const LANDED = new Set([STATUS.MERGED, STATUS.AUDIT, STATUS.WEAK_TESTS]);

/**
 * Statuses where a tier produced work that PASSED the gate. Wider than LANDED:
 * a `review` node passed and is merely awaiting a human, so the tier succeeded
 * even though nothing is on main yet. This is the right set for the ledger —
 * it measures the model, not the merge.
 */
export const PASSED_GATE = new Set([STATUS.MERGED, STATUS.AUDIT, STATUS.WEAK_TESTS, STATUS.REVIEW]);

export function statePath(root, cfg) {
  return path.join(root, cfg.paths.state, "state.json");
}

export function initState(root, cfg, graph) {
  const s = {
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    graphHash: graph.__hash,
    project: graph.project || cfg.project,
    baseBranch: cfg.baseBranch,
    nodes: {},
  };
  for (const n of graph.nodes) {
    s.nodes[n.id] = {
      status: STATUS.PENDING, attempts: [], tier: null, branch: null, reason: null,
      survivingMutations: [], routing: null,
    };
  }
  return s;
}

export function loadState(root, cfg) {
  const p = statePath(root, cfg);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export function saveState(root, cfg, state) {
  const p = statePath(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

export function resumable(state, graph) {
  return Boolean(state && state.graphHash === graph.__hash);
}

export function rollup(state) {
  const counts = {};
  for (const v of Object.values(state.nodes)) counts[v.status] = (counts[v.status] || 0) + 1;
  const total = Object.keys(state.nodes).length;
  const done = (counts[STATUS.MERGED] || 0) + (counts[STATUS.REVIEW] || 0) +
               (counts[STATUS.AUDIT] || 0) + (counts[STATUS.WEAK_TESTS] || 0);
  const stuck = (counts[STATUS.EXHAUSTED] || 0) + (counts[STATUS.BLOCKED] || 0) +
                (counts[STATUS.CONFLICT] || 0) + (counts[STATUS.BUDGET] || 0);
  return { counts, total, done, stuck };
}

/** Aggregate token usage across every attempt, per tier. */
export function usageByTier(state) {
  const out = {};
  for (const n of Object.values(state.nodes)) {
    for (const a of n.attempts || []) {
      const t = (out[a.tier] ||= { attempts: 0, prompt: 0, completion: 0 });
      t.attempts++;
      t.prompt += a.usage?.prompt_tokens || 0;
      t.completion += a.usage?.completion_tokens || 0;
    }
  }
  return out;
}
