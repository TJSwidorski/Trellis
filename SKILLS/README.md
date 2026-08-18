# The arsenal

Everything Trellis carries into a project: skills, reference lenses, and the
provenance record for each. `REGISTRY.json` is the control surface.

```
SKILLS/
  REGISTRY.json      provenance + audit status + activation rules
  skills/<name>/     SKILL.md and assets — the source of truth
  lenses/<name>.md   Layer 3 reference material, never auto-loaded
  AUDIT/<name>.md    the audit record that admitted each entry
```

## Two rules

**`SKILLS/skills/` is the source of truth. `.claude/skills/` is a materialised
view of it.** The driver rewrites that view before each stage; `SKILLS/` is what
you edit and commit. `.claude/skills/` is gitignored, because a directory the
driver rewrites between stages would otherwise leave the tree dirty and the runner
refuses to start dirty.

**Nothing unaudited ever loads.** Only `trusted-provenance` and `audited` entries
activate. `pending` and `rejected` are inert, and so is an entry with no status at
all — unclassified fails closed. No activation rule and no manual override can get
around it; `kit/lib/skills.mjs` checks the gate first and unconditionally, and
adversarial fixtures in `kit/regression/run.mjs` try to defeat it on every run.

The reason for the strictness: a skill is an instruction file that the orchestrator
reads into its own context. That makes it the highest-privilege artifact in the
system — strictly more dangerous than an unaudited dependency, because it needs no
code at all to do damage. `lenses/repo-audit.md` is the admission standard.

## Which skills load, and why

Activation is resolved mechanically by the driver, in code, before a session
starts. **It costs zero model tokens** — no model ever reads a manifest.

| Switch | Fires |
| --- | --- |
| `always` | every session. Reserve for voice and behaviour skills. |
| `stage: [...]` | only in the named stages. |
| `applies_to: {kinds, surfaces, lenses}` | when the current slice contains a matching node. |
| `manual` | only when named in `trellis.config.json` → `skills.manual`. |

`applies_to` resolves against the product graph's own `kind`, `surfaces`, and
`lenses` fields, so **skill selection is derived, never authored** — the same rule
the schema already enforces for `high_risk`. A SPEC author never needs to know this
catalogue exists.

```bash
trellis skills --stage 04_tests --explain
```

## Why gate at all

The token cost is real but modest: roughly 70 tokens per activated skill at session
start, so twenty skills is ~1,400 tokens per session and ~7,000 per slice — under
1% of an Opus window. **The token argument alone would not justify this machinery.**

Two things do. Gating is mechanical, so it costs nothing to run. And the cost that
actually bites is **selection accuracy**: a model choosing among forty descriptions
picks worse, and fires spurious skills more often, than one choosing among six. No
per-node metric captures that.

Measure before adding anything to the `always` list.

## Adding an entry

1. `git clone` it — cloning is safe, installing is not, and **do not open the folder
   with an agent running**.
2. Audit against `lenses/repo-audit.md`. Write the result to `AUDIT/<name>.md`.
3. Add to `REGISTRY.json` pinned to a **full commit SHA**, never a tag — tags are
   mutable and a maintainer can retarget them.
4. Set `audit_status` to `audited` and put the SHA in `audited_sha`.

Trust is per-commit, not per-repo. On update, diff against `audited_sha` rather
than re-reading, and re-audit anything that changed in an instruction file.

**Connectors are not skills.** MCP servers (`21st.dev`, shadcn, Figma) need a
stricter path: a live `tools/list` dump diffed against the descriptions in source,
because what a server serves at runtime can differ from what its repo shows. Static
review cannot catch that, so connectors stay `manual` and are wired through
`.mcp.json` rather than materialised here.
