# Scale tiers

Every node declares the user count at which it must still hold. This file says
what that means, so `scale_tier: "1000"` is a testable claim rather than a hope.

The purpose is not to build for 100k on day one. It is to know **which decisions
are cheap to defer and which are one-way doors**, so you defer the first kind
deliberately and review the second kind carefully.

| Tier | What holds | First thing that breaks at the next tier |
| --- | --- | --- |
| 1 | Anything. Local files, in-process state, synchronous everything. | Concurrent writes corrupt state; no isolation between users. |
| 10 | Single process, a real database, sessions in memory. | Restart loses sessions; one slow request blocks others. |
| 100 | Connection pooling, background jobs off the request path, stateless app tier. | N+1 queries and missing indexes dominate; no cache means the DB is the ceiling. |
| 1,000 | Indexed queries, caching with explicit invalidation, horizontal app scaling, real observability. | Single-writer DB saturates; hot keys and lock contention appear. |
| 10,000 | Read replicas, queue-backed writes, rate limiting, partitioned hot tables. | Cross-partition transactions and global uniqueness constraints break down. |
| 100,000 | Sharding with a chosen key, eventual consistency where it is acceptable, multi-region. | You are past what a checklist helps with. |

## How to use this at planning time

For each node, ask two questions:

1. **What breaks first at the tier above this one?** Write it in the node notes.
   Not to build it now — to know what you are choosing not to build.
2. **Is this decision reversible?** Data model shape, primary key choice, auth
   model, multitenancy boundary, public API contract, and billing structure are
   one-way doors. Everything else is usually a two-way door.

One-way doors derive `high_risk` automatically and get read at triage regardless of
whether their gates went green. That is not conservatism; it is that a gate proves
the code does what the test says, and the test cannot ask whether the shape was
right.

## The scaling failure Trellis is trying to prevent

Generated software fails at scale in a specific way: it works perfectly at the
tier it was tested at and has no seams for the next one. Not because the code is
wrong, but because nobody wrote down which assumptions were load-bearing.

The mitigation is boring and effective — make the assumption explicit at plan time,
attach it to the node, and let it surface at triage.
