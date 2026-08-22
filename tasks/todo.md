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
