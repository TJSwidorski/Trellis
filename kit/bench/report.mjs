// Render an A/B run into the shape examples/EVALUATION.md already asks for.
//
// Extends that sheet rather than replacing it: its three-way split — bad plan vs.
// weak model vs. broken kit — is the right diagnostic frame, and the numbers here
// slot into its sections 2, 3 and 5. What this file must never do is print a
// single headline "winner", because the arms are not commensurable at face value
// and a single number would hide the trade the whole system exists to make.

import { WINDOW } from "./meter.mjs";

const usd = (n) => (n == null ? "unpriced" : `$${n.toFixed(4)}`);
const win = (p) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);
const num = (n) => (n == null ? "—" : n.toLocaleString());
const secs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

function tokenRows(a, b) {
  const pick = (arm, k) => (arm ? num(arm.orchestrator[k]) : "—");
  return [
    ["Fresh input", pick(a, "input"), pick(b, "input")],
    ["Cache write", pick(a, "cacheWrite"), pick(b, "cacheWrite")],
    ["Cache read", pick(a, "cacheRead"), pick(b, "cacheRead")],
    ["Output", pick(a, "output"), pick(b, "output")],
    ["Requests", pick(a, "requests"), pick(b, "requests")],
    ["Always-on per session", a ? num(a.alwaysOnPerSession) : "—", b ? num(b.alwaysOnPerSession) : "—"],
  ];
}

