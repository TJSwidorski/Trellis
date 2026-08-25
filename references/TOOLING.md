# Tooling — what a recurring pattern earns

`trellis evolve` hands you a shortlist. This file decides what each row on it
becomes. Read it with the shortlist, not on its own.

The judgement it replaces is the one that goes wrong the same way every time: a
model looking at a recurring problem reaches for a skill, because writing a skill
feels like building a capability and writing a check feels like a chore. The
opposite is true, and the reason is invisible from inside a single session.

## The ordering rule

**Prefer the mechanism with the smallest context footprint that can express the
fix.**

```
contract fix  <  plain code  <  subagent  <  applies_to skill  <  always skill  <  plugin
```

Note the inversion: **plain code ranks cheaper than a skill despite being more work
up front.** A check written once costs zero context forever. A skill's name and
description enter the context of every session it is eligible for, and — the cost
that actually bites — a model choosing among forty descriptions picks worse, and
fires spurious skills more often, than one choosing among six.

That degradation appears in no per-node metric. Nothing in Trellis will ever notice
it. It is the reason this file exists.

## The table

Walk it top to bottom and **stop at the first row that fits.**

| Signal in the shortlist | Mechanism | Invisible cost | Retirement test |
| --- | --- | --- | --- |
| Same code, same file, and the fix is deterministic | **plain code** — a gate check, a validator, a CLI flag | none | the check never fires in 20 runs |
| Same code, judgement, and it belongs to one known stage | **contract fix** — that stage's `CONTEXT.md` | a few tokens, one stage | the code stops appearing |
| Recurring judgement, spans stages, gates cleanly on node kind / surface / lens | **skill with `applies_to`** | selection accuracy, every eligible session | zero activations across N runs |
| Needs its own context window and returns a small artifact | **subagent** | one session's cost per invocation | invocation count stays zero |
| Needs credentials, a remote server, or state Trellis does not hold | **plugin** | trust surface, plus an audit that can go stale | the audit lapses and nobody renews it |
| Behaviour genuinely needed in every session | **`always` skill** | worst available — degrades every selection in the system | very high bar to add at all |
| Fewer than 3 distinct runs, or one person's habit | **nothing** | — | — |

## Two rows that get chosen wrongly

**"Plain code" is under-chosen.** The question to ask is not "could a model do this
better?" but "does this need judgement *at all*?" A friction record of
`missing-mechanical-check` is almost always this row: somebody verified by reading
what a script could verify. Write the script.

**"Contract fix" is under-chosen too**, because it feels like it does not scale —
one stage, one file. But most recurring rejection codes are a stage contract
failing to ask for something, and `references/CODES.md` names the likely culprit
for each code in its `suspects` field. Check there before reaching further down.

## What a tooling proposal must carry

`trellis propose --kind tooling` enforces three things beyond the usual proposal
sections, and none of them is ceremony.

**Alternatives considered.** Name at least the two cheaper rows and say why each
fails. A proposal that skipped straight to a skill without explaining why a check
could not do it has not made an argument.

**Cost.** For a skill: the current `.claude/skills` count, and that this makes it
N+1. Written down, because the cost is otherwise invisible at the moment of
choosing.

**Retirement condition.** A mechanical test that would say this should be removed,
committed to before anyone is attached to it. `writeProposal` refuses a tooling
proposal without one — a blank section here is not acceptable, because the
pre-commitment *is* the deletion mechanism. `trellis evolve --retire` re-evaluates
these later.

## Deletion is half the loop

A loop that can only add is not a loop. Every addition taxes something that no
metric watches, so left alone the arsenal grows monotonically and every dashboard
says things are improving.

Evidence that justifies removal, in descending order of how much it can be
trusted:

1. **Zero activations across N runs.** Provable from `.trellis/skills.jsonl` and
   needs no judgement — the rules never matched, so the entry never entered a
   context window. This is the one to act on.
2. **The stated retirement condition, met.** The proposal said what would falsify
   it. It happened.
3. **Self-reported usage — never counted.** A session has every incentive to
   over-report using the tool it was handed, and over-reporting is exactly what
   would protect a useless skill from deletion. Shown in the shortlist, never in
   the arithmetic.

Retirement proposals target `SKILLS/REGISTRY.json`, which is load-bearing: a human
merges. An entry going in is a standing tax on every session; an entry coming out
is a capability the next project silently no longer has. Neither should happen
without someone looking.
