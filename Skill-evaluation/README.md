# Skill triage pipeline

Two independent programs sharing one ledger file.

```
sources.json ──▶ skillfinder.py ──▶ ledger.json ──▶ skillfit.py ──▶ ledger.json
                 (is it safe?)      state=awaiting_fit  (is it useful?)  state=adopted
```

Pipeline 1 (`skillfinder.py`) owns the `security` block of every ledger entry.
Pipeline 2 (`skillfit.py`) owns the `fit` block. Neither writes the other's.
That separation is the whole design: rerun the security crawl nightly without
touching fit verdicts; re-tune what "useful" means without rescanning anything.

## Status (2026-09-01)

Pipeline 1 and pipeline 2 gates A–C are built, tested, and in use. **Gate D
(live A/B evaluation) is not wired** — see "Gate D" below. Every skill that
reaches pipeline 2 today comes back `deferred`: it passed the cheap gates and is
waiting on a gate-D run that cannot happen yet. That is the expected state, not a
bug. The persistence work and the eval corpus that gate D needs are separate
tracks, not on this pipeline's critical path.

## Files

| File | What it is |
|---|---|
| `ledger.schema.json` | The contract (schema_version 2). Validate every ledger write against it. |
| `skillfinder.py` | Pipeline 1. Discovery + SkillSpector triage (static + LLM). |
| `skillfit.py` | Pipeline 2. Four-gate fit evaluation against a manifest. Imports `classify_incompleteness` / `migrate_ledger` from `skillfinder`. |
| `sources.json` | Crawl inputs: `manual`, `github_topics` (consumed today), `lists` / `collections_pending_enumeration` (staged, inert until a list-crawler exists). |
| `trellis-manifest.json` | What Trellis specifically needs. `needs` is the hand-maintained part. |
| `general-manifest.json` | A "what would I want day to day" manifest — point pipeline 2 at it with a **second ledger file**. |
| `skillspector-baseline.yaml` | One rule: suppresses `EA5` on the `model:` frontmatter key (characterised noise — a normal manifest field, disclosed by definition). LP3/E1 deliberately not baselined. |
| `raw-captures/` | Investigation artifacts: `calibration.json`, per-skill full scan JSON under `calib_raw/`, the determinism runs, the retry check, `triage-predictions.md`. |

## Setup

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
uv tool install --python 3.13 "skillevaluator[all] @ git+https://github.com/NVIDIA/SkillEvaluator.git"
```

The LLM leg (gate 2) runs against an **OpenAI-compatible endpoint**. We point it
at OpenRouter with a cheap open model — screening should be one of the cheapest
things you run:

```bash
export SKILLSPECTOR_PROVIDER=openai
export OPENAI_API_KEY="$OPENROUTER_API_KEY"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export SKILLSPECTOR_MODEL="deepseek/deepseek-v4-flash"   # trellis.config.json "cheap" tier
export SKILLSPECTOR_TEMPERATURE=0
export SKILLSPECTOR_SEED=42
export PYTHONUTF8=1                                       # Windows: SkillEvaluator's Rich renderer crashes on cp1252 otherwise
```

Pipeline 2 gate B (redundancy) needs an **embeddings** provider for
SkillEvaluator (`NVIDIA_API_KEY` for NVIDIA Build, or `OPENAI_API_KEY` for
OpenAI). Without one, gate B fails closed to `partial_overlap` — never `novel`.

Gate C's `skillevaluator validate` runs keyless. Gate D would need Docker + a
live-agent backend (`skillevaluator doctor --agents codex --env-mode docker`).

## Running

```bash
# nightly crawl (once sources.json has real inputs)
python skillfinder.py --sources sources.json --ledger ledger.json \
  --baseline skillspector-baseline.yaml

# ad hoc — a specific skill you found
python skillfinder.py --add https://github.com/acme/some-skill --ledger ledger.json \
  --baseline skillspector-baseline.yaml

# read the triage table
python skillfinder.py --ledger ledger.json --report

# fit evaluation, cheap gates only (gate D can't run — everything -> deferred)
python skillfit.py --ledger ledger.json --manifest trellis-manifest.json

