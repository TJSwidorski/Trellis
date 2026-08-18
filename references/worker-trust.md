# Worker trust

Workers are open-weight models called over an API. Their parameters cannot be
inspected, and a backdoored model would emit code that passes the gate while doing
something else. This file records what protects against that, what does not, and
what is worth investigating.

The framing that matters: **the defence is not trusting the worker, it is denying
it authority its output cannot be checked against.**

---

## What already protects us

- **The test author is a different model family than the implementer.** Opus writes
  the frozen tests through Anthropic; workers implement through OpenRouter. A
  backdoor would have to exist in both, coordinated, to pass. This is the single
  strongest property in the design and it is free.
- **Workers cannot edit tests.** Output screening rejects the write; the gate
  reverts it and records `test-tampering`.
- **`verify-tests` proves every gate rejects a null-returning stub** before any
  worker runs.
- **Mutation testing** reintroduces plausible-wrong variants after a pass. Tests
  that cannot catch them mark the node `weak-tests`.
- **Write scopes are allowlisted** per node, and `boundaries.denyWrite` is absolute.
- **High-risk nodes are read by Opus regardless of a green gate** — one-way doors,
  auth/payments/secrets surfaces, and interfaces with two or more consumers.

---

## Should workers see the frozen tests?

**Yes, and they do.** `buildPrompt` inlines every file in `node.tests`. This is
deliberate and should stay.

The objection is sound in principle: a worker that sees `assert(add(2,3) === 5)`
can write `return 5`. But hiding the tests is the wrong instrument.

**It does not actually hide them.** On failure the gate returns up to
`gate.feedbackChars` of test output to the worker. A worker that fails once learns
the assertions anyway — one attempt later, at one attempt's cost. Hiding delays
disclosure and bills for the delay.

**It does not impede poisoning.** Hiding makes *passing* harder. It does not make
*harming* harder. A poisoned worker still emits whatever it emits; it just needs
one more round trip to calibrate.

**It is expensive.** Without the test, the worker guesses function names,
signatures, arity, return shapes, error types, and module paths. Those failures are
mechanical rather than capability-related — a correct implementation exported under
the wrong name fails for no useful reason. Expect attempt inflation, tier
escalation, and a worse cost-per-merged-node on every honest node, to slightly
inconvenience a dishonest one.

**The real risk it points at is overfitting, and that has a better answer:**

1. **Mutation testing** — already implemented. Declare `mutations` on any node
   whose test could be satisfied by a lookup table.
2. **Property-based assertions over example-based ones.** `add(a, b) === a + b`
   over random inputs cannot be overfit; `add(2,3) === 5` can. This is a test
   authoring instruction for `04_tests`, not a runner change.
3. **Positive controls** for any node whose output is an absence claim — a
   detection check that finds nothing is indistinguishable from one that stopped
   looking unless a fixture requires it to fire.

---

## Investigate: local workers via LM Studio or Ollama

**Why.** Self-hosted weights can be scanned. Microsoft's AI Red Team published
"The Trigger in the Haystack" (arXiv:2602.03085, Feb 2026), a practical backdoor
scanner reporting 87.8% detection with zero false positives across Llama-3.1-8B,
Phi-4, Gemma-3, and Qwen-class models; a semantic-drift approach reports 92.5%.
None of it applies to a model reached over an API, because there are no parameters
to analyse. Going local converts an un-auditable risk into a partially auditable
one, and stops a provider swapping the model under a stable slug.

**Trellis already supports it — config only, no code.** `tierKey` returns null
gracefully when `apiKeyEnv` is absent:

```json
{ "name": "local", "baseUrl": "http://localhost:1234/v1", "model": "qwen3-coder", "maxAttempts": 3 }
```

Run `trellis doctor` afterwards to confirm the slug resolves.

**The economics do not motivate it.** At roughly $1/M blended across the configured
tiers, a $2,000 GPU buys ~2 billion tokens — about 667 full runs at the 3M-token
budget cap before breaking even, ignoring power and setup. A 32B model at 4-bit
quantisation is also meaningfully weaker than kimi-k2.6 or qwen3-coder-next, which
means more escalation and more exhausted nodes. Local hosting is a **security**
decision, not a cost one, and should be argued on those terms.

**Suggested shape.** Keep OpenRouter as the default. Keep a second config that runs
entirely local for security-critical builds, where inspectable weights justify a
capability penalty. Two config files, not two systems.

**Do not switch before an A/B run** — changing worker models changes what the
benchmark measures.

---

## The gate is already the detonation

**Worker-written code executes on the host, with the full environment, before any
human sees it.** This is not a hypothetical at merge time — it is what running the
gate *is*. `node tests/x.test.mjs` imports and runs the implementation the worker
just produced.

Measured, not inferred:

```
exec() in kit/lib/gate.mjs  ->  spawn(command, { cwd, shell: true })
no `env` option  ->  full process.env inherited
observed: 89 variables visible, including OPENROUTER_API_KEY
```

A poisoned worker does not need to wait for its code to be merged, deployed, or
imported by anything. It needs the gate to run once, which is the one thing
guaranteed to happen to every node.

The worktree bounds *where files are written*. It does nothing about environment
variables, network egress, or reads outside the tree.

### Three layers, cheapest first

1. **Strip the environment for gate execution.** Pass an explicit minimal env to
   `exec` rather than inheriting. A gate needs `PATH`, `HOME`, and a language
   runtime's own variables — it does not need API keys. This is a few lines and
   removes the credential exposure outright. Note `kit/lib/gate.mjs` is in the
   PROTECTED set in `references/EVOLUTION.md`, so this is a human-merged change
   and can never be proposed by `trellis evolve`.
2. **Run gates in a container.** Non-root, dropped capabilities, no host home
   mounted, worktree bind-mounted in. Costs startup latency per gate and a Docker
   dependency, which is a real trade for a kit that currently has zero
   dependencies.
3. **Observe, per `v2.sandbox-detonation`.** Canary tokens planted as a fake
   `.env`, fake AWS credentials, and a fake SSH key; a first pass with no network;
   a second behind a logging proxy with DNS capture. Stripping the environment
   stops credential theft but not egress or filesystem reads; this layer is what
   catches those, and it is the only one that produces *evidence* rather than
   prevention.

Layer 1 is cheap enough to be unarguable. Layers 2 and 3 are the same machinery
the scanner's v2 needs, so building it once serves both: **the scanner detonates
other people's repos, and Trellis detonates its own workers' output.** That reuse
is the argument for doing it properly rather than twice.

### Do not change this before an A/B run

Every layer alters what the gate does, and the gate is inside the measurement.
Changing it mid-experiment invalidates comparison. Record the finding, run the
benchmark, then fix.

---

## Investigate: post-gate review hook

Run `code-review@claude-plugins-official` (Anthropic-authored, Anthropic Verified)
against a node's diff after it passes its gate but before it merges — catching code
that satisfies the test while doing something else.

**The tension to resolve first.** Trellis's headline metric is orchestrator tokens
per merged node. A review pass on *every* node attacks that metric directly, and
the kit already reviews the nodes most likely to matter: high-risk and exhausted
ones. So the question is not "should we review" but "does reviewing the remaining
nodes find anything the gate plus mutations did not".

**Measure before adopting.** Run it advisory-only for one full build, record what it
finds on nodes that were already green, and compare against the token cost. If it
finds nothing on low-risk nodes, scope it to `risk: audit` and above and leave the
rest to the gate. That is an evidence question, and the ledger can answer it.
