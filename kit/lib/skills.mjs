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
