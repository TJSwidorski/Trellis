# Changelog

Format: one section per tagged release, newest first. Each entry names the
commit range and the tag. This file starts at 2.1.0 — everything before that is
`2.0.0` as shipped and described in `README.md` / `UPGRADING.md`.

Schema and file-format identifiers (`trellis.product-graph/1`,
`trellis.skill-registry/1`, the task-graph `version` field, and anything else
under `kit/schema/`) are **not** tracked by this file. They change only on an
incompatible on-disk format break, documented in `UPGRADING.md`, not on a routine
release.

## v2.10.0 – v2.10.2 — what it cost

Track E of the remediation series, and the last track of code changes. The
declared success metric was a hardcoded zero, the A/B report's result
section was structurally always blank, and a run in progress could only be
inspected by reading JSONL. All three now produce a number or a view.

- **Worker tokens per shipped node** (`kit/lib/report.mjs`, v2.10.0).
  REPORT.md's Cost section ended with one line — "Orchestrator tokens spent
  during the run: **0**". That line stays; it is the guarantee. But it is
  not the metric MISSION.md commits to trending, and on the headless path
  it is structurally zero. Added beneath it: worker tokens summed from
  `state.nodes[].attempts[].usage` — the same reduction the ledger does,
  and the one that never sees the mutation scorer's calls — divided by the
  nodes that landed. The report states which denominator each ratio uses
  (`st.LANDED` for the headline, merged-clean alongside it when they
  differ).
