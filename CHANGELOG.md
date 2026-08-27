# Changelog

Format: one section per tagged release, newest first. Each entry names the
commit range and the tag. This file starts at 2.1.0 — everything before that is
`2.0.0` as shipped and described in `README.md` / `UPGRADING.md`.

Schema and file-format identifiers (`trellis.product-graph/1`,
`trellis.skill-registry/1`, the task-graph `version` field, and anything else
under `kit/schema/`) are **not** tracked by this file. They change only on an
incompatible on-disk format break, documented in `UPGRADING.md`, not on a routine
release.

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
