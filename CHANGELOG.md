# Changelog

Format: one section per tagged release, newest first. Each entry names the
commit range and the tag. This file starts at 2.1.0 — everything before that is
`2.0.0` as shipped and described in `README.md` / `UPGRADING.md`.

Schema and file-format identifiers (`trellis.product-graph/1`,
`trellis.skill-registry/1`, the task-graph `version` field, and anything else
under `kit/schema/`) are **not** tracked by this file. They change only on an
incompatible on-disk format break, documented in `UPGRADING.md`, not on a routine
release.

## v2.5.0 — one command, a whole cycle

Landed the `run-two-fixes` branch (re-reviewed, blockers fixed inline, ported
onto everything Phases 1–3 had already changed) and deleted it. Trellis can
now run a whole cycle — slice, build, triage, apply what's reversible — with
one command, and resume genuinely holds after a test gets strengthened.

- **`trellis auto --cycles N`** (`kit/bin/cli.mjs`, `kit/lib/driver.mjs`,
  new `kit/lib/cycle.mjs`) drives the default chain N times, beginning a
  fresh cycle each pass, committing exactly what each stage was declared to
  produce and halting — never guessing — on anything else. `--dry-run` prints
  the plan and cost without starting anything. New `OPERATING.md` is the
  manual for it; `QUICKSTART.md` is cut over from the retired
  `/trellis-plan` skill flow to the `sessions/NN_stage/CONTEXT.md` pipeline
  this has been hardening since v2.2.0.
- **The checkpoint is the one stop `--cycles` cannot skip**: a high-risk node
  held for review halts the whole loop, unconditionally, regardless of how
  many cycles remain, and `.trellis/checkpoint.json` is now written on every
  apply — including empty — so a stale entry can no longer report a
  long-accepted node as still awaiting review.
- **`--resume` rebuilds a node whose test got strengthened, not just whose
  contract changed** (`kit/lib/state.mjs`). `nodeHash` now folds in a digest
  of the frozen tests' actual content, not just their paths — REPORT.md's own
  advice to "strengthen the tests, then re-run" previously did nothing,
  because nothing compared what a test *said*.
- **`.trellis/cycle.json`** rolls `runId` forward on a genuinely new pass at
  the product graph, fixing evolve.mjs/friction.mjs thresholds and stale-
  artifact skip bugs in `trellis auto` that came from two real runs, weeks
  apart, counting as one.
- **`.trellis/built.json` is derived, not hand-authored** (new
  `kit/lib/built.mjs`): the ledger, then the current run's `state.json`, then
  an additive-only `built.manual.json`, in that trust order. `trellis slice`
  reads the derived set directly; nothing downstream depends on the cached
  file staying fresh.
- **`trellis triage` is a command, not a hand-formatted JSONL line**
  (`kit/lib/triage.mjs`), and **`trellis apply-triage`** mechanises the
  reversible half of a triage decision — reset a rejected non-landed node,
  bookkeep an accept on one already landed — while a held high-risk accept
  is never applied directly, only ever written to the checkpoint.
- **`.claude/hooks/guard-bash.mjs`** closes the Bash hole: a headless stage
  session could previously run `trellis accept --merge` or a raw
  `git merge`/`push`/`pull`/`reset --hard` — a one-way door MISSION.md
  reserves for a human — through the Bash tool, which no existing hook
  matched. Denies the CLI form, the `trellis` bin-alias form, and the raw git
  equivalents, tolerating arbitrary flags between `git` and the subcommand.
  `trellis auto` refuses to start at all without this hook registered.
- **`reject` no longer false-positives on a landed node via a `git merge-base`
  check that a squash or rebase merge defeats** — it now checks the node's
  own recorded status (`st.LANDED`) instead.

