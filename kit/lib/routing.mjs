import { tierStats } from "./ledger.mjs";

/**
 * Ledger-driven tier selection — the "Chief Optimization Officer" as arithmetic.
 *
 * The ladder is inherently ordered cheap to expensive, so the only decisions are
 * where to START and which tiers to SKIP. This does exactly that and nothing
 * more, because anything cleverer would be unexplainable and we could not tell
 * whether it was helping.
 *
 * Inert without data: with no ledger, or too few observations, it returns the
 * configured order unchanged. It gets better as the ledger fills and never
 * needs retraining.
 */
export function planTiers(cfg, node, records) {
  const routing = cfg.routing || {};
  const order = cfg.tiers;
  if (!routing.enabled || !records?.length) {
    return { tiers: order, reason: null };
  }

  const minObs = routing.minObservations ?? 5;
  const minRate = routing.minSuccessRate ?? 0.15;
  const stats = tierStats(records);
  const tags = (node.tags || []).length ? node.tags : ["__untagged"];

  // Pool observations across all of the node's tags.
  // Pool by UNION of node identities, never by summing counts. A node tagged
  // ["adapter","parser","csv"] is one observation, not three.
  const rateFor = (tierName) => {
    const seenNodes = new Set();
    const landedNodes = new Set();
    for (const tag of tags) {
      const s = stats.get(`${tag}|${tierName}`);
      if (!s) continue;
      for (const n of s.nodes) seenNodes.add(n);
      for (const n of s.landedNodes) landedNodes.add(n);
    }
    if (seenNodes.size < minObs) return null;
    return { rate: (landedNodes.size + 1) / (seenNodes.size + 3), seen: seenNodes.size };
  };

  const skipped = [];
  let start = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const r = rateFor(order[i].name);
    if (r && r.rate < minRate) {
      skipped.push(`${order[i].name} (${(r.rate * 100).toFixed(0)}% over ${r.seen})`);
      start = i + 1;
    } else {
      break; // only skip a contiguous cheap prefix; never skip in the middle
    }
  }

  if (!skipped.length) return { tiers: order, reason: null };
  return {
    tiers: order.slice(start),
    reason: `skipped ${skipped.join(", ")} — historically below ${(minRate * 100).toFixed(0)}% for tag(s) ${tags.join("+")}`,
  };
}

/** What `trellis ledger --routing` prints, so the decision is auditable. */
export function explain(cfg, records) {
  const stats = tierStats(records);
  const rows = [];
  for (const [key, s] of stats) {
    const [tag, tier] = key.split("|");
    rows.push({ tag, tier, seen: s.seen, landed: s.landed, rate: s.rate, avgAttempts: s.avgAttempts });
  }
  rows.sort((a, b) => a.tag.localeCompare(b.tag) || a.tier.localeCompare(b.tier));
  return rows;
}
