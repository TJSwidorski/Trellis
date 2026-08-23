# Trellis self-improvement loop — implementation

Plan: `~/.claude/plans/plan-steps-1-4-spicy-puzzle.md`
Order: 0 → 1 → 2 → 5 → 3 → 4 → 6

## Commit 0 — prerequisites
- [x] `rejectionCounts(root, cfg)` / `actionable(root, cfg, …)` honour `cfg.paths.state`
- [x] `cmdEvolve` keeps `cfg`, honours `cfg.evolve.minRuns`
- [x] regression + units green

## Commit 1 — controlled vocabulary
- [x] `references/CODES.md` with delimited JSON block
- [x] `kit/lib/codes.mjs` — loadCodes / normaliseCode / isKnown
- [x] `other:` bucketing; `actionable` filters `other:*` unconditionally
- [x] `trellis codes` + `trellis evolve --unknown`
- [x] `sessions/06_triage/CONTEXT.md` points at the CLI; jsonl shape specified
- [x] 06_triage `verify` requires a triage.jsonl record for this run
- [x] adversarial checks

## Commit 2 — attempt-kind evidence
- [x] `kit/lib/kinds.mjs` — KINDS / FLAG_TO_KIND / COSTLY_KINDS
- [x] `kindCounts` / `kindByTier` / `kindActionable` scoped to costly outcomes
- [x] second section in `trellis evolve`
- [x] adversarial checks incl. source-text set-equality

## Commit 5 — skills activation log
- [x] `.trellis/skills.jsonl` written from `applySkills`
- [x] `trellis evolve --retire` (zero-activation)
- [x] `SKILLS/` added to LOAD_BEARING

## Commit 3 — friction stream
- [x] `kit/lib/friction.mjs` + `trellis friction`
- [x] driver verify predicate; `--none` assertion
- [x] contradiction detector
- [x] adversarial checks

## Commit 4 — decision table + tooling proposals
- [x] `references/TOOLING.md`
- [x] `writeProposal({ kind })` + `trellis propose`
- [x] `NO_AUTO_APPLY` mitigation for CODES.md
- [x] adversarial checks

## Commit 6 — 07_evolve stage
- [x] `sessions/07_evolve/CONTEXT.md`
- [x] `STAGES` entry with `periodic: true`; `cmdAuto` skips it by default
- [x] stage-07 proposals stamped human-merge
- [x] lockstep updates: root CONTEXT.md, regression stage list, bench prompts
- [x] adversarial checks

## Review
_(filled in at the end)_

---

## Review

Seven commits on `evolve-evidence-loop`. Regression 38 -> 85 checks; units 21/21;
e2e 31/31; doctor clean apart from being on a feature branch.

**What changed, in one line each**

| Commit | Effect |
| --- | --- |
| `a06f684` | `evolve` honours `cfg.paths.state` and `cfg.evolve.minRuns` (both were dead) |
| `1e1c536` | `references/CODES.md` vocabulary; unknown codes bucket and can never act; triage must leave a run-stamped jsonl record |
| `c25640d` | attempt failure kinds counted, scoped to nodes that actually cost something |
| `a615a16` | `.trellis/skills.jsonl` + `evolve --retire` — the loop can now propose deletion |
| `3c4d019` | `.trellis/friction.jsonl` + contradiction detector |
| `62aa666` | `references/TOOLING.md` decision table; `writeProposal({kind})`; `trellis propose` |
| `d770c7b` | `07_evolve` periodic stage reading `evolve --json --top 5` and nothing else |

**Deviations from the plan**

- `kit/bench/prompts.json` was listed for a lockstep update and deliberately left
  alone. The bench measures the build pipeline; `07_evolve` builds nothing.
- `neverActivated` needed two refinements the plan did not anticipate. On the real
  registry the naive version named 55 of 78 entries, which is a signal nobody
  reads. Manual-only entries are excluded (their silence is the design working)
  and rule-less entries are reported separately as *unreachable* (a registry bug,
  not dead weight). Report is now 20 entries.