Six things fixed while porting rather than deferred: `auto` no longer halts
on a fresh project's own `.trellis/ingest.json` (gitignored, working state
rather than a deliverable); `commitStageOutput` reuses the existing
rename-aware `changedPaths()` instead of re-parsing `git status --porcelain`
by hand; a `RUNNING` node surviving a graph-changed salvage is normalised to
`PENDING` through a helper both the happy-path and salvage-path resume call,
so it is never invisible to `readySet` again; a `BUDGET`-stopped node is
revived by `--resume` the same way; the Bash guard tolerates `git -C .` and
`git -c foo=bar` (a global option's *value* is not itself dash-prefixed) and
also blocks the `trellis accept` bin-alias and raw `git pull`.

Regression 189 (was 152 going into this phase), units 28/28, e2e 44/44 (was
31).

## v2.4.0 — the worker loop

Quality and cost, not safety — five fixes to how a worker actually gets
retried, paid for, resumed, and read back.

- **The prompt is rebuilt every attempt, not once before the loop**
  (`kit/lib/worker.mjs`). A retry used to ask the model to fix code it could
  not see — for a brand-new file, "Current contents of files you may edit"
  was simply absent on attempt 1 and stayed built from that snapshot forever
  after. Likely the single largest quality change in this release.
- **Truncation gets a bigger cap on the same tier, not escalation**
  (`kit/lib/provider.mjs`, `kit/lib/extract.mjs`, `kit/lib/worker.mjs`, new
  `truncated` kind). An empty completion with `finish_reason=length` was
  marked `transient:true`, so `chatWithBackoff` retried the identical request
  at the identical cap up to three times before the caller ever learned
  anything was wrong. The common shape — two files complete, a third cut off
  mid-fence — is now checked before "produced nothing usable", not nested
  inside it, so a real truncation no longer burns a full escalation to solve
  what was never a capability problem. Base `maxTokens` raised 8000 → 16000
  (`trellis.config.json`, `kit/lib/config.mjs`'s default) — whole-file
  emission at 8k was the truncation source in the first place.
- **Mutation-check spend is now counted** (`kit/lib/mutate.mjs`,
  `kit/lib/runner.mjs`). One provider call per mutation per passing node
  reached neither `maxCostUsd` nor `maxTotalAttempts` before this — at 40
  nodes × 3 mutations that's roughly half the real spend going unmetered.
- **A `RUNNING` node kept across a graph-changed salvage no longer stays
  stuck forever** (`kit/bin/cli.mjs`). The salvage path copied node state
  verbatim, including status; a node interrupted mid-run whose own contract
  hadn't changed stayed `running` after `--resume` — invisible to the ready
  set, invisible to `markBlocked`, silently unbuilt while the run reported
  finished.
- **Gate output can no longer close its own report fence early**
  (`kit/lib/report.mjs`, new `untrustedBlock`). A worker's own code produced
  the gate stdout quoted in `REPORT.md`; a fixed triple-backtick fence closed
  on the first backtick run inside that text, and whatever followed rendered
  as ordinary report body in the orchestrator's own context. The fence is now
  always longer than the longest backtick run the body contains, and the
  block is explicitly labelled untrusted. `REPORT.md` is also now written
  atomically (tmp + rename), matching `saveState`.

## v2.3.0 — authenticate the evidence, make the docs true

The self-improvement loop's evidence stream had an unvalidated `run` field —
the one field its entire `minRuns` discipline depends on — and anything the
unsandboxed gate executed (see v2.2.0) could append to it. Also: three
documents claimed a hooks/apply behavior the code did not have.

- **`trellis triage`** (`kit/lib/triage.mjs`, new). Stage 06 used to hand-format
  `.trellis/triage.jsonl` itself, including the `run` field copied out of
  `state.json` — three fabricated `run` values in one session could clear
  `minRuns: 3` on their own. Mirrors `friction.mjs`'s pattern: `run` is
  stamped in code, never accepted from the caller. `.trellis/triage.json` is
  now a materialised view of the current run's jsonl rows, not a separate
  file to keep in sync.
- **Forged-run detection** (`kit/lib/driver.mjs`). Stage 06's verify now cross-
  checks every distinct `run` value `.trellis/triage.jsonl` has *ever* claimed
  against runIds the ledger actually recorded, not just the current run's.
- **`isCostly` reads the top tier from config** (`kit/lib/evolve.mjs`), not a
  hardcoded `"strong"` — a renamed or added top tier no longer silently drops
  out of the self-improvement loop's costly-node population.
- **`friction.contradictions()` wired into the shortlist** as a fourth source
  (`unreported-suspected`). The one mechanism that catches a session falsely
  asserting `--none` was computed and shown only to a human; stage 07's
  contract restricts it to `evolve --json`, so it never reached the one place
  a decision gets made.
- **`neverActivated` respects an entry's `firstSeen`** (`kit/lib/skills.mjs`) —
  a skill registered yesterday is no longer judged against runs that predate
  it. **`materialise` validates registry-supplied skill names** through
  `safeRelative` before a recursive delete, closing a traversal path.
- **Hook coverage now matches what `CLAUDE.md`/`CONTEXT.md` claim**
  (`.claude/hooks/protect-runner.mjs`). Previously covered three run-state
  filenames and `.worktrees/`; now imports `PROTECTED` from `evolve.mjs` and
  additionally covers the evidence `.jsonl` files, `evolution/proposals/`,
  `references/CODES.md`, and both settings files.
- **Deleted the false auto-apply claim** from `cli.mjs`, `evolution/README.md`,
  `references/EVOLUTION.md`, and `sessions/06_triage/CONTEXT.md` — no apply
  mechanism exists; every proposal waits for a human.
- **`package.json` classified `LOAD_BEARING`** (`kit/lib/evolve.mjs`) — it was
  neither protected nor load-bearing before, the least-guarded tier there is.

## v2.2.0 — integrity: close the gate, make the oracle real

Two independent adversarial audits converged on the same root cause: the gate
ran untrusted worker code with `shell: true`, unsandboxed, as the host user,
and every boundary check ran *before* it started. From that one hole followed
both a way for a worker to rewrite its own frozen test and a way for a gate
command to forge evidence in `.trellis/`. This release closes it, and fixes the
verification layer that was largely verifying its own invocation.

- **Gate path-delta check** (`kit/lib/gate.mjs`). The scope and frozen-test
  checks now re-run immediately after the gate command executes, before its
  exit code is trusted. A side effect of running the command — an import-time
  rewrite of a test file, a write into `.trellis/` — now fails the attempt as
  `gate-tampering`, reverting what can be reverted, regardless of exit code.
- **`revertPaths` mixed tracked/untracked bug** (`kit/lib/worktree.mjs`).
  `git checkout HEAD -- ...paths` aborts entirely if any one path is untracked,
  silently leaving every tracked path un-reverted. `revertPaths` now partitions
  first and returns what it actually reverted, so callers can report the truth
  instead of assuming success.
- **`verify-tests` import resolution** (`kit/lib/verify.mjs`). Four of six
  realistic import forms — extensionless specifiers, the TypeScript
  `.js`-for-`.ts` convention, `require()`, and dynamic `import()` — produced no
  stub at all, and the resulting module-not-found error was reported as
  non-vacuity established. All six now resolve correctly, including directory
  imports through an index file.
- **`verify-tests` no longer reports success on silence.** A node whose tests
  never import anything from its own write scope now gets a hard `unstubbed`
  finding instead of running the gate against an absent implementation. And
  `trellis verify-tests` now exits non-zero when nothing was proven at all,
  instead of printing a warning and exiting 0 — `driver.mjs`'s stage-04 verify
  shells out to this exact command and reads only its exit code.
- **`node.tests` paths are now validated** the same way `read`/`write` already
  were (`kit/lib/graph.mjs`), closing a traversal/shell-injection path into
  `verify-tests`' `node --check` call, which is now argv-based rather than an
  interpolated shell string.
- **`PROTECTED` now covers `kit/lib/paths.mjs` and `kit/lib/extract.mjs`**
  (`kit/lib/evolve.mjs`, `MISSION.md`) — the files that *implement* every
  boundary decision the already-protected files merely call.

## v2.1.0 — baseline

The state three independent adversarial audits were performed against: `main`,
the (already merged) `evolve-evidence-loop` branch, and the unmerged
`run-two-fixes` branch. This release does not fix anything found — it exists so
every fix after it lands as a visible, tagged increment against a known point.

- Pushed 25 commits that had accumulated on local `main` without ever reaching
  `origin/main`.
- Deleted branch `evolve-evidence-loop` (fully merged, 0 commits ahead of `main`).
- Added this file and a CI workflow (`.github/workflows/test.yml`) running
  `npm test` on push and PR — there was no CI of any kind before this.
