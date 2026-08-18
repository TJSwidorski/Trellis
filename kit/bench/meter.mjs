// Token and cost accounting for an A/B arm.
//
// Pure functions over `claude -p --output-format stream-json` records, so the
// whole thing is testable offline. The arms are driven identically; only the
// prompt differs. Anything that could favour one arm lives outside this file.
//
// The awkward truth this has to encode: the two arms are NOT commensurable at
// face value. Arm B spends Anthropic tokens on planning and OpenRouter tokens on
// implementation; Arm A spends only Anthropic tokens. A single "total cost" number
// hides the trade the system exists to make, so every total here stays split.

/**
 * Model prices, USD per 1M tokens. Worker tiers price themselves in the config.
 *
 * cacheWrite is 1.25x input (the 5-minute TTL rate; the 1-hour TTL is 2x) and
 * cacheRead is 0.1x input. Those multipliers matter more than they look: this
 * benchmark's first real run showed 7.8M cache-read tokens against 446 fresh
 * input, so pricing cache reads at the input rate would overstate cost by
 * roughly an order of magnitude.
 */
export const PRICES = {
  "claude-opus-5":     { input: 5.0,  output: 25.0, cacheWrite: 6.25,  cacheRead: 0.5  },
  "claude-opus-4-8":   { input: 5.0,  output: 25.0, cacheWrite: 6.25,  cacheRead: 0.5  },
  "claude-opus-4-5":   { input: 5.0,  output: 25.0, cacheWrite: 6.25,  cacheRead: 0.5  },
  "claude-sonnet-5":   { input: 3.0,  output: 15.0, cacheWrite: 3.75,  cacheRead: 0.3  },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0, cacheWrite: 3.75,  cacheRead: 0.3  },
  "claude-sonnet-4-5": { input: 3.0,  output: 15.0, cacheWrite: 3.75,  cacheRead: 0.3  },
  "claude-haiku-4-5":  { input: 1.0,  output: 5.0,  cacheWrite: 1.25,  cacheRead: 0.1  },
};

/**
 * Subscription window accounting — the OTHER currency.
 *
 * On a Max/Pro subscription dollars are not the binding constraint; the rolling
 * 5-hour usage window is. A run can cost $6 of notional API spend and still be
 * free, or cost $2 and cost you the rest of the day. Those are different
 * questions, so this file answers both and never collapses them.
 *
 * Two honest caveats, stated here rather than buried:
 *
 *  1. There is no API for remaining window quota. It is visible in the status bar
 *     of an interactive session and nowhere else. So this is a MODEL of the
 *     window, calibrated against observed readings, not a measurement of it.
 *  2. The weights below are the published *price* ratios, used as a stand-in for
 *     the unpublished *rate-limit* ratios. They are directionally right — cache
 *     reads are cheap, output is expensive — and wrong in detail.
 *
 * Recalibrate by running one real arm, reading the window percentage off an
 * interactive session immediately after, and setting `calibration` to that pair.
 * A single point is enough for a ratio; it is not enough for confidence.
 */
export const WINDOW = {
  windowMs: 5 * 60 * 60 * 1000,

  // Output is the expensive one; cache reads are nearly free. Same shape as the
  // price table above, deliberately — until a better source exists, price ratio
  // is the best available proxy for rate-limit ratio.
  weights: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },

  /**
   * Observed anchor. The first real Arm B run metered 1,773,798 weighted tokens
   * (446 in + 38,536 out + 641,724 cache-write + 7,785,168 cache-read) and was
   * reported as consuming roughly half a window. Hence ~3.5M weighted tokens per
   * window on Opus.
   *
   * This is ONE data point from a run that produced no artifacts, so treat it as
   * an order-of-magnitude anchor. Overwrite it after the next clean run.
   */
  calibration: {
    weightedTokens: 1_773_798,
    observedWindowPct: 0.50,
    model: "opus",
    source: "arm-b first real run, 2026-08-16 (declined-writes run)",
  },

  get budgetTokens() {
    return Math.round(this.calibration.weightedTokens / this.calibration.observedWindowPct);
  },
};

