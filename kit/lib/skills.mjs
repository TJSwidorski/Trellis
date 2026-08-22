// Which skills load in which session.
//
// Every activated skill's name and description enters the orchestrator's context
// at session start, before any work happens. The token cost of that is real but
// modest; the cost that actually bites is selection accuracy — a model choosing
// among forty descriptions picks worse, and fires spurious skills more often, than
// one choosing among six. Neither cost shows up in any per-node metric.
//
// The resolution is mechanical and costs zero model tokens: the driver computes
// the active set here, in code, and materialises just those into .claude/skills/
// before launching a stage. No model ever reads a manifest. That is the same rule
// the whole kit runs on — the dispatch loop lives in code, not in the context.
//
// `applies_to` resolves against the product graph's own kind/surfaces/lenses
// fields, so skill selection is DERIVED, never authored. A SPEC author never needs
// to know this catalogue exists.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Only these may ever be activated. 'pending' means nobody has audited it yet and
// 'rejected' means somebody did — either way it does not enter a context window.
// A skill is an instruction file read by the orchestrator, which makes it the
// highest-privilege artifact in the system; an unaudited one is strictly worse
// than an unaudited dependency, because it needs no code to do damage.
const ACTIVATABLE = new Set(["trusted-provenance", "audited"]);

export function loadRegistry(root) {
  const p = path.join(root, "SKILLS", "REGISTRY.json");
  if (!fs.existsSync(p)) return { schema: "trellis.skill-registry/1", entries: [] };
  const reg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(reg.entries)) throw new Error("SKILLS/REGISTRY.json: entries must be an array");
  return reg;
}

const arr = (x) => (Array.isArray(x) ? x : []);

/**
 * Does this entry match anything in the slice?
 *
 * Union, not intersection: a design skill should load when ANY frontend node is
 * present, not only when every node is one.
 */
function matchesSlice(applies, sliceNodes) {
  if (!applies) return false;
  const kinds = new Set(sliceNodes.map((n) => n.kind).filter(Boolean));
  const surfaces = new Set(sliceNodes.flatMap((n) => arr(n.surfaces)));
  const lenses = new Set(sliceNodes.flatMap((n) => arr(n.lenses)));
  return (
    arr(applies.kinds).some((k) => kinds.has(k)) ||
    arr(applies.surfaces).some((s) => surfaces.has(s)) ||
    arr(applies.lenses).some((l) => lenses.has(l))
  );
}

/**
 * The active set for one session.
 *
 * Returns [{ name, kind, reason }], reason being why it activated — `trellis
 * skills --explain` prints it, because "why is this loaded" is the question you
 * ask when a session is behaving oddly, and guessing is expensive.
 */
export function resolveActive(registry, { stage = null, sliceNodes = [], manual = [] } = {}) {
  const out = [];
  const manualSet = new Set(manual);

  for (const e of registry.entries ?? []) {
    // The gate. Checked first and unconditionally: no activation rule, and no
    // manual override, may load something unaudited.
    if (!ACTIVATABLE.has(e.audit_status)) continue;

    // Lenses are Layer 3 reference material a stage contract names explicitly, and
    // connectors are wired through .mcp.json. Neither belongs in .claude/skills/.
    if (e.kind !== "skill" && e.kind !== "plugin") continue;

    const a = e.activation ?? {};
    const hasStage = arr(a.stage).length > 0;
    const hasApplies = Boolean(a.applies_to);
    const stageHit = stage && arr(a.stage).includes(stage);
    const sliceHit = matchesSlice(a.applies_to, sliceNodes);

    let reason = null;

    if (a.always) reason = "always";
    else if (manualSet.has(e.name)) reason = "manual";
    // Declaring BOTH a stage and an applies_to means "in this stage, for this kind
    // of work" — conjunction, not disjunction. Treating it as OR loaded a browser
    // testing skill into a project with no frontend, on the strength of the stage
    // alone. Either rule on its own still fires on its own.
    else if (hasStage && hasApplies) reason = stageHit && sliceHit ? `stage:${stage}+slice` : null;
    else if (stageHit) reason = `stage:${stage}`;
    else if (sliceHit) reason = "slice";

    // `manual: true` with no other rule means opt-in only — never automatic.
    if (reason) out.push({ name: e.name, kind: e.kind, reason });
  }

  return out;
}

/**
 * Entries that would have activated but for their audit status. Surfaced rather
 * than silently dropped: "the design skills did nothing" is a confusing session,
 * and the honest explanation is that they are queued, not broken.
 */
export function blockedByAudit(registry, opts = {}) {
  const permissive = {
    ...registry,
    entries: (registry.entries ?? []).map((e) => ({ ...e, audit_status: "audited" })),
  };
  const wouldBe = new Set(resolveActive(permissive, opts).map((x) => x.name));
  return (registry.entries ?? [])
    .filter((e) => wouldBe.has(e.name) && !ACTIVATABLE.has(e.audit_status))
    .map((e) => ({ name: e.name, status: e.audit_status ?? "unset" }));
}

/**
 * Which registry plugins are not installed on this machine.
 *
 * Plugins are user-scoped: they live in ~/.claude and are enabled in the user's
 * settings.json. Trellis cannot vendor them, so the registry records the intent
 * and this reports the gap. Without it, a kit installed on a second machine would
 * silently run with a smaller arsenal than the registry claims — the sort of
 * difference that quietly invalidates a comparison between two runs.
 */
