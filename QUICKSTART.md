# Quickstart — Windows 11 + VS Code

About ten minutes. No WSL. Everything is Node.

---

## 0. Prove the kit works before you spend a cent

Unzip anywhere. The kit root is **the folder containing `package.json`** — that is
where every command runs from. If you are unsure where you landed:

```powershell
Get-ChildItem -Recurse -Filter package.json | Select-Object -First 1 FullName
```

`cd` to that folder, then:

```powershell
npm test
```

You should see three suites pass: `28/28 unit checks`, `190 regression checks`, and
`43/43` end-to-end. (An *installed* copy reports slightly fewer regression checks:
the ones that verify the installer itself need `setup.mjs`, which the installer
does not install.) They spin up a fake model server and throwaway git repos and
run the whole scheduler offline — parallel nodes, retries, tier escalation,
test-tamper rejection, exhaustion, blocking, the review hold, environment-failure
detection, and the skill audit gate. No API key needed.

Roughly half the regression fixtures are *adversarial*: inputs engineered to be
rejected. If one of those fails, a gate stopped catching something it used to.
No API key involved. If this passes, the machinery is sound and any later problem is
configuration or a model.

---

## 1. Drop it into a project

Trellis is repo-agnostic. Copy these into the root of the repo you want to build:

```powershell
node setup.mjs --into C:\path\to\your\repo
```

That copies the whole payload and then verifies it — every path `CLAUDE.md` and
`CONTEXT.md` reference must exist at the destination, or the install fails loudly
rather than leaving you with a kit whose orchestrator reads missing files.

If you would rather copy by hand, the full set is:

```
kit/                sessions/              references/
evolution/          SKILLS/                examples/
.claude/            .vscode/               .mcp.json
MISSION.md          CLAUDE.md              CONTEXT.md
README.md           QUICKSTART.md          UPGRADING.md
package.json        trellis.config.json    trellis.code-workspace
.gitignore
```

The target repo must be a git repo, on a clean base branch, with at least one commit.

```powershell
git status                          # must be clean
git rev-parse --abbrev-ref HEAD     # must match baseBranch in trellis.config.json
```

`baseBranch` defaults to `main`. A repo created with plain `git init` on an older
git is on `master`, and `doctor` will fail on the mismatch — either rename the
branch (`git branch -m main`) or set `baseBranch` to what you actually use. This
is the single most common first-run stumble and it is not a real problem.

---

## 2. Get a key and set it

One OpenRouter key reaches DeepSeek, Kimi, Qwen, GLM, and MiniMax through a single
OpenAI-compatible endpoint. That's the fastest path for a first run.

```powershell
setx OPENROUTER_API_KEY "sk-or-..."
```

Then **open a new terminal** — `setx` doesn't affect the current one.

Prefer direct providers or a local model? Edit the `tiers` array in
`trellis.config.json`. Anything OpenAI-compatible works.

---

## 3. Check it

```powershell
node kit/bin/cli.mjs doctor
```

This checks Node, git, branch, cleanliness, worktree support, and — the part that
saves you a confusing first run — it asks each provider for its model list and tells
you whether your configured slugs actually exist. Model names churn constantly. If a
slug is dead, `doctor` prints the closest live matches; paste one into the config.

---

## 4. Open the workspace, not the folder

```powershell
code trellis.code-workspace
```

This matters. The workspace is multi-root: as the runner creates a worktree for each
node, it adds that folder to the workspace, and removes it on merge. You watch
parallel workers appear and disappear in the Explorer, and each gets its own section
in Source Control so you can read any worker's diff natively.

Opening the plain folder instead still works — you just lose that view.

---

## 5. Write a spec

Copy `examples/SPEC.template.md` to `SPEC.md` in your repo root and fill it in.

The two sections that determine whether your first run goes well:

- **Interfaces already decided.** Every signature you leave vague becomes a node that
  fails twice and escalates. Paste real types.
- **Explicitly not in scope.** This is what stops the graph sprawling to forty nodes.

