# Stage 03 — cases

## Inputs

- Layer 4 (working): `.trellis/plan.json`, `.trellis/graph.json`
- Layer 3 (reference): `references/chiefs/` (per node `lenses`), `references/scale-tiers.md`

## Process

Invoke the `trellis-cases` skill. Its job is adversarial enumeration: for every
node, what could be true that the acceptance bullets did not say.

This stage exists because tests written directly from acceptance criteria test
what someone already thought of. The interesting defects live in what nobody wrote
down — the empty collection, the second call, the timezone at the boundary, the
duplicate submit, the field that is legally null.

Each case gets a stable id. Stage 04 writes exactly one test per accepted case id,
which is what makes coverage auditable and stops test volume from inflating to
fill whatever budget it is given.

Load only the chief documents named in each node's `lenses`. A node with no
security surface does not need the security chief in context.

## Outputs

- `.trellis/cases.json` — `{ cycle, nodes: { <node-id>: { cases: [{ id, behaviour, why, mutation? }] } } }`
  — `cycle` is `.trellis/cycle.json`'s `id`, copied verbatim. Without it this
  stage's proof of completion cannot tell a cases file you wrote this pass from
  one left over from an earlier one.

## Verify

Every node in `plan.json` has a non-empty case list, and `cases.json`'s `cycle`
matches the current one. The driver checks both mechanically; a well-formed file
covering the first eight of twenty nodes is exactly what a budget-exhausted
session leaves behind.

Cross-stage check: every acceptance bullet in `plan.json` maps to at least one
case id. An unclaimed bullet means an acceptance criterion nobody will test.

## Do not

- Do not write tests here.
- Do not invent cases the contract cannot decide. A case whose expected value you
  cannot compute by hand from the contract is a contract gap — record it as such.
