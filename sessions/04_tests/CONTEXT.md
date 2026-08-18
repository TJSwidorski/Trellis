# Stage 04 — tests

## Inputs

- Layer 4 (working): `.trellis/graph.json`, `.trellis/cases.json`
- Layer 3 (reference): `references/conventions.md`

## Process

Invoke the `trellis-tests` skill. One test per accepted case id. No implementation,
no helpers, no edits to the graph.

## Outputs

- Every file listed in every node's `tests` array

## Verify

`node kit/bin/cli.mjs verify-tests` reports every gate non-vacuous.

The driver additionally checks that every declared test file exists and is not
suspiciously small, because "wrote the file, then ran out of room" leaves a
plausible-looking stub that `verify-tests` may not reach.

## Do not

- Do not soften an assertion to make a test pass. Nothing is implemented yet; red
  is the expected state.
- Do not add tests beyond the case list. If a case is missing, the gap is in
  stage 03 and belongs there.
