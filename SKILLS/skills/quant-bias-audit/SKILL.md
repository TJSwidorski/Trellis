---
name: quant-bias-audit
description: Audit a quantitative research codebase for the four bias classes that invalidate a backtest — lookahead bias (negative shifts, unfiltered iloc, joins without an as_of key), survivorship bias (universe not point-in-time), overfitting and out-of-sample leakage, and an absent or unrealistic cost model. Use when reviewing a backtester, a genetic-algorithm fitness function, or any strategy whose reported returns need to be trusted before capital is committed.
---

# Skill: quant-bias-audit

When this skill is invoked:

Walk through the four bias checklist items from `CLAUDE.md` interactively. For each item,
read the relevant source files and return a verdict.

## Step 1 — Identify Files to Audit
Glob for files in `backend/research/backtester/` and `backend/research/ga/fitness.py`.
If none exist yet (stubs only), say "No implementation to audit yet — all stubs raise NotImplementedError."
and stop.

## Step 2 — Lookahead Bias Check
- Search for any use of the prices DataFrame that could access future rows.
- Specifically look for: negative `.shift()`, `.iloc` with full slice on time-series data, any join/merge that doesn't use `as_of` date filtering.
- Verdict + line numbers.

## Step 3 — Survivorship Bias Check
- Find where the trading universe is defined for each backtest date.
- Confirm it uses a point-in-time list, not a static current list.
- Verdict + line numbers.

## Step 4 — Overfitting / Out-of-Sample Check
- Find where `evaluate_genome()` is called.
- Confirm the `prices` slice passed to it covers only the test window, not the full history.
- Confirm no signal parameters were tuned using test-window data.
- Verdict + line numbers.

## Step 5 — Cost Model Check
- Find trade execution logic.
- Confirm slippage is deducted, tax bucket is updated, PDT counter is maintained.
- Verdict + line numbers.

## Step 6 — Summary
Table of all four items: PASS / FAIL / NOT_IMPLEMENTED.
For any FAIL: quote the exact lines and state the fix needed.
For NOT_IMPLEMENTED: note it is expected and not a problem yet.

Do not fix anything — only audit and report.