**For your first run, skip writing one.** `examples/FIRST-RUN-SPEC.md` is a
filled-in spec for a five-node cart-pricing library — no dependencies, real
correctness surface, and a graph shape that exercises parallelism at two levels plus
a convergence. Copy it straight over:

```powershell
copy examples\FIRST-RUN-SPEC.md SPEC.md
```

`examples/graph.example.json` is a separate four-node graph you can compare the
planner's output against.

---

## 6. Cut a slice, then plan and test it

This section is the "by hand, one stage at a time" path — the right one until you
trust the loop. Once you do, `OPERATING.md` covers driving all of this with one
command (`trellis auto --cycles N`) instead. Same pipeline either way; this is just
watching it happen a stage at a time first.

You don't need a product graph of your own yet — `SPEC.md` from step 5 stands in
for one on your first run. Cut the first batch:

```powershell
node kit/bin/cli.mjs cycle
node kit/bin/cli.mjs slice --max 25
```

`trellis cycle` declares this a fresh pass (you can skip it — `trellis run` begins
cycle 1 for you lazily — but running it explicitly is clearer for a first pass).
`trellis slice` cuts the next buildable batch into `.trellis/plan.json` — mechanical,
no judgement, no model call.

Then, in Claude Code:

```
Read sessions/02_slice/CONTEXT.md and do exactly what it says. Nothing else.
```

Opus turns the plan into `.trellis/graph.json` — write scopes, gate commands,
mutations, any shared interface file two nodes would otherwise agree on by
coincidence. This is the small, expensive, judgement-heavy artifact.

**Read the graph.** Not the tests — the graph. It is about a hundred lines and it is
where the errors that matter live. Check every constant and unit against reality: a
contract can be internally consistent and still absurd.

```
Read sessions/03_cases/CONTEXT.md and do exactly what it says. Nothing else.
```

Adversarial case enumeration, per node — what could be true that the acceptance
bullets did not say. Then:

```
Read sessions/04_tests/CONTEXT.md and do exactly what it says. Nothing else.
```

Sonnet writes the frozen test files from the cases, one test per case id, and runs
`verify-tests` until every gate rejects a null stub. This is the step that used to
consume most of your Opus window.

```powershell
node kit/bin/cli.mjs verify-tests
git add -A
git commit -m "trellis: plan + frozen tests"
```

---

## 7. Run

`Ctrl+Shift+B` in VS Code, or:

```powershell
node kit/bin/cli.mjs run
```

Opus is now idle. You'll see per-node lines as tiers attempt, fail, escalate, and
merge. Failures land in the Problems panel via the task's problem matcher.

Useful flags:

```powershell
node kit/bin/cli.mjs run --resume                  # continue after an interrupt
node kit/bin/cli.mjs run --resume --retry-failed   # also retry exhausted nodes
node kit/bin/cli.mjs run --only codec --concurrency 1   # one node, serial
```

---

## 7b. What the run now checks for you

After each node passes, the `mutations` Opus declared are reintroduced into the
accepted code by a cheap model, and the tests must catch every one. A survivor means
the gate would not have noticed that defect — the node merges but is flagged
`weak-tests` in the report.

Budget ceilings from `trellis.config.json` apply across the whole run. On a breach
the runner stops launching, lets in-flight nodes finish, and marks the rest
`budget-stopped` so `--resume` picks them up.

## 8. Triage

Back in Claude Code:

```
Read sessions/06_triage/CONTEXT.md and do exactly what it says. Nothing else.
```

Opus reads `.trellis/REPORT.md` — one compact artifact, not a stream of worker
chatter — and for each stuck node picks one of: re-decompose, rewrite the contract,
take it itself, or cut it. High-risk nodes that passed are held unmerged; Opus reads
those diffs and records a decision for each — accept or reject — in `triage.json`.

Apply the reversible ones mechanically rather than running `accept`/`reject` by
hand for each node:

