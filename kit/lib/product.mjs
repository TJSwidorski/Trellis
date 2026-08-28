// Product graph: the artifact authored outside Trellis and handed in complete.
//
// Nothing here calls a model. Every derived property is computed mechanically so
// that two people running `trellis ingest` on the same file get the same answer.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findCycle } from "./graphutil.mjs";
import { levels } from "./graph.mjs";

const TIERS = ["1", "10", "100", "1000", "10000", "100000"];
const KINDS = ["frontend", "backend", "data", "infra", "interface", "ops"];
const SURFACES = ["auth", "pii", "payments", "secrets", "network", "filesystem", "none"];
const ID_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

export const PRODUCT_GRAPH_DEFAULT = ".trellis/product-graph.json";

export function loadProductGraph(root, rel = PRODUCT_GRAPH_DEFAULT) {
  const p = path.resolve(root, rel);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No product graph at ${rel}.\n` +
        `Trellis does not author this file — it is written outside and handed in.\n` +
        `Start from examples/product-graph.example.json.`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${rel} is not valid JSON: ${e.message}`);
  }
  return raw;
}

// ------------------------------------------------------------------ validate

// Returns { errors, warnings, graph } where graph has derived fields filled in.
// Errors are fatal by design: a plausible-looking graph that plans wrong costs
// far more than a hard stop at ingest.
export function validateProductGraph(graph) {
  const errors = [];
  const warnings = [];

  const fail = (m) => errors.push(m);

  if (graph?.schema !== "trellis.product-graph/1") {
    fail(`schema must be "trellis.product-graph/1", got ${JSON.stringify(graph?.schema)}`);
    return { errors, warnings, graph };
  }
  if (!graph.product || typeof graph.product !== "string") fail("product must be a non-empty string");

  for (const v of ["v1", "v2"]) {
    const spec = graph.versions?.[v];
    if (!spec) { fail(`versions.${v} is missing`); continue; }
    if (!spec.definition) fail(`versions.${v}.definition is missing — say what this version does standing alone`);
    if (!TIERS.includes(String(spec.scale_target))) {
      fail(`versions.${v}.scale_target must be one of ${TIERS.join(", ")}`);
    }
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!nodes.length) fail("nodes is empty");

  const byId = new Map();
  for (const n of nodes) {
    if (!n.id || !ID_RE.test(n.id)) {
      fail(`node id ${JSON.stringify(n.id)} must be lowercase slug, e.g. auth.session`);
      continue;
    }
    if (byId.has(n.id)) fail(`duplicate node id: ${n.id}`);
    byId.set(n.id, n);
  }

  for (const n of byId.values()) {
    const at = `node ${n.id}`;
    if (!n.title) fail(`${at}: title is missing`);
    if (!["v1", "v2"].includes(n.version)) fail(`${at}: version must be v1 or v2`);
    if (!KINDS.includes(n.kind)) fail(`${at}: kind must be one of ${KINDS.join(", ")}`);
    if (!Array.isArray(n.acceptance) || !n.acceptance.length) {
      fail(`${at}: acceptance must have at least one bullet — without it the cases session has nothing to expand`);
    }
    if (!["one-way", "two-way"].includes(n.reversibility)) {
      fail(`${at}: reversibility must be one-way or two-way`);
    }
    if (!TIERS.includes(String(n.scale_tier))) fail(`${at}: scale_tier must be one of ${TIERS.join(", ")}`);
    for (const s of n.surfaces ?? []) {
      if (!SURFACES.includes(s)) fail(`${at}: unknown surface ${JSON.stringify(s)}`);
    }
    if ("high_risk" in n) {
      fail(`${at}: high_risk is derived, not authored. Remove it — the validator computes it.`);
    }
    for (const d of n.deps ?? []) {
      if (!byId.has(d)) fail(`${at}: depends on unknown node ${JSON.stringify(d)}`);
    }
  }

  if (errors.length) return { errors, warnings, graph };

  // v1 may never depend on v2. This is the check that keeps v1 shippable alone.
  for (const n of byId.values()) {
    if (n.version !== "v1") continue;
    for (const d of n.deps ?? []) {
      if (byId.get(d).version === "v2") {
        fail(`node ${n.id} is v1 but depends on v2 node ${d} — v1 would not ship standalone`);
      }
    }
  }

  const cyc = findCycle(byId);
  if (cyc) fail(`dependency cycle: ${cyc.join(" -> ")}`);

  // Orphans are legal but usually a typo in deps, so they warn rather than fail.
  const referenced = new Set();
  for (const n of byId.values()) for (const d of n.deps ?? []) referenced.add(d);
  for (const n of byId.values()) {
    if (!referenced.has(n.id) && !(n.deps ?? []).length && byId.size > 1) {
      warnings.push(`node ${n.id} is isolated — no deps and nothing depends on it`);
    }
  }

  if (errors.length) return { errors, warnings, graph };

  const derived = deriveRisk(graph, byId);
  return { errors, warnings, graph: derived };
}

