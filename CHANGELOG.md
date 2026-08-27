# Changelog

Format: one section per tagged release, newest first. Each entry names the
commit range and the tag. This file starts at 2.1.0 — everything before that is
`2.0.0` as shipped and described in `README.md` / `UPGRADING.md`.

Schema and file-format identifiers (`trellis.product-graph/1`,
`trellis.skill-registry/1`, the task-graph `version` field, and anything else
under `kit/schema/`) are **not** tracked by this file. They change only on an
incompatible on-disk format break, documented in `UPGRADING.md`, not on a routine
release.

## v2.1.0 — baseline

The state three independent adversarial audits were performed against: `main`,
the (already merged) `evolve-evidence-loop` branch, and the unmerged
`run-two-fixes` branch. This release does not fix anything found — it exists so
every fix after it lands as a visible, tagged increment against a known point.

- Pushed 25 commits that had accumulated on local `main` without ever reaching
  `origin/main`.
- Deleted branch `evolve-evidence-loop` (fully merged, 0 commits ahead of `main`).
- Added this file and a CI workflow (`.github/workflows/test.yml`) running
  `npm test` on push and PR — there was no CI of any kind before this.