/** Weighted tokens — the unit the window is plausibly metered in. */
export function weightedTokens(t, w = WINDOW.weights) {
  return Math.round(
    t.input * w.input +
    t.output * w.output +
    t.cacheWrite * w.cacheWrite +
    t.cacheRead * w.cacheRead
  );
}

/** Share of one 5-hour window, as a fraction. Null if uncalibrated. */
export function windowShare(t, cfg = WINDOW) {
  const weighted = weightedTokens(t, cfg.weights);
  const budget = cfg.budgetTokens;
  return {
    weightedTokens: weighted,
    budgetTokens: budget,
    pct: budget ? Number((weighted / budget).toFixed(4)) : null,
  };
}

const ZERO = () => ({
  input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
  requests: 0, costUsd: 0,
});

function priceFor(model) {
  if (!model) return null;
  const exact = PRICES[model];
  if (exact) return exact;
  // Model ids carry date suffixes and vendor prefixes; match on the family stem.
  const stem = Object.keys(PRICES).find((k) => model.includes(k) || k.includes(model.split("-").slice(0, 3).join("-")));
  return stem ? PRICES[stem] : null;
}

export function costOf(usage, model) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (usage.input * p.input +
     usage.output * p.output +
     usage.cacheWrite * p.cacheWrite +
     usage.cacheRead * p.cacheRead) / 1e6
  );
}

/**
 * Fold one stream-json line into a tally.
 *
 * Cache reads are counted separately rather than folded into input because the
 * distinction is most of the story: an arm that re-reads a warm 40k-token prompt
 * twenty times looks catastrophic on raw input tokens and is nearly free.
 */
export function accumulate(tally, record) {
  const u = record?.message?.usage ?? record?.usage;
  if (!u) return tally;
  tally.input       += u.input_tokens ?? 0;
  tally.output      += u.output_tokens ?? 0;
  tally.cacheWrite  += u.cache_creation_input_tokens ?? 0;
  tally.cacheRead   += u.cache_read_input_tokens ?? 0;
  tally.requests    += 1;
  return tally;
}

/**
 * Meter one session's stream-json output.
 *
 * `alwaysOn` is the first assistant turn's non-cached input: system prompt +
 * CLAUDE.md + CONTEXT.md + every activated skill description. That is the arsenal
 * tax, and isolating it is the only way to set the always-list threshold from
 * evidence rather than opinion.
 */
