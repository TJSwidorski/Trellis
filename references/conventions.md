# Repo conventions

Fill this in for the project Trellis is building. Everything here is restated into
node `notes` at slice time, because **workers never see this file** — they see only
their node contract.

## Language and tooling

- Language / runtime version:
- Package manager:
- Test runner and invocation:
- Lint / format command:
- Type checking:

## Layout

- Source root:
- Test location convention:
- Where interfaces and shared types live:

## Rules workers must follow

State these as rules, not preferences. A cheap model does what it is told and
ignores what it is encouraged to consider.

- Imports use ...
- Errors are ... (thrown / returned / wrapped)
- No ... (network in unit tests, Date.now(), randomness, shared mutable state)

## Traps in this codebase

Things that have actually broken here before. This section is worth more than
everything above it, because generic best practice is already in the model and
your specific past mistakes are not.

-
