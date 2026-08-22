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
- [ ] `references/TOOLING.md`
- [ ] `writeProposal({ kind })` + `trellis propose`
- [ ] `NO_AUTO_APPLY` mitigation for CODES.md
- [ ] adversarial checks

## Commit 6 — 07_evolve stage
- [ ] `sessions/07_evolve/CONTEXT.md`
- [ ] `STAGES` entry with `periodic: true`; `cmdAuto` skips it by default
- [ ] stage-07 proposals stamped human-merge
- [ ] lockstep updates: root CONTEXT.md, regression stage list, bench prompts
- [ ] adversarial checks

## Review
_(filled in at the end)_
