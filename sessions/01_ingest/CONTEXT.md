# Stage 01 — ingest

## Inputs

- Layer 4 (working): `.trellis/product-graph.json` — handed in, not yours
- Layer 3 (reference): `references/conventions.md`

## Process

Run `node kit/bin/cli.mjs ingest`.

That command does the work. Your job is to read what it says and decide what it
means, not to re-implement its checks by eye.

If it reports errors, **stop**. Do not fix the product graph. It is authored
outside this workspace, and a graph you silently repaired is a graph whose author
does not know it was wrong. Write the errors into your summary in the author's
language — which node, which field, what would satisfy it — and end the session.

If it validates, read the derived high-risk list. For each high-risk node, confirm
the derivation makes sense: a one-way door that is genuinely reversible, or an
interface with only one real consumer, is a signal the graph is mis-specified.
Note disagreements; do not edit.

## Outputs

- `.trellis/ingest.json` — written by the command
- `.trellis/product-graph.derived.json` — the graph with `high_risk` filled in

## Verify

Zero errors in `ingest.json`. Anything else and the pipeline stops here by design.

## Do not

- Do not author, extend, or correct the product graph.
- Do not set `high_risk` by hand. It is derived so it cannot be forgotten on the
  node where it mattered.