- `setup.mjs` needed `tasks/` in `NOT_INSTALLED` and the evidence files in
  `RUNTIME_PATHS`. Both were caught by existing fixtures, not by inspection.

**Open item the user should decide**

The vocabulary lives in `references/CODES.md` (advisory) per an explicit choice
over `kit/schema/` (protected). The `NO_AUTO_APPLY` carve-out in `evolve.mjs`
closes the resulting hole — a proposal touching CODES.md waits for a human while
every other advisory file still auto-applies. Droppable in one line if unwanted.

**Not done, deliberately**

Outcome correlation for skills (does a skill make runs better?) is out of scope.
It confounds badly — skills activate on the slices that are already hard, the same
asymmetry `ledger.mjs:92-95` documents for tiers. The activation log makes it
possible later if enough runs accumulate.

---

## Audit round (adversarial, fresh-context subagents)

Three cold subagents reviewed the branch and the system. They found real
defects, including in the work above. Six fix commits.

| Commit | What it closed |
| --- | --- |
| `18d0da7` | **`changedPaths()` corrupted the first path.** `git()` trimmed stdout; an unstaged modification's porcelain status has a leading space, so the first path lost a character. A tampered frozen test sorting first went undetected, and every node that *modified* a file was falsely reverted out-of-scope and burned to exhaustion. Pre-existing; invisible to all 137 checks because every fixture creates new files. |
| `a8f5f08` | **`classify()` was walked around by any alternate spelling.** `./MISSION.md` wrote a proposal against the mission statement. The guarding check was a tautology iterating `PROTECTED` against itself; six of eight entries could be deleted with the suite green. |
| `ee89bf2` | `friction.counts` never normalised, so invented free text cleared the threshold; `isCostly`'s surviving-mutation clause was dead against real ledger records; a malformed line crashed `evolve`. |
| `6e3a053` | 07_evolve was permanently deadlockable (verify enumerated the full shortlist, contract fed `--top 5`); any readable file counted as a proposal; a stale artifact satisfied the stage forever. |
| `106125c` | Proposal numbering recycled numbers and overwrote; `--from-evolve-stage` was attested by the party it constrains; bench call site missed; `COSTLY_KINDS` deleted as dead theatre; three unguarded behaviours covered. |
| `d33321b` | Gate ran worker code with the provider API key in its env; a node with no frozen test was a warning, not an error. Both pre-existing, both against MISSION invariants. |

Regression 85 -> 110 checks. Every fix was confirmed load-bearing by reverting
it and watching a named check go red.

**Process note.** The mutation-testing agent ran concurrently with two agents
reading the same working tree, and briefly left mutants in tracked files. That
was a mistake in how I fanned them out: mutation testing must run against a
copy or alone. Tree verified clean afterwards.

**Still open — not addressed, deliberately**

- Glob matching is case-sensitive on a case-insensitive filesystem, so
  `.GIT/config` and `KIT/lib/x` pass a `denyWrite` that blocks the lowercase
  forms. `classify()` is now case-insensitive; `paths.mjs` is not.
- `package.json`, `conftest.py`, `jest.config.js` etc. are not in `denyWrite`,
  so a node with a broad write scope can still author the command its own gate
  runs. The no-tests fix narrows this but does not close it.
- `testsExistAndAreNonVacuous` (stage 04's driver check) never calls
  `verifyTests`; it checks file size >= 120 bytes.
- Writes to gitignored paths are invisible to `changedPaths`, so they bypass
  scope checking, frozen-test detection, and revert.
- `node.read` is unvalidated: a node can read outside the repo into a prompt.
- `verify-tests` copies `.env` into the system temp dir and runs the gate there.
- `--resume` silently discards a run after any graph edit.
- `verify-tests` is JavaScript-only and does not say so.