export function meterSession(lines, { stage = null, model = null } = {}) {
  const t = ZERO();
  let alwaysOn = 0;
  let resolvedModel = model;
  let seenFirstTurn = false;
  let reportedCostUsd = null;

  for (const raw of lines) {
    let rec;
    try { rec = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { continue; }
    resolvedModel ??= rec?.message?.model ?? null;

    // The terminal `result` record carries the CLI's own cost figure. Prefer it:
    // it knows the actual model and the actual cache TTL, and this table does not.
    if (rec?.type === "result" && typeof rec.total_cost_usd === "number") {
      reportedCostUsd = rec.total_cost_usd;
    }

    const u = rec?.message?.usage ?? rec?.usage;
    if (u && !seenFirstTurn) {
      alwaysOn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      seenFirstTurn = true;
    }
    accumulate(t, rec);
  }

  // $0.0000 across a run that moved 7.8M tokens is a broken meter, not a free
  // run. The first real run reported exactly that because no model id was ever
  // resolved and costOf silently returned 0. Silent zero is now impossible:
  // either the CLI told us, or the table priced a known model, or we say so.
  const priced = priceFor(resolvedModel) !== null;
  t.costUsd = reportedCostUsd ?? (priced ? costOf(t, resolvedModel) : null);

  return {
    stage,
    model: resolvedModel,
    costSource: reportedCostUsd != null ? "cli" : priced ? "table" : "unknown",
    alwaysOn,
    ...t,
    window: windowShare(t),
  };
}

/** Sum session tallies into one arm total. */
export function summariseArm(name, sessions, { workerCostUsd = 0, workerTokens = 0, wallMs = 0, attendedMs = null } = {}) {
  const t = ZERO();
  let unpriced = 0;
  for (const s of sessions) {
    t.input += s.input; t.output += s.output;
    t.cacheWrite += s.cacheWrite; t.cacheRead += s.cacheRead;
    t.requests += s.requests;
    if (s.costUsd == null) unpriced++; else t.costUsd += s.costUsd;
  }
  // A dollar total assembled from sessions we could not price is a lie with a
  // decimal point on it. Report null and let the renderer say "unpriced".
  const orchestratorUsd = unpriced ? null : t.costUsd;
  return {
    arm: name,
    sessions: sessions.length,
    unpricedSessions: unpriced,
    orchestrator: t,
    worker: { costUsd: workerCostUsd, tokens: workerTokens },
    // Split, never summed into one headline. See the file header.
    costUsd: {
      orchestrator: orchestratorUsd,
      worker: workerCostUsd,
      total: orchestratorUsd == null ? null : orchestratorUsd + workerCostUsd,
    },
    // The second currency. Workers are OpenRouter and touch no Anthropic window,
    // so this is orchestrator-only by construction — which is the whole argument
    // for Arm B on a subscription, and why it gets its own line.
    window: windowShare(t),
    wallMs,
    // Wall-clock you must be present for. Arm B's build stage runs unattended, so
    // this is the number that decides how many runs a day are possible.
    attendedMs: attendedMs ?? wallMs,
    alwaysOnPerSession: sessions.length ? Math.round(sessions.reduce((a, s) => a + s.alwaysOn, 0) / sessions.length) : 0,
  };
}

/**
 * The comparison.
 *
 * `heldOutPassRate` is the primary score and comes from a suite NEITHER arm can
 * see. `ownTestsPassRate` is Arm B's own gates. The gap between them is the most
 * interesting number the experiment produces: it measures how much Trellis's
 * planning actually pinned the behaviour the spec asked for, as opposed to
 * behaviour Trellis decided to test for.
 */
export function compare(armA, armB, { heldOut = {}, ownTests = {} } = {}) {
  const ratio = (a, b) => (a == null || b == null || b === 0 ? null : Number((a / b).toFixed(2)));
  const nodesB = ownTests.mergedNodes ?? null;
  return {
    perMergedNode: nodesB && armB.costUsd.orchestrator != null
      ? Math.round(armB.costUsd.orchestrator / nodesB * 1e4) / 1e4
      : null,
    // Window share per merged node is the subscription-native unit of "what did
    // this node cost me". Dollars are the API-native one. Both, always.
    windowPerMergedNode: nodesB && armB.window.pct != null
      ? Number((armB.window.pct / nodesB).toFixed(5))
      : null,
    windowRatio: ratio(armB.window?.pct, armA.window?.pct),
    orchestratorTokensPerMergedNode: nodesB
      ? Math.round((armB.orchestrator.input + armB.orchestrator.output + armB.orchestrator.cacheWrite) / nodesB)
      : null,
    costRatio: ratio(armB.costUsd.total, armA.costUsd.total),
    attendedTimeRatio: ratio(armB.attendedMs, armA.attendedMs),
    heldOut: { A: heldOut.A ?? null, B: heldOut.B ?? null },
    // A large positive gap means Trellis's gates were green while the spec was not
    // satisfied — the failure mode per-node gates structurally cannot catch.
    selfGradeGap: heldOut.B != null && ownTests.passRate != null
      ? Number((ownTests.passRate - heldOut.B).toFixed(3))
      : null,
  };
}
