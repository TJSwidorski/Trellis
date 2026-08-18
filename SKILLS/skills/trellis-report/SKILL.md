---
name: trellis-report
description: Triage a finished Trellis run. Use after `trellis run` completes, or when the user asks what failed, what needs review, or what to do next about a Trellis build.
model: opus
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git diff*), Bash(git log*), Bash(git merge*), Bash(git branch*), Bash(node kit/bin/cli.mjs *)
---

# Triage a Trellis run

Read `.trellis/REPORT.md`. **Read nothing else first.** The report was written to be
the whole interface — the per-attempt chatter is in `.trellis/run.jsonl` and you
almost never need it.

Work the sections in this order.

## 1. Nodes that need a decision

For each exhausted or conflicted node, pick exactly one of four moves and say which:

**Re-decompose.** The node was too big. Split it into two or three nodes with
narrower goals, write their tests, add them to the graph, remove the original.
This is the right move most of the time and it is the cheapest.

**Rewrite the contract.** The failure trail shows the model solving a different
problem than you meant. The goal or the test was ambiguous. Fix the wording or the
test, leave the shape alone.

**Take it yourself.** Only when the node is genuinely hard: novel algorithm, subtle
concurrency, something where the failure trail shows real conceptual confusion rather
than sloppiness. Write it, commit it, mark the node merged in the graph for the next
run.

**Cut it.** The node was not actually needed. Say so and remove it.

Read the failure trail before deciding. The pattern tells you which move:

| Trail | What it means | Move |
| --- | --- | --- |
| `test-tampering` early | The test was hard or felt wrong to the model | Check the test is actually satisfiable, then re-decompose |
| `out-of-scope` repeatedly | The node needs a file it was not given | Widen `write`, or split out the missing piece as its own node |
| `test-failure` × N, different each time | Model does not understand the goal | Rewrite the contract |
| `test-failure` × N, converging | Node is too big to hold at once | Re-decompose |
| `no-files` or `malformed` | Output format problem, not a capability problem | Usually fixed by a shorter `read` list |
| `provider-error` | Nothing to do with the task | Re-run with `--resume --retry-failed` |

## 2. High-risk nodes held for review

These passed their gates. Your job is the judgement the test cannot make: is the
auth check actually checking the right thing, does the migration lose data, is the
deletion scoped correctly.

For each, run the `git diff` line the report gives you. Read the diff, not the whole
file.

If it is right, tell the human to run `node kit/bin/cli.mjs accept <id> --merge`.
**Merging the branch by hand is not enough** — Trellis learns the outcome only
through `accept`, and until it does, the node still reads `review` and its
dependants will never launch. A `--resume` that finishes in 0.1s having done
nothing is this mistake.

If it is wrong, describe precisely what is wrong, then either have the human run
`reject <id>` after you fix the contract, or turn it into a `fixer` node.

## 3. Blocked nodes

These never ran. They unblock automatically once their upstream lands. No action
beyond fixing the upstream.

## 4. The decomposition signal

If several nodes needed a stronger tier than the cheapest, that is feedback about
your planning, not about the models. Read those nodes' goals and ask whether they
were doing two things at once. Say what you would cut differently next time — this
is the one part of triage that makes the *next* run cheaper.

## Then stop

Update `.trellis/graph.json` if you changed the shape, run
`node kit/bin/cli.mjs validate`, and tell the human to re-run with
`--resume`. Do not start implementing.
