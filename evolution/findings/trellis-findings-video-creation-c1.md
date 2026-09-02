# Trellis — findings from the Video-Creation cycle 1 setup

Source: first real run of Video-Creation against kit v2.10.2, September 2026.
Every item below cost time on a single afternoon and is reproducible.

Ordered by cost incurred, not by severity. Tier column uses `references/EVOLUTION.md`'s
classification — advisory prose vs load-bearing code.

| # | Finding | Tier | Cost |
|---|---|---|---|
| 1 | `doctor` advertises a flow retired in v2.5.0 | load-bearing | ~3h |
| 2 | Nothing detects an orphaned `graph.json` | load-bearing | ~1h |
| 3 | Scope bullets are written per phase, sliced per level | advisory | ~1h |
| 4 | No node owns the toolchain the gates invoke | advisory | caught in review |
| 5 | `doctor` checks API keys but not gate interpreters | load-bearing | ~1h |
| 6 | Non-vacuity proves nothing for non-JS/TS test files | load-bearing | not yet hit |
| 7 | Content-first install collides with the payload | advisory | ~30m |
| 8 | Autonomy exists but is not discoverable | advisory | — |

---

## 1. `doctor` advertises a retired flow

**Symptom.** `node kit/bin/cli.mjs doctor` ends its next-steps block pointing at
`/trellis-plan`. That flow was retired in v2.5.0 when QUICKSTART was cut over to the
`sessions/NN_stage/CONTEXT.md` pipeline. The skill still resolves and still produces
plausible output.

**What it cost.** A full planning session that wrote `.trellis/graph.json` directly,
skipping `01_ingest` and `02_slice`. The output was good work — 22 nodes, clean
decomposition, a thorough review — against node ids the pipeline had never seen.
Most of it had to be discarded and redone.

**Why it is worse than a stale doc line.** A retired flow that errors is a five-minute
problem. A retired flow that *succeeds* produces artifacts indistinguishable from
correct ones until two stages later. The failure surfaces far from its cause.

**Proposed fix.** Grep the shipped surface for references to retired flows as a
regression check. Any retired skill either stops resolving or prints a redirect naming
its replacement. Retiring something and leaving a pointer to it is the actual defect.

## 2. Nothing detects an orphaned `graph.json`

**Symptom.** `.trellis/` held `graph.json` and `product-graph.json` and nothing else —
no `ingest.json`, no `cycle.json`, no `plan.json`. `trellis status` reported "No run
yet" and said nothing about the graph sitting next to it.

**Why it matters.** `graph.json` is the most consequential artifact in the tree. One
present without the run that should have produced it means something wrote it out of
band. Stage 02's verify would eventually catch the mismatch, but only after a cycle was
begun and a slice cut — several steps after the evidence was already on disk.

**Proposed fix.** `status` and `doctor` report a `graph.json` with no `cycle.json`, no
`plan.json`, or a cycle stamp that does not match the current one. Name it plainly:
"graph.json exists but no cycle produced it." This is the same class of check as the
existing stale-cycle regression fixtures, one level earlier.

## 3. Scope bullets are written per phase, sliced per level

**Symptom.** `SPEC.md`'s "Scope for this run" was written with eight bullets covering
the whole contracts phase. `trellis slice` cut three nodes — all of level 0. Five
bullets had no node that could claim them.

**Root cause.** Nothing states the granularity. A reasonable author reads "this run" as
the phase they have in mind; Trellis cuts by dependency level, which is usually much
smaller. The mismatch only surfaces at the coverage check.

**Proposed fix.** `examples/SPEC.template.md` and QUICKSTART say explicitly that scope
bullets describe **one slice, not one phase**, and that the section is rewritten every
cycle. A worked example showing an 8-bullet phase becoming three 3-bullet cycles would
land harder than the rule.

## 4. No node owns the toolchain the gates invoke

**Symptom.** Every TypeScript gate in the planned graph was
`node --test ts/tests/*.test.ts`, and the tests called `npx tsc --noEmit`. No node wrote
`tsconfig.json`, `ts/package.json`, `pyproject.toml`, `py/__init__.py`, or the pytest
config that keeps `fixtures/` uncollectable — which six fixture nodes asserted and none
implemented. The first three implementer nodes would have failed on infrastructure
rather than on their contracts.

