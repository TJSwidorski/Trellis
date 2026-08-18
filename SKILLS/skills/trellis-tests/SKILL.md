---
name: trellis-tests
description: Write the frozen test files for a Trellis graph, one test per enumerated case id. Use after the cases session has produced .trellis/cases.json, or when the user asks to write, regenerate, or strengthen the frozen tests for a Trellis build.
model: sonnet
context: fork
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node kit/bin/cli.mjs *), Bash(node --check *), Bash(node --test *), Bash(git status*), Bash(git add*), Bash(git commit*)
---

# Write the frozen tests

Read `.trellis/graph.json` and `.trellis/cases.json`. For every node, write every
file listed in its `tests` array. Write nothing else — no implementation, no helpers
under `src/`, no changes to the graph or the cases.

**One test per case id. Not more, not fewer.** The cases session already decided
what needs covering; your job is to express each decision as an assertion, not to
re-open the question. Name each test with its case id so coverage is auditable:

```js
test("auth.session.c01 — expired token is rejected even if the signature is valid", ...)
```

This cap exists for a measured reason. When test-writing was previously run
without it, volume expanded to fill the available budget — 135 tests where the
planner had written 45, with no corresponding gain in coverage and no saving in
quota. A test with no case id behind it is volume, not coverage.

You run on a cheaper model than the planner, in a forked context, because this is
high-volume work from an already-precise contract. Two consequences:

- **The node plus its cases are your whole specification.** `goal`, `acceptance`,
  `notes`, `mutations`, and the node's entry in `cases.json` fully determine what
  to assert. Do not go looking for the spec file or infer intent from elsewhere; if
  a case is ambiguous, say so in your summary rather than guessing quietly. A
  guessed expected value becomes a frozen oracle that every downstream worker will
  faithfully satisfy.
- **Your output is verified mechanically.** `trellis verify-tests` proves every gate
  rejects a null stub, and after each node passes, its `mutations` are reintroduced
  and the tests must catch them. Weak tests get caught. Write to survive that.

## The two properties that matter

**Non-vacuous.** The test must FAIL against a module whose exports all return
`null`. Before writing an assertion, ask what it would do against `null`. Assertions
like `assert.ok(result !== undefined)` or `assert.doesNotThrow(...)` pass against
almost anything and are worthless.

**Discriminating.** For every entry in the node's `mutations`, at least one
assertion must fail if that defect is present. Work through the list explicitly:

> mutation: "day keys use toISOString().slice(0,10), ignoring the offset"
> → needs a case with a non-zero offset that crosses local midnight, where the
>   naive answer and the correct answer differ.

If you cannot construct a case that distinguishes a mutation, say so in your
summary. That is a real finding — it usually means the contract is underspecified.

## Writing the tests

- `node --test` with `node:assert/strict`. No frameworks, no dependencies.
- Import through the exact path in the node's `write` array, using the exact export
  names in the contract. A wrong import path fails the whole node for no reason.
- One behaviour per test. Name the test after the behaviour, not the function.
- Cover: the stated happy path, every boundary the contract names explicitly, and
  every error condition the contract says throws.
- Use exact expected values, computed by hand from the contract. Never compute the
  expected value with the same logic the implementation would use — that passes
  against any consistent implementation, including a wrong one.
- No sleeps, no network, no `Date.now()`, no randomness, no shared mutable state.
- For floating point, assert within an explicit tolerance and say why.

## Do not

- Do not modify `.trellis/graph.json`. If a contract is wrong, report it.
- Do not write implementation code, not even a helper the tests import.
- Do not write integration tests spanning several nodes unless a node explicitly
  asks for one — per-node gates must stay independent or one failure reddens many.
- Do not soften an assertion to make a test pass. Nothing has been implemented yet;
  a failing test at this stage is the expected state.

## Finish

1. `node --check` every file you wrote, and confirm every case id in
   `cases.json` appears in exactly one test name. A missing id is uncovered work;
   a duplicated id is inflation.
2. `node kit/bin/cli.mjs verify-tests` — this must report every gate as non-vacuous.
   If a node comes back `vacuous`, strengthen it and re-run. Do not stop until clean.
3. Commit the test files.
4. Summarise in at most fifteen lines: files written, case ids covered against
   case ids declared, any mutation you could not construct a discriminating case
   for, and any contract ambiguity you had to resolve — state what you chose and
   what the alternative was.

That last item matters more than it looks. A resolved ambiguity that nobody reads
becomes a wrong answer frozen into the oracle, and every downstream worker will
faithfully satisfy it.
