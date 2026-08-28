# Trellis

**Product graph in, working software out.** Claude Code orchestrates, open-source
models implement, and the loop lives in code.

Version 2.8.3. Coming from 1.1.x, read `UPGRADING.md` first — the runner is
unchanged, but the workspace layout is not. See `CHANGELOG.md` for what has
changed since 2.0.0.

## Start here

| If you want to | Read |
| --- | --- |
| Know what this is for and what it will never do | `MISSION.md` |
| Know which session handles what | `CONTEXT.md` |
| Do one stage of work | `sessions/NN_*/CONTEXT.md` |
| Add your own skills and conventions | `references/skills/SKILLS.md` |
| Understand how Trellis changes itself | `references/EVOLUTION.md` |
| Migrate from 1.1.x | `UPGRADING.md` |
| See what changed release to release | `CHANGELOG.md` |

## The shape of it

```
product graph  ->  ingest  ->  slice  ->  cases  ->  tests  ->  RUN  ->  triage
   authored        derive     <=25       enumerate   frozen    no       accept /
   outside you     risk       nodes      edges       oracle    tokens   reject
                                                                          |
                                       <----------- next slice -----------+
```

The top row is sequential and human-reviewable, so it is organised as folders and
plain markdown — one stage, one job, one context window. The `RUN` step is
concurrent worker dispatch and stays in code, because that is the part a filesystem
protocol is bad at.

Everything above `RUN` produces artifacts. Nothing above `RUN` claims completion:
each stage is verified by reading disk after the process exits, which is what stops
a budget-exhausted session from reporting success on work it did not do.

## What is new in 2.0.0

- **Product graph as the input contract.** Authored outside Trellis, validated
  unforgivingly at ingest. `high_risk` is derived, never authored, so it cannot be
  forgotten on the node where it mattered.
- **Mechanical v1/v2 analysis.** `trellis promote` computes which v2 nodes are
  actually unblocked instead of leaving it to judgement.
- **Session pipeline.** Six stages, each with an Inputs/Process/Outputs/Verify
  contract, each idempotent so an interruption is a pause rather than a corruption.
- **`trellis auto`.** Headless session chaining with on-disk verification and
  backoff. Off by default.
- **Layer 3 references.** Chiefs as documents rather than agents, a skills drop
  point, scale-tier playbook.
- **Gated self-improvement.** Evidence thresholds, a protected core, and a
  regression suite whose adversarial half exists to catch gate erosion.

---

## The pipeline

```
/trellis-plan     opus     →  graph.json with contracts + mutations   (~100 lines)
/trellis-review   opus     →  adversarial findings, fresh context      (read-only)
/trellis-tests    sonnet   →  the frozen test files                    (~1200 lines)
trellis verify-tests        →  every gate must reject a null stub      (no model calls)
trellis run                 →  open-source workers, headless           (0 orchestrator tokens)
/trellis-report   opus     →  triage from one compact artifact
```

The split exists because planning is two different jobs. **Judgement** —
decomposition, dependency edges, spotting that a unit is ambiguous — is tiny in
token volume and enormous in value. **Generation** — writing the test files from
those contracts — is the opposite. Measured on a five-node project, `/trellis-plan`
alone consumed 59% of a day's Opus usage, and roughly 95% of that output was test
files. Splitting them moves the volume to a cheaper model and keeps the judgement
where it belongs.

## The one idea

Most multi-agent setups keep the orchestrator in the loop — it dispatches a task,
reads the result, decides what's next, dispatches again. That works, and it also
means the orchestrator's context grows with every worker result. You save nothing.

In Trellis the orchestrator produces **artifacts** and the loop is **code**:

```
Opus            →  .trellis/graph.json + frozen test files   (then it stops)
runner.mjs      →  topological dispatch, retry, escalate, gate, merge
Opus            →  reads .trellis/REPORT.md once, adjusts the graph
```

Orchestrator tokens spent during a run: zero.

---

## Why a graph and not waves

Waves — "run these five, then those four" — are a coarse approximation of a DAG. A
node in wave 3 waits on every node in wave 2 even if it depends on one of them. You
lose parallelism, and one failure stalls a whole wave.

Trellis takes real dependency edges. A node runs the moment its own dependencies have
merged. A node that exhausts blocks only its own descendants; everything else keeps
going. The name is the design: work climbs the lattice node by node.

---

## What stops a cheap model from lying to you

Cheap models are competent at filling in a well-specified function and terrible at
knowing when they've failed. Four things make delegation safe:

**Tests exist before any worker runs.** `trellis validate` refuses a graph whose
test files aren't already on disk. The test is the contract.

**The tests themselves are verified, not trusted.** Once a cheaper model writes
them they stop being trustworthy by construction, so two mechanical checks replace
that trust. `verify-tests` proves every gate *fails* against a stub whose exports
all return null — a gate that passes there asserts nothing. Then, after a node
passes, each `mutations` entry Opus declared is reintroduced into the accepted code
by a cheap model and the tests must catch it. A surviving mutant means the gate
would not have noticed the defect, and the node is flagged.

