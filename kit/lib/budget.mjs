/**
 * Run-level ceilings — failure mode 1, runs forever and burns the budget.
 *
 * The tier ladder caps attempts per node, which bounds one node but not a
 * graph. Forty nodes at seven attempts each has no brake at all. This is that
 * brake: when a ceiling is hit the runner stops LAUNCHING, lets in-flight nodes
 * finish, and leaves everything else pending so `--resume` picks it up.
 *
 * Stopping cleanly matters more than stopping instantly. A killed run with half
 * a merge applied is worse than one that overruns by a single node.
 */
export class Budget {
  constructor(cfg) {
    const b = cfg.budget || {};
    this.maxTotalAttempts = b.maxTotalAttempts ?? null;
    this.maxWorkerTokens = b.maxWorkerTokens ?? null;
    this.maxWallClockMs = b.maxWallClockMs ?? null;
    this.maxCostUsd = b.maxCostUsd ?? null;

    this.costByTier = new Map(
      (cfg.tiers || []).map((t) => [t.name, {
        in: t.costPer1kInput ?? null,
        out: t.costPer1kOutput ?? null,
      }])
    );

    this.startedAt = Date.now();
    this.attempts = 0;
    // Mutation-check calls (kit/lib/mutate.mjs) spend real tokens and money
    // through this exact same accounting, but they are not a worker retrying
    // a node -- they are the oracle grading an already-passed gate. Counted
    // here, separately, so they show up in a snapshot without silently
    // tripping `maxTotalAttempts`, which this class's own docblock describes
    // as the brake on a node retrying forever. Before this split, a graph of
    // 25 nodes declaring 3 mutations each spent 75 of a 120-attempt ceiling
    // on scoring work, tripping the "runs forever" brake roughly a third
    // early on graphs that were never actually looping.
    this.oracleCalls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.costUsd = 0;
    this.costKnown = [...this.costByTier.values()].some((c) => c.in !== null || c.out !== null);
    this.breach = null;
  }

  record(attempt) {
    this.attempts++;
    this._accrue(attempt);
  }

  /** Same token/cost accounting as record(), without counting against the
   * worker-retry attempt ceiling. See the constructor's comment on
   * `oracleCalls` for why these are kept separate. */
  recordOracleCall(call) {
    this.oracleCalls++;
    this._accrue(call);
  }

  _accrue({ tier, usage }) {
    const p = usage?.prompt_tokens || 0;
    const c = usage?.completion_tokens || 0;
    this.promptTokens += p;
    this.completionTokens += c;
    const rate = this.costByTier.get(tier);
    if (rate) {
      this.costUsd += (p / 1000) * (rate.in ?? 0) + (c / 1000) * (rate.out ?? 0);
    }
  }

  /** Returns a breach reason string, or null. Sticky once tripped. */
  check() {
    if (this.breach) return this.breach;
    const tok = this.promptTokens + this.completionTokens;
    if (this.maxTotalAttempts !== null && this.attempts >= this.maxTotalAttempts) {
      this.breach = `attempt ceiling reached (${this.attempts}/${this.maxTotalAttempts})`;
    } else if (this.maxWorkerTokens !== null && tok >= this.maxWorkerTokens) {
      this.breach = `worker token ceiling reached (${tok}/${this.maxWorkerTokens})`;
    } else if (this.maxCostUsd !== null && this.costKnown && this.costUsd >= this.maxCostUsd) {
      this.breach = `cost ceiling reached ($${this.costUsd.toFixed(4)}/$${this.maxCostUsd})`;
    } else if (this.maxWallClockMs !== null && Date.now() - this.startedAt >= this.maxWallClockMs) {
      this.breach = `wall-clock ceiling reached (${Math.round((Date.now() - this.startedAt) / 1000)}s)`;
    }
    return this.breach;
  }

  snapshot() {
    return {
      attempts: this.attempts,
      oracleCalls: this.oracleCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      costUsd: this.costKnown ? Number(this.costUsd.toFixed(6)) : null,
      elapsedMs: Date.now() - this.startedAt,
      breach: this.breach,
    };
  }
}
