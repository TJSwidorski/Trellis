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
import * as friction from "./friction.mjs";

// Never proposable. See MISSION.md. Prefix match on repo-relative paths.
//
// paths.mjs and extract.mjs are here for the same reason worktree.mjs is: they
// are what gate.mjs, verify.mjs, and worker.mjs actually call to decide whether
// a path or a block of output is allowed. Protecting the callers and leaving
// the boundary's own implementation merely load-bearing (proposable, human-
// merged, same as any other kit/lib file) would let a proposal reach the exact
// same effect as editing gate.mjs by naming a file nobody was watching for it.
export const PROTECTED = [
  "MISSION.md",
  "kit/lib/gate.mjs",
  "kit/lib/verify.mjs",
  "kit/lib/mutate.mjs",
  "kit/lib/worktree.mjs",
  "kit/lib/paths.mjs",
  "kit/lib/extract.mjs",
  "kit/schema/",
  "kit/regression/",
  ".claude/hooks/",
];

// Proposable, but a human merges. Correctness lives here.
//
// SKILLS/ is listed explicitly rather than left to fail closed. Retirement
// proposals target SKILLS/REGISTRY.json, and the arsenal is exactly the kind of
// thing that should not change without someone looking — an entry going in is a
// standing tax on every session's selection accuracy, and an entry coming out is
// a capability the next project silently no longer has.
//
// package.json is here for the same reason: it classified "unclassified"
// before, which made a version bump the single least-guarded edit a proposal
// could make. Nothing in the kit reads the version at runtime, so the risk was
// never a broken run — it was that "unclassified" behaves like a hole in a file
// where every other tier was a deliberate choice.
export const LOAD_BEARING = [
  "kit/lib/",
  "kit/bin/",
  "kit/mcp/",
  "trellis.config.json",
  "package.json",
  "sessions/",
  "SKILLS/",
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

/**
 * Reduce a target to one canonical repo-relative spelling, or refuse it.
 *
 * The boundary used to prefix-match the raw string, so every alternate spelling
 * of a protected path walked straight through it: `./MISSION.md` classified
 * `unclassified` and a proposal to rewrite the mission statement was written to
 * disk. `kit/schema` without the trailing slash missed `kit/schema/`.
 * `references//CODES.md` missed the vocabulary carve-out and auto-applied.
 *
 * A path this cannot canonicalise is REFUSED rather than normalised. `..` is
 * never resolved away — `references/../kit/regression/` is not a request to
 * touch the regression suite that we should quietly permit, it is a request
 * nobody should be making, and resolving it would mean the boundary's answer
 * depended on a traversal an attacker chose.
 */
export function normaliseTarget(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, reason: "empty path" };
  if (s.includes("\0")) return { ok: false, reason: "null byte in path" };
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || /^[\\/]{2}/.test(s)) {
    return { ok: false, reason: `not repo-relative: ${s}` };
  }
  const parts = s.replace(/\\/g, "/").split("/").filter((seg) => seg !== "" && seg !== ".");
  if (parts.includes("..")) return { ok: false, reason: `parent traversal: ${s}` };
  if (!parts.length) return { ok: false, reason: "empty path" };
  return { ok: true, rel: parts.join("/") };
}

/**
 * Segment-aware containment, case-insensitive.
 *
 * Case-insensitive because this repo runs on Windows and macOS, where
 * `KIT/LIB/GATE.MJS` opens the very file the boundary exists to protect. Over-
 * classifying on a case-sensitive filesystem is the safe direction to be wrong.
 *
 * Segment-aware so `kit/lib/gate.mjs.bak` is not swallowed by `kit/lib/gate.mjs`
 * and `kit/schema` still matches the entry `kit/schema/`.
 */
function under(p, base) {
  const a = p.toLowerCase();
  const b = base.replace(/\/+$/, "").toLowerCase();
  return a === b || a.startsWith(b + "/");
}

export function classify(relPath) {
  const n = normaliseTarget(relPath);
  // Not a classification, a refusal. writeProposal treats it as unproposable.
  if (!n.ok) return "invalid";
  const p = n.rel;
  if (PROTECTED.some((x) => under(p, x))) return "protected";
  // Advisory is checked before load-bearing so references/ and .claude/skills/
  // are not swallowed by a broader prefix later.
  if (ADVISORY.some((x) => under(p, x))) return "advisory";
  if (LOAD_BEARING.some((x) => under(p, x))) return "load-bearing";
  return "unclassified";
}

// ------------------------------------------------------------------ evidence

