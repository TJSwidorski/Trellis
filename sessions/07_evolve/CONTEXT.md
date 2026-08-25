# Stage 07 — evolve

**Periodic.** This stage is not in the default `trellis auto` chain and should not
run every run. Reach it deliberately:

```
node kit/bin/cli.mjs auto --stage 07_evolve
```

## Inputs

- Layer 4 (working): the output of `node kit/bin/cli.mjs evolve --json --top 5`,
  **and nothing else.**
- Layer 3 (reference): `references/EVOLUTION.md`, `references/TOOLING.md`,
  `references/CODES.md`

The exclusions are the point of this stage, so they are named rather than implied.
Do not read `.trellis/ledger.jsonl`, `.trellis/run.jsonl`, `.trellis/triage.jsonl`,
`.trellis/friction.jsonl`, `.trellis/skills.jsonl`, `REPORT.md`, worker transcripts,
or any diff. Those files are the *input to the counting*, and the counting already
happened, mechanically, for free. Reading them spends the one resource this system
is built to conserve in order to re-derive a number you have already been handed.

If the shortlist is empty, there is nothing to do. Write the artifact saying so and
stop. That is a correct outcome, not a failure to find something.

## Process

For each pattern on the shortlist, walk the table in `references/TOOLING.md` from
the top and **stop at the first row that fits.** Do not survey all the rows and
pick the most interesting; the ordering is the judgement, and skipping past the
cheap rows is the specific failure this stage exists to prevent.

`suspects` on a shortlist row names the artifact the vocabulary thinks the code
indicts. Start there.

**At most two proposals per pass.** If more than two patterns deserve action, the
two you pick are the ones with the most distinct runs behind them; the rest keep
accumulating evidence and will still be there next pass. A pass that produces six
proposals has stopped choosing.

Every pattern gets a decision. A pattern you decline is recorded with the row you
declined it at and why — usually "the evidence is real but a contract fix already
landed for it" or "this is one project's habit, not a fact about Trellis".

Write proposals with the command, never by hand:

```
node kit/bin/cli.mjs propose --title "..." --targets a,b --kind tooling \
  --evidence <file> --alternatives <file> --cost <file> --reversal <file> \
  --from-evolve-stage
```

The command is what enforces the protected-path refusal, the tier, the numbering,
and the retirement condition. Formatting the markdown yourself bypasses all four.

## Outputs

- `evolution/proposals/NNN-*.md` — at most two, written via `trellis propose`
- `.trellis/evolve.json` —
  `{ run, consideredCodes: [], proposals: [relpath], declined: [{ code, row, why }] }`

## Verify

`consideredCodes` must be a superset of every code `trellis evolve` currently
reports, and `consideredCodes.length` must equal `proposals.length +
declined.length`.

This is stage 06's rule transplanted. There, silence on a stuck node is not
acceptance. Here, silence on a shortlisted pattern is not a decline — you may
decide a pattern deserves nothing, but you may not simply not mention the one you
would rather not think about.

## Do not

- Do not read raw logs. See Inputs.
- Do not propose changes to protected paths. `trellis classify <path>` will tell
  you which bucket a file is in.
- Do not widen `references/CODES.md`. Naming a new code is a human's decision;
  a loop that can extend its own vocabulary can manufacture a threshold.
- Do not write a proposal for a code that is not on the shortlist. If you believe
  something recurs that the counting missed, that is a bug in the counting and
  belongs in a friction record, not a proposal.
- Do not propose more than two changes in one pass.
