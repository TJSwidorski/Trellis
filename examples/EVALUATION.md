# Evaluation sheet

Fill this in after a run and paste it into a Claude conversation. The point is to
separate **three different failure sources** that all look the same from the outside:
a bad plan, a weak model, or a broken kit. Without that separation, the obvious
reaction to a bad run is "use a better model," which is usually the wrong fix.

---

## 1. Planning quality

Answer before looking at run results, so the outcome doesn't colour the judgement.

- Node count / depth / high-risk count:
- Did `validate` pass on the first try? If not, what did it reject?
- **Stub test:** pick two nodes. Would their tests pass against an implementation
  that returns `null` for everything?
  - node ___: yes / no
  - node ___: yes / no
- Any node whose goal contains "and" joining two capabilities?
- Any two independent nodes that should have been one, or vice versa?
- Did the plan add dependency edges that weren't real interface dependencies?

> A "yes" on the stub test is the single most important finding you can record.
> It means that node's green status proved nothing.

## 2. Run outcome

| node | status | tier landed | attempts | failure kinds seen |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

- Nodes merged on the cheapest tier: ___ / ___
- Nodes that needed escalation: ___
- Nodes exhausted: ___
- Merge conflicts: ___
- Wall clock: ___

## 3. Failure taxonomy

Count each kind across all attempts. The distribution says what to fix.

| kind | count | what it points at |
| --- | --- | --- |
| `test-failure` | | model capability *or* node too big |
| `test-tampering` | | test may be unsatisfiable, or contract unclear |
| `out-of-scope` | | `write` scope too narrow, or node needs splitting |
| `no-files` / `malformed` | | prompt too long — trim the `read` list |
| `provider-error` | | infrastructure, ignore for evaluation |
| `no-op` | | model didn't understand the goal at all |
| `env-failure` | | **environment, not model** — see below |

Dominant kind: ___

> **`env-failure` is excluded from the denominator.** A missing library exits
> non-zero exactly like a failing assertion, so before this classification existed
> these were counted as `test-failure` — which reads as "model capability" and
> points at the one fix that cannot work. No stronger model can import a package
> that is not installed.
>
> If you see any, the run is not evaluable: install the dependency, `--resume`, and
> score the completed run. Do not average an environment fault into a capability
> measurement.

## 4. The integration question

Per-node gates can all be green while the assembled system is broken, because two
nodes agreed on nothing. This is the known gap in v1 and the thing most likely to
need a v2 change.

- Does the full suite pass on `main` after the run?
- Did any two nodes disagree about a shared signature or data shape?
- Was there anything the graph had no node for, that only became visible at the end?

## 5. Cost

The only metric that matters across runs.

- Orchestrator context used during `/trellis-plan`:
- Orchestrator context used during `/trellis-report`:
- Worker tokens by tier (from the REPORT.md cost table):
- **Orchestrator tokens per merged node:** ___

Compare to the previous run. If this is flat or rising while the green rate holds,
the planning is not improving — that's where to spend effort, not on model choice.

## 6. Kit defects

Things that were wrong with Trellis itself, as distinct from the plan or the models.
Be specific — a crash, a misleading message, a check that should have fired and
didn't, a report section that was useless.

-

## 7. One change for v2

If you could make exactly one change before the next run, what is it? Resist listing
five. The discipline of picking one is what makes the comparison meaningful.
