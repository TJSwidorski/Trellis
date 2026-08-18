---
name: trellis-plan
description: Turn a spec into a Trellis task graph. Use when the user asks to plan, decompose, or scope a build, mentions SPEC.md or graph.json, or says "plan this with Trellis". Produces .trellis/graph.json only — the frozen tests are written afterwards by /trellis-tests.
argument-hint: [path to spec, defaults to SPEC.md]
model: opus
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node kit/bin/cli.mjs *), Bash(git status*), Bash(git log*), Bash(ls*)
---

# Plan a Trellis build

Read `$ARGUMENTS` (default `SPEC.md`). Produce exactly one artifact and stop:

**`.trellis/graph.json`** — the dependency graph, including each node's `mutations`.

You write no test files and no implementation code. `/trellis-tests` writes the
tests on a cheaper model from your contracts; open-source models write the code.
You are the most expensive model in this system and your output volume is the
binding constraint — measured at 59% of a 5-hour window on one small project.
So: dense contracts, no prose, no code.

## What replaces writing the tests

Your judgement about *how a node can plausibly be wrong* is the expensive, valuable
part. It costs a few hundred tokens as `mutations` instead of a thousand lines of
test file:

```json
"mutations": [
  "the all-domains bonus keys on domains present rather than domains completed",
  "the streak multiplier is fed the longest streak instead of the current one",
  "day keys are derived with toISOString().slice(0,10), ignoring the offset"
]
```

Each entry names one plausible-wrong implementation in plain language. After the
node passes its gate, the runner has a cheap model reintroduce each defect and
re-runs the tests. A mutant that survives means the tests cannot detect that defect
and the node is flagged. **This is how you get run-1's mutation testing without
paying run-1's token cost.**

Write two to five mutations per node. Aim at what the contract leaves *just* loose
enough to get wrong — off-by-one at a stated boundary, the wrong one of two similar
inputs, a unit or timezone ignored, an ordering swapped. A mutation nobody would
ever write is a wasted check.

## Contracts must be tight enough to test from

`/trellis-tests` sees your node and nothing else — not the spec, not this
conversation. If `goal` and `acceptance` do not fully determine the expected
behaviour, the tests will encode a guess. Every constant, boundary, unit, error
condition, and ordering rule goes in the node.

## Node sizing

One node is one engineer-hour of work for a competent mid-level developer with the
contract in front of them. If you cannot state the node's goal in three sentences,
it is two nodes.

Signs you have cut too coarse:
- the `write` array has more than about four entries
- the goal contains the word "and" joining two different capabilities
- you cannot write its test without first knowing how it will be implemented

Signs you have cut too fine:
- the node's whole job is one function under ten lines
- it has exactly one dependant and nothing else can run in parallel with it

## Dependencies are for interfaces, not for tidiness

Add an edge from A to B only when B genuinely cannot be written or tested until A
exists. Do not add edges to impose a reading order — every unnecessary edge is
parallelism you threw away.

If two nodes need to agree on an interface, do not make one depend on the other.
Write the interface yourself as a third node's output, or as a type/stub file you
create during planning, and let both read it.

## Write scopes must not collide

Two nodes with no dependency path between them can run at the same time, in separate
worktrees, and will be merged independently. If both declare write access to the same
file, you get a merge conflict. `trellis validate` rejects this, so check it yourself
first: for every pair of independent nodes, the `write` globs must be disjoint.

## Risk tagging

There are two review tags and picking the wrong one stalls the graph.

**`"risk": "high"`** — the node passes its gate and is then held **unmerged** for
you to review. Its dependants block until you merge it. Use only on *leaf* nodes,
or nodes whose dependants you are willing to stall: auth checks, payment paths,
deletion logic, anything where shipping the wrong thing is unrecoverable.

**`"risk": "audit"`** — the node merges so dependants proceed, and is flagged in the
report for you to read afterwards. Use this on foundational nodes. A root node
tagged `high` stalls its entire downstream subtree, which is almost never what you
want.

Be sparing with both. If more than about a fifth of the graph is tagged, you are
using it as a comfort blanket. Prefer a good `mutations` list over a risk tag —
mutations are checked automatically and cost you nothing.

## Graph format

```json
{
  "version": 1,
  "project": "short-name",
  "nodes": [
    {
      "id": "auth-mw",
      "title": "Session validation middleware",
      "goal": "Three sentences maximum. What must exist when this is done.",
      "role": "implementer",
      "deps": ["session-store"],
      "write": ["src/middleware/auth.js"],
      "read": ["src/session/store.js", "src/types.d.ts"],
      "tests": ["tests/middleware/auth.test.js"],
      "gate": "npm test -- tests/middleware/auth.test.js",
      "risk": "high",
      "acceptance": "Optional. Behaviour the test cannot express.",
      "notes": "Optional. Constraints, gotchas, library choices already made."
    }
  ]
}
```

- `role`: `implementer` | `fixer` | `refactorer` | `tester`
- `gate` must be scoped to this node's tests, not the whole suite. A node that runs
  the entire suite fails whenever anything else is red and tells you nothing.
- `read` is how the worker learns the interfaces it must call. Keep it short —
  cheap models degrade badly with long context. Three files is usually plenty.
- `tags`: **one or two** short labels for the *kind* of work (`adapter`, `algorithm`,
  `glue`, `crud`, `csv`). This is how the ledger generalises across runs; without
  tags every node is a sample of one and routing can never learn.

  Never use synonyms together. Tagging every adapter `["adapter","parser"]` splits
  one node's history across two tags that mean the same thing, so both take twice as
  long to reach significance and neither says anything the other doesn't. `validate`
  warns when two tags cover exactly the same nodes. Prefer the label that
  distinguishes this node from its siblings — if four adapters differ by input
  format, `csv` and `json` are useful and `parser` is not.
- `covers`: the exact scope bullets from the spec's "Scope for this run" that this
  node satisfies. `validate` fails if any bullet goes unclaimed — that is what stops
  a required step being silently dropped.

## Finish by validating

Run `node kit/bin/cli.mjs validate --plan`. The `--plan` flag downgrades "test file
does not exist" to a warning, because `/trellis-tests` has not run yet — everything
else still applies. Fix all of it, including uncovered scope bullets and any
redundant-tag warnings. Then print, in at most ten lines: node count, depth, risk
tags, and the first parallel level. Then stop.

Do not write tests. Do not run the graph. Next step is `/trellis-review`, then
`/trellis-tests`.
