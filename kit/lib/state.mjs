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

export function initState(root, cfg, graph, { runId } = {}) {
  const s = {
    runId: runId ?? crypto.randomUUID(),
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
      // What this node's contract said when it was built, so a later resume can
      // tell which nodes actually changed instead of discarding the whole run
      // — including a test file whose CONTENT changed with its path unchanged.
      hash: nodeHash(n, { root }),
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

/**
 * Digest of what a node's frozen tests actually SAY, not just which files they
 * are. REPORT.md's own advice for a weak-tests node is "strengthen `<tests>`
 * until each mutant fails, then re-run" — an instruction the hash could not
 * see before this, because it hashed the test PATHS. A --resume kept the node
 * proven against the old, weaker test forever; the system printed an
 * instruction and then ignored the exact thing that instruction asked for.
 *
 * Sorted so file order in `node.tests` cannot change the digest independent
 * of content. A missing file gets a literal marker rather than being
 * skipped — a test that used to exist and now does not is itself a change
 * worth rebuilding over, not a silent no-op in the digest.
 */
export function testsDigest(root, node) {
  const paths = [...(node.tests ?? [])].sort();
  const parts = paths.map((rel) => {
    try {
      return `${rel}:${fs.readFileSync(path.join(root, rel), "utf8")}`;
    } catch {
      return `${rel}:__missing__`;
    }
  });
  return crypto.createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 16);
}

/**
 * A hash of the fields that determine what a worker is asked to do.
 *
 * Deliberately not the whole node: `title` and `tags` change nothing about the
 * work, and a run should not be discarded because someone fixed a typo in a
 * title. Everything a worker sees or is graded against is included.
 *
 * `root` is optional and changes nothing when absent — kit/regression/run.mjs
 * (PROTECTED) calls `nodeHash(base)` with no root at all, so that shape must
 * keep meaning exactly what it always has.
 */
export function nodeHash(node, { root } = {}) {
  const material = JSON.stringify([
    node.goal ?? null, node.acceptance ?? null, node.notes ?? null, node.role ?? null,
    [...(node.write ?? [])].sort(), [...(node.read ?? [])].sort(),
    [...(node.tests ?? [])].sort(), node.gate ?? null,
    [...(node.deps ?? [])].sort(), [...(node.mutations ?? [])].sort(),
    root ? testsDigest(root, node) : null,
  ]);
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Which nodes a resume may keep, and which must be rebuilt.
 *
 * The old rule was all-or-nothing on a hash of the entire graph FILE: change one
 * node's contract and every merged node in the run went back to pending and was
 * rebuilt from scratch. Real money, silently, behind a single log.warn — and
 * `trellis reject` explicitly told you to edit a contract and then --resume,
 * which is exactly the sequence that triggered it.
 *
 * A node is rebuilt if its own contract changed, or if anything it depends on
 * did. The second half matters: a node built against an old version of its
 * dependency was proven against something that no longer exists.
 */
export function resumePlan(state, graph, { root } = {}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const dirty = new Set();

  for (const n of graph.nodes) {
    const prior = state.nodes?.[n.id];
    if (!prior || prior.hash !== nodeHash(n, { root })) dirty.add(n.id);
  }
  // Propagate to dependants until it settles.
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of graph.nodes) {
      if (dirty.has(n.id)) continue;
      if ((n.deps ?? []).some((d) => dirty.has(d))) { dirty.add(n.id); changed = true; }
    }
  }

  const gone = Object.keys(state.nodes ?? {}).filter((id) => !byId.has(id));
  const keep = graph.nodes.map((n) => n.id).filter((id) => !dirty.has(id));
  return { dirty: [...dirty], keep, gone };
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
