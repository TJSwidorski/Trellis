---
name: quant-phase-status
description: Report progress against a phased implementation plan. Reads tasks/implementation_plan.md, parses phase headers and checkboxes, and returns a status table, the active phase, the next open items, and any lessons in tasks/lessons.md relevant to that phase. Use when asked where a project stands, what phase it is in, or what to do next.
---

# Skill: quant-phase-status

When this skill is invoked:

1. Read `tasks/implementation_plan.md` in the current working directory.
2. Parse all phase headers and their checkbox items.
3. Output a concise status table — each phase on one row: phase name | done | total | emoji (✅ all done, 🔄 in progress, ⬜ not started).
4. List the next 3 open `[ ]` items across all phases.
5. State which phase is currently active (first with any open items).
6. If `tasks/lessons.md` exists, surface any lessons relevant to the active phase.

Keep output tight — no preamble, just the table and next-item list.