**Workers cannot edit tests.** Enforced twice — output screening rejects the write
before it touches disk, and the acceptance gate reverts anything that slips through.
A model that tries is recorded as `test-tampering`, which is a signal about your
decomposition, not about the model.

**The gate sees every change, including untracked files.** `git diff --name-only HEAD`
misses new files entirely — a worker could add a whole new module and the gate would
never notice. Trellis uses `git status --porcelain --untracked-files=all`.

**Write scopes are structural, not advisory.** Each node runs in its own git worktree
on its own branch, and may only write the paths its node declares. Validation rejects
a graph where two nodes that can run concurrently claim the same file — that's a merge
conflict you'd otherwise discover at 2am.

---

## Layout

The kit root is the folder holding `package.json`. Run every command from there.
The engine lives in `kit/` — deliberately not named `trellis/`, so no path is ever
ambiguous about which level you are on.

```
package.json                kit root — run npm test / npm run doctor from here
trellis.config.json         tiers, concurrency, boundaries — edit this, not the code
CLAUDE.md                   orchestrator constitution
.mcp.json                   optional broker for one-off interactive delegation
.claude/
  settings.json             hook registration
  hooks/block-secrets.mjs   PreToolUse: refuse credential material
  hooks/protect-runner.mjs  PreToolUse: keep Opus out of run state and worktrees
  skills/trellis-plan/      /trellis-plan  — decompose, write tests, validate
  skills/trellis-report/    /trellis-report — triage a finished run
.vscode/
  tasks.json                Ctrl+Shift+B runs the graph
  launch.json               breakpoint the scheduler
kit/
  bin/cli.mjs               validate | doctor | run | status | clean
  lib/graph.mjs             schema, cycles, concurrent-write collisions
  lib/runner.mjs            the scheduler — the actual loop
  lib/worker.mjs            prompt construction, tier ladder, apply + gate
  lib/gate.mjs              scope check, test-tamper check, gate command
  lib/worktree.mjs          git worktrees + VS Code workspace sync
  lib/extract.mjs           parse model output, reject traversal and out-of-scope
  lib/provider.mjs          OpenAI-compatible client, backoff, model listing
  lib/report.mjs            REPORT.md — the only thing Opus reads after a run
  lib/envfail.mjs           tell a broken environment from a failing test
  lib/skills.mjs            which skills load in which session, and why
  roles/*.md               worker system prompts
  selftest/e2e.mjs          full offline suite, no API key needed
  regression/run.mjs        fixtures that must hold after any kit change
examples/
  FIRST-RUN-SPEC.md         ready-to-run spec for your first test
  SPEC.template.md          fill this in for your own projects
  graph.example.json        a real four-node graph
  EVALUATION.md             post-run capture sheet
```

---

## The escalation ladder

Each tier gets `maxAttempts` tries. Failure feedback from the gate is fed back to the
same model as a repair prompt. When a tier is exhausted, the next tier starts fresh
but is told a weaker model already failed and how.

```
cheap  (3 attempts)  →  mid  (2 attempts)  →  strong  (2 attempts)  →  EXHAUSTED
```

An exhausted node keeps its worktree so you can look at what it produced. Its
descendants are marked `blocked` and never attempted — no point burning tokens on
code that depends on something that doesn't exist.

Escalation is also your best planning signal. If a node consistently needs the strong
tier, the node was probably too big, not the model too weak. `REPORT.md` says so.

---

## Node statuses

| Status | Meaning |
| --- | --- |
| `merged` | Gate passed, merged into the base branch, worktree removed |
| `audit` | Gate passed, `risk: audit` — merged so dependants proceed, flagged to read |
| `weak-tests` | Gate passed but a declared mutant survived — the tests can't detect it |
| `review` | Gate passed but `risk: high` — held unmerged. **Run `accept` after reviewing**, or dependants never launch |
| `budget-stopped` | Never attempted; a run ceiling was hit. Resume raises it |
| `exhausted` | Failed every attempt at every tier; worktree kept |
| `conflict` | Gate passed but the merge conflicted; branch kept |
| `blocked` | An upstream node never landed; never attempted |
| `pending` / `running` | Self-explanatory |

---

## Commands

| Command | What it does |
| --- | --- |
| `/trellis-plan [spec]` | In Claude Code. Decompose, write frozen tests, validate |
| `/trellis-report` | In Claude Code. Triage a finished run |
| `node kit/bin/cli.mjs doctor` | Env, git state, and whether each model slug resolves |
| `node kit/bin/cli.mjs validate` | Cycles, write collisions, missing tests, **spec coverage** |
| `node kit/bin/cli.mjs verify-tests` | Prove every gate rejects a null stub — no model calls |
| `node kit/bin/cli.mjs ledger [--routing]` | Cross-run performance by tag |
| `node kit/bin/cli.mjs run` | Execute the graph headless |
| `... run --resume` | Continue an interrupted run |
| `... run --resume --retry-failed` | Also retry exhausted nodes |
| `... run --only n01,n02` | Run specific nodes |
| `node kit/bin/cli.mjs accept <id> [--merge]` | Mark a reviewed node accepted so its dependants unblock |
| `node kit/bin/cli.mjs reject <id>` | Reset a reviewed node to pending for a rebuild |
| `node kit/bin/cli.mjs status` | Per-node status |
| `node kit/bin/cli.mjs clean [--branches]` | Remove worktrees |
| `npm test` | Offline end-to-end suite — no API key required |