**Why the graph invites this.** Every node is a product concern. Scaffolding is a
prerequisite for the gate rather than a deliverable, so it has no natural home and gets
assumed into existence.

**Proposed fix.** Stage 02's CONTEXT.md asks directly: can every gate command in this
graph run against what these nodes create? If not, a scaffold node with `deps: []` is
part of the cut. A gate command that cannot execute is not a gate.

## 5. `doctor` checks API keys but not gate interpreters

**Symptom.** Preflight reported "tier API keys present" and passed. Python was not on
PATH — the Windows Store alias stub shadowed a real 3.13.3 install. Every `python -m`
gate in the graph would have failed identically, and the first signal was a Claude Code
hook error unrelated to any stage.

**Proposed fix.** `doctor` resolves the interpreters the graph's gate commands name.
It already parses gates for other purposes; a "can I execute this" check is the same
information used one step further. Windows-specific: a `python.exe` resolving inside
`WindowsApps` is the Store stub, not an install, and is worth naming as such.

## 6. Non-vacuity proves nothing for non-JS/TS test files

**Symptom.** `verify-tests` proves non-vacuity for `.js`, `.ts`, `.tsx`, `.mts`.
Everything else returns `unsupported-language`, a soft finding. Stage 04 passes.

**Why it matters here.** Video-Creation's design puts every invariant in Python — lint,
audio, timing, provenance. A green stage 04 on the Python half is a weaker claim than
the same green on the TypeScript half, and nothing in the output distinguishes them.
This is the same shape as the original 21-of-25 weak-tests failure: a check that
succeeds by finding nothing.

**Proposed fix.** Short term, `unsupported-language` is reported in the stage summary
with a count, so "proved 6, could not prove 9" is visible rather than implied. Longer
term, a Python non-vacuity path — the null-stub technique ports directly.

## 7. Content-first install collides with the payload

**Symptom.** `setup.mjs` skips any payload item that already exists. A repo prepared
with its own `references/` before installing silently loses the kit's `references/`
tree — `conventions.md`, `scale-tiers.md`, the chiefs, the skills catalogue. Recovery
was renaming aside, installing, and merging back.

**Proposed fix.** QUICKSTART states the order: install into an empty or
kit-only repo, *then* add SPEC, product graph, and project references. Additionally,
`setup.mjs` distinguishes "skipped, identical" from "skipped, yours differs" and says
which — a silent skip on a directory the stages read is the failure mode.

## 8. Autonomy exists but is not discoverable

**The ask.** Run 03 → 04 → 05 → 06 without prompting each stage.

**This already exists.** `trellis auto --cycles N` drives the default chain headless,
verifying each stage on disk and committing exactly what that stage declared. `--dry-run`
prints the plan and cost first. `OPERATING.md` is its manual. `07_evolve` is periodic and
reachable only by `--stage`.

**So the gap is discoverability, not capability** — and it is the same gap as finding 1.
`doctor` sent a first-time user to a retired manual flow rather than to `auto`. Fixing
finding 1 mostly fixes this one.

**The honest caveat for this project.** `auto` stops unconditionally at the high-risk
checkpoint after `06_triage`, and Video-Creation's ingest derived **23 high-risk nodes
of 34** — nearly every one is a one-way door or an interface with multiple consumers.
Cycle 1's three nodes are all high-risk. So `auto --cycles 3` will halt at the first
checkpoint every time, and that is the design working, not failing: one-way doors get
human eyes. Expect autonomy *within* a cycle long before autonomy *across* cycles, and
expect it to arrive as the build moves past the contract layer into implementation
nodes with fewer dependents.

---

## What this list does not contain

No finding here is about the graph, the spec, or the architecture. Ingest validated
34 nodes with zero errors on the first attempt, and the slice was correct. Every item
above is environment, documentation, or a stale pointer.

That is worth recording as its own result: the parts of Trellis that were hard to build
worked, and the afternoon went to a docs line, a PATH entry, and an install ordering
nobody had written down.
