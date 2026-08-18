# Skills — Layer 3 reference material

**This is the drop point. Put skill files in the folder that matches, add a row to
the table, and they load when a node names that lens.**

Skills here are *reference material*, not agents. A skill is a document that
constrains how a stage does its work — house conventions, a checklist, a design
system, a set of traps to avoid. It costs the ~1k tokens of its own text and
applies its lens exactly where it is relevant.

This is deliberate. The alternative — a frontend agent, a security agent, an
optimization agent — costs a session each and produces coordination overhead the
problem does not have. A `security.md` loaded during planning and again during
adversarial review applies the same judgement for a fraction of the budget.

## How loading works

Each node in the product graph carries a `lenses` array:

```json
{ "id": "billing.checkout", "lenses": ["frontend-design", "connectors"] }
```

At stage 02 and stage 03, the session loads `references/chiefs/*` for the node's
domain plus every `references/skills/<lens>/` folder named here. Nothing else.

A node with no security surface never sees the security material. A backend node
never loads the design system. That scoping is the point — irrelevant context in
the window measurably degrades the work done on the relevant part.

## The catalogue

| Lens | Folder | Loads at | What belongs here |
| --- | --- | --- | --- |
| `frontend-design` | `frontend-design/` | 02, 03 | Design tokens, component conventions, spacing and type scales, accessibility floors, the visual rules that stop design slop |
| `plugins` | `plugins/` | 02 | Plugin architecture, extension points, versioning and compatibility rules |
| `connectors` | `connectors/` | 02, 03 | Third-party integration patterns, auth flows, retry and idempotency, webhook handling |
| `context` | `context/` | 02, 03, 04 | Context engineering — what to load, what to leave out, how to structure a prompt for a cheap model |
| `token-management` | `token-management/` | all | Budget discipline, compaction rules, when to split a session, what makes a stage expensive |
| `browser` | `browser/` | 02, 03 | Browser APIs, storage constraints, rendering and layout traps, cross-browser behaviour |
| `web-automation` | `web-automation/` | 02, 03 | Scraping and driving pages, selector stability, rate limiting, headless quirks |
| `agents` | `agents/` | 02, 06 | Agent design patterns, delegation boundaries, when an agent is the wrong shape |
| `orchestration` | `orchestration/` | 02, 06 | DAG and pipeline patterns, concurrency, failure isolation, retry semantics |
| `cli` | `cli/` | 02, 03 | CLI ergonomics, flag conventions, exit codes, error messages people can act on |
| `terminal` | `terminal/` | 02, 03 | Shell behaviour, TTY handling, cross-platform paths, Windows and WSL differences |

## Format

Any readable file works — Trellis loads text, it does not parse a manifest. A
`SKILL.md` with frontmatter, a plain `.md`, a `tokens.css`, a JSON schema. Prefer
one file per concern over one long file per folder; stages load whole folders and
a 6k-token catch-all defeats the scoping.

What makes a skill earn its tokens:

- **Rules, not explanations.** "Never nest a button inside an anchor" beats three
  paragraphs on semantic HTML.
- **Traps you have actually hit.** Generic best practice is already in the model.
  Your specific past mistakes are not.
- **Concrete over abstract.** A wrong example next to a right one lands harder
  than a principle.
- **Short.** If a file exceeds roughly 2,000 tokens, split it.

## What does not belong here

- Per-run artifacts. Anything that changes between builds is Layer 4 and lives in
  `.trellis/`. Files here are the factory; files there are the product.
- Secrets or credentials of any kind. `.claude/hooks/block-secrets.mjs` will stop
  a read, but do not rely on it.
- Anything you have not read. These files steer how your software gets built. A
  skill pulled from a repo you have not audited is an instruction-injection
  surface pointed directly at your planner.
