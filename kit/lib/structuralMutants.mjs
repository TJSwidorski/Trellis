import path from "node:path";
import { CHECKABLE_EXT } from "./verify.mjs";

/**
 * Mechanical, zero-token mutation generation — the free half of the mutation
 * oracle. `node.mutations` in the product graph is Opus's judgement about
 * which WRONG implementation is plausible for a given contract; that costs a
 * provider call per mutation and is worth it. These do not need that
 * judgement or a call at all: a flipped comparison, a flipped boolean, a
 * flipped `++`/`--` is wrong regardless of what the contract says, so it
 * runs whether or not the graph declared any mutations, and costs nothing
 * but a gate execution.
 *
 * This is a lightweight, token-level approximation of property-based
 * mutation testing — it perturbs the IMPLEMENTATION source, not generated
 * INPUT values, and it is scoped to languages `node --check` can parse (see
 * CHECKABLE_EXT in verify.mjs). Framed honestly rather than oversold: the
 * rest of this remediation series exists to remove exactly this kind of
 * inflated claim of rigor.
 *
 * Longest-match-first and negative lookaround so `===`/`!==` are never
 * partially matched by `==`/`!=`, and `<=`/`>=` are never partially matched
 * by `<`/`>`.
 */
const OPERATORS = [
  { pattern: /===/g, replacement: "!==", label: "=== flipped to !==" },
  { pattern: /!==/g, replacement: "===", label: "!== flipped to ===" },
  { pattern: /(?<![=!<>])==(?!=)/g, replacement: "!=", label: "== flipped to !=" },
  { pattern: /(?<![=!<>])!=(?!=)/g, replacement: "==", label: "!= flipped to ==" },
  { pattern: /<=/g, replacement: "<", label: "<= flipped to <" },
  { pattern: />=/g, replacement: ">", label: ">= flipped to >" },
  { pattern: /(?<![<>=])<(?!=)/g, replacement: "<=", label: "< flipped to <=" },
  { pattern: /(?<![<>=])>(?!=)/g, replacement: ">=", label: "> flipped to >=" },
  { pattern: /&&/g, replacement: "||", label: "&& flipped to ||" },
  { pattern: /\|\|/g, replacement: "&&", label: "|| flipped to &&" },
  { pattern: /\+\+/g, replacement: "--", label: "++ flipped to --" },
  { pattern: /--/g, replacement: "++", label: "-- flipped to ++" },
  { pattern: /\btrue\b/g, replacement: "false", label: "boolean literal true flipped to false" },
  { pattern: /\bfalse\b/g, replacement: "true", label: "boolean literal false flipped to true" },
];

/** True where this path's language is one OPERATORS' token matches are meaningful for. */
export function structurallyMutable(relPath) {
  return CHECKABLE_EXT.has(path.extname(String(relPath)).toLowerCase());
}

/**
 * Every single-occurrence structural mutant of `source`, in file order. Each
 * flips exactly one operator occurrence — the standard mutation-testing unit
 * — not every occurrence of that operator at once, so a survivor names the
 * one call site the tests failed to exercise rather than the whole file.
 *
 * `limit` bounds how many are returned, applied to the front-to-back scan
 * order — the caller decides whether front-to-back is a fair sample or
 * whether it should shuffle first.
 */
export function generateStructuralMutants(source, { limit = Infinity } = {}) {
  const mutants = [];
  for (const { pattern, replacement, label } of OPERATORS) {
    // Reset lastIndex per operator: `pattern` is a shared module-level
    // regex object with the `g` flag, so exec() carries state across calls
    // if not rewound.
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(source))) {
      if (mutants.length >= limit) return mutants;
      const start = m.index;
      const end = start + m[0].length;
      mutants.push({
        description: `${label} (offset ${start})`,
        mutate: () => source.slice(0, start) + replacement + source.slice(end),
      });
      // Non-overlapping matches only within one operator's scan — advance
      // past the just-matched text rather than resuming at m.index + 1,
      // otherwise "===" would also register spurious "==" hits inside itself.
      pattern.lastIndex = end;
    }
  }
  return mutants;
}