- **The held-out suite scorer is wired into the A/B report** (new
  `kit/bench/score.mjs`, v2.10.1). `kit/bench/run.mjs` called `compare(a, b,
  {})` with an empty options object, so section 4 of the report ("Result —
  held-out suite") was always "—". `scoreHeldOut()` runs the held-out
  acceptance suite exactly as `prompts.json` documents and parses a
  pass/total out of node:test, mocha/jest, or bare-TAP output;
  `armSelfGrade()` reads Arm B's own gate results for the self-grade gap.
  `--dry-run` fills the section with canned figures so the render path is
  exercised with nothing spent. `score.mjs` shells out to a suite in
  another repo and is deliberately not importable from anything on the
  `npm test` path. Also fixed `examples/FIRST-RUN-SPEC.md`, which still
  pointed at the `/trellis-plan` skill flow retired in v2.5.0.
- **`trellis watch`** (`kit/bin/cli.mjs`, new `kit/lib/watchview.mjs`,
  v2.10.2). The `trellis validate` level view, re-rendered from
  `.trellis/state.json` on `fs.watch`, each node annotated with its live
  status; `--once` renders and exits. Alongside it, a single self-contained
  HTML snapshot with the model JSON inlined — no server, no dependency, no
  Pages workflow. The snapshot carries the rendered model, not raw
  `state.json`: gate `feedback` is worker-influenced text and has no
  business in an HTML page.

Each tag in the range carries its own commit and tests. Regression grew
225 → 227 checks, units 69 → 71.

## v2.9.0 – v2.9.4 — cheaper attempts

Track D of the same remediation series — the highest blast-radius track,
landed last among code changes on purpose. Nothing here changes WHAT gets
built; all of it changes what building it costs.

- **mock-server.mjs indexes by distinct prompt, not call count** (v2.9.0).
  A behaviour-preserving enabler, landed first and alone so its own
  correctness was provable before anything load-bearing depended on it —
  every existing fixture stayed green and unchanged.
- **The mutable file-contents section moves to the end of the prompt**
  (`kit/lib/worker.mjs`, v2.9.1). Everything through OUTPUT_CONTRACT is now
  byte-identical across every attempt on a node; only the small mutable
  tail changes. The prerequisite for both items below.
- **`cache_control` on the stable prefix, a stable per-node `user` id**
  (`kit/lib/provider.mjs`, `kit/lib/worker.mjs`, v2.9.2). Standard
  Anthropic Messages API content-block caching, plus OpenAI's own `user`
  field reused as a stable per-node identifier for gateway-level sticky
  routing — both opt-in via `provider.promptCaching`, default on.
- **Parallel sampling on the first attempt of the first tier**
  (`kit/lib/worker.mjs`, v2.9.3). Config-gated (`sampling.parallelSamples`,
  default 1 — off in practice), N concurrent requests sharing the cached
  prefix, never `n` in one request body. Tiebreak: the first sample with no
  disqualifying flag (tampering, out-of-scope, truncation) wins; the rest
  of the existing single-reply pipeline is completely unchanged once a
  winner is picked.
- **Route on node features, not just tags** (`kit/lib/features.mjs`,
  `kit/lib/routing.mjs`, `kit/lib/ledger.mjs`, v2.9.4). A coarse size
  bucket derived from dep/write/test counts already on every node, folded
  into the same tag-pooling machinery routing already had — a brand-new
  tag with zero history still inherits signal from other nodes its size.
  Deliberately kept out of evolve.mjs's own tag-grouped evidence to avoid
  double-reporting the same incidents under two keys.

Verification for the whole track: `npm test` green after every commit
(units 69/69, regression 225, e2e 68/68 at the end of the range); every new
behaviour's test confirmed to fail against the pre-fix code before landing.

## v2.8.1 – v2.8.3 — levels

Track C of the same remediation series, per the user's own restated rule for
how a slice should be cut: build in levels, and find the maximum number of
WHOLE levels that fit under the cap — some batches may be much smaller than
the cap, but no batch ever starts a wave of sibling work it can't finish
just because a few more nodes happened to fit. (v2.8.0, a discriminating
fixture proven against the OLD flat-cutoff behaviour, was folded into
v2.8.1 rather than tagged separately — it had no standalone value once the
algorithm it existed to prove landed in the same commit.)

- **Slices are cut in whole dependency levels, never split** (`kit/lib/product.mjs`,
  v2.8.1). `nextSlice` now computes depth via `graph.mjs`'s hardened `levels()`
  over the remaining, unbuilt candidate pool, and walks levels in order,
  taking each one whole while under the cap. The one exception: a level that
  is oversized all by itself is taken whole anyway (`overflowed: true`) — a
  level cannot be half-planned. `level` is never persisted onto a node (the
  task-graph schema's `additionalProperties:false` has no room for it,
  and it is metadata about the cut); `.trellis/plan.json` carries it instead.
- **Re-gate at level boundaries** (`kit/lib/runner.mjs`, v2.8.2). Each node's
  own gate only ever proved its tests accept its own implementation in
  isolation, on a worktree branched before any dependency-level sibling had
  merged. Once every node at a depth has resolved, every node that actually
  merged there gets its gate re-run against the current `baseBranch` —
  catching two siblings that each pass alone but conflict once both are
  actually merged together. A failure holds the (already-merged, never
  reverted) node for review via the existing REVIEW status, rather than a
  new one — a real behaviour break, documented in `UPGRADING.md`.
- **A decomposition ceiling, as a warning** (`kit/bin/cli.mjs`, v2.8.3).
  `trellis validate --plan` now flags a task-graph level wider than
  `validate.decompositionCeiling` (default 25) — more surface for v2.8.2's
  re-gate to catch a conflict in. Deliberately a warning, never a validation
  failure: 25 is an empirical number, not a proven ceiling.

Verification for the whole track: `npm test` green after every commit (units
56/56, regression 218, e2e 68/68 at the end of the range); every new
behaviour's test confirmed to fail against the pre-fix code before landing.

## v2.7.0 – v2.7.5 — the oracle fails closed

Track B of the same remediation series. Track A (v2.6.1–v2.6.22, below) fixed
enforcement that failed open at the edges; this track does the same to the
oracle itself — the mechanism that lets Trellis claim a node's tests actually
prove something. Protected-file heavy, since that mechanism is exactly what
`kit/lib/evolve.mjs`'s PROTECTED list exists to guard.

- **`copyRepo` carries the dependency tree instead of excluding it entirely**
  (`kit/lib/verify.mjs`, v2.7.0). `node_modules` was dropped from the scratch
  copy a mutation or verify-tests check runs the gate in, so any project with
  real dependencies failed every gate for a reason that had nothing to do with
  vacuity. Now symlinked (junctioned on Windows) instead.
- **An environment failure can no longer score as a killed mutant**
  (`kit/lib/mutate.mjs`, v2.7.1). The same class of bug as v2.6.3, in the
  mutation scorer: a broken environment made every mutant "survive" the exit
  code check by exiting non-zero for the wrong reason, reporting a perfect,
  meaningless mutation score. Must follow v2.7.0 — that broken environment was
  usually the missing `node_modules` the previous fix closed.
- **Every verifier fails closed** (v2.7.2). An unrecognised test language used
  to produce no finding at all; REPORT.md now has a dedicated section for "a
  mutation oracle that never ran," distinct from a clean pass.
- **`verify-tests` is a precondition, not an optional command** (`kit/bin/cli.mjs`,
  `kit/lib/verify.mjs`, v2.7.3). `trellis run` now refuses to start if any
  node's tests were never proven non-vacuous, or changed since they last were —
  covering "never verified" and "verified once, then quietly weakened" in one
  check. A real behaviour break, documented in `UPGRADING.md`; `--skip-verify`
  or `verify.requirePrecondition: false` opt back out.
- **An opt-in, resource-limited gate sandbox** (`kit/lib/sandbox.mjs`, v2.7.4).
  `gate.sandbox`, default off, wraps the gate command in POSIX `ulimit` limits
  when enabled — a real but explicitly best-effort backstop against a runaway
  gate, not network or filesystem isolation. `trellis doctor` warns when it's
  off (the default) and fails loudly when it's on but the platform can't
  enforce it (Windows has no `ulimit`), rather than silently running
  unsandboxed. Landed after v2.6.9's tree-kill fix on purpose — a sandbox
  wrapping broken kill semantics is worse than no sandbox.
- **Mechanical, zero-token structural mutants, and survivors become held
  proposals** (`kit/lib/structuralMutants.mjs`, `kit/lib/mutate.mjs`,
  `kit/lib/runner.mjs`, v2.7.5). A lightweight, honestly-framed sweep of
  comparison/logical/boolean-literal flips runs alongside any LLM-authored
  `mutations`, so every node gets some mutation coverage even when the graph
  declared none. Any mutant that survives — mechanical or LLM-authored — now
  writes a proposal under `evolution/proposals/` instead of sitting only in
  `state.json`; always held for a human to merge, never an auto-committed
  test.

Verification for the whole track: `npm test` green after every commit (units
56/56, regression 212, e2e 63/63 at the end of the range); every new
behaviour's test confirmed to fail against the pre-fix code before landing.

## v2.6.1 – v2.6.22 — fail loudly

An adversarial audit (five independent clean-context reviewers, ten lenses)
found that this kit's defects share one shape: enforcement that fails open —
a check that cannot run, an error scored as a pass, a halt that reports
success. Every finding below closes one of those. Each tag in the range is
its own commit with its own tests; this section summarises the whole run.

- **An environment halt can no longer report success** (`kit/lib/runner.mjs`,
  v2.6.3). The terminal sweep re-derived `budget.check()` alone, omitting the
  `envHalt` term the launch loop itself uses, so an environment-halted run
  left every untried node PENDING — counted as neither done nor stuck — and
  exited 0 having built nothing.
- **Cycle detection runs even when field errors already exist**
  (`kit/lib/graph.mjs`, v2.6.4), and **`ancestors()`/`levels()` are
  cycle-safe, iterative primitives** (v2.6.5, v2.6.6) — promoted ahead of
  their own payoff ranking, since they become load-bearing scheduling logic
  later in this same series.
- **A stalled response body can no longer hang a worker call**
  (`kit/lib/provider.mjs`, v2.6.7). `clearTimeout` fired at response headers,
  not at the end of the body read; a 32MB size cap was also missing entirely.
- **A broken git can no longer read as a clean, unchanged tree**
  (`kit/lib/worktree.mjs`, v2.6.8). `git()` dropped `spawnSync`'s own error
  field, so a spawn failure was indistinguishable from a genuinely empty,
  successful result.
- **A killed gate or session can no longer leave orphan processes running**
  (`kit/lib/gate.mjs`, `kit/lib/driver.mjs`, new `kit/lib/proc.mjs`, v2.6.9).
  Both spawn with `shell:true`, making the killed process the shell, not the
  command — reproduced by hand as a genuine >30s hang with a surviving
  orphan node process before the fix, confirmed gone after.
- **A failed commit can no longer be reported as a merged node**
  (`kit/lib/worker.mjs`, `kit/lib/worktree.mjs`, v2.6.10). A `git commit`
  failure after a passing gate was silently indistinguishable from success;
  the worktree was then force-deleted, taking the only copy of the work.
- **One source of truth for the slice cap** (`kit/bin/cli.mjs`, v2.6.11).
- **Mutation scoring no longer trips the worker-retry attempt ceiling**
  (`kit/lib/budget.mjs`, v2.6.12).
- **`cfg.paths.state` is honoured everywhere in the driver, not just in one
  function** (`kit/lib/driver.mjs`, v2.6.13) — roughly two dozen hardcoded
  `.trellis` literals unified behind one `statePath()` helper.
- **`denyWrite` covers the gate-config files today's test runners actually
  read** (`trellis.config.json`, v2.6.14) — Vite, TypeScript path mapping,
  Playwright, Babel, `.gitignore`, and CI workflow files, none of which were
  covered before.
- **Write-collision detection agrees with the gate about case folding**
  (`kit/lib/paths.mjs`, v2.6.15). `globsOverlap` never folded case at all,
  so two differently-cased write scopes could pass validation and then both
  write the same physical file on Windows or macOS.
- **A landed node can no longer be silently rebuilt on `--resume`**
  (`kit/lib/state.mjs`, `kit/bin/cli.mjs`, v2.6.16). Editing a merged node's
  contract and then `--resume` used to reset it to PENDING and rebuild it
  from a base branch that still contained its own merge — automatically
  doing what `trellis reject` explicitly refuses to do without a human
  reverting first.
- **A `--only` deadlock is now visibly stuck, not silently done**
  (`kit/lib/runner.mjs`, v2.6.17).
- **A held-on-survivor node is visible again** (`kit/lib/runner.mjs`,
  `kit/lib/log.mjs`, v2.6.18) — the `onSurvivor:"hold"` disposition logged
  neither a console line nor a `run.jsonl` event, unlike the structurally
  identical high-risk hold beside it. Also fixes a real flush race in
  `closeRunLog()` found while writing this fix's own test.
- **Multi-byte UTF-8 survives a pipe chunk boundary**
  (`kit/lib/gate.mjs`, `kit/lib/driver.mjs`, v2.6.19). Per-chunk
  `d.toString()` decoded each half of a split character independently to
  U+FFFD, which could corrupt `detectEnvFailure`'s own pattern matching.
- **`buildStub` emits CommonJS when the target actually resolves as
  CommonJS** (`kit/lib/verify.mjs`, v2.6.20). It always emitted ESM
  regardless of the target's real module system, so a CJS test's `require()`
  threw a bare `SyntaxError` that was then scored as "non-vacuous" anyway.
- **One shared, iterative cycle detector for both graphs**
  (new `kit/lib/graphutil.mjs`, v2.6.21). `product.mjs`'s was still
  recursive — exactly the algorithm shape that blows the call stack on a
  long chain — while `graph.mjs`'s was already iterative; unifying them
  fixed the duplication and the stack-overflow risk in the same move.
- **One `readJsonOrNull`, one `parseJsonl`, and matched path validators**
  (`kit/lib/paths.mjs` and nine call sites, v2.6.22). Also closes a gap
  between `safeRelative` and `evolve.mjs`'s `normaliseTarget`: both now
  reject a UNC-style path, where before only one of them did.
- **CI now runs on `windows-latest` as well as `ubuntu-latest`**
  (v2.6.1) — development happens on Windows; several fixes above are
  platform-divergent and ubuntu-only CI could not have caught them.
- **Documented that sessions are cleared, never compacted, as the
  deliberate architectural choice it is** (`sessions/README.md`, `CLAUDE.md`,
  `CONTEXT.md`, v2.6.2) — written ahead of its own payoff ranking, as the
  invariant later prompt-caching work must not violate.

Regression 206 (was 190), units 45/45 (was 28), e2e 52/52 (was 44).

## v2.6.0 — a driver that actually launches on Windows

- **`trellis auto` can launch its driver on a Windows install where `claude`
  is an npm global shim** (`kit/lib/driver.mjs`). `driver.command` is a bare
  name, and `npm install -g` on Windows resolves that to a `.cmd`/`.ps1`
  shim trio — Node's CVE-2024-27980 fix refuses to exec a `.cmd` directly
  without `shell:true`, throwing `EINVAL` *synchronously*, which escaped
  `runSession`'s un-caught executor entirely and surfaced as a bare crash
  instead of the intended "Is Claude Code on PATH?" hint. `shell:true` is
  gated to `win32` and paired with quoting both the command and every arg —
  Node's own args-are-concatenated-not-escaped warning is real, confirmed
  here two different ways: an unquoted multi-word prompt arrives torn into
  several argv entries, and an unquoted command path containing a space (a
  `Program Files` install, a Windows username with a space in it) fails to
  launch at all. `kit/bench/run.mjs`'s identical `spawn("claude", ...)` call
  got the same args-quoting fix.

Regression 190 (was 189), units 28/28, e2e 44/44 (unchanged).

## v2.5.0 — one command, a whole cycle

Landed the `run-two-fixes` branch (re-reviewed, blockers fixed inline, ported
onto everything Phases 1–3 had already changed) and deleted it. Trellis can
now run a whole cycle — slice, build, triage, apply what's reversible — with
one command, and resume genuinely holds after a test gets strengthened.

- **`trellis auto --cycles N`** (`kit/bin/cli.mjs`, `kit/lib/driver.mjs`,
  new `kit/lib/cycle.mjs`) drives the default chain N times, beginning a
  fresh cycle each pass, committing exactly what each stage was declared to
  produce and halting — never guessing — on anything else. `--dry-run` prints
  the plan and cost without starting anything. New `OPERATING.md` is the
  manual for it; `QUICKSTART.md` is cut over from the retired
  `/trellis-plan` skill flow to the `sessions/NN_stage/CONTEXT.md` pipeline
  this has been hardening since v2.2.0.
- **The checkpoint is the one stop `--cycles` cannot skip**: a high-risk node
  held for review halts the whole loop, unconditionally, regardless of how
  many cycles remain, and `.trellis/checkpoint.json` is now written on every
  apply — including empty — so a stale entry can no longer report a
  long-accepted node as still awaiting review.
- **`--resume` rebuilds a node whose test got strengthened, not just whose
  contract changed** (`kit/lib/state.mjs`). `nodeHash` now folds in a digest
  of the frozen tests' actual content, not just their paths — REPORT.md's own
  advice to "strengthen the tests, then re-run" previously did nothing,
  because nothing compared what a test *said*.
- **`.trellis/cycle.json`** rolls `runId` forward on a genuinely new pass at
  the product graph, fixing evolve.mjs/friction.mjs thresholds and stale-
  artifact skip bugs in `trellis auto` that came from two real runs, weeks
  apart, counting as one.
- **`.trellis/built.json` is derived, not hand-authored** (new
  `kit/lib/built.mjs`): the ledger, then the current run's `state.json`, then
  an additive-only `built.manual.json`, in that trust order. `trellis slice`
  reads the derived set directly; nothing downstream depends on the cached
  file staying fresh.
- **`trellis triage` is a command, not a hand-formatted JSONL line**
  (`kit/lib/triage.mjs`), and **`trellis apply-triage`** mechanises the
  reversible half of a triage decision — reset a rejected non-landed node,
  bookkeep an accept on one already landed — while a held high-risk accept
  is never applied directly, only ever written to the checkpoint.
- **`.claude/hooks/guard-bash.mjs`** closes the Bash hole: a headless stage
  session could previously run `trellis accept --merge` or a raw
  `git merge`/`push`/`pull`/`reset --hard` — a one-way door MISSION.md
  reserves for a human — through the Bash tool, which no existing hook
  matched. Denies the CLI form, the `trellis` bin-alias form, and the raw git
  equivalents, tolerating arbitrary flags between `git` and the subcommand.
  `trellis auto` refuses to start at all without this hook registered.
- **`reject` no longer false-positives on a landed node via a `git merge-base`
  check that a squash or rebase merge defeats** — it now checks the node's
  own recorded status (`st.LANDED`) instead.

Six things fixed while porting rather than deferred: `auto` no longer halts
on a fresh project's own `.trellis/ingest.json` (gitignored, working state
rather than a deliverable); `commitStageOutput` reuses the existing
rename-aware `changedPaths()` instead of re-parsing `git status --porcelain`
by hand; a `RUNNING` node surviving a graph-changed salvage is normalised to
`PENDING` through a helper both the happy-path and salvage-path resume call,
so it is never invisible to `readySet` again; a `BUDGET`-stopped node is
revived by `--resume` the same way; the Bash guard tolerates `git -C .` and
`git -c foo=bar` (a global option's *value* is not itself dash-prefixed) and
also blocks the `trellis accept` bin-alias and raw `git pull`.

Regression 189 (was 152 going into this phase), units 28/28, e2e 44/44 (was
31).

## v2.4.0 — the worker loop

Quality and cost, not safety — five fixes to how a worker actually gets
retried, paid for, resumed, and read back.

- **The prompt is rebuilt every attempt, not once before the loop**
  (`kit/lib/worker.mjs`). A retry used to ask the model to fix code it could
  not see — for a brand-new file, "Current contents of files you may edit"
  was simply absent on attempt 1 and stayed built from that snapshot forever
  after. Likely the single largest quality change in this release.
- **Truncation gets a bigger cap on the same tier, not escalation**
  (`kit/lib/provider.mjs`, `kit/lib/extract.mjs`, `kit/lib/worker.mjs`, new
  `truncated` kind). An empty completion with `finish_reason=length` was
  marked `transient:true`, so `chatWithBackoff` retried the identical request
  at the identical cap up to three times before the caller ever learned
  anything was wrong. The common shape — two files complete, a third cut off
  mid-fence — is now checked before "produced nothing usable", not nested
  inside it, so a real truncation no longer burns a full escalation to solve
  what was never a capability problem. Base `maxTokens` raised 8000 → 16000
  (`trellis.config.json`, `kit/lib/config.mjs`'s default) — whole-file
  emission at 8k was the truncation source in the first place.
- **Mutation-check spend is now counted** (`kit/lib/mutate.mjs`,
  `kit/lib/runner.mjs`). One provider call per mutation per passing node
  reached neither `maxCostUsd` nor `maxTotalAttempts` before this — at 40
  nodes × 3 mutations that's roughly half the real spend going unmetered.
- **A `RUNNING` node kept across a graph-changed salvage no longer stays
  stuck forever** (`kit/bin/cli.mjs`). The salvage path copied node state
  verbatim, including status; a node interrupted mid-run whose own contract
  hadn't changed stayed `running` after `--resume` — invisible to the ready
  set, invisible to `markBlocked`, silently unbuilt while the run reported
  finished.
- **Gate output can no longer close its own report fence early**
  (`kit/lib/report.mjs`, new `untrustedBlock`). A worker's own code produced
  the gate stdout quoted in `REPORT.md`; a fixed triple-backtick fence closed
  on the first backtick run inside that text, and whatever followed rendered
  as ordinary report body in the orchestrator's own context. The fence is now
  always longer than the longest backtick run the body contains, and the
  block is explicitly labelled untrusted. `REPORT.md` is also now written
  atomically (tmp + rename), matching `saveState`.

## v2.3.0 — authenticate the evidence, make the docs true

The self-improvement loop's evidence stream had an unvalidated `run` field —
the one field its entire `minRuns` discipline depends on — and anything the
unsandboxed gate executed (see v2.2.0) could append to it. Also: three
documents claimed a hooks/apply behavior the code did not have.

- **`trellis triage`** (`kit/lib/triage.mjs`, new). Stage 06 used to hand-format
  `.trellis/triage.jsonl` itself, including the `run` field copied out of
  `state.json` — three fabricated `run` values in one session could clear
  `minRuns: 3` on their own. Mirrors `friction.mjs`'s pattern: `run` is
  stamped in code, never accepted from the caller. `.trellis/triage.json` is
  now a materialised view of the current run's jsonl rows, not a separate
  file to keep in sync.
- **Forged-run detection** (`kit/lib/driver.mjs`). Stage 06's verify now cross-
  checks every distinct `run` value `.trellis/triage.jsonl` has *ever* claimed
  against runIds the ledger actually recorded, not just the current run's.
- **`isCostly` reads the top tier from config** (`kit/lib/evolve.mjs`), not a
  hardcoded `"strong"` — a renamed or added top tier no longer silently drops
  out of the self-improvement loop's costly-node population.
- **`friction.contradictions()` wired into the shortlist** as a fourth source
  (`unreported-suspected`). The one mechanism that catches a session falsely
  asserting `--none` was computed and shown only to a human; stage 07's
  contract restricts it to `evolve --json`, so it never reached the one place
  a decision gets made.
- **`neverActivated` respects an entry's `firstSeen`** (`kit/lib/skills.mjs`) —
  a skill registered yesterday is no longer judged against runs that predate
  it. **`materialise` validates registry-supplied skill names** through
  `safeRelative` before a recursive delete, closing a traversal path.
- **Hook coverage now matches what `CLAUDE.md`/`CONTEXT.md` claim**
  (`.claude/hooks/protect-runner.mjs`). Previously covered three run-state
  filenames and `.worktrees/`; now imports `PROTECTED` from `evolve.mjs` and
  additionally covers the evidence `.jsonl` files, `evolution/proposals/`,
  `references/CODES.md`, and both settings files.
- **Deleted the false auto-apply claim** from `cli.mjs`, `evolution/README.md`,
  `references/EVOLUTION.md`, and `sessions/06_triage/CONTEXT.md` — no apply
  mechanism exists; every proposal waits for a human.
- **`package.json` classified `LOAD_BEARING`** (`kit/lib/evolve.mjs`) — it was
  neither protected nor load-bearing before, the least-guarded tier there is.

## v2.2.0 — integrity: close the gate, make the oracle real

Two independent adversarial audits converged on the same root cause: the gate
ran untrusted worker code with `shell: true`, unsandboxed, as the host user,
and every boundary check ran *before* it started. From that one hole followed
both a way for a worker to rewrite its own frozen test and a way for a gate
command to forge evidence in `.trellis/`. This release closes it, and fixes the
verification layer that was largely verifying its own invocation.

- **Gate path-delta check** (`kit/lib/gate.mjs`). The scope and frozen-test
  checks now re-run immediately after the gate command executes, before its
  exit code is trusted. A side effect of running the command — an import-time
  rewrite of a test file, a write into `.trellis/` — now fails the attempt as
  `gate-tampering`, reverting what can be reverted, regardless of exit code.
- **`revertPaths` mixed tracked/untracked bug** (`kit/lib/worktree.mjs`).
  `git checkout HEAD -- ...paths` aborts entirely if any one path is untracked,
  silently leaving every tracked path un-reverted. `revertPaths` now partitions
  first and returns what it actually reverted, so callers can report the truth
  instead of assuming success.
- **`verify-tests` import resolution** (`kit/lib/verify.mjs`). Four of six
  realistic import forms — extensionless specifiers, the TypeScript
  `.js`-for-`.ts` convention, `require()`, and dynamic `import()` — produced no
  stub at all, and the resulting module-not-found error was reported as
  non-vacuity established. All six now resolve correctly, including directory
  imports through an index file.
- **`verify-tests` no longer reports success on silence.** A node whose tests
  never import anything from its own write scope now gets a hard `unstubbed`
  finding instead of running the gate against an absent implementation. And
  `trellis verify-tests` now exits non-zero when nothing was proven at all,
  instead of printing a warning and exiting 0 — `driver.mjs`'s stage-04 verify
  shells out to this exact command and reads only its exit code.
- **`node.tests` paths are now validated** the same way `read`/`write` already
  were (`kit/lib/graph.mjs`), closing a traversal/shell-injection path into
  `verify-tests`' `node --check` call, which is now argv-based rather than an
  interpolated shell string.
- **`PROTECTED` now covers `kit/lib/paths.mjs` and `kit/lib/extract.mjs`**
  (`kit/lib/evolve.mjs`, `MISSION.md`) — the files that *implement* every
  boundary decision the already-protected files merely call.

## v2.1.0 — baseline

The state three independent adversarial audits were performed against: `main`,
the (already merged) `evolve-evidence-loop` branch, and the unmerged
`run-two-fixes` branch. This release does not fix anything found — it exists so
every fix after it lands as a visible, tagged increment against a known point.

- Pushed 25 commits that had accumulated on local `main` without ever reaching
  `origin/main`.
- Deleted branch `evolve-evidence-loop` (fully merged, 0 commits ahead of `main`).
- Added this file and a CI workflow (`.github/workflows/test.yml`) running
  `npm test` on push and PR — there was no CI of any kind before this.
