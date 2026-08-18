# Backend lens

Loaded for `kind: backend` and `kind: data` nodes.

## Hard rules

- Every write that must not run twice is idempotent, or protected by a uniqueness
  constraint the database enforces. Retries happen; assume them.
- Transactions wrap the whole unit of work, not each statement in it.
- Timeouts on every outbound call. A call with no timeout is a call that hangs
  forever exactly once, in production.
- Errors are typed and distinguishable. A single `Error("failed")` at a boundary
  makes every caller guess.
- Nothing unbounded: no query without a limit, no queue without a ceiling, no
  retry without a cap.

## Traps specific to generated code

- **N+1 queries in a loop that reads perfectly.** The code is clear, the plan is
  quadratic.
- **Optimistic concurrency assumed, never enforced.** Read-modify-write with no
  version check passes every single-threaded test.
- **Time handled in local time somewhere in the middle**, which works until an
  offset crosses midnight.
- **Migrations that are not reversible** and were never run against data.

## At planning time

Name the consistency requirement out loud in the node notes. "Eventually
consistent is fine here" and "this must be atomic with the row above it" produce
very different implementations, and a cheap model will pick whichever is easier if
nobody says.
