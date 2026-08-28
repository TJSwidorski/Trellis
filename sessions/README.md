# Sessions

Numbered folders are pipeline stages. The number is the execution order; the
folder boundary is the separation of concerns.

Each stage declares a contract in its `CONTEXT.md`: what it reads (Inputs, split
by layer), what it does (Process), what it writes (Outputs), and what it checks
against earlier stages (Verify).

## Why one stage per session

Planning, case enumeration, and test writing for a large graph do not fit in one
context window. We learned this the expensive way: a 134-node run where the test
stage exhausted its budget partway through and reported success anyway, having
written a fraction of the files.

Three consequences shape everything here:

1. **Completion is proven on disk, never claimed in prose.** The driver runs each
   stage's `verify` after the process exits. A stage that died halfway fails its
   own check and re-runs.
2. **Every stage is idempotent.** Re-running it after a partial failure picks up
   from whatever is on disk. This is what makes an interruption a pause rather
   than a corruption, and it is why the driver does not need to predict whether
   the next session will fit.
3. **Each stage starts in a genuinely empty context, not a compacted one.**
   `runSession` (`kit/lib/driver.mjs`) launches a fresh `claude -p` process per
   stage — there is no `--continue`, `--resume`, or session id carried forward
   anywhere in that call. This is a real architectural choice, not a hedge: the
   mainstream long-running-agent pattern is to *compact* a growing history —
   summarise it and keep going in the same window — and 2026's governance-decay
   findings are that compaction can silently drop earlier constraints during the
   rewrite, because the thing being optimised (task accuracy, throughput) is not
   whether governance survived the summary. Trellis never asks a model to
   summarise its own instructions faithfully. It writes the instructions to disk
   once, as this file's contract, and hands a new session nothing but that file
   and the Layer 4 artifacts the contract names. There is nothing to drop,
   because there is nothing carried forward to drop it from.

## Running them

By hand, one at a time — the default, and the right way until you trust the loop:

```
claude
> Read sessions/02_slice/CONTEXT.md and do exactly what it says.
```

Headless, chained, unattended:

```
node kit/bin/cli.mjs auto
node kit/bin/cli.mjs auto --stage 04_tests
```

`auto` is off until you set `driver.enabled` in `trellis.config.json`.

## A note on quota

There is no way to query your remaining subscription quota from a script. Session
caps, weekly caps, and credit balance are visible in the status bar during an
active session and nowhere else. The driver therefore does not ask "will this
fit?" — it runs, verifies, and on failure backs off and retries the same stage.

If `ANTHROPIC_API_KEY` is set, headless runs use it in preference to your
subscription credential. That is the configuration `auto` handles best: documented
limits and retryable 429s are a scheduling problem the driver can solve, where an
opaque subscription cap is a wall it cannot see. It also keeps an overnight build
from eating the quota you wanted for interactive work.
