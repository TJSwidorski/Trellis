# Predictions — written before scanning

Corrected buckets: of the 13 "SKILL — scan-ready" entries, only **1** is a true
single skill (`zanwei/design-dna`). Full re-bucketing in the report. These 8 are
what I'm scanning (4 clear singles + `google-labs-code/design.md`'s 4 dev-workflow
skills, which are small and coherent).

| skill | prediction | why |
|---|---|---|
| `zanwei/design-dna` | **SUSPICIOUS** | has `scripts/` (4 files), analyses images/URLs, no `allowed-tools`. Executable content + URL handling + no tool scoping is exactly what makes gate 1 score high. Predict CAUTION or DO_NOT_INSTALL; the 1.3× executable multiplier applies. |
| `lottiefiles/motion-design-skill` (`skills/motion-design`) | **CLEAN** | 0 scripts, pure guidance markdown, `license: MIT` + `metadata.author`. Predict CAUTION low, driven only by the structural `reference_unresolved` SAFE→CAUTION downgrade + maybe LP3 (no `allowed-tools`). |
| `nutlope/hallmark` (`skills/hallmark`) | **CLEAN** | 0 scripts, guidance only, `references/`. "Powered by Together AI" is prose, no code. Predict CAUTION low; small chance of an E1 false-positive if `references/` carry URLs. |
| `ayghri/i-have-adhd` (`skills/i-have-adhd`) | **SUSPICIOUS** | 0 scripts, but `disable-model-invocation: true` + hard persistence language ("apply to every response for the rest of the session", "do not expire", "if you are unsure whether they still apply, they do"). That's the shape of anti-refusal / memory-poisoning / rogue-agent static patterns, benign intent notwithstanding. Predict CAUTION or DO_NOT_INSTALL — the test case for "true positive vs score saturation". |
| `design.md/tdd` | **CLEAN** | TS TDD workflow doc, 0 scripts, minimal frontmatter. Predict CAUTION low. |
| `design.md/ink` | **CLEAN** | TS library usage doc with illustrative (non-executable) code blocks. Predict CAUTION low; small chance an import/`npx` snippet trips a pattern. |
| `design.md/typed-service-contracts` | **CLEAN** | architecture-pattern doc, 0 scripts. Predict CAUTION low. |
| `design.md/agent-dx-cli-scale` | **CLEAN** | a scoring rubric, 0 scripts, one relative blog link. Predict CAUTION low. |

Overall: **6 CLEAN, 2 SUSPICIOUS.** The two suspicious ones are suspicious for
*structural* reasons (design-dna: executable + URL surface; i-have-adhd:
persistent-instruction language) — not because I think either is hostile. If
gate 1 flags them for those reasons that's a **true positive on the pattern**
even if the skill is benign. If it also flags the 6 clean guidance docs at
comparable severity, that's the **score saturating**.
