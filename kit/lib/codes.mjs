// The vocabulary that self-improvement counts in.
//
// The failure mode this file exists to prevent is subtler than the one evolve.mjs
// guards. There, the risk is a system that weakens its own gates. Here, it is a
// system that never learns anything at all, because "unhandled-error",
// "unhandled-error-path" and "missing-error-handling" are three codes at one
// occurrence each and a threshold of three is never reached.
//
// Two rules, and the second is the one that matters:
//
//   1. An unrecognised code is BUCKETED, never rejected. A session that cannot
//      record a novel failure will record the nearest wrong one instead, and a
//      wrong code is worse than an unknown one — it inflates an unrelated pattern
//      toward acting on evidence that was never about it.
//   2. A bucketed code can never become actionable, at any run count. So the loop
//      cannot invent a code and then act on it. Widening the vocabulary means
//      editing references/CODES.md, which is a human commit.

import fs from "node:fs";
import path from "node:path";

const BEGIN = "<!-- codes:begin -->";
const END = "<!-- codes:end -->";

export const CODES_DOC = "references/CODES.md";
export const OTHER = "other:";

const EMPTY = { schema: "trellis.codes/1", rejection: {}, friction: {} };

/**
 * Parse references/CODES.md.
 *
 * The machine-readable list lives in one fenced block between HTML comment
 * markers, and the prose around it is what a human reads. Keeping both in one
 * file is deliberate: a vocabulary split across a schema file and a doc drifts,
 * and this repo already has four copies of the stage list to prove it.
 */
export function loadCodes(root) {
  const p = path.resolve(root, CODES_DOC);
  if (!fs.existsSync(p)) return { ...EMPTY, missing: true };
  const text = fs.readFileSync(p, "utf8");

  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(
      `${CODES_DOC}: could not find the ${BEGIN} / ${END} block. ` +
        `The prose is for humans; that block is the only part the kit parses.`
    );
  }

  const fenced = text.slice(a + BEGIN.length, b);
  const json = fenced.replace(/^\s*```(?:json)?/, "").replace(/```\s*$/, "");

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`${CODES_DOC}: the codes block is not valid JSON — ${e.message}`);
  }

  return {
    schema: parsed.schema ?? EMPTY.schema,
    rejection: parsed.rejection ?? {},
    friction: parsed.friction ?? {},
    // Prose headings, so `trellis codes` can report a code documented in one half
    // and not the other. Undocumented codes still work; they are just unexplained.
    documented: new Set([...text.matchAll(/^###\s+(\S+)\s*$/gm)].map((m) => m[1])),
  };
}

/** Every known code, both families. */
export function allCodes(codes) {
  return [...Object.keys(codes.rejection ?? {}), ...Object.keys(codes.friction ?? {})];
}

export function isKnown(code, codes, family = null) {
  if (typeof code !== "string") return false;
  if (family) return Object.hasOwn(codes[family] ?? {}, code);
  return Object.hasOwn(codes.rejection ?? {}, code) || Object.hasOwn(codes.friction ?? {}, code);
}

export function isBucketed(code) {
  return typeof code === "string" && code.startsWith(OTHER);
}

/** The slug half of `other:foo-bar`, or null for a known code. */
export function bucketOf(code) {
  return isBucketed(code) ? code.slice(OTHER.length) : null;
}

/**
 * A known code passes through; anything else becomes `other:<slug>`.
 *
 * Idempotent by construction — normalising an already-bucketed code must not
 * produce `other:other:x`, or the same observation would count under two keys.
 */
export function normaliseCode(raw, codes, family = null) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (isKnown(s, codes, family)) return s;

  // Strip any number of leading "other:" prefixes before slugging, so the
  // operation is stable no matter how many times it has been applied.
  s = s.replace(/^\s*(?:other\s*:\s*)+/i, "");
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  if (isKnown(slug, codes, family)) return slug;
  return OTHER + slug;
}

/**
 * Group near-identical buckets FOR DISPLAY ONLY.
 *
 * Never for counting. Counting fuzzy matches would hand the loop a way to reach a
 * threshold by varying spelling, which is exactly the manipulation the run-count
 * discipline exists to prevent. A human looking at the grouped list can see that
 * three spellings are one idea and add the code deliberately.
 */
export function groupSimilar(buckets, { minOverlap = 0.6 } = {}) {
  const tokens = (b) => new Set(bucketOf(b).split("-").filter(Boolean));
  const groups = [];

  for (const b of buckets) {
    const t = tokens(b);
    const hit = groups.find((g) => {
      const shared = [...t].filter((x) => g.tokens.has(x)).length;
      const union = new Set([...t, ...g.tokens]).size;
      return union > 0 && shared / union >= minOverlap;
    });
    if (hit) {
      hit.members.push(b);
      for (const x of t) hit.tokens.add(x);
    } else {
      groups.push({ members: [b], tokens: new Set(t) });
    }
  }

  return groups.map((g) => ({ members: g.members }));
}
