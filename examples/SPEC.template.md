# <project name>

## What this is
One paragraph. What it does and who for. No implementation detail.

## Stack
Fixed decisions the orchestrator must not relitigate.
- language / runtime:
- framework:
- test runner + how to run one test file:
- lint / typecheck command:
- data store:

## Scope for this run
Bullet the capabilities that must exist when this graph is green.
Anything not listed here is out of scope and must not appear in the graph.
- [ ]
- [ ]
- [ ]

## Explicitly not in scope
Naming these is what stops the graph sprawling.
-

## Interfaces already decided
Types, schemas, endpoint shapes, function signatures already fixed.
Paste them. Anything left vague here becomes a node that fails twice and escalates.

## High-risk areas
Where a passing test is not sufficient evidence of correctness.
Auth, payments, migrations, deletion, anything touching PII.
These become `risk: high` nodes and you will review their diffs by hand.
-

## Definition of done
The command that, when it exits 0, means this run succeeded.
