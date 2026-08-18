---
name: trellis-review
description: Adversarially review a Trellis graph against its spec before any tests are written. Use after /trellis-plan, when the user asks to check, critique, or sanity-check a graph, or before committing to an expensive run.
argument-hint: [path to spec, defaults to auto-detect]
model: opus
context: fork
allowed-tools: Read, Glob, Grep, Bash(node kit/bin/cli.mjs validate*)
---

# Adversarial review of a Trellis graph

Read the spec and `.trellis/graph.json`. **Do not read the tests** — they may not
exist yet, and if they do, reading them will anchor you to the same assumptions
that produced them.

You are not the planner. You did not write this graph and you have no memory of
the reasoning behind it. That is the entire value you provide: a plan's author is
blind to its own assumptions in a way a fresh reader is not. Your job is to find
what the author could not see.

**You do not edit anything.** Output findings. The planner fixes them.

## The finding that justifies this pass

In a real run, a planner resolved `cal ↔ kcal` as the scientific factor of 1000,
correctly noted it had resolved an ambiguity, and froze the result: a logged meal
of "640 cal" became **0.64 kcal**. Scientifically right, obviously absurd as food.
Every downstream check passed, because every downstream check measured conformance
to the contract rather than conformance to reality.

No validator catches that. A reader does, in about two seconds. Look for its cousins.

## What to look for, in order

**1. Absurd values.** Take every constant, unit, conversion, and threshold in the
graph and ask what it produces on a realistic input. A meal of 0.64 kcal. A
timeout of 3 milliseconds. A price of $0.004. A streak of 400 days in a two-week
history. Anything that would make a domain expert blink.

**2. Ambiguities the planner resolved silently.** Anywhere the contract states a
rule with more precision than the spec did, the planner made a choice. Find those
choices and ask whether the *other* reading is the one a user would expect.
Conventions beat correctness here: "cal" on a nutrition label means kcal no matter
what physics says.

**3. Scope drift, both directions.** Does every scope bullet in the spec have a
node claiming it in `covers`? Does any node build something the spec did not ask
for, or that the "Explicitly not in scope" section forbids?

**4. Contracts too loose to test from.** `/trellis-tests` sees only the node. For
each one, ask: could a competent engineer write the test from this alone, without
the spec? If `goal` and `acceptance` leave a constant, boundary, ordering, or error
condition undetermined, the tests will encode a guess.

**5. Mutations that aren't real.** Each `mutations` entry should name a defect a
real implementation would plausibly have. Entries that are absurd on their face
("returns a string instead of a number") burn a check on nothing. Also flag the
*missing* mutation: the plausible-wrong implementation nobody listed.

**6. Structure.** Edges that encode reading order rather than a real interface
dependency, and so throw away parallelism. Nodes doing two things at once. A
foundational node tagged `risk: high` — that stalls its whole downstream subtree
and should almost always be `audit`.

## Output

A numbered list. For each finding: severity (**blocking** / **worth fixing** /
**note**), the node id, what is wrong, and what you would change it to.

Then one line: proceed, or fix first.

Be specific and be brief. A review that restates the graph back is worthless; the
planner has already read it. Say only what it got wrong. If the graph is sound,
say so in two lines — a short review is a legitimate result, and padding it wastes
the tokens this pass exists to save.
