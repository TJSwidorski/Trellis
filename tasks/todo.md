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

**All eight open items are now closed.** Second fix round:

| Commit | What it closed |
| --- | --- |
| `8c1c666` | Case folding at the deny boundary, plus denyWrite covering runner config (package.json, conftest.py, Makefile...). **Found already uncommitted in the working tree at session start — not my work; reviewed, mutation-tested, and committed so it was not lost.** |
| `a42e54a` | Stage 04 now RUNS verify-tests instead of claiming it, and checks tests per node rather than by flattened total. verify-tests scoped honestly to JS/TS — a foreign-language test is reported unchecked, not broken — and stops printing "non-vacuous" when nothing was proven. |
| `32ea702` | Ignored writes are visible to the gate (detection only, never reverted); a gitignored frozen test is refused at validation. |
| `08781c2` | `node.read` validated at read time and in validate; copyRepo stops copying .env and friends into world-readable temp. |
| `2a5a2a5` | Resume is per node with dependant propagation, instead of discarding a whole run over one edit. |

Regression 110 → 126 checks. Every fix confirmed by reverting it and watching a
named check go red.

**Judgement calls worth knowing about**

- `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` are now denied at
  every depth. A node can no longer add a dependency; that became a human's
  edit. Deliberate, and the cost is real.
- Stage 04 now runs every gate against a stub copy, so `trellis auto` takes
  meaningfully longer. That is the price of the stage proving what it is named
  after.
- `matchAllow` folding tracks the filesystem, so its mutation is only
  distinguishable on a case-sensitive one. The check is platform-correct but
  cannot be exercised both ways from Windows.

**Genuinely still open**

- The gate still executes worker-authored code as the host user with
  `shell: true`. Stripping the provider key narrowed the blast radius; it is not
  a sandbox and does not claim to be. Real containment means a container or a
  seccomp/AppArmor profile, which is a design decision rather than a patch.
- Non-vacuity is proven for JavaScript and TypeScript only. Other languages are
  now reported as unchecked rather than silently miscounted, but they are still
  unchecked.
- `ignoredPaths` uses `--ignored=traditional`, so an ignored write inside an
  already-ignored directory is reported as the directory, not the file.

---

# Remediation and improvement series (plan: `here-are-my-thoughts-idempotent-pike.md`)

Separate from the self-improvement loop above. An adversarial audit of `kit/`
(five clean-context reviewers, ten lenses) returned 15 verified findings plus
~12 secondaries, all sharing one shape: **enforcement that fails open**. This
series fixed those and landed 17 improvements alongside, one patch tag per
change, minor bump at each track boundary.

| Track | Tags | Theme |
| --- | --- | --- |
| A | `v2.6.1`–`v2.6.22` | fail loudly — false-green bugs first |
| B | `v2.7.0`–`v2.7.5` | the oracle fails closed |
| C | `v2.8.1`–`v2.8.3` | level-aware slicing and re-gating |
| D | `v2.9.0`–`v2.9.4` | cheaper attempts — cache prefix, sampling, routing |
| E | `v2.10.0`–`v2.10.2` | what it cost — the metric, the bench, a live view |

**Track E, in one line each**

| Tag | Effect |
| --- | --- |
| `v2.10.0` | REPORT.md publishes worker tokens per shipped node, summed from `state.nodes[].attempts[].usage` (never the mutation scorer), with the denominator stated |
| `v2.10.1` | `kit/bench/score.mjs` runs the held-out suite and Arm B's self-grade into `compare()`; section 4 of the A/B report is no longer structurally blank; `--dry-run` fills it with canned figures; `FIRST-RUN-SPEC.md` no longer points at retired `/trellis-plan` |
| `v2.10.2` | `trellis watch` — the `validate` level view re-rendered from `state.json` on `fs.watch`, plus one self-contained HTML snapshot; no server, no dependency |

**Final**

- Item 30 — `docs/trellis-teardown.html` committed and linked from `README.md`
  (`08496fc`), pushed to the public repo.
- Item 31 — `protect-runner.mjs` restored to `.claude/settings.json`'s
  `PreToolUse` list, byte-identical to its pre-series state.
- `Skill-evaluation/` at the repo root is unrelated work-in-progress, excluded
  by name from the installer's completeness check (`08496fc`), contents
  untouched, still untracked — the user is handling it separately.

**Verification.** `npm test` green — units 71/71, regression 227, e2e 68/68.
Each tag in the range carries its own commit and tests.

## Re-audit (follow-up — not yet done)

Once this series has settled, re-run the same three-part process against the
**changed** `kit/` — the fixes here add mechanism, and mechanism is where
defects live:

1. A fresh adversarial audit — five clean-context reviewers, the same ten
   lenses — over the new `kit/`.
2. A rewritten elementary explanation reflecting level-based batching, the
   fail-closed oracle, and the opt-in sandbox.
3. A new improvement brainstorm, grounded in whatever `.bench/REPORT.md` says
   by then — the first time the roadmap can argue from measurements rather than
   from reasoning. This needs a real paid A/B run first (`kit/bench/run.mjs`,
   held-out suite at `trellis-heldout/suite`).
