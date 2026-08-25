import fs from "node:fs";
import path from "node:path";
import { PASSED_GATE } from "./state.mjs";

/**
 * The ledger is the only thing in Trellis that survives a run.
 *
 * state.json remembers what happened; the ledger remembers what *tends* to
 * happen. Without it every run repeats the previous run's mistakes — failure
 * mode 4, the agent forgets everything between runs.
 *
 * Append-only JSONL, one record per node per run. Never rewritten.
 */

// Tolerates a missing cfg the way every other path helper here does. A caller
// that forgot to thread it (kit/bench/run.mjs did) should read the default
// location, not crash the verify predicate that called it.
export function ledgerPath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "ledger.jsonl");
}

export function append(root, cfg, records) {
  if (!records.length) return null;
  const p = ledgerPath(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

export function read(root, cfg) {
  const p = ledgerPath(root, cfg);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Build the per-node records for a finished run. */
export function recordsFor(state, nodes) {
  const out = [];
  for (const [id, s] of Object.entries(state.nodes)) {
    const n = nodes.get(id);
    if (!n) continue;

    // Per-tier breakdown is what makes the ledger usable for routing. Without
    // it, "this node landed on mid" says nothing about whether cheap was worth
    // trying at all.
    const byTier = {};
    for (const a of s.attempts || []) {
      const t = (byTier[a.tier] ||= { attempts: 0, landed: false, kinds: [] });
      t.attempts++;
      if (a.ok) t.landed = true;
      else t.kinds.push(a.kind);
    }

    const usage = (s.attempts || []).reduce(
      (acc, x) => ({
        prompt: acc.prompt + (x.usage?.prompt_tokens || 0),
        completion: acc.completion + (x.usage?.completion_tokens || 0),
        ms: acc.ms + (x.ms || 0),
      }),
      { prompt: 0, completion: 0, ms: 0 }
    );

    out.push({
      ts: new Date().toISOString(),
      runId: state.runId,
      project: state.project,
      nodeId: id,
      role: n.role,
      risk: n.risk,
      tags: (n.tags || []).length ? n.tags : ["__untagged"],
      depCount: (n.deps || []).length,
      writeCount: (n.write || []).length,
      testCount: (n.tests || []).length,
      mutationCount: (n.mutations || []).length,
      status: s.status,
      landedTier: PASSED_GATE.has(s.status) ? s.tier : null,
      attempts: (s.attempts || []).length,
      attemptsByTier: byTier,
      failureKinds: (s.attempts || []).filter((a) => !a.ok).map((a) => a.kind),
      survivingMutations: (s.survivingMutations || []).length,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      workerMs: usage.ms,
    });
  }
  return out;
}

/**
 * Success rate per (tag, tier), Laplace-smoothed.
 *
 * A tier "succeeded" for a node if it landed it, and "failed" if the node moved
 * past it to a stronger tier or exhausted. A tier never reached is not counted —
 * that asymmetry matters, because the ladder means stronger tiers are only ever
 * observed on nodes that already proved hard.
 */
export function tierStats(records, { alpha = 1, beta = 2 } = {}) {
  const byKey = new Map();
  for (const r of records) {
    // One node observed once is ONE observation, however many tags it carries.
    // Keeping identities lets callers pool across tags by union rather than by
    // sum — summing would turn a three-tag node into three data points and
    // manufacture confidence that does not exist.
    const identity = `${r.runId}|${r.nodeId}`;
    for (const [tier, t] of Object.entries(r.attemptsByTier || {})) {
      for (const tag of r.tags || ["__untagged"]) {
        const k = `${tag}|${tier}`;
        const s = byKey.get(k) || { nodes: new Set(), landedNodes: new Set(), attempts: 0 };
        s.nodes.add(identity);
        s.attempts += t.attempts;
        if (t.landed) s.landedNodes.add(identity);
        byKey.set(k, s);
      }
    }
  }
  for (const s of byKey.values()) {
    s.seen = s.nodes.size;
    s.landed = s.landedNodes.size;
    s.rate = (s.landed + alpha) / (s.seen + alpha + beta);
    s.avgAttempts = s.seen ? s.attempts / s.seen : 0;
  }
  return byKey;
}

/** Human-facing rollup for `trellis ledger`. */
export function summarise(records) {
  const byTag = new Map();
  for (const r of records) {
    for (const tag of r.tags || ["__untagged"]) {
      const s = byTag.get(tag) || { nodes: 0, landed: 0, attempts: 0, tiers: {}, kinds: {}, tokens: 0 };
      s.nodes++;
      s.attempts += r.attempts || 0;
      s.tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      if (r.landedTier) {
        s.landed++;
        s.tiers[r.landedTier] = (s.tiers[r.landedTier] || 0) + 1;
      }
      for (const k of r.failureKinds || []) s.kinds[k] = (s.kinds[k] || 0) + 1;
      byTag.set(tag, s);
    }
  }
  return byTag;
}
