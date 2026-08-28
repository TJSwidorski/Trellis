# Operating Trellis — the one-command loop

`QUICKSTART.md` is how you run your first slice by hand, one stage at a time,
until you trust the loop. This file is for after that: one command, driving a
whole cycle, stopping only where it has to.

```
node kit/bin/cli.mjs auto --cycles 3
```

That's it. What follows is what it does, where it stops, and what to type when
it does.

## What one cycle is

A cycle is one pass through the pipeline: slice the next batch of work, write
its contracts and tests, build it headless, triage the result, apply what's
reversible. `trellis auto` with no `--cycles` flag runs exactly one. `--cycles N`
repeats it, beginning a fresh cycle each time, until N passes are done, nothing
is left to build, a stage gets stuck, or a high-risk node needs your eyes —
whichever comes first.

| Stage | What it does | Proof it finished |
| --- | --- | --- |
| `01_ingest` | Validate the handed-in product graph | Zero errors, scoped to the spec — an unchanged spec is never re-validated |
| `02_slice` | Cut the next batch, assemble its contracts | `plan.json` + `graph.json`, both stamped with this cycle |
| `03_cases` | Enumerate edge cases per node | `cases.json`, cycle-stamped, covering every node |
| `04_tests` | Write the frozen tests | Every declared test file exists and rejects a null stub |
| `05_build` | Deterministic runner — no model | The run finished, under this cycle |
| `06_triage` | Accept, reject, or re-spec | Every exhausted or high-risk node has a decision |

Each stage's actual contract is `sessions/NN_stage/CONTEXT.md` — read one of
those if you want to know what a session is doing, not this file. This table
exists to tell you where you are, not to replace what governs the work.

`07_evolve` is not in this list on purpose. It is periodic, reached only by
name (`trellis auto --stage 07_evolve`), because it reads evidence that only
moves across many cycles and every pass costs a full session. Running it every
cycle would be spending real money to re-read data that has not changed.

After each stage verifies, `auto` commits exactly what that stage was declared
to produce — nothing more. If the tree has changes it did not declare, it stops
rather than guessing which commit they belong in. That is almost always either
a session that was supposed to commit something itself and didn't (02_slice's
interface files), or an edit you made by hand mid-run. Either way, it is
something to look at, not paper over.

## The checkpoint

This is the one stop that is not negotiable, and it exists because of one line
in `MISSION.md`:

> A replacement for review on irreversible decisions. One-way doors get human
> eyes.

After `06_triage`, `auto` applies every *reversible* verdict automatically —
resetting a rejected node, bookkeeping an already-landed accept. It does this
under the hood; you do not run `apply-triage` yourself unless you are working
by hand. What it will never do, under any `--cycles` count, is merge a
high-risk node that is sitting in review. If triage accepted one, it lands in
`.trellis/checkpoint.json` and the loop stops right there:

```
Cycle 3 built. 2 high-risk node(s) need your eyes:
  publish.youtube          git show trellis/publish.youtube
  ops.orchestrator          git show trellis/ops.orchestrator

When you have reviewed them:
  node kit/bin/cli.mjs accept publish.youtube ops.orchestrator --merge
  node kit/bin/cli.mjs auto --cycles 1
```

Read the diffs. If they're right, run the `accept --merge` line — that is the
one place a merge into your base branch happens without you having typed the
command yourself. If one is wrong, `trellis reject <id>` instead and re-run.

This is also the reason a headless stage session cannot run `accept --merge`
itself: `.claude/hooks/guard-bash.mjs` denies it outright, by string match, from
outside the session's own shell. That is not a policy a session can talk its
way around — it's the actual answer to "why can't the orchestrator just merge
it if the tests pass." Tests passing is not the bar. A one-way door is.

## When a stage gets stuck

A stage that exhausts its attempts does not vanish into scrollback. It writes
`.trellis/handback.json` — which cycle, which stage, how many attempts, and the
exact command to type — and stops with a non-zero exit. Nothing is corrupted;
every stage is idempotent, so the fix is almost always one of:

| `handback.json.stage` | What to check |
| --- | --- |
| `01_ingest` | The product graph itself has an error — `01_ingest` doesn't fix it, it says why and stops. Fix the graph at its source. |
| `02_slice` | Usually a contract the graph's constraints could not resolve into concrete write scopes. Read `.trellis/REPORT.md` if one exists, or re-run the stage by hand and watch what it says. |
| `03_cases` | A node whose acceptance criteria don't decompose into checkable behaviour. |
| `04_tests` | `node kit/bin/cli.mjs verify-tests` directly — it will name which test is vacuous or won't parse. |
| `05_build` | Not a session — check `.trellis/REPORT.md`'s "Needs orchestrator decision" section. A model did not get stuck here; a node did. |
| `06_triage` | The friction record it should have left (`--none` still counts) is missing, or a decision is missing for an exhausted/high-risk node. |

Re-run with `node kit/bin/cli.mjs auto --stage <id>` once you've fixed the cause.

## The verbs, by status

| A node's status is... | You want |
| --- | --- |
| `exhausted` | `trellis reject <id>` to rebuild it, or `run --resume --retry-failed` to try again in place |
| `weak-tests` / `audit` | Already merged. `trellis accept <id>` is bookkeeping only — nothing new lands. |
| `review` (held, high-risk) | Read the diff, then `trellis accept <id> --merge` or `trellis reject <id>` |
| Unsure what's pending | `trellis status` |
| Unsure what counts as built | `trellis built` |
| Starting over on a batch | `trellis clean` |

## What stays manual, and why

These are not missing features. They are the boundary MISSION.md draws, and
`references/EVOLUTION.md` explains the mechanism behind each one:

- **Merging a high-risk node.** The checkpoint above.
- **Editing `MISSION.md`, the gates, the schemas, `kit/regression/`, or
  `.claude/hooks/`.** No proposal may touch these, ever — a system that can
  edit its own regression suite has no regression suite.
- **Widening the rejection-code vocabulary** (`references/CODES.md`) or **this
  file.** Both are flagged in `evolve.mjs`'s `NO_AUTO_APPLY` for extra caution
  if apply is ever implemented — a loop that can redefine its own evidence, or
  quietly relax when it's allowed to stop, is not a loop worth trusting.
- **Authoring or editing the product graph.** It's handed in from outside
  Trellis. If it's wrong, `01_ingest` says so and stops — that's correct, not
  a bug to route around.
- **Promoting a v2 node into v1.** `trellis promote` only ever suggests; moving
  a node is a hand edit to the source graph.

If you find yourself wanting to automate one of these, the honest next step is
a proposal against the mechanism itself (`trellis propose`), not a workaround.
