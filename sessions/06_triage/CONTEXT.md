# Stage 06 — triage

## Inputs

- Layer 4 (working): `.trellis/REPORT.md`, `.trellis/plan.json`
- Layer 3 (reference): `references/chiefs/` (per node `lenses`), `references/EVOLUTION.md`,
  `references/CODES.md`, `references/TOOLING.md`

## Process

Read `REPORT.md` once. Not `run.jsonl`, not worker transcripts, not the diffs of
nodes that passed cleanly.

You enter the loop for exactly two categories:

- **Exhausted nodes** — the mechanical loop tried every tier and failed.
- **High-risk nodes** — one-way doors, security surfaces, interfaces with two or
  more consumers. These get read whether or not they went green, because the gate
  cannot see what the test did not ask.

Everything else merged on evidence. Leave it alone. Reviewing a green low-risk node
costs context and buys nothing the mutation gate did not already prove.

For each node you do review, choose one: re-decompose, rewrite the contract, take
it yourself (say so out loud), or cut it. Two review passes per node is the ceiling
— a third means the decomposition is wrong, not the implementation.

## Rejection codes

Record every rejection with a **structured code**, not prose. "The error handling
is sloppy" cannot be counted across runs. `unhandled-error-path` can, and nine
occurrences of it is evidence that stage 03 is missing a case category.

This is the entire input to self-improvement. Prose here means Trellis learns
nothing about itself, ever.

The vocabulary is not listed here — it lives in one place and you read it at run
time:

```
node kit/bin/cli.mjs codes
node kit/bin/cli.mjs codes --explain <code>
```

Pick the closest code. **If nothing fits, use your own words.** The record is still
written, bucketed as `other:<your-words>`, and surfaced under
`trellis evolve --unknown` for a human to name later. What it cannot do is reach a
threshold — so never stretch a code to fit. A wrong code is worse than an unknown
one, because it pushes an unrelated pattern toward a proposal that was never about
it.

## Outputs

- `.trellis/triage.json` — `{ decisions: [{ node, verdict, code?, reason }] }`
- Appended to `.trellis/triage.jsonl` — the cross-run record. One line per triage
  session: `{ run, decisions: [{ node, verdict, code?, reason }] }`, where `run` is
  the `runId` from `.trellis/state.json`. Without `run` the line cannot be counted
  and the stage does not pass.
- `.trellis/built.json` — accepted node ids, so the next slice skips them
- One or more friction records, written by `trellis friction` (see below)

## Friction

Before you finish, record what was expensive about *doing this stage*, as opposed
to what was wrong with the software. Rejection codes and failure kinds both
describe the product. Neither can see you fixing an artifact by hand for the third
run running, and that is the thing worth automating.

```
node kit/bin/cli.mjs friction --stage 06_triage \
  --kind manual-edit --code hand-tightened-contract \
  --target sessions/03_cases/CONTEXT.md --count 2
```

If there genuinely was none, say so:

```
node kit/bin/cli.mjs friction --stage 06_triage --none
```

`trellis codes` lists the friction codes alongside the rejection ones. Ten records
per stage per run is the ceiling — a long list is as uninformative as an empty one.

## Verify

Every node in the report that is exhausted or high-risk has a decision. Silence on
a stuck node is not acceptance.

A friction record for this run exists — reported or explicitly `none`.

## Evolution

Run `node kit/bin/cli.mjs evolve`. If a pattern has appeared in three or more
distinct runs, write a proposal with `trellis propose` — through the command, never
by hand-formatting markdown, because the command is what enforces the refusals.

`references/TOOLING.md` decides *what* a pattern earns: a check, a contract fix, a
skill, a subagent, a plugin, or nothing. Walk it top to bottom and stop at the
first row that fits. The bias is strongly toward the cheap rows — a skill taxes
every session's selection accuracy, and nothing in Trellis measures that.

Fix the source, not the run. If you have tightened the same contract three times,
the fix is in the skill that writes contracts, not in this run's contract.

You may not propose changes to `MISSION.md`, the gates, the schemas, the hooks, or
the regression suite. `trellis classify <path>` will tell you which bucket a file
is in. Advisory proposals auto-apply once regression is green; load-bearing ones
wait for a human.

## Do not

Do not stretch a rejection code to fit. An unrecognised code is bucketed and
harmless; a wrong one pushes an unrelated pattern toward a proposal that was never
about it.

**Reporting friction never fails this stage.** The check is that you reported
*something*, not what you reported — an honest list of six costs you nothing, and
`--none` passes exactly as cleanly. The one thing ever counted against the loop is
asserting `none` on a run whose ledger shows exhausted nodes, and that is counted
across runs as a pattern, never held against a single session.
