# Trellis — mission

**This file is the immutable core. No model may propose a change to it. Only a
human may edit it, and doing so is a deliberate act, not a refinement.**

---

## Purpose

Trellis breaks large software projects into small, digestible units of work and
builds them to a high standard using expensive judgement sparingly and cheap
implementation abundantly.

## Invariants

These are the ends. They do not change.

1. **The test is the contract.** Nothing merges that was not proven against an
   oracle written before the implementation existed.
2. **Judgement is scarce, implementation is cheap.** The orchestrator's context is
   the binding resource. Work that does not require judgement does not enter it.
3. **Completion is proven, never claimed.** A stage is done when an artifact on
   disk says so. A model's assertion that it finished is not evidence.
4. **The three failure modes of generated software are treated as defects, not
   taste:** insecurity, non-scalability, and design slop. Each has a gate.
5. **Every intermediate artifact is a plain file a human can read and edit.**

## Non-goals

Naming these is as load-bearing as naming the goals. Trellis is not:

- A general agent. It builds software from a specification. It does not decide
  what to build.
- A replacement for review on irreversible decisions. One-way doors get human eyes.
- A system that optimises for green runs. A green run against weakened gates is a
  worse outcome than a red run against honest ones.

## What mechanisms are NOT protected

The invariants above are fixed. How Trellis achieves them is not. Graph
decomposition, loop escalation, tier ladders, the specific gates, the session
split — all of these are mechanisms, and mechanisms are allowed to change when
evidence says a better one exists. See `references/EVOLUTION.md`.

If a proposed change would satisfy the invariants better, it is admissible even
if it discards everything else in this kit.

## The protected set

`trellis evolve` will refuse to write a proposal touching any of these:

```
MISSION.md
kit/lib/gate.mjs
kit/lib/verify.mjs
kit/lib/mutate.mjs
kit/lib/worktree.mjs
kit/schema/
kit/regression/
.claude/hooks/
```

The last two matter most and are the least obvious. A system that can edit its own
regression suite has no regression suite. A system that can edit its own schema can
redefine failure as success.