/** Where the cross-run triage record lives. Routed through config like every
 *  other artifact — see ledgerPath in ledger.mjs, which this mirrors. */
export function triagePath(root, cfg) {
  return path.resolve(root, cfg?.paths?.state ?? ".trellis", "triage.jsonl");
}

/**
 * Every row triage.jsonl has ever recorded, parsed. One reader shared by the
 * contradiction source below and the human-facing friction report in
 * cli.mjs, so the two cannot drift on what counts as a row.
 */
export function triageRows(root, cfg) {
  const p = triagePath(root, cfg);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Triage records structured rejection codes, not prose. "the error handling is
// sloppy" cannot be counted; REJECT:unhandled-error-path across nine runs is a
// signal that the cases skill is missing a category.
export function rejectionCounts(root, cfg) {
  const p = triagePath(root, cfg);
  if (!fs.existsSync(p)) return {};
  const codes = loadCodes(root);
  // Object.create(null): the keys come from a file a human can edit, and a
  // decision coded "__proto__" reached Object.prototype and mutated it
  // process-wide before throwing.
  const counts = Object.create(null);
  for (const line of fs.readFileSync(p, "utf8").split("\n").filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // A malformed line is not evidence, and it is also not a reason to take down
    // `trellis evolve` and stage-07 verify with it. `null` survives JSON.parse,
    // and `decisions` is whatever the file says it is.
    if (!row || typeof row !== "object" || !Array.isArray(row.decisions)) continue;
    for (const d of row.decisions) {
      if (!d || typeof d !== "object") continue;
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
/**
 * `survivingMutations` is a COUNT in the ledger, not an array.
 *
 * ledger.recordsFor writes `(s.survivingMutations || []).length`. This read
 * `?.length` on it, which is `undefined` on a number, so the clause was dead
 * against every record the ledger has ever written — nodes that landed with a
 * live mutant, the exact population the scoping comment says matters most, were
 * silently outside it. The regression fixture used `[]`, a shape recordsFor
 * never produces, so nothing caught the mismatch.
 *
 * Accept both, because state.json holds the array form and a future caller may
 * pass one.
 */
function survivorCount(rec) {
  const v = rec?.survivingMutations;
  if (Array.isArray(v)) return v.length;
  return Number.isFinite(v) ? v : 0;
}

// The tier ladder is config-driven and documented as free to change
// (references/EVOLUTION.md names the tier roster explicitly as a mechanism,
// not an invariant). Hardcoding "strong" here meant a renamed or added top
// tier silently stopped counting as costly — no error, `trellis evolve`
// just reports less pressure than actually exists, and looks like the loop
// is correctly inert rather than blind to half its population.
function isCostly(rec, topTier) {
  return (
    rec.status === "exhausted" ||
    (topTier && rec.landedTier === topTier) ||
    survivorCount(rec) > 0
  );
}

function scoped(records, scope, cfg) {
  if (scope === "all") return records;
  const topTier = cfg?.tiers?.[cfg.tiers.length - 1]?.name;
  return records.filter((r) => isCostly(r, topTier));
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
  const records = scoped(history ?? ledger.read(root, cfg), scope, cfg);

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
  const records = scoped(history ?? ledger.read(root, cfg), scope, cfg);
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

/**
 * `--none` asserted on a run whose ledger shows exhausted nodes or two or
 * more rejections, grouped by stage. This is the one mechanism that catches
 * a session lying about friction, and it used to be computed by
 * friction.contradictions() and only ever displayed to a human in `trellis
 * evolve`'s prose output — never fed into the shortlist, and stage 07's
 * contract restricts it to `evolve --json` and nothing else. So the party
 * with judgement was structurally prevented from ever seeing it.
 *
 * references/CODES.md already documents "unreported-suspected" as "written
 * by the contradiction detector in evolve" — this is that wiring.
 */
function contradictionRows(root, cfg, { minRuns, ledgerRecords }) {
  const found = friction.contradictions(root, cfg, {
    ledgerRecords,
    triageRows: triageRows(root, cfg),
  });
  const byStage = new Map();
  for (const c of found) {
    const e = byStage.get(c.stage) ?? { stage: c.stage, runs: new Set() };
    e.runs.add(c.run);
    byStage.set(c.stage, e);
  }
  return [...byStage.values()]
    .filter((e) => e.runs.size >= minRuns)
    .map((e) => ({
      source: "friction",
      code: "unreported-suspected",
      runs: e.runs.size,
      occurrences: e.runs.size,
      targets: [e.stage],
    }));
}

/**
 * The shortlist: every source, one ranking, one cap.
 *
 * This exists as one function because it used to exist as two. `emitShortlist`
 * in the CLI sliced to `--top`, and the stage-07 verify predicate enumerated the
 * whole thing — so the moment more than `top` patterns were actionable, the
 * stage was required to account for codes it was structurally forbidden from
 * seeing, and could never pass again. Any duplicate of this ranking will drift
 * the same way; call this instead.
 */
export function shortlist(root, cfg, { minRuns = 3, scope = "costly", top = 5, codes = null } = {}) {
  const vocab = codes ?? loadCodes(root);
  const ledgerRecords = ledger.read(root, cfg);
  const rows = [
    ...actionable(root, cfg, { minRuns }).map((f) => ({
      source: "rejection",
      code: f.code,
      runs: f.runs,
      occurrences: f.count,
      nodes: f.nodes.length,
    })),
    ...kindActionable(root, cfg, { minRuns, scope }).map((k) => ({
      source: "attempt-kind",
      code: `${k.kind}|${k.tag}`,
      runs: k.runs,
      occurrences: k.attempts,
      nodes: k.nodes,
    })),
    ...Object.values(friction.counts(root, cfg, { codes: vocab }))
      .filter((f) => !isBucketed(f.code) && f.runs >= minRuns)
      .map((f) => ({
        source: "friction",
        code: f.code,
        runs: f.runs,
        occurrences: f.count,
        targets: f.targets.slice(0, 3),
      })),
    ...contradictionRows(root, cfg, { minRuns, ledgerRecords }),
  ]
    // Deterministic: the verify predicate and the stage must agree on WHICH
    // patterns made the cut, so ties cannot be broken by array order.
    .sort((a, b) => b.runs - a.runs || b.occurrences - a.occurrences || a.code.localeCompare(b.code))
    .slice(0, top);

  for (const r of rows) {
    const entry = vocab.rejection?.[r.code] ?? vocab.friction?.[r.code];
    if (entry?.suspects?.length) r.suspects = entry.suspects;
  }
  return rows;
}

// ------------------------------------------------------------------ proposal

export const PROPOSAL_KINDS = Object.freeze(new Set(["mechanism", "tooling", "retirement"]));

/**
 * Advisory paths that still wait for a human.
 *
 * `references/CODES.md` is prose, so it classifies advisory and would auto-apply
 * once regression is green. But it is the definition of what counts as evidence,
 * and a loop that can widen its own vocabulary without review can manufacture a
 * threshold. Narrow carve-out rather than reclassifying all of `references/`,
 * which would put README typos in front of a human and train them to skim.
 */
export const NO_AUTO_APPLY = ["references/CODES.md"];

/** Is this target on the held list, whatever spelling it arrived in? */
function isHeld(relPath) {
  const n = normaliseTarget(relPath);
  if (!n.ok) return true; // unproposable; certainly not auto-appliable
  return NO_AUTO_APPLY.some((x) => under(n.rel, x));
}

export function autoAppliable(relPath, cfg) {
  if (cfg?.evolve?.autoApplyAdvisory === false) return false;
  if (classify(relPath) !== "advisory") return false;
  return !isHeld(relPath);
}

export function writeProposal(
  root,
  {
    title, targets, rationale, evidence, change,
    // Defaulted, not required. The only existing callers are inside
    // kit/regression/run.mjs, a PROTECTED file — a required parameter would force
    // a human edit to protected code just to keep the suite compiling.
    kind = "mechanism",
    mechanism, alternatives, cost, reversal,
    // Set by stage 07. See the stamp below.
    fromEvolveStage = false,
  }
) {
  if (!PROPOSAL_KINDS.has(kind)) {
    throw new Error(`Unknown proposal kind "${kind}". One of: ${[...PROPOSAL_KINDS].join(", ")}`);
  }

  if (!Array.isArray(targets) || !targets.length) {
    throw new Error("A proposal must name at least one target path.");
  }

  const bad = targets.filter((t) => classify(t) === "protected");
  if (bad.length) {
    throw new Error(
      `Refusing to write a proposal touching protected paths: ${bad.join(", ")}\n` +
        `These are the immutable core. Editing them is a human decision, not a refinement.`
    );
  }

  // A target that cannot be canonicalised is refused outright rather than
  // classified. Absolute paths, `..`, and null bytes are how every alternate
  // spelling of a protected path used to walk past the check above.
  const unusable = targets.map((t) => [t, normaliseTarget(t)]).filter(([, n]) => !n.ok);
  if (unusable.length) {
    throw new Error(
      `Refusing to write a proposal with unusable targets:\n` +
        unusable.map(([t, n]) => `  ${t} — ${n.reason}`).join("\n") +
        `\nName targets as plain repo-relative paths.`
    );
  }

  // The pre-commitment IS the deletion mechanism. A tooling proposal without a
  // falsifiable retirement condition is an addition that can never be undone on
  // evidence, and a loop that can only add is not a loop.
  if (kind === "tooling" && !String(reversal ?? "").trim()) {
    throw new Error(
      "A tooling proposal must state a retirement condition — a mechanical test that would " +
        "say this should be removed. Without one the arsenal only ever grows, and the cost of " +
        "that growth appears in no metric. See references/TOOLING.md."
    );
  }

  const tier = targets.some((t) => classify(t) === "load-bearing" || classify(t) === "unclassified")
    ? "load-bearing"
    : "advisory";

  // Two reasons an advisory proposal still waits for a human: it touches the
  // vocabulary, or a model wrote it in 07_evolve. The second is the one that
  // matters — otherwise the system writes prose about how it should behave and
  // that prose applies with nobody in the path. You cannot un-apply instructions
  // that quietly changed the loop's own instructions.
  const heldTargets = targets.filter((t) => classify(t) === "advisory" && isHeld(t));
  const held = tier === "advisory" && (fromEvolveStage || heldTargets.length > 0);
  const applies =
    tier === "load-bearing" || held
      ? "only when a human merges it"
      : "automatically once the regression suite is green";
  const heldWhy = !held
    ? null
    : fromEvolveStage
      ? "written by 07_evolve — model-authored prose does not auto-apply"
      : `touches ${heldTargets.join(", ")}, which defines what counts as evidence`;

  const dir = path.resolve(root, "evolution/proposals");
  fs.mkdirSync(dir, { recursive: true });

  // Number from the highest number present, not from the count of .md files.
  // Counting meant that renaming 001 to 001-....md.merged — the obvious thing a
  // reviewer does — made the next proposal reuse 002 and silently overwrite it.
  // Evidence disappeared and the call still returned success.
  const existing = fs.readdirSync(dir);
  const highest = existing.reduce((max, f) => {
    const m = /^(\d+)-/.exec(f);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const n = String(highest + 1).padStart(3, "0");

  const slug =
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "proposal";
  const file = path.join(dir, `${n}-${slug}.md`);
  // Belt and braces: never clobber, whatever the numbering concluded.
  if (fs.existsSync(file)) {
    throw new Error(`Refusing to overwrite ${path.relative(root, file)}. Rename it or retitle the proposal.`);
  }

  const head = [
    `# ${title}`,
    "",
    `- **Kind:** ${kind}`,
    `- **Tier:** ${tier}`,
    `- **Targets:** ${targets.join(", ")}`,
    `- **Written:** ${new Date().toISOString()}`,
    `- **Applies:** ${applies}`,
    ...(heldWhy ? [`- **Held because:** ${heldWhy}`] : []),
    "",
    "## Evidence",
    "",
    evidence,
    "",
  ];

  const body =
    kind === "tooling"
      ? [
          "## Alternatives considered",
          "",
          alternatives ?? "_(none named — this proposal is incomplete)_",
          "",
          "## Proposed mechanism",
          "",
          mechanism ?? change ?? "",
          "",
          "## Cost",
          "",
          cost ?? "_(not stated — the cost of a skill is invisible unless it is written down)_",
          "",
          "## Retirement condition",
          "",
          reversal,
          "",
        ]
      : [
          "## Why this fixes the cause, not the symptom",
          "",
          rationale ?? "",
          "",
          "## Proposed change",
          "",
          change ?? mechanism ?? "",
          "",
          ...(reversal ? ["## Retirement condition", "", reversal, ""] : []),
        ];

  const checklist = [
    "## Reviewer checklist",
    "",
    ...(kind === "tooling"
      ? ["- [ ] Does a contract fix or a plain check do this instead? (references/TOOLING.md)"]
      : []),
    "- [ ] Does this weaken any gate, threshold, or acceptance condition?",
    "- [ ] Would the adversarial fixtures still fail if this ships?",
    "- [ ] Does it serve a MISSION.md invariant, or only make runs greener?",
    ...(kind === "tooling" ? ["- [ ] Is the retirement condition something `trellis evolve --retire` could actually check?"] : []),
    "",
  ];

  fs.writeFileSync(file, [...head, ...body, ...checklist].join("\n"), "utf8");

  return { file: path.relative(root, file), tier, kind, held };
}
