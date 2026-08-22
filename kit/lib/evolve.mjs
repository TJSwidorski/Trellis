// Self-improvement, gated.
//
// The failure mode this file exists to prevent: the cheapest way to make runs go
// green is to weaken the gate that keeps failing. A system that can edit its own
// gates and its own regression suite will find that path, and every metric will
// improve while the product gets worse.
//
// So: evidence before proposal, proposal before change, and a protected set that
// no proposal may touch at all.

import fs from "node:fs";
import path from "node:path";
import { loadCodes, normaliseCode, isBucketed } from "./codes.mjs";
import * as ledger from "./ledger.mjs";
import { isKnownKind } from "./kinds.mjs";

// Never proposable. See MISSION.md. Prefix match on repo-relative paths.
export const PROTECTED = [
  "MISSION.md",
  "kit/lib/gate.mjs",
  "kit/lib/verify.mjs",
  "kit/lib/mutate.mjs",
  "kit/lib/worktree.mjs",
  "kit/schema/",
  "kit/regression/",
  ".claude/hooks/",
];

// Proposable, but a human merges. Correctness lives here.
export const LOAD_BEARING = [
  "kit/lib/",
  "kit/bin/",
  "kit/mcp/",
  "trellis.config.json",
  "sessions/",
];

// Proposable and auto-applied when the regression suite is green. Prose only.
export const ADVISORY = [
  "README.md",
  "QUICKSTART.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "references/",
  ".claude/skills/",
  "kit/roles/",
];

export function classify(relPath) {
  const p = relPath.replace(/\\/g, "/");
  if (PROTECTED.some((x) => p === x || p.startsWith(x))) return "protected";
  // Advisory is checked before load-bearing so references/ and .claude/skills/
  // are not swallowed by a broader prefix later.
  if (ADVISORY.some((x) => p === x || p.startsWith(x))) return "advisory";
  if (LOAD_BEARING.some((x) => p === x || p.startsWith(x))) return "load-bearing";
  return "unclassified";
}

// ------------------------------------------------------------------ evidence

/** Where the cross-run triage record lives. Routed through config like every
 *  other artifact — see ledgerPath in ledger.mjs, which this mirrors. */
export function triagePath(root, cfg) {
  return path.resolve(root, cfg?.paths?.state ?? ".trellis", "triage.jsonl");
}

// Triage records structured rejection codes, not prose. "the error handling is
// sloppy" cannot be counted; REJECT:unhandled-error-path across nine runs is a
// signal that the cases skill is missing a category.
export function rejectionCounts(root, cfg) {
  const p = triagePath(root, cfg);
  if (!fs.existsSync(p)) return {};
  const codes = loadCodes(root);
  const counts = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n").filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    for (const d of row.decisions ?? []) {
      if (d.verdict !== "reject" || !d.code) continue;
      // Normalise at read time, not write time. Sessions past wrote what they
      // wrote; the vocabulary can grow later and old records pool correctly the
      // moment a spelling becomes a known code.
      const code = normaliseCode(d.code, codes, "rejection");
      if (!code) continue;
      counts[code] ??= { count: 0, nodes: new Set(), runs: new Set() };
      counts[code].count++;
      counts[code].nodes.add(d.node ?? "?");
      if (row.run) counts[code].runs.add(row.run);
    }
  }
  return Object.fromEntries(
    Object.entries(counts).map(([code, v]) => [
      code,
      { count: v.count, nodes: [...v.nodes], runs: v.runs.size },
    ])
  );
}

// A pattern is actionable when the same code appears across enough distinct runs.
// Distinct runs, not distinct nodes: one bad slice producing the same code eight
// times is one observation about that slice, not eight about Trellis.
// Bucketed codes are excluded here unconditionally, at any run count. That is the
// loophole closure: the loop can record a code nobody has agreed on, and can show
// it as pressure, but cannot act on one. Widening the vocabulary is a human commit
// to references/CODES.md.
export function actionable(root, cfg, { minRuns = 3 } = {}) {
  return Object.entries(rejectionCounts(root, cfg))
    .filter(([code]) => !isBucketed(code))
    .filter(([, v]) => v.runs >= minRuns)
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.runs - a.runs);
}

