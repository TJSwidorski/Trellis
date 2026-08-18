# Upgrading from 1.1.2 to 2.0.0

This is a major version because the workspace layout changed. Existing `.trellis/`
state in a repo running 1.1.x will not be understood by the new session pipeline
without the step below.

**Nothing in the runner changed.** `runner.mjs`, `gate.mjs`, `worker.mjs`,
`worktree.mjs`, `verify.mjs`, `mutate.mjs`, and `ledger.mjs` are byte-identical to
1.1.2. That core works and is tested; 2.0.0 adds layers above it rather than
rewriting it. Your existing graphs, ledger history, and routing data carry forward.

## What is new

| | |
| --- | --- |
| `MISSION.md` | Immutable core — invariants, non-goals, the protected set |
| `CONTEXT.md` | Layer 1 routing: which session handles what |
| `sessions/` | Six stage contracts, one job each |
| `references/` | Layer 3 — chiefs, skills drop point, conventions, scale tiers |
| `kit/lib/product.mjs` | Product graph validation, risk derivation, promotion, slicing |
| `kit/lib/driver.mjs` | Headless session chaining with on-disk verification |
| `kit/lib/evolve.mjs` | Proposal writing with protected-path enforcement |
| `kit/regression/` | Happy and adversarial fixtures |
| `trellis ingest / promote / slice / auto / sessions / evolve / classify / regression` | New commands |

## Migration

1. Copy your existing `trellis.config.json` values into the new one — it gained
   `driver` and `evolve` sections and kept everything else. Do not overwrite the
   new file wholesale.
2. Move `.trellis/ledger.jsonl` across if you want routing history preserved. It is
   the same format.
3. Author a product graph. This is the new required input and Trellis does not
   write it — start from `examples/product-graph.example.json`.
4. `node kit/bin/cli.mjs ingest` and fix whatever it rejects, in the source graph.
5. `node kit/bin/cli.mjs regression` should report all checks passing before you
   trust anything else.

## Behaviour changes worth knowing

- **`high_risk` is derived, not authored.** A graph that sets it is rejected. The
  derivation is one-way door, or a real security surface, or two or more dependents.
- **A v1 node depending on a v2 node is a hard failure.** v1 must ship standalone.
- **Triage rejections need structured codes.** Prose rejections still work but
  produce no evidence, so `evolve` will never surface anything.
- **`trellis auto` is off by default.** Set `driver.enabled` deliberately.

## Not implemented

Two things discussed in design and deliberately left out:

- **Automatic promotion of v2 nodes into v1.** `trellis promote` reports candidates;
  moving one is a human edit to the source graph. The computation is mechanical, the
  decision is not.
- **Quota-aware scheduling.** There is no API for remaining subscription quota, so
  the driver backs off and retries rather than predicting. `trellis sessions` gives
  you measured cost per stage to pace by hand against `/usage`.