// Risk is derived so it cannot be forgotten on the node where it mattered.
//
// Three levels, matching the vocabulary the task graph already uses:
//
//   high   one-way door, a consequential security surface, or two or more
//          dependents (an interface — integration breaks live here). Opus reads
//          these at triage whether or not the gates went green.
//   audit  touches pii, the network, or the filesystem, but nothing above.
//          Merges normally and gets flagged for reading afterwards.
//   low    everything else.
//
// The split exists because a flag that fires on every node is not a flag. In a
// product that stores user data, `pii` appears almost everywhere; treating it as
// automatically high-risk buries the one-way doors in noise. Auth, payments, and
// secrets are the surfaces where a mistake is not recoverable by editing code.
const CONSEQUENTIAL = new Set(["auth", "payments", "secrets"]);

export function deriveRisk(graph, byId = index(graph)) {
  const fanIn = new Map();
  for (const n of byId.values()) {
    for (const d of n.deps ?? []) fanIn.set(d, (fanIn.get(d) ?? 0) + 1);
  }

  const nodes = graph.nodes.map((n) => {
    const surfaces = (n.surfaces ?? ["none"]).filter((s) => s !== "none");
    const heavy = surfaces.filter((s) => CONSEQUENTIAL.has(s));
    const light = surfaces.filter((s) => !CONSEQUENTIAL.has(s));

    const reasons = [];
    if (n.reversibility === "one-way") reasons.push("one-way door");
    if (heavy.length) reasons.push(`surfaces: ${heavy.join(", ")}`);
    if ((fanIn.get(n.id) ?? 0) >= 2) reasons.push(`${fanIn.get(n.id)} dependents (interface)`);

    const auditReasons = light.length ? [`surfaces: ${light.join(", ")}`] : [];

    const risk_level = reasons.length ? "high" : auditReasons.length ? "audit" : "low";

    return {
      ...n,
      risk_level,
      high_risk: risk_level === "high",
      risk_reasons: reasons.length ? reasons : auditReasons,
    };
  });

  return { ...graph, nodes };
}