export function missingPlugins(registry, { home = os.homedir() } = {}) {
  const declared = (registry.entries ?? []).filter(
    (e) => e.kind === "plugin" && ACTIVATABLE.has(e.audit_status)
  );
  if (!declared.length) return [];

  let enabled = {};
  try {
    const p = path.join(home, ".claude", "settings.json");
    enabled = JSON.parse(fs.readFileSync(p, "utf8")).enabledPlugins ?? {};
  } catch { /* no user settings: everything is missing */ }

  return declared
    .filter((e) => {
      const key = `${e.source?.plugin ?? e.name}@${e.source?.marketplace ?? ""}`;
      return enabled[key] !== true;
    })
    .map((e) => ({
      name: e.name,
      install: `/plugin install ${e.source?.plugin ?? e.name}@${e.source?.marketplace ?? "?"}`,
    }));
}

// ------------------------------------------------------------- activation log
//
// The arsenal could only ever grow. materialise() records what got copied in;
// nothing recorded whether it was ever reached. Without that, a proposal to
// delete a skill can never have evidence, and a self-improvement loop that can
// only add will quietly degrade every session's selection accuracy while every
// metric it can see improves.
//
// This is the cheapest true signal available: a skill whose rules never matched
// has PROVABLY never entered a context window. No outcome data, no confounding,
// no judgement — just an absence of rows.

export function activationPath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "skills.jsonl");
}

/** One row per skill per stage-run. Append-only, like every other record here. */
export function recordActivation(root, cfg, { run, stage, active }) {
  const p = activationPath(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ts = new Date().toISOString();
  const rows = active.map((a) => JSON.stringify({ ts, run, stage, name: a.name, reason: a.reason }));
  if (!rows.length) return p;
  fs.appendFileSync(p, rows.join("\n") + "\n");
  return p;
}

export function readActivations(root, cfg) {
  const p = activationPath(root, cfg);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Rules that can fire on their own. `manual` is not one — it needs a human. */
const AUTOMATIC = ["always", "stage", "applies_to"];

const firesAutomatically = (e) => AUTOMATIC.some((k) => {
  const v = e.activation?.[k];
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
});

/**
 * Registered entries that never once activated.
 *
 * Two thresholds, and both exist because a naive version of this is worse than
 * useless — it names forty entries every time and gets ignored.
 *
 *   - `minRuns` distinct runs before saying anything at all. One run in which a
 *     skill happened not to match is not a fact about the skill.
 *   - Manual-only entries are excluded entirely. They activate when a human names
 *     them in `skills.manual` and never otherwise, so their silence is the design
 *     working, not evidence of dead weight.
 *
 * Entries with no automatic rule AND no manual opt-in are a different finding:
 * not unused but *unreachable*, which is a bug in the registry rather than a
 * reason to delete. Reported separately so the two never get confused.
 */
export function neverActivated(registry, activations, { minRuns = 3 } = {}) {
  const runs = new Set(activations.map((a) => a.run).filter(Boolean));

  const candidates = (registry.entries ?? [])
    .filter((e) => ACTIVATABLE.has(e.audit_status))
    .filter((e) => e.kind === "skill" || e.kind === "plugin");

  const unreachable = candidates
    .filter((e) => !firesAutomatically(e) && !e.activation?.manual)
    .map((e) => ({ name: e.name, kind: e.kind }));

  if (runs.size < minRuns) return { ready: false, runs: runs.size, skills: [], unreachable };

  const fired = new Set(activations.map((a) => a.name));
  const skills = candidates
    .filter(firesAutomatically)
    .filter((e) => !fired.has(e.name))
    .map((e) => ({
      name: e.name,
      kind: e.kind,
      rules: AUTOMATIC.filter((k) => {
        const v = e.activation?.[k];
        return Array.isArray(v) ? v.length > 0 : Boolean(v);
      }),
    }));

  return { ready: true, runs: runs.size, skills, unreachable };
}

/**
 * Materialise the active skills into `.claude/skills/`, which is where Claude Code
 * discovers them at session start.
 *
 * Only ever removes directories it previously wrote (tracked in .manifest.json),
 * so a hand-placed project skill is never destroyed by a stage transition.
 * Plugin-kind entries are installed at user scope and are not copied.
 */
export function materialise(root, active, { dryRun = false } = {}) {
  const dest = path.join(root, ".claude", "skills");
  const manifestPath = path.join(dest, ".manifest.json");

  const prior = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).written ?? []
    : [];
  const want = active.filter((a) => a.kind === "skill").map((a) => a.name);

  const removed = prior.filter((n) => !want.includes(n));
  const added = want.filter((n) => !prior.includes(n));
  if (dryRun) return { added, removed, kept: want.filter((n) => prior.includes(n)) };

  fs.mkdirSync(dest, { recursive: true });
  for (const name of removed) {
    fs.rmSync(path.join(dest, name), { recursive: true, force: true });
  }
  for (const name of want) {
    const from = path.join(root, "SKILLS", "skills", name);
    if (!fs.existsSync(from)) continue;   // registry entry without files yet
    fs.rmSync(path.join(dest, name), { recursive: true, force: true });
    fs.cpSync(from, path.join(dest, name), { recursive: true });
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ written: want }, null, 2) + "\n");

  return { added, removed, kept: want.filter((n) => prior.includes(n)) };
}