```powershell
node kit/bin/cli.mjs apply-triage --apply
```

This resets every rejected node that never landed, bookkeeps every accept that was
already merged, and — the one thing it will never do — never merges a held
high-risk node itself. Those land in `.trellis/checkpoint.json` instead:

```powershell
node kit/bin/cli.mjs accept <id> [<id> ...] --merge     # after you've read the diff
```

Merging the branch in git alone does not do it. Trellis tracks the node as `review`
until `accept` says otherwise, so `--resume` would finish instantly having run
nothing.

Then re-run with `--resume`. Repeat until green — or, once you trust the loop, let
`trellis auto --cycles N` do steps 6 through 8 for you, stopping automatically at
exactly the point this section describes. See `OPERATING.md`.

---

## Debugging the scheduler

When something looks wrong in the *orchestration* rather than the code, use
**Run and Debug → "Debug: e2e suite (no network)"**. Breakpoint `runner.mjs` and step
through dispatch with zero API calls. `"Debug: runner (single node)"` prompts for a
node id and runs just that one, serially, against real models.

This is worth setting up before you need it. A DAG scheduler's bugs are exactly the
kind you cannot diagnose from a chat transcript.

---

## Common first-run problems

| Symptom | Cause |
| --- | --- |
| `Working tree is dirty` | Commit or stash. Trellis merges into this branch. |
| `HTTP 404` from a tier | Dead model slug. Run `doctor`, paste a suggested match. |
| Every node fails `no-files` | The model isn't emitting `### FILE:` blocks. Usually a too-long `read` list — trim to three files. |
| Repeated `test-tampering` | Your test is probably unsatisfiable. Read it again. |
| Repeated `out-of-scope` | The node genuinely needs a file it wasn't given. Widen `write` or split the node. |
| Node passes but integration breaks | Two nodes disagreed on a signature. Have Opus write the interface file during planning. |
| Everything escalates to the top tier | Nodes are too big. Cut finer. |
| `validate` fails on uncovered scope | A spec bullet has no node claiming it in `covers`. Either add the node or narrow the spec. |
| `verify-tests` says `vacuous` | That gate passes against a null stub. The node would go green without working — strengthen the test before running. |
| Node merges as `weak-tests` | A declared mutant survived. The code may be fine; the test cannot tell. Strengthen it and re-run. |
| Run stops with `budget-stopped` nodes | A ceiling in `config.budget` was hit. Raise it and `--resume`. |
| `reject <id>` says "already merged" | It genuinely is — `st.LANDED` covers merged/audit/weak-tests. Revert the merge first; Trellis will not rewrite history. |
| `accept <id>` says "not awaiting review" | It's telling you the verb that actually applies for that status — read the rest of the message. |
| `trellis auto` refuses to start, names `.claude/settings.json` | No `Bash`-matched hook registered — see `.claude/hooks/guard-bash.mjs`. Required before `auto` will run at all. |
| `trellis auto --cycles N` halts, names a file in the tree | It found a modification no stage declared. Either the session should have committed it itself (check the stage's contract) or it's yours — commit or revert it, then re-run. |

---

## What to measure

One number: **orchestrator tokens per merged node**, across runs. If that trends down
while the green rate holds, the kit is working. Wall-clock time and node count are
not metrics.

`node kit/bin/cli.mjs ledger` shows cross-run performance by tag once you have a few
runs; `--routing` shows the per-tier table that tier selection decides from.

After the run, fill in `examples/EVALUATION.md`. It exists to separate three failure
sources that look identical from the outside — a bad plan, a weak model, and a broken
kit. Without that split, the reflex after a bad run is "use a better model," and that
is usually the wrong fix.

---

## Next: `OPERATING.md`

Everything above is the by-hand path — the right one until you trust the loop.
`OPERATING.md` covers the same six stages driven by one command
(`trellis auto --cycles N`), what it commits and when, and exactly where and why it
stops for you. Read it once you've watched a slice go through by hand and want the
loop to run itself.