---

## Configuration

Everything lives in `trellis.config.json`. The tiers are OpenAI-compatible endpoints,
so anything speaking that protocol works — OpenRouter, DeepSeek direct, Moonshot,
Together, Fireworks, or a local LM Studio / Ollama server.

Model slugs move fast. **Run `doctor` after editing tiers** — it queries the provider's
`/models` endpoint, tells you if a slug is dead, and suggests the closest live match.

To run entirely locally, point a tier at LM Studio:

```json
{ "name": "local", "baseUrl": "http://localhost:1234/v1", "model": "qwen3-coder", "maxAttempts": 3 }
```

No `apiKeyEnv` needed for local servers.

---

## Note on `node --test` in an installed repo

The self-test lives in `kit/selftest/`, deliberately not `kit/test/`. Node's test
runner discovers **every** `.mjs` under any directory named `test`, regardless of
filename — so a `kit/test/` would make your project's `node --test` also spin up
Trellis' fake model server and temp git repos. Hidden directories are skipped, so
`.worktrees/` is safe.

If you add your own tooling that walks the tree (coverage, lint, typecheck), exclude
`kit/` explicitly.

## The six failure modes

| Failure mode | Discipline | How Trellis answers it |
| --- | --- | --- |
| Runs forever, burns budget | Loop | Per-node attempt ladder, plus run-level `budget` ceilings on attempts, tokens, cost and wall clock. A breach stops launching, lets in-flight nodes finish, and marks the rest resumable |
| Stops halfway, calls it done | Loop | The gate is an executable oracle; a worker cannot self-certify |
| Touched what it shouldn't | Harness | Worktree isolation, per-node write allowlist, automatic revert of out-of-scope writes, `denyWrite` boundaries, PreToolUse hooks on the orchestrator |
| Forgets between runs | Harness | `state.json` for the run, `ledger.jsonl` across runs. Tags let the ledger generalise |
| Skipped a required step | Graph | DAG edges, plus `covers` matched against the spec's scope bullets — an unclaimed bullet fails validation |
| Burns tokens a script could do | Graph | The loop, the gate, mutation checking, and tier routing are all code. The orchestrator spends zero tokens during a run |

## Ledger-driven routing

The "Chief Optimization Officer" as arithmetic. After each run, every node's
outcome is appended to `.trellis/ledger.jsonl` with its tags and per-tier attempt
record. On later runs, `routing` skips leading tiers that historically fail a
node's tags.

It is deliberately unclever: it only decides where to *start* on the existing
ladder, never reorders it, never skips the last tier, and stays inert until
`minObservations` exist. Anything smarter would be unexplainable, and you could not
tell whether it was helping. `trellis ledger --routing` shows the table it decides
from.

## Known limits in v2.0

- **Merge conflicts on sequential nodes.** Validation catches concurrent collisions,
  but two nodes in a dependency chain that touch the same file can still conflict at
  merge time. Trellis aborts the merge cleanly and reports it; it does not resolve it.
- **No cross-node interface negotiation.** If two nodes disagree about a shared
  signature, both pass their own tests and integration fails later. Mitigate by having
  Opus write the interface file during planning, and by adding an integration node.
- **`read` context is static.** Workers get the files the node names, not a search
  tool. Deliberate — it keeps prompts small — but it means a bad `read` list shows up
  as repeated failures.
- **The MCP broker is optional and untested at scale.** The runner does not use it.
- **Mutation checking only tests what you declare.** It cannot find the defect
  nobody thought of, and it cannot tell you a value is absurd. A contract that says
  "convert cal to kcal by dividing by 1000" is scientifically right and, on a food
  label, wrong — no mechanical check catches that. `/trellis-review` exists for that
  class of error, and it is a fresh-context read, not a guarantee.
- **Routing learns slowly and only from tags.** Untagged nodes never accumulate
  usable history, and synonym tags dilute what there is — `validate` warns when two
  tags cover exactly the same nodes.
- **Mutation checking dominates wall clock.** Each mutant is a model call plus a
  repo copy plus a gate run. A 26-mutation graph took 13x longer than the same graph
  without them. Batching mutants per node into one call is the obvious v1.2 fix.
- **No path from a weak-tests finding back to `/trellis-tests`.** The report names
  the surviving mutants, but re-strengthening tests is a manual hand-off.

---

## Credit where it's due

Trellis is a rewrite of the ideas in forge-kit-oss, with the wave model replaced by a
real DAG, boundary hooks replaced by git worktrees, and — the part that actually
matters — the dispatch loop moved out of the orchestrator's context and into
`runner.mjs`.
