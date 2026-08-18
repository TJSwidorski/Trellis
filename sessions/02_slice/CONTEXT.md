# Stage 02 — slice

## Inputs

- Layer 4 (working): `.trellis/product-graph.derived.json`, `.trellis/built.json`
- Layer 3 (reference): `references/conventions.md`, `references/scale-tiers.md`

## Process

Run `node kit/bin/cli.mjs slice --max 25`.

The cut is mechanical: unbuilt nodes of the target version whose dependencies are
already built, in dependency order, capped. You do not choose the nodes.

What you do choose is what happens next. Read the resulting `plan.json` and, for
each node, produce the *implementation* contract the runner needs — `write` paths,
`read` context, `gate` command, `tags`, `mutations` — and assemble
`.trellis/graph.json` in the task-graph schema (`kit/schema/graph.schema.json`).

Two rules that prevent the failure modes we have actually hit:

- **Write scopes must be disjoint across nodes that can run concurrently.** Two
  nodes writing the same file is a merge conflict the runner cannot resolve.
- **Where two or more nodes consume the same signature, write the interface file
  yourself during this stage.** Nodes agreeing on a contract by coincidence is
  where integration breaks come from, and no per-node test catches it.

Keep each node's `read` list to about three files. Cheap models degrade with long
context, and a bloated read list is the most common cause of a worker emitting no
file blocks at all.

## Outputs

- `.trellis/plan.json` — written by the command
- `.trellis/graph.json` — the task graph you assemble
- Any interface files the slice needs, committed

## Verify

`node kit/bin/cli.mjs validate --plan` passes. Tests do not exist yet, so `--plan`
downgrades that to a warning.

Cross-stage check: every node id in `plan.json` appears in `graph.json`. A node
that got dropped between the two files is silently descoped work.

## Do not

- Do not exceed the cap because the remainder "is small".
- Do not write tests here. That is stage 04, after cases are enumerated.
