# Stage 02 — slice

## Inputs

- Layer 4 (working): `.trellis/product-graph.derived.json`, `.trellis/built.json`
- Layer 3 (reference): `references/conventions.md`, `references/scale-tiers.md`

## Process

Run `node kit/bin/cli.mjs slice --max 25`.

The cut is mechanical: unbuilt nodes of the target version, taken in whole
dependency LEVELS — nodes whose deps are already built, then the nodes that
unblocks, and so on — capped by node count. A level is never split: the slice
stops before starting a level it can't finish, even if that level alone would
have fit inside a few more nodes of headroom. The exception is a level that
is oversized all by itself, which is taken whole anyway (`overflowed: true`
in `plan.json`) — a level cannot be half-planned. You do not choose the
nodes, and you do not choose which level a node lands in.

What you do choose is what happens next. Read the resulting `plan.json` and, for
each node, produce the *implementation* contract the runner needs — `write` paths,
`read` context, `gate` command, `tags`, `mutations` — and assemble
`.trellis/graph.json` in the task-graph schema (`kit/schema/graph.schema.json`).

**Stamp `"cycle"` at the top of `graph.json`, copied verbatim from
`.trellis/cycle.json`'s `id` field.** `plan.json` already carries it — the CLI wrote
that one — but `graph.json` is your work, and nothing else can stamp it for you.
Without it, this stage's proof of completion cannot tell a graph you assembled for
this pass from one left over from an earlier one, and a second `trellis auto` would
report the stage already satisfied without you ever having run.

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

- Do not manually add nodes to a slice because the remainder "is small" — an
  `overflowed: true` slice is the tool's own atomic-level decision, not
  license for you to do the same thing by hand elsewhere.
- Do not write tests here. That is stage 04, after cases are enumerated.