/**
 * Vocabulary pressure: unrecognised codes and how often they recur.
 *
 * These can never trip a threshold. They exist so a human can see that the same
 * unnamed thing keeps happening and decide, deliberately, to name it.
 */
export function unknownCodes(root, cfg) {
  return Object.entries(rejectionCounts(root, cfg))
    .filter(([code]) => isBucketed(code))
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.runs - a.runs || b.count - a.count);
}

// -------------------------------------------------------- mechanical evidence
//
// Rejection codes need a human or a model to have rejected something three
// separate times before anything can be said. Attempt kinds exist from run one,
// cost nothing to collect, and are already in the ledger — they are the reason
// `trellis evolve` stops being inert.

/**
 * Was this node expensive?
 *
 * The scoping decision that makes the whole aggregation work. A node that failed
 * twice on `test-failure` and then landed on the cheap tier is the ladder doing
 * its job, and counting it would drown every other signal in the noise of the
 * system working correctly. So the population is nodes that actually cost
 * something: never landed, needed the top tier, or landed with a mutation still
 * alive.
 *
 * This is not a statistical correction applied after the fact. It is the correct
 * population, and choosing it dissolves the `test-failure` problem without a
 * blocklist that someone would later have to maintain.
 */
function isCostly(rec) {
  return (
    rec.status === "exhausted" ||
    rec.landedTier === "strong" ||
    (rec.survivingMutations?.length ?? 0) > 0
  );
}

function scoped(records, scope) {
  return scope === "all" ? records : records.filter(isCostly);
}

/**
 * Failure kinds by `kind|tag`, deduped by distinct run.
 *
 * Keyed on tag as well as kind because a tooling proposal is almost always "for
 * nodes tagged X we keep hitting Y" — and because tags are the join key routing
 * and skills already use. Identity for dedup is `runId|nodeId`, copied from
 * ledger.tierStats: without it, one node retried four times looks like four
 * independent observations.
 *
 * Deliberately not built on ledger.summarise(), which counts a node once per tag
 * and never dedupes by run. That function is human-facing; this one feeds a
 * threshold, and a threshold needs the stricter arithmetic.
 */
export function kindCounts(root, cfg, { scope = "costly", history = null } = {}) {
  const records = scoped(history ?? ledger.read(root, cfg), scope);

  // Corpus-wide share per kind, for the comparison column below.
  const corpus = {};
  let corpusTotal = 0;
  for (const rec of records) {
    for (const k of rec.failureKinds ?? []) {
      corpus[k] = (corpus[k] ?? 0) + 1;
      corpusTotal++;
    }
  }

  const byTag = {};
  const out = new Map();
  const seen = new Set();

  for (const rec of records) {
    const identity = `${rec.runId}|${rec.nodeId}`;
    const tags = rec.tags?.length ? rec.tags : ["__untagged"];
    for (const k of rec.failureKinds ?? []) {
      for (const tag of tags) {
        byTag[tag] = (byTag[tag] ?? 0) + 1;
        const key = `${k}|${tag}`;
        const e = out.get(key) ?? { kind: k, tag, runs: new Set(), nodes: new Set(), attempts: 0 };
        e.attempts++;
        if (!seen.has(`${key}|${identity}`)) {
          seen.add(`${key}|${identity}`);
          e.nodes.add(identity);
          if (rec.runId) e.runs.add(rec.runId);
        }
        out.set(key, e);
      }
    }
  }

  const result = new Map();
  for (const [key, e] of out) {
    const base = corpusTotal ? (corpus[e.kind] ?? 0) / corpusTotal : 0;
    const local = byTag[e.tag] ? e.attempts / byTag[e.tag] : 0;
    result.set(key, {
      kind: e.kind,
      tag: e.tag,
      runs: e.runs.size,
      nodes: e.nodes.size,
      attempts: e.attempts,
      // Shown, never gated on. Gating on a ratio invites threshold-gaming, and
      // there is no data yet to calibrate a cutoff against.
      share: local,
      baseline: base,
    });
  }
  return result;
}

