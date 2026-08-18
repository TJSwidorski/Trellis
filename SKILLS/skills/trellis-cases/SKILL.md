---
name: trellis-cases
description: Enumerate edge cases and corner conditions for every node in a Trellis slice, before any test is written. Use after `trellis slice` has produced .trellis/plan.json and .trellis/graph.json, or when the user asks to brainstorm cases, find corner cases, or strengthen coverage for a Trellis build.
model: opus
context: fork
allowed-tools: Read, Write, Glob, Grep, Bash(node kit/bin/cli.mjs *)
---

# Enumerate the cases

Read `.trellis/plan.json` and `.trellis/graph.json`. For every node, produce the
list of behaviours that must be true — then write `.trellis/cases.json` and stop.

You write no tests. That is stage 04, and separating the two is the point: a test
written straight from acceptance criteria tests what somebody already thought of.
This stage exists to find what nobody wrote down.

## Why this is a separate stage

Test volume expands to fill whatever budget it is given. In a previous run, moving
test-writing to a cheaper model produced 135 tests where the planner had produced
45 — three times the tests, not three times the coverage, and no saving at all.

Enumerating cases first fixes that. Each case gets a stable id; stage 04 writes
exactly one test per accepted id. Coverage becomes auditable and volume becomes a
decision rather than a side effect.

## The seven questions

For each node, walk these in order against its `acceptance` bullets. Most nodes
yield cases in three or four categories; a node yielding cases in none is either
trivial or under-specified, and you should say which.

1. **Empty and absent.** Zero items, empty string, null, missing field, an
   optional that is legally absent. What is the correct answer, not just the
   non-crashing one?
2. **Boundary.** One below, exactly at, one above every threshold the contract
   names. Off-by-one lives here and nowhere else.
3. **Repetition and order.** Called twice. Called out of order. Duplicate input.
   Does the second call do the same thing as the first, and should it?
4. **Type and shape edges.** Wrong type where the language allows it. Unicode
   where ASCII was assumed. A number that is `0`, negative, or floating point
   where an integer was meant.
5. **Time and locale.** Timezone offsets that cross local midnight. DST
   transitions. Month and year rollovers. Sorting where locale changes the answer.
6. **Failure of a dependency.** The call this node makes throws, times out, or
   returns a shape it should not. What is the contract's answer?
7. **Scale.** At the node's declared `scale_tier`, does anything here become
   quadratic, unbounded, or serialised? This one produces a note more often than a
   test, and the note is still worth writing.

## Applying the lenses

Load only the chiefs named in the node's `lenses`, plus `references/skills/<lens>/`
for each. A backend node does not need the frontend lens in context, and the
irrelevant material measurably degrades work on the relevant part.

The chiefs carry the trap lists. Those traps are cases: "validation written from
the happy path" means the node needs a case where an invalid input is rejected,
not merely one where a valid input passes.

## The output

```json
{
  "nodes": {
    "auth.session": {
      "cases": [
        {
          "id": "auth.session.c01",
          "behaviour": "expired token is rejected even if the signature is valid",
          "why": "boundary — expiry is checked separately from signature",
          "mutation": "checks signature only and ignores exp"
        }
      ],
      "contract_gaps": ["contract does not say whether a clock-skew grace window applies"]
    }
  }
}
```

- `id` — stable, `<node-id>.cNN`. Stage 04 writes one test per id.
- `behaviour` — what must be true, phrased so a test could fail it.
- `why` — which of the seven questions produced it. Forces the enumeration to be
  systematic rather than associative.
- `mutation` — optional. A plausible-wrong implementation this case would catch.
  These flow into the node's `mutations` array and get reintroduced after the node
  passes; the tests must catch each one.

## Contract gaps

When you find a case whose expected value you **cannot compute by hand from the
contract**, do not invent one. Record it in `contract_gaps` for that node.

This matters more than it looks. A guessed expected value becomes a frozen oracle,
and every downstream worker will faithfully satisfy the wrong answer. A recorded
gap is a five-minute fix at plan time; a wrong oracle is discovered in production.

## Budget

Aim for six to twelve cases per node. Fewer than four on a non-trivial node means
you stopped at the acceptance bullets. More than fifteen usually means you are
enumerating input permutations rather than distinct behaviours — collapse them.

## Finish

1. Confirm every node id in `plan.json` has a non-empty case list. A file covering
   the first eight of twenty nodes is what a budget-exhausted session leaves; the
   driver checks this mechanically and will re-run you.
2. Confirm every acceptance bullet maps to at least one case id.
3. Summarise in at most fifteen lines: case counts per node, every contract gap,
   and any node where the seven questions produced nothing.