# evaluate against a different manifest -> use a different ledger file
python skillfit.py --ledger general-ledger.json --manifest general-manifest.json
```

`skillfinder.py` exits 1 when it quarantines something new, so a cron wrapper
can page on that alone.

## The gates

Ordered cheapest first, so expensive work only ever sees survivors.

### Pipeline 1 — `skillfinder.py`

- **Gate 1 — static scan.** `skillspector scan --no-llm`. Free, parallel. Regex,
  AST, YARA, dependency lookup. High recall, moderate precision.
- **Gate 2 — LLM scan.** `skillspector scan` (full). Costs tokens. Runs on
  everything a manual `--add` produced; on a crawl, skips anything gate 1
  already marked `DO_NOT_INSTALL`.
  - **Retries.** SkillSpector's own per-call LLM timeout is 120s (hardcoded) and
    it retries each batch 7× internally. When its LLM leg still fails, pipeline 1
    re-invokes the whole scan up to `LLM_RETRY_ATTEMPTS` (3) times with backoff
    (60s, 180s) — failures cluster in provider windows. It only retries a
    *transient* failure: if the skill's own static scan already classifies as a
    blind spot (`structural`), retrying changes nothing.
  - **`blind_spot_kind`** distinguishes why an incomplete scan is incomplete:
    `structural` (the scanner cannot finish reading the skill — settled),
    `provider_unavailable` (only the LLM leg failed, static is benign — retried
    next run), `provider_persistent` (`provider_unavailable` that has recurred
    `LLM_PERSISTENT_FAILURE_RUNS` = 3 consecutive runs — the payload is too large
    for the model's per-call budget; stop retrying, escalate to a bigger model
    or manual review). `consecutive_provider_failures` is the counter.

A scanned, non-`DO_NOT_INSTALL` skill lands in `state: awaiting_fit` — the
handoff point. `DO_NOT_INSTALL` lands in `state: quarantined` (terminal, never
handed over). Pipeline 1 does **not** pre-judge fitness: SAFE and CAUTION both
go to `awaiting_fit`, and pipeline 2 routes from the raw signals in the
`security` block. (v1's `cleared`/`scanned` split and `--include-caution` are
gone; `migrate_ledger` collapses both to `awaiting_fit`.)

### Pipeline 2 — `skillfit.py`

- **Gate A — relevance.** Keyword match of the skill's own description against
  the manifest's `needs`. Free. Discards the overwhelming majority.
- **Gate B — redundancy.** `skillevaluator similarity-check` against
  `installed_skills_dir`. Needs embeddings. Fails closed to `partial_overlap`.
- **Gate C — validation.** `skillevaluator validate` (keyless tier-1). Split
  into **hard** failures (malformed / unsafe: PII, unicode smuggling, structural
  schema) which reject here, and **soft** flags (`fit.provenance_flags`:
  no LICENSE, no author, missing sections, quality score) which never reject —
  they cap the final verdict at `trial`. Also: a bundled `*.py` that does not
  `ast.parse` is a hard failure (SkillEvaluator's own lint swallows SyntaxError
  silently).
- **Gate D — live evaluation.** Not wired. See below.

**Incompleteness → `fit.scan_flags`.** Pipeline 2 reads the security block's
completeness signals through `classify_incompleteness`:
`clean` / `benign` / `blind_spot`. `benign` incompleteness (`reference_unresolved`
on a skill's own file references — near-universal) is recorded but does **not**
cap the verdict. Only `blind_spot` caps (at `trial`, never rejects), with the
`blind_spot_kind` named in the rationale.

**The verdict** (`decide()`): reject on no relevance / redundant / hard tier-1
failure / measurable regression / a negative gate-D `security` delta. Otherwise
`adopt`, unless something caps it at `trial`: open scan findings, a `blind_spot`,
a CAUTION-with-findings, provenance flags, or (post gate-D) an unreported
`security` dimension. The floor guards — a security delta below 0 vetoes; it can
only cap, never carry.

## Gate D — what it would add, and why it isn't wired

Gate D runs the target's task set twice, once with the skill installed and once
without, and reports the per-dimension delta (`security`, `correctness`,
`discoverability`, `effectiveness`, `efficiency`). That delta is the only signal
in the whole pipeline that answers "does this skill measurably help", rather
than "is this skill plausible". It is also the signal a **gated self-improvement
loop** needs: a proposed change is accepted only if the agent measurably does
better with it.

It is not wired because it needs three things that don't exist yet:

1. **A task set.** SkillEvaluator has no `--eval-dataset` flag; a caller-supplied
   set is picked up only from `<skill_dir>/evals/`, or `--full`/`--autopilot`
   generates one. Trellis has no `evals/` directory and no held-out suite for
   the skill domain. `gate_live` stages `manifest.task_set` into `<skill_dir>/evals/`
   if the manifest names one — none does.
2. **A live-agent backend.** `--env-mode docker` + a working agent
   (`codex`, `claude-code`). Costs model tokens and sandbox time per skill;
   `--max-live` caps it.
3. **A reason to spend it.** At the current candidate volume (~a dozen), the
   question "does this skill help" is answerable by installing one and using it.
   Gate D earns its cost at scale, or as the self-improvement accept/reject gate.

`gate_live`'s parser is written and unit-tested against SkillEvaluator's source
(the `tier3` payload shape: `dimensions` is a list of `{id, with_skill,
baseline, lift, verdict}`, keyed back to canonical names via
`manifest.dimension_map`; there is no flat `deltas` map). It has never run
against a live backend. A completed gate-D run that produces an empty `deltas`
raises `GateError` rather than scoring a phantom zero.

## SkillSpector upstream issue

**SAFE is structurally near-unreachable for well-formed markdown skills.**
`report.py` rewrites `SAFE → CAUTION` whenever a scan is not `is_complete`, and
two benign constructs in a skill's *instructions* force `is_complete: false`:

- `reference_unresolved` — any file-path-shaped string that doesn't resolve
  (`` `SPEC.md` ``, `.trellis/graph.json`). Near-universal.
- `static_parse_limit` — a `$NAME` token in a command-shaped span
  (`` `$ARGUMENTS` ``) makes `static_patterns_tool_misuse` return `PARTIAL`,
  which for a single-file skill also zeroes `coverage_percent`.

Reproduced with NVIDIA's own `tier3/reference_skills/calculator`: 0 findings,
100% coverage, both `--no-llm` and full LLM scan, still `CAUTION`, sole cause
`reference_unresolved`. **Status: issue drafted and filed by the maintainer of
this pipeline** (three reproductions incl. calculator). Not fixed upstream as of
this writing. The pipeline works around it by *not* gating on `SAFE` — pipeline 2
reads the raw completeness signals and classifies benign vs blind-spot
incompleteness itself.

## Known limits

- **SAFE near-unreachable in practice** (above). Effectively every real skill
  scores CAUTION; the SAFE/CAUTION distinction carries almost no signal, which is
  why pipeline 1 stopped routing on it.
- **Reproducibility rests on seed + temperature, not a pinned backend.**
  OpenRouter load-balances a model across backend providers and the serving
  backend appears **nowhere** in SkillSpector's JSON. `llm_seed` +
  `llm_temperature` are recorded in the `security` block; they held byte-identical
  output across three runs spaced minutes apart on `deepseek/deepseek-v4-flash`
  at temp 0 for a small clean skill. `llm_model` / `llm_provider` are recorded
  too — verdicts from different models are not comparable.
- **Non-determinism on heavy skills.** The LLM leg fails (`runtime_limit` /
  `llm_batch_failed`) on large bundled-script skills — the failure rate varies
  run to run and is model-dependent (deepseek and kimi time out at 120s;
  qwen partially completes then hits batch failures). A skill's recorded
  classification can flip between runs purely from provider flakiness. The retry
  mechanism + `blind_spot_kind` + `consecutive_provider_failures` bound the
  churn: after 3 consecutive failed runs a skill is settled as
  `provider_persistent` and stops being retried.
- **SkillEvaluator is experimental and moves fast.** Both scripts shell out to
  the CLI and parse JSON rather than importing internals. When a version bumps,
  re-verify the JSON key names in `gate_redundancy`, `gate_validation`,
  `gate_live` against the CLI output first. `validate` and `similarity-check`
  write JSON to a **file** (`-r json -o DIR`), never stdout, and have no
  `--format` flag — `_run_skillevaluator` handles this.
- **Gate C runs under SkillEvaluator's default `external` profile**, which is
  publication-strict. The hard/soft split exists precisely so "no LICENSE" and
  "no author" flag without rejecting.
- **`--env-mode local`** (gate D) skips sandbox charges but runs untrusted code
  on your machine. Docker for anything you didn't write.

## Where this hooks into an orchestration framework

Each hook is a place where a boolean or a delta from these pipelines replaces a
judgment call.

1. **Ingest gate.** Anywhere external instructions enter a run — a skill, a
   prompt fragment, a fetched document — call the scanner and refuse on
   `DO_NOT_INSTALL`. SkillSpector ships an MCP server exposing `scan_skill` with
   a `safe_to_install` boolean. Fail closed: a scan that errors is not a pass.
2. **Self-improvement acceptance gate.** Gate D is the accept/reject signal that
   isn't the author's own opinion: accept a proposed change only if the agent
   measurably does better with it. Two-dimensional — cost down **and** quality
   not down; the quality dimension can only veto, never carry.
3. **Artifact gate.** Run gate 1 over your own generated scripts / subagent
   prompts / skill files before they are committed. Fast, free, catches
   `curl | bash`, over-broad triggers, credential reads flowing to a network call.
4. **Protected-core boundary.** A skill whose trigger collides with a core
   capability is what you want blocked at adoption time. Trigger-shadowing is a
   real detection category.
5. **Provenance in the run record.** Record the ledger entry id, `content_hash`,
   `blind_spot_kind`, and scan verdict for every skill loaded into a run. The
   `history` array is append-only for this reason.

## Cost discipline

- Content hashing (`content_hash`) means an unchanged skill is never rescanned.
- `--baseline` suppresses characterised noise so rescans surface only new issues.
- The gate-2 retry policy bounds paid re-scans: 3 in-run attempts, then 3
  nightly runs, then `provider_persistent` and no more retries.
- `--max-live` would cap gate D per invocation once it exists.
