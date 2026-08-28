# Upgrading to 2.8.2: a merged node can be held for review after the fact

**Real behaviour break.** `verify.regateAtLevelBoundaries` defaults to `true`.
Once every node at a given dependency depth has resolved, `trellis run` now
re-runs each merged one's gate against the current `baseBranch` — catching a
node that passed its own gate in isolation but conflicts with a
dependency-level sibling now that both are actually merged together (a
shared config file edited in compatible-alone-but-incompatible-together
ways, two implementations of one interface that disagree). Each merged
node's own worktree only ever saw itself; nothing before this re-checked
what happens once a whole wave of siblings is actually on the branch
together.

**What breaks:** a node that used to end a run simply `merged` can now end
it `review` instead, with a `regate` entry in its `attempts` array, if a
level-mate's changes conflict with it. **Nothing is reverted** — the code
stays on `baseBranch` exactly as merged; the node is only held for review,
which blocks ITS OWN dependents from starting (the same as any other
`review`-status upstream), until a human resolves it.

**Fix, in order of preference:**

1. Read the two (or more) level-mates named across their `reason` fields and
   resolve the actual conflict — this is real evidence of an integration
   break the isolated gates could not see.
2. Set `verify.regateAtLevelBoundaries: false` in `trellis.config.json` to
   restore the old behaviour (each node's own gate is the only check that
   ever runs) project-wide.

# Upgrading to 2.7.3: `trellis run` now requires verify-tests

**Real behaviour break.** `verify.requirePrecondition` defaults to `true`. `trellis
run` now refuses to start if any node with tests has never been proven non-vacuous
by `trellis verify-tests`, or if its tests changed since the last time they were
proven. Previously `verify-tests` was an optional command an operator had to
remember to run — nothing stopped a node with vacuous or unchecked tests from
running for real money.

**What breaks:** any existing project's `trellis run` that has not first run
`trellis verify-tests` (or ran it before this upgrade, before `.trellis/verified.json`
existed) will die with a list of nodes needing verification.

**Fix, in order of preference:**

1. Run `node kit/bin/cli.mjs verify-tests` once — it writes `.trellis/verified.json`
   and `run` proceeds normally from then on. Re-run it whenever a node's frozen
   tests change; `run` will tell you exactly which node needs it.
2. Pass `--skip-verify` to `trellis run` to bypass the check for a single invocation
   without touching config.
3. Set `verify.requirePrecondition: false` in `trellis.config.json` to restore the
   old behaviour (verify-tests as a fully optional command) project-wide.

`.trellis/verified.json` is new, generated state — safe to delete or `.gitignore`
like the rest of `.trellis/*.json` besides `graph.json`.

---

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
