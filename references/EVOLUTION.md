# Evolution — how Trellis is allowed to change itself

Self-improvement is a real capability and a real hazard. The hazard is specific and
worth stating plainly:

> The cheapest way to make runs go green is to weaken the gate that keeps failing.

A system that can edit its own gates will find that path. Every metric improves
while the product gets worse, and the metrics are the only thing watching.

Three mechanisms prevent it.

## 1. Evidence before proposal

Triage records **structured rejection codes**, not prose. `unhandled-error-path` can
be counted across runs; "the error handling was sloppy" cannot.

Nothing may be proposed until the same code appears in three or more *distinct
runs*. Distinct runs, not distinct nodes — one bad slice producing the same code
eight times is one observation about that slice.

```
node kit/bin/cli.mjs evolve
node kit/bin/cli.mjs evolve --unknown
```

The codes themselves live in `references/CODES.md` — read that file, not this one,
when you need to pick one. Counting only works if everyone spells it the same way,
which is the whole reason the vocabulary is written down. A code nobody has agreed
on is recorded as `other:<slug>`: visible under `--unknown` as pressure to name it,
and **never actionable at any run count**. Widening the vocabulary is a human
commit, so the loop cannot redefine what counts as evidence.

## 2. Three buckets, three authorities

```
node kit/bin/cli.mjs classify <path>
```

**Protected** — never proposable, human edit only.
`MISSION.md`, `kit/lib/gate.mjs`, `verify.mjs`, `mutate.mjs`, `worktree.mjs`,
`kit/schema/`, `kit/regression/`, `.claude/hooks/`.

The last two are the ones people forget. A system that can edit its own regression
suite has no regression suite. A system that can edit its own schema can redefine
failure as success.

**Load-bearing** — proposable, human merges. `kit/lib/`, `kit/bin/`, `kit/mcp/`,
`trellis.config.json`, `sessions/`. Correctness lives here.

**Advisory** — proposable, auto-applies when regression is green. `README.md`,
`CLAUDE.md`, `CONTEXT.md`, `references/`, `.claude/skills/`, `kit/roles/`. Prose.

Unclassified paths fail closed to load-bearing.

The reason for the split is behavioural. If every proposal needs review, you review
README typos for a month and stop reading carefully — and that is exactly when a
load-bearing one goes through.

### The one carve-out

Tier roster changes — which open-source model sits in which tier — are governed by
`references/chiefs/optimization.md`. Cost and pass rate are measured rather than
judged, and the change is cheap to revert, so it moves on evidence with a minimum
observation count and does not need a human. It may never touch strictness.

## 3. The regression suite

```
node kit/bin/cli.mjs regression
```

Two halves, and the second is the one that matters.

**Happy fixtures** catch "the change broke the thing." Valid graphs validate, risk
derives correctly, slices respect dependencies and caps, promotion finds only
unblocked nodes.

**Adversarial fixtures** are inputs engineered to fail, each with an expected
failure. A v1 node depending on v2. A dependency cycle. A hand-set `high_risk`. A
proposal touching the regression suite. If one of these starts *passing*, a gate
has stopped catching something it used to.

A happy-path-only suite would applaud a change that loosened every gate, because
loosened gates make happy paths greener. Gate erosion is only visible when
something is supposed to fail.

Add your own under `kit/regression/fixtures/*.json`:

```json
{ "expect": "reject", "match": "cycle", "graph": { "schema": "trellis.product-graph/1", "...": "..." } }
```

## The edit-source principle

Editing a run's output fixes that run. Editing the source that produced it fixes
every future run.

If you have tightened the same contract by hand three times, the fix is not a
fourth tightening — it is in the skill that writes contracts. That is what a
recurring rejection code is telling you, and it is the whole reason the codes are
structured.

There is a real exception. Some corrections are judgement that cannot be reduced to
a rule, and editing the output is the right move. The distinguishing question is
whether the same correction would apply next time. If yes, it belongs in the source.

## What a pattern earns

Evidence says *that* something recurs. It does not say what to do about it, and the
choice — a check, a contract fix, a skill, a subagent, a plugin, nothing — goes
wrong the same way every time: a skill feels like building a capability and a check
feels like a chore, when a check costs zero context forever and a skill taxes every
session's selection accuracy.

`references/TOOLING.md` is the decision table, with the ordering rule and the
retirement test each mechanism owes. A tooling proposal cannot be written without a
retirement condition, because a loop that can only add is not a loop.

## Writing a proposal

`evolution/proposals/NNN-title.md`, with evidence attached: run ids, ledger stats,
the rejection code and its count. Every proposal carries a reviewer checklist whose
first question is the one that matters:

> Does this weaken any gate, threshold, or acceptance condition?
