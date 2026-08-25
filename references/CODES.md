# Codes — the vocabulary self-improvement counts in

Triage records a **structured code**, not prose. "The error handling is sloppy"
cannot be counted across runs; `unhandled-error-path` can, and nine occurrences of
it is evidence that stage 03 is missing a case category.

That only works if everyone spells it the same way. `unhandled-error`,
`unhandled-error-path`, and `missing-error-handling` are three codes as far as
counting is concerned, and three codes at one occurrence each never reach a
threshold of three. This file is the shared spelling.

## How to use it

```
node kit/bin/cli.mjs codes                    # list
node kit/bin/cli.mjs codes --explain <code>   # what it means and what it indicts
```

Pick the closest code. **If nothing fits, use your own words** — the record is
still written, bucketed as `other:<your-words>`, and it shows up under
`trellis evolve --unknown` as vocabulary pressure. What it can never do is reach a
threshold and trigger a proposal.

That asymmetry is deliberate. A session forced to choose from a closed list will
pick the nearest wrong code rather than record nothing, and a wrong code is worse
than an unknown one: it inflates an unrelated pattern toward acting on evidence
that was never about it. Bucketing keeps novel failures visible without letting
them act.

## Adding a code

When `trellis evolve --unknown` shows an `other:` bucket clearing the run
threshold, that is the signal to add it here. A human does that — deliberately, in
a commit. The loop cannot widen its own definition of what counts as evidence.

`suspects` names the artifact a recurring code probably indicts. It is a starting
point for the decision table, not a verdict.

---

## Rejection codes

Written by stage 06 when a node is rejected.

### unhandled-error-path

A failure mode the code can actually reach has no handling, and no case asked for
one. The canonical example: the happy path is complete and correct, and the
network call it depends on has no failure branch at all.

### happy-path-only-test

The test asserts the valid input succeeds and nothing asserts the invalid one is
rejected — so the rejecting branch may not exist. Distinct from
`unhandled-error-path`: there the code is wrong, here the *oracle* is.

### test-too-weak

The gate passed and a mutation survived, or the test would pass against an
implementation that is obviously wrong in a way the test never asks about. The node
is green and the contract was not proven.

### missing-boundary-validation

Input crossing a trust boundary is validated deep inside the call stack, or not at
all, rather than at the boundary where the caller's assumptions are still visible.

### authz-not-checked-at-resource

Authorisation checked at the route rather than at the resource — a route guard plus
a direct object reference. Includes authentication mistaken for authorisation.

### secret-in-source

A credential, key, or token reached source, tests, fixtures, logs, or an error
message.

### missing-timeout

An outbound call with no timeout. Hangs forever exactly once, in production.

### unbounded-operation

A query with no limit, a queue with no ceiling, a retry with no cap, a buffer that
grows with input.

### non-idempotent-write

A write that must not run twice is neither idempotent nor protected by a uniqueness
constraint the database enforces. Retries happen.

### n-plus-one

A loop that reads perfectly and is quadratic against the database.

### contract-underspecified

The node contract did not say enough for any worker to succeed, and the failure is
the contract's rather than the implementation's. The tell is every tier failing the
same way.

### node-too-large

The node bundled several changes and no tier could land all of them. Distinct from
`contract-underspecified`: the contract was clear and simply asked for too much.

### interface-drift

An interface with two or more consumers changed for one of them. The other still
compiles and is now wrong.

### design-slop

Structure that works and will not survive contact with the next node — the
abstraction is at the wrong level, the seam is in the wrong place, or the thing has
no name anyone would guess.

---

## Friction codes

Written by a session via `trellis friction` to record work it did by hand. These
answer a different question from rejection codes: not "what was wrong with the
software" but "what was expensive about building it".

### hand-tightened-contract

Edited a node contract, case list, or test by hand to get it right. The one that
matters most — three of these on the same target is the edit-source principle
telling you the fix belongs upstream.

### re-derived-context

Worked something out that an earlier session had already worked out, because it was
not on disk.

### manual-artifact-fixup

Repaired a malformed or incomplete artifact written by an earlier stage.

### missing-mechanical-check

Verified something by reading that a script could have verified. The strongest
signal for the "plain code" row of the decision table.

### repeated-lookup

Read the same reference more than twice in one session to answer the same question.

### missing-tool

Wanted a capability that does not exist — a command, a skill, a subagent.

### unreported-suspected

Reserved. Written by the contradiction detector in `evolve`, never by a session: it
records that a stage asserted `none` on a run whose mechanical record shows
otherwise. It counts across runs like any other code and accuses no single session.

---

The block below is what the kit parses. The prose above is what a human reads;
`trellis codes` checks the two stay in sync.

<!-- codes:begin -->
```json
{
  "schema": "trellis.codes/1",
  "rejection": {
    "unhandled-error-path": { "suspects": ["sessions/03_cases/CONTEXT.md"] },
    "happy-path-only-test": { "suspects": ["sessions/03_cases/CONTEXT.md", "sessions/04_tests/CONTEXT.md"] },
    "test-too-weak": { "suspects": ["sessions/04_tests/CONTEXT.md", "references/worker-trust.md"] },
    "missing-boundary-validation": { "suspects": ["references/chiefs/security.md", "sessions/03_cases/CONTEXT.md"] },
    "authz-not-checked-at-resource": { "suspects": ["references/chiefs/security.md"] },
    "secret-in-source": { "suspects": ["references/chiefs/security.md"] },
    "missing-timeout": { "suspects": ["references/chiefs/backend.md"] },
    "unbounded-operation": { "suspects": ["references/chiefs/backend.md", "references/scale-tiers.md"] },
    "non-idempotent-write": { "suspects": ["references/chiefs/backend.md"] },
    "n-plus-one": { "suspects": ["references/chiefs/backend.md", "references/chiefs/optimization.md"] },
    "contract-underspecified": { "suspects": ["sessions/02_slice/CONTEXT.md"] },
    "node-too-large": { "suspects": ["sessions/02_slice/CONTEXT.md"] },
    "interface-drift": { "suspects": ["references/chiefs/architecture.md", "sessions/02_slice/CONTEXT.md"] },
    "design-slop": { "suspects": ["references/chiefs/architecture.md"] }
  },
  "friction": {
    "hand-tightened-contract": { "suspects": ["sessions/03_cases/CONTEXT.md", "sessions/02_slice/CONTEXT.md"] },
    "re-derived-context": { "suspects": [] },
    "manual-artifact-fixup": { "suspects": [] },
    "missing-mechanical-check": { "suspects": [] },
    "repeated-lookup": { "suspects": [] },
    "missing-tool": { "suspects": [] },
    "unreported-suspected": { "suspects": [] }
  }
}
```
<!-- codes:end -->
