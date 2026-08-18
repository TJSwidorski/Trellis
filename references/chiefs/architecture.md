# Architecture lens

Loaded for `kind: interface` and `kind: infra` nodes, and any node with two or
more dependents.

## Why interface nodes are treated specially

Per-node gates are independent by design — one node's failure must not redden
others. The cost of that independence is that **no test in the system checks
whether two nodes agree.** Node A satisfies its contract, node B satisfies its
contract, and the signature between them differs.

The mitigation is structural, not procedural: where two or more nodes consume the
same signature, the interface file is written during slicing, before either node
is dispatched, and both nodes read it. Delegating that file to a worker
reintroduces the exact failure it exists to prevent.

## Rules

- One writer per file, always. Concurrent write scopes must be disjoint.
- Shared types live in a node that both consumers depend on. Never duplicated.
- A module that both reads and writes shared state is two nodes.
- Public contracts — anything a user, another service, or a persisted record
  depends on — are one-way doors. Mark them so.

## At triage

For each interface node, read the diff against its consumers even if everything
went green. The gate proved each side does what its test says; nothing proved the
tests describe the same contract.