/**
 * The same kinds keyed by tier.
 *
 * A different and very tooling-shaped question: "the cheap tier emits `no-files`
 * on everything" is a fact about the prompt and the extract format, not about the
 * product being built. That distinction is what routes a signal to plain code
 * rather than to a contract fix.
 */
export function kindByTier(root, cfg, { scope = "costly", history = null } = {}) {
  const records = scoped(history ?? ledger.read(root, cfg), scope);
  const out = new Map();
  const seen = new Set();

  for (const rec of records) {
    const identity = `${rec.runId}|${rec.nodeId}`;
    for (const [tier, t] of Object.entries(rec.attemptsByTier ?? {})) {
      for (const k of t.kinds ?? []) {
        const key = `${k}|${tier}`;
        const e = out.get(key) ?? { kind: k, tier, runs: new Set(), nodes: new Set(), attempts: 0 };
        e.attempts++;
        if (!seen.has(`${key}|${identity}`)) {
          seen.add(`${key}|${identity}`);
          e.nodes.add(identity);
          if (rec.runId) e.runs.add(rec.runId);
        }
        out.set(key, e);
      }
    }
  }

  const result = new Map();
  for (const [key, e] of out) {
    result.set(key, { kind: e.kind, tier: e.tier, runs: e.runs.size, nodes: e.nodes.size, attempts: e.attempts });
  }
  return result;
}

/**
 * Kinds with enough evidence to act on.
 *
 * Same discipline as `actionable`: distinct runs, not distinct nodes. An
 * unrecognised kind is dropped rather than counted — a kind this table does not
 * know about means the mirror in kinds.mjs has drifted, which is a bug to fix
 * rather than evidence to act on, and the regression suite says so loudly.
 */
export function kindActionable(root, cfg, { minRuns = 3, scope = "costly", history = null } = {}) {
  return [...kindCounts(root, cfg, { scope, history }).values()]
    .filter((e) => isKnownKind(e.kind))
    .filter((e) => e.runs >= minRuns)
    .sort((a, b) => b.runs - a.runs || b.attempts - a.attempts);
}

// ------------------------------------------------------------------ proposal

export function writeProposal(root, { title, targets, rationale, evidence, change }) {
  const bad = targets.filter((t) => classify(t) === "protected");
  if (bad.length) {
    throw new Error(
      `Refusing to write a proposal touching protected paths: ${bad.join(", ")}\n` +
        `These are the immutable core. Editing them is a human decision, not a refinement.`
    );
  }

  const tier = targets.some((t) => classify(t) === "load-bearing" || classify(t) === "unclassified")
    ? "load-bearing"
    : "advisory";

  const dir = path.resolve(root, "evolution/proposals");
  fs.mkdirSync(dir, { recursive: true });
  const n = String(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length + 1).padStart(3, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const file = path.join(dir, `${n}-${slug}.md`);

  fs.writeFileSync(
    file,
    [
      `# ${title}`,
      "",
      `- **Tier:** ${tier}`,
      `- **Targets:** ${targets.join(", ")}`,
      `- **Written:** ${new Date().toISOString()}`,
      `- **Applies:** ${tier === "advisory" ? "automatically once the regression suite is green" : "only when a human merges it"}`,
      "",
      "## Evidence",
      "",
      evidence,
      "",
      "## Why this fixes the cause, not the symptom",
      "",
      rationale,
      "",
      "## Proposed change",
      "",
      change,
      "",
      "## Reviewer checklist",
      "",
      "- [ ] Does this weaken any gate, threshold, or acceptance condition?",
      "- [ ] Would the adversarial fixtures still fail if this ships?",
      "- [ ] Does it serve a MISSION.md invariant, or only make runs greener?",
      "",
    ].join("\n"),
    "utf8"
  );

  return { file: path.relative(root, file), tier };
}