export function index(graph) {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

// ------------------------------------------------------------------- promote

// A v2 node is promotable when every node it transitively depends on is already
// in v1. Nothing blocks it, so shipping it early costs only the work itself.
// This is a suggestion. Moving a node is a human edit to the source graph.
export function promotable(graph) {
  const byId = index(graph);
  const memo = new Map();

  const deepDeps = (id) => {
    if (memo.has(id)) return memo.get(id);
    const out = new Set();
    memo.set(id, out); // cycle guard; validate() already rejected real cycles
    for (const d of byId.get(id).deps ?? []) {
      out.add(d);
      for (const x of deepDeps(d)) out.add(x);
    }
    return out;
  };

  return graph.nodes
    .filter((n) => n.version === "v2")
    .filter((n) => [...deepDeps(n.id)].every((d) => byId.get(d).version === "v1"))
    .map((n) => ({ id: n.id, title: n.title, deps: [...deepDeps(n.id)] }));
}

// --------------------------------------------------------------------- slice

// Cut the next buildable slice: unbuilt nodes of the target version, taken
// in whole dependency LEVELS (longest-path depth among what is still
// unbuilt — a dep that already landed, or belongs to the other version,
// does not push its dependant's level up), capped at maxNodes.
//
// The cap exists because planning, case enumeration, and test writing for more
// than roughly 25 nodes does not fit in one session window. That is an empirical
// limit from real runs, not a theoretical one.
//
// Level-aware rather than a flat cutoff: a flat cutoff can stop mid-level,
// handing a session five sibling nodes at depth 3 and leaving the other
// five siblings at the SAME depth for next time, for no reason connected to
// the graph's actual shape — the cap just happened to land there. Cutting
// at level boundaries instead means every slice is either the WHOLE next
// wave of work or stops before starting a wave it can't finish, which is
// the thing "the next 25" was always supposed to mean.
//
// A level is atomic: if the very first level under consideration alone
// exceeds maxNodes, it is taken WHOLE anyway (`overflowed: true`) rather
// than split — a level cannot be half-planned, and every node in it is
// equally ready. This can only happen on the first level of a call: once
// anything has been chosen, a level that would push the total past the cap
// is left for the NEXT call instead, where it becomes that call's own
// first (and possibly still-oversized) level.
export function nextSlice(graph, { version = "v1", built = [], maxNodes = 25 } = {}) {
  const done = new Set(built);
  const candidates = graph.nodes.filter((n) => n.version === version && !done.has(n.id));

  // levels() ignores any dep id not present in the node set it's given
  // (graph.mjs:350) — exactly the semantics wanted here: an already-built
  // node, or one of the other version, is "satisfied" and contributes
  // nothing to its dependant's depth, so depth reflects only the shape of
  // what is left to build, not the whole product graph's history.
  const depthOf = levels({ nodes: candidates });
  const byLevel = new Map();
  for (const n of candidates) {
    const d = depthOf.get(n.id) ?? 0;
    if (!byLevel.has(d)) byLevel.set(d, []);
    byLevel.get(d).push(n);
  }
  const orderedDepths = [...byLevel.keys()].sort((a, b) => a - b);

  const chosen = [];
  const levelPlan = []; // { depth, count } for every level actually taken
  let overflowed = false;
  for (const d of orderedDepths) {
    const lvl = byLevel.get(d);
    if (chosen.length > 0 && chosen.length + lvl.length > maxNodes) break;
    chosen.push(...lvl);
    levelPlan.push({ depth: d, count: lvl.length });
    if (chosen.length > maxNodes) overflowed = true;
  }

  const takenIds = new Set(chosen.map((n) => n.id));
  const remaining = candidates.filter((n) => !takenIds.has(n.id));

  return {
    version,
    nodes: chosen,
    remaining: remaining.map((n) => n.id),
    high_risk: chosen.filter((n) => n.high_risk).map((n) => n.id),
    levels: levelPlan,
    overflowed,
    maxNodes,
  };
}

// ------------------------------------------------------------------ staleness

// A node's plan is stale when the source that produced it changed. Cheap version
// of incremental compilation: hash the fields a planner reads, compare to what
// was recorded when the node was planned.
export function nodeFingerprint(node) {
  const material = JSON.stringify({
    title: node.title,
    acceptance: node.acceptance,
    deps: [...(node.deps ?? [])].sort(),
    kind: node.kind,
    scale_tier: node.scale_tier,
    surfaces: [...(node.surfaces ?? [])].sort(),
    notes: node.notes ?? "",
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function staleNodes(graph, fingerprints = {}) {
  return graph.nodes
    .filter((n) => fingerprints[n.id] && fingerprints[n.id] !== nodeFingerprint(n))
    .map((n) => n.id);
}
