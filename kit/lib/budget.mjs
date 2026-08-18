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
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.costUsd = 0;
    this.costKnown = [...this.costByTier.values()].some((c) => c.in !== null || c.out !== null);
    this.breach = null;
  }

  record(attempt) {
    this.attempts++;
    const p = attempt.usage?.prompt_tokens || 0;
    const c = attempt.usage?.completion_tokens || 0;
    this.promptTokens += p;
    this.completionTokens += c;
    const rate = this.costByTier.get(attempt.tier);
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
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      costUsd: this.costKnown ? Number(this.costUsd.toFixed(6)) : null,
      elapsedMs: Date.now() - this.startedAt,
      breach: this.breach,
    };
  }
}