export function renderReport({ spec, dryRun, a, b, sessions = [], comparison }) {
  const L = [];
  L.push(`# A/B: Trellis vs. plain Claude Code`);
  L.push(``);
  if (dryRun) {
    L.push(`> **DRY RUN.** Canned transcripts; no sessions were spawned and nothing was`);
    L.push(`> spent. This validates the measurement rig, not the systems under test.`);
    L.push(``);
  }
  L.push(`Spec: \`${spec}\` — identical for both arms.`);
  L.push(``);
  L.push(`## 0. What this compares`);
  L.push(``);
  L.push(`**Realistic use, not a matched contest.** Each arm is prompted the way it would`);
  L.push(`actually be used, because the question is "which should I reach for", not "which`);
  L.push(`wins once the advantages are equalised". Three asymmetries follow, all deliberate`);
  L.push(`and stated here rather than buried:`);
  L.push(``);
  L.push(`1. **Arm B gets a hand-authored product graph. Arm A gets only the spec.** Under`);
  L.push(`   realistic use that is correct — authoring the graph is part of using Trellis.`);
  L.push(`   It does mean Arm B starts from a human decomposition Arm A must derive itself.`);
  L.push(`2. **The graph's authoring cost is booked to neither arm.** It was written in a`);
  L.push(`   separate Opus session. Treat Arm B's cost as a floor, not a total.`);
  L.push(`3. **Arm A runs in one session; Arm B in five plus an unattended build.** That is`);
  L.push(`   the shape of each product, which is why "attended time" is reported separately`);
  L.push(`   from wall clock.`);
  L.push(``);
  L.push(`Arm A's guardrails forbid unwanted *behaviour* (no stubs, no scope narrowing) but`);
  L.push(`never prescribe *method*. Telling Arm A to write tests first would hand it`);
  L.push(`Trellis's approach and measure that approach twice instead of comparing two`);
  L.push(`systems. See \`kit/bench/prompts.json\` for the exact text of both arms.`);
  L.push(``);
  L.push(`## 1. Cost — two currencies`);
  L.push(``);
  L.push(`Cost is reported twice because it is paid twice, in units that do not convert.`);
  L.push(`Dollars are what an API-key run would bill. **Window share is what a`);
  L.push(`subscription run actually spends** — and it is the one that decides whether a`);
  L.push(`second run today is possible at all.`);
  L.push(``);
  L.push(`### 1a. Dollars (notional API spend)`);
  L.push(``);
  L.push(`Split, never summed into one headline: Arm B trades expensive orchestrator`);
  L.push(`tokens for cheap worker tokens, and a single total would hide exactly that.`);
  L.push(``);
  L.push(`| | A (plain) | B (Trellis) |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| Orchestrator (Anthropic) | ${usd(a?.costUsd.orchestrator)} | ${usd(b?.costUsd.orchestrator)} |`);
  L.push(`| Workers (OpenRouter) | ${usd(a?.costUsd.worker)} | ${usd(b?.costUsd.worker)} |`);
  L.push(`| **Total** | **${usd(a?.costUsd.total)}** | **${usd(b?.costUsd.total)}** |`);
  L.push(``);
  if (a?.unpricedSessions || b?.unpricedSessions) {
    L.push(`> \`unpriced\` means no model id resolved and the CLI reported no cost — the`);
    L.push(`> meter could not price those sessions. It is **not** a free run. Fix before`);
    L.push(`> quoting any dollar figure from this table.`);
    L.push(``);
  }
  L.push(`### 1b. 5-hour window share (the binding constraint)`);
  L.push(``);
  L.push(`| | A (plain) | B (Trellis) |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| Weighted tokens | ${num(a?.window.weightedTokens)} | ${num(b?.window.weightedTokens)} |`);
  L.push(`| **Share of one window** | **${win(a?.window.pct)}** | **${win(b?.window.pct)}** |`);
  L.push(`| Runs per window (implied) | ${a?.window.pct ? Math.floor(1 / a.window.pct) : "—"} | ${b?.window.pct ? Math.floor(1 / b.window.pct) : "—"} |`);
  L.push(``);
  L.push(`Worker tokens are OpenRouter and consume **none** of the Anthropic window, so`);
  L.push(`this row is orchestrator-only by construction. That asymmetry is the core`);
  L.push(`argument for Arm B on a subscription, and it is invisible in dollars.`);
  L.push(``);
  L.push(`> **Model, not measurement.** No API exposes remaining window quota. This is`);
  L.push(`> weighted tokens (in ×${WINDOW.weights.input}, out ×${WINDOW.weights.output},`);
  L.push(`> cache-write ×${WINDOW.weights.cacheWrite}, cache-read ×${WINDOW.weights.cacheRead})`);
  L.push(`> against a budget of ${num(WINDOW.budgetTokens)} weighted tokens per window,`);
  L.push(`> calibrated from: ${WINDOW.calibration.source} (${win(WINDOW.calibration.observedWindowPct)}`);
  L.push(`> observed at ${num(WINDOW.calibration.weightedTokens)} weighted tokens). One data`);
  L.push(`> point. Read the real figure off an interactive session right after this run`);
  L.push(`> and update \`WINDOW.calibration\` in \`kit/bench/meter.mjs\`.`);
  L.push(``);
  L.push(`## 2. Tokens by loading type`);
  L.push(``);
  L.push(`| Bucket | A (plain) | B (Trellis) |`);
  L.push(`| --- | --- | --- |`);
  for (const [k, av, bv] of tokenRows(a, b)) L.push(`| ${k} | ${av} | ${bv} |`);
  L.push(``);
  L.push(`"Always-on" is the first turn's uncached input: system prompt + \`CLAUDE.md\` +`);
  L.push(`\`CONTEXT.md\` + every activated skill description. That is the arsenal tax, and`);
  L.push(`the number to watch before adding anything to the \`always\` list.`);
  L.push(``);

  if (sessions.length) {
    L.push(`### Arm B, per stage`);
    L.push(``);
    L.push(`| Stage | Fresh in | Cache read | Out | Cost | Window |`);
    L.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const s of sessions) {
      L.push(`| ${s.stage} | ${num(s.input)} | ${num(s.cacheRead)} | ${num(s.output)} | ${usd(s.costUsd)} | ${win(s.window?.pct)} |`);
    }
    L.push(``);
    L.push(`The window column is where to look first. A stage taking a double-digit`);
    L.push(`percentage of the window is the one deciding how many runs fit in a day,`);
    L.push(`whatever its dollar figure says.`);
    L.push(``);
    L.push(`\`05_build\` is absent because it spends zero orchestrator tokens — it is the`);
    L.push(`runner, not a session. That absence is the central claim under test.`);
    L.push(``);
  }

  L.push(`## 3. Time`);
  L.push(``);
  L.push(`| | A (plain) | B (Trellis) |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| Wall clock | ${secs(a?.wallMs)} | ${secs(b?.wallMs)} |`);
  L.push(`| **Attended** | **${secs(a?.attendedMs)}** | **${secs(b?.attendedMs)}** |`);
  L.push(``);
  L.push(`Attended time excludes Arm B's unattended build. It is the more useful figure:`);
  L.push(`it decides how many runs fit in a day.`);
  L.push(``);
  L.push(`## 4. Result — held-out suite`);
  L.push(``);
  L.push(`> Fill from the held-out acceptance suite, which **neither arm has seen**.`);
  L.push(`> Scoring Trellis on the tests Trellis wrote makes it win by construction.`);
  L.push(``);
  L.push(`| | A (plain) | B (Trellis) |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| Held-out pass rate | ${pct(comparison?.heldOut.A)} | ${pct(comparison?.heldOut.B)} |`);
  L.push(``);
  if (comparison) {
    L.push(`| Derived | Value |`);
    L.push(`| --- | --- |`);
    L.push(`| Orchestrator tokens / merged node | ${num(comparison.orchestratorTokensPerMergedNode)} |`);
    L.push(`| Orchestrator $ / merged node | ${usd(comparison.perMergedNode)} |`);
    L.push(`| Window share / merged node | ${win(comparison.windowPerMergedNode)} |`);
    L.push(`| Cost ratio (B ÷ A) | ${comparison.costRatio ?? "—"} |`);
    L.push(`| **Window ratio (B ÷ A)** | **${comparison.windowRatio ?? "—"}** |`);
    L.push(`| Attended-time ratio (B ÷ A) | ${comparison.attendedTimeRatio ?? "—"} |`);
    L.push(`| **Self-grade gap** | **${comparison.selfGradeGap ?? "—"}** |`);
    L.push(``);
    L.push(`**The self-grade gap is the most informative number here.** It is Arm B's own`);
    L.push(`test pass rate minus its held-out pass rate. A large positive value means`);
    L.push(`Trellis's gates were green while the spec was not satisfied — the failure that`);
    L.push(`per-node gates structurally cannot catch, because a gate proves the code`);
    L.push(`matches the test and cannot ask whether the test described the right thing.`);
    L.push(``);
  }
  L.push(`## 5. Failure taxonomy`);
  L.push(``);
  L.push(`Fill from \`.trellis/REPORT.md\`, per \`examples/EVALUATION.md\`. Note that`);
  L.push(`\`env-failure\` is **excluded from the denominator** — an environment fault is`);
  L.push(`not a capability measurement, and averaging it in points at the one fix that`);
  L.push(`cannot work.`);
  L.push(``);
  L.push(`## 6. One change before the next run`);
  L.push(``);
  L.push(`Pick exactly one. The discipline of picking one is what makes the next`);
  L.push(`comparison mean anything.`);
  L.push(``);
  return L.join("\n");
}
