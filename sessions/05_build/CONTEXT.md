# Stage 05 — build

**No model runs this stage.** It is `kit/lib/runner.mjs` executing the graph
headless: topological dispatch, retry, tier escalation, gates, merge.

```
node kit/bin/cli.mjs run
node kit/bin/cli.mjs run --resume
```

Orchestrator tokens spent during a build: zero. That property is the whole reason
Trellis exists, and it is why the loop lives in code rather than in a conversation.

## Outputs

- `.trellis/REPORT.md` — one compact artifact
- `.trellis/state.json`, `.trellis/run.jsonl` — the runner's, not yours

## If you are a model reading this

You have opened the wrong file. You do not dispatch nodes, poll for results, or
read worker output as it streams. Go to `sessions/06_triage/CONTEXT.md` once the
report exists.
