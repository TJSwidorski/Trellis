# Workspace routing

You are in a Trellis workspace. This file answers one question: **given what needs
doing, which session handles it, and what does that session load?**

Read this, then read exactly one stage contract. Do not read the others.

## The layers

| Layer | File | Answers | Loaded |
| --- | --- | --- | --- |
| 0 | `CLAUDE.md` | Where am I, what are the rules | Always |
| 1 | `CONTEXT.md` (this file) | Where do I go | Always |
| 2 | `sessions/NN_stage/CONTEXT.md` | What do I do | One per session |
| 3 | `references/**` | What constraints apply | Per the stage's Inputs table |
| 4 | `.trellis/**` | What am I working with | Per the stage's Inputs table |

Layer 3 is the factory: conventions, chiefs, design systems, skills. It is
configured once and does not change between runs. Layer 4 is the product: graphs,
plans, cases, tests, reports. It changes every run.

The distinction is not filing. Layer 3 material is a **constraint** you internalise;
Layer 4 material is **input** you transform. Loading them undifferentiated makes you
sort them yourself, badly.

## The sessions

| Stage | Job | Proof it finished |
| --- | --- | --- |
| `01_ingest` | Validate the handed-in product graph | `.trellis/ingest.json` with zero errors, scoped to the spec |
| `02_slice` | Cut the next buildable slice | `.trellis/plan.json` + `.trellis/graph.json`, both stamped with the current cycle |
| `03_cases` | Enumerate edge cases per node | `.trellis/cases.json`, cycle-stamped, covering every planned node |
| `04_tests` | Write the frozen tests | Every declared test file exists and is non-vacuous |
| `05_build` | Deterministic runner; no model | `.trellis/REPORT.md`, from a run stamped with the current cycle |
| `06_triage` | Accept, reject, or re-spec | `.trellis/triage.json`, plus a `triage.jsonl` and a friction record for this run |
| `07_evolve` | **Periodic.** Turn recurring patterns into proposals | `.trellis/evolve.json` accounting for every shortlisted pattern |

One session does one stage. At the end of a session the context is cleared or
compacted, so **anything the next stage needs must be on disk before you stop.**
Never rely on something you remember from earlier in the conversation.

`07_evolve` is not in the default `trellis auto` chain. Evolution reads evidence
that only moves across many runs, and every pass costs an expensive session, so it
is reached deliberately with `trellis auto --stage 07_evolve`.

## Cycles

Each pass through 01–06 is a **cycle**, declared with `trellis cycle` — or begun for
you, lazily, the first time you `trellis run` with none declared yet. A stage's
proof of completion is scoped to the current cycle's id (see `.trellis/cycle.json`),
which is what lets a second `trellis auto` tell "I already did this pass" from
"time to do the next one" — without it, every stage looked satisfied forever after
the first pass, and self-improvement's "distinct runs" counted a second pass as the
same run as the first. If you assemble `graph.json` or `cases.json`, stamp `cycle`
into it from `.trellis/cycle.json`'s `id` — that field is what makes the distinction
real.

## What is not yours

The product graph is authored outside Trellis and handed in complete. You do not
write it, extend it, or quietly reinterpret it. If it is wrong, `01_ingest` says so
and stops — that is the correct outcome, not a failure to work around.

`MISSION.md` is immutable. `kit/` is write-protected by a hook. `.trellis/state.json`
and `.worktrees/` belong to the runner.

## Where the loop is

`05_build` is not a session you drive. It is `kit/lib/runner.mjs` executing a
dependency graph headless, dispatching to open-source models in isolated worktrees.
Orchestrator tokens spent during a build: zero. If you find yourself reading
`run.jsonl`, stop and read `REPORT.md`.
