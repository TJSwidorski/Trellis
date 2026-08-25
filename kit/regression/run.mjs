#!/usr/bin/env node
// The exam Trellis is not allowed to grade itself on.
//
// Half of these are happy fixtures: they catch "the change broke the thing."
// Half are adversarial: inputs engineered to FAIL, each with an expected failure.
// The adversarial half is the point. A suite that only checks happy paths will
// applaud a change that loosens every gate, because loosened gates make happy
// paths greener. Gate erosion is only visible when something is supposed to fail.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateProductGraph,
  promotable,
  nextSlice,
  nodeFingerprint,
} from "../lib/product.mjs";
import { validateGraph } from "../lib/graph.mjs";
import { gateEnv } from "../lib/gate.mjs";
import { classify, writeProposal, PROTECTED, actionable, unknownCodes, autoAppliable, rejectionCounts as rejectionCountsFn, triagePath } from "../lib/evolve.mjs";
import { isRetryable, STAGES, DEFAULT_CHAIN, EVOLVE_TOP } from "../lib/driver.mjs";
import { resolveActive, blockedByAudit, neverActivated, materialise, activationPath } from "../lib/skills.mjs";
import { loadCodes, normaliseCode, allCodes, groupSimilar, CODES_DOC } from "../lib/codes.mjs";
import { KINDS, FLAG_TO_KIND } from "../lib/kinds.mjs";
import * as friction from "../lib/friction.mjs";
import { kindActionable, kindCounts, shortlist } from "../lib/evolve.mjs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { changedPaths } from "../lib/worktree.mjs";
import { matchAny, matchDeny, matchAllow, FS_CASE_INSENSITIVE } from "../lib/paths.mjs";
import { recordsFor, ledgerPath } from "../lib/ledger.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --------------------------------------------------------------- fixtures

const node = (id, over = {}) => ({
  id,
  title: id,
  version: "v1",
  kind: "backend",
  acceptance: ["does the thing"],
  reversibility: "two-way",
  scale_tier: "100",
  deps: [],
  surfaces: ["none"],
  ...over,
});

const graph = (nodes, over = {}) => ({
  schema: "trellis.product-graph/1",
  product: "fixture",
  versions: {
    v1: { definition: "ships alone", scale_target: "100" },
    v2: { definition: "later", scale_target: "10000" },
  },
  nodes,
  ...over,
});

// ------------------------------------------------------------ happy fixtures

check("valid graph validates clean", () => {
  const { errors } = validateProductGraph(graph([node("a"), node("b", { deps: ["a"] })]));
  assert(errors.length === 0, `unexpected errors: ${errors.join("; ")}`);
});

check("one-way door derives high risk", () => {
  const { graph: g } = validateProductGraph(graph([node("a", { reversibility: "one-way" })]));
  assert(g.nodes[0].high_risk === true, "one-way node was not marked high risk");
});

check("consequential surface derives high risk", () => {
  const { graph: g } = validateProductGraph(graph([node("a", { surfaces: ["auth"] })]));
  assert(g.nodes[0].high_risk === true, "auth surface did not derive high risk");
});

check("two dependents derives high risk (interface node)", () => {
  const { graph: g } = validateProductGraph(
    graph([node("iface"), node("a", { deps: ["iface"] }), node("b", { deps: ["iface"] })])
  );
  const iface = g.nodes.find((n) => n.id === "iface");
  assert(iface.high_risk === true, "fan-in of 2 did not derive high risk");
});

check("pii-only node is audit, not high — the flag must stay a signal", () => {
  const { graph: g } = validateProductGraph(graph([node("a", { surfaces: ["pii"] })]));
  assert(g.nodes[0].risk_level === "audit", `expected audit, got ${g.nodes[0].risk_level}`);
  assert(g.nodes[0].high_risk === false, "pii alone should not force a triage read");
});

check("auth surface is high, pii surface is not", () => {
  const { graph: g } = validateProductGraph(
    graph([node("a", { surfaces: ["auth"] }), node("b", { surfaces: ["network"] })])
  );
  assert(g.nodes[0].risk_level === "high", "auth did not derive high");
  assert(g.nodes[1].risk_level === "audit", "network alone should be audit");
});

check("ordinary leaf node is not high risk", () => {
  const { graph: g } = validateProductGraph(graph([node("a"), node("b", { deps: ["a"] })]));
  const b = g.nodes.find((n) => n.id === "b");
  assert(b.high_risk === false, "false positive on plain node");
  assert(b.risk_level === "low", `expected low, got ${b.risk_level}`);
});

check("slice respects dependency order and the cap", () => {
  const { graph: g } = validateProductGraph(
    graph([node("a"), node("b", { deps: ["a"] }), node("c", { deps: ["b"] })])
  );
  const s = nextSlice(g, { maxNodes: 2 });
  assert(s.nodes.length === 2, `expected 2 nodes, got ${s.nodes.length}`);
  assert(s.nodes[0].id === "a", "slice did not start at the root");
  assert(s.remaining.includes("c"), "c should still be pending");
});

check("slice honours already-built nodes", () => {
  const { graph: g } = validateProductGraph(graph([node("a"), node("b", { deps: ["a"] })]));
  const s = nextSlice(g, { built: ["a"] });
  assert(s.nodes.length === 1 && s.nodes[0].id === "b", "built node was re-sliced");
});

check("promote finds only fully unblocked v2 nodes", () => {
  const { graph: g } = validateProductGraph(
    graph([
      node("base"),
      node("free", { version: "v2", deps: ["base"] }),
      node("blocked", { version: "v2", deps: ["free"] }),
    ])
  );
  const p = promotable(g).map((x) => x.id);
  assert(p.includes("free"), "unblocked v2 node not reported");
  assert(!p.includes("blocked"), "v2 node depending on v2 work was wrongly promoted");
});

check("fingerprint changes when acceptance changes", () => {
  const a = nodeFingerprint(node("x"));
  const b = nodeFingerprint(node("x", { acceptance: ["something else"] }));
  assert(a !== b, "fingerprint did not move — staleness would never be detected");
});

// ------------------------------------------------------ adversarial fixtures
//
// Each of these MUST be rejected. If one starts passing, a gate has eroded.

check("ADVERSARIAL v1 depending on v2 is rejected", () => {
  const { errors } = validateProductGraph(
    graph([node("later", { version: "v2" }), node("now", { deps: ["later"] })])
  );
  assert(errors.some((e) => /v1 but depends on v2/.test(e)), "v1->v2 dependency was allowed");
});

check("ADVERSARIAL dependency cycle is rejected", () => {
  const { errors } = validateProductGraph(
    graph([node("a", { deps: ["b"] }), node("b", { deps: ["a"] })])
  );
  assert(errors.some((e) => /cycle/i.test(e)), "cycle was allowed");
});

check("ADVERSARIAL authored high_risk is rejected", () => {
  const { errors } = validateProductGraph(graph([node("a", { high_risk: false })]));
  assert(errors.some((e) => /derived/i.test(e)), "hand-set high_risk was accepted");
});

check("ADVERSARIAL unknown dependency is rejected", () => {
  const { errors } = validateProductGraph(graph([node("a", { deps: ["ghost"] })]));
  assert(errors.some((e) => /unknown node/.test(e)), "dangling dep was accepted");
});

check("ADVERSARIAL empty acceptance is rejected", () => {
  const { errors } = validateProductGraph(graph([node("a", { acceptance: [] })]));
  assert(errors.some((e) => /acceptance/.test(e)), "node with no acceptance criteria was accepted");
});

check("ADVERSARIAL duplicate node ids are rejected", () => {
  const { errors } = validateProductGraph(graph([node("a"), node("a")]));
  assert(errors.some((e) => /duplicate/.test(e)), "duplicate id was accepted");
});

check("ADVERSARIAL wrong schema string is rejected", () => {
  const g = graph([node("a")]);
  g.schema = "trellis.product-graph/99";
  const { errors } = validateProductGraph(g);
  assert(errors.length > 0, "unknown schema version was accepted");
});

// The requirement comes from MISSION.md, not from the constant under test.
//
// The previous version of this check iterated PROTECTED and asserted each of its
// own members classified protected — it imported the constant and asserted it
// equalled itself. Deleting kit/schema/, .claude/hooks/, gate.mjs or verify.mjs
// from the boundary left the suite green. Six of eight protected paths could be
// removed and nothing noticed.
//
// MISSION.md is the authority (no proposal may edit it), so parse the set from
// there and hold the implementation to it.
const MISSION_PROTECTED = (() => {
  // kitRoot is declared further down; resolve independently rather than reorder.
  const text = fs.readFileSync(path.resolve(here, "../..", "MISSION.md"), "utf8");
  const block = /## The protected set[\s\S]*?```\n([\s\S]*?)```/.exec(text);
  if (!block) throw new Error("MISSION.md no longer states a protected set — that IS the finding");
  return block[1].split("\n").map((l) => l.trim()).filter(Boolean);
})();

check("ADVERSARIAL every path MISSION.md protects is actually protected", () => {
  assert(MISSION_PROTECTED.length >= 8,
    `MISSION.md lists only ${MISSION_PROTECTED.length} protected paths; the set shrank`);
  for (const p of MISSION_PROTECTED) {
    const probe = p.endsWith("/") ? `${p}anything.mjs` : p;
    assert(classify(probe) === "protected",
      `MISSION.md protects ${p}, but classify("${probe}") says "${classify(probe)}"`);
    // The directory itself, not just things under it.
    assert(classify(p.replace(/\/$/, "")) === "protected",
      `${p} without its trailing slash classifies "${classify(p.replace(/\/$/, ""))}"`);
  }
});

check("ADVERSARIAL an alternate spelling of a protected path does not escape", () => {
  // Every one of these classified "unclassified" before, and writeProposal
  // happily wrote a proposal targeting the mission statement.
  const spellings = [
    "./MISSION.md",
    ".\\MISSION.md",
    "MISSION.md/",
    "kit/schema",
    "kit//schema//graph.schema.json",
    "kit/./regression/run.mjs",
    ".claude/hooks",
    "KIT/LIB/GATE.MJS",
  ];
  for (const s of spellings) {
    assert(classify(s) === "protected", `classify("${s}") === "${classify(s)}" — the boundary was walked around`);
  }
  // Traversal and absolute paths are refused outright rather than resolved.
  for (const s of ["a/../kit/lib/gate.mjs", "references/../kit/regression/run.mjs", "C:/x/kit/lib/gate.mjs", "/etc/passwd", "\\\\server\\share\\x"]) {
    assert(classify(s) === "invalid", `classify("${s}") === "${classify(s)}" — expected refusal`);
  }
});

check("ADVERSARIAL writeProposal refuses every alternate spelling too", () => {
  // classify() being right is necessary but not sufficient — the refusal is what
  // MISSION.md actually promises.
  for (const t of ["./MISSION.md", "kit/schema", "KIT/LIB/GATE.MJS", "a/../kit/lib/gate.mjs", "/etc/passwd"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-prot-"));
    fs.mkdirSync(path.join(dir, "evolution", "proposals"), { recursive: true });
    let threw = false;
    try { writeProposal(dir, { title: "weaken it", targets: [t], rationale: "x", evidence: "x", change: "x" }); }
    catch { threw = true; }
    const written = fs.readdirSync(path.join(dir, "evolution", "proposals"));
    assert(threw, `writeProposal accepted target "${t}"`);
    assert(written.length === 0, `writeProposal wrote ${written.join(", ")} for target "${t}"`);
  }
});

check("ADVERSARIAL proposal touching the regression suite is refused", () => {
  let threw = false;
  try {
    writeProposal(here, {
      title: "loosen a fixture",
      targets: ["kit/regression/run.mjs"],
      rationale: "x",
      evidence: "x",
      change: "x",
    });
  } catch {
    threw = true;
  }
  assert(threw, "a proposal was allowed to edit the regression suite");
});

check("ADVERSARIAL proposal touching MISSION.md is refused", () => {
  let threw = false;
  try {
    writeProposal(here, { title: "reword mission", targets: ["MISSION.md"], rationale: "x", evidence: "x", change: "x" });
  } catch {
    threw = true;
  }
  assert(threw, "a proposal was allowed to edit the mission");
});

check("ADVERSARIAL unknown path fails closed to load-bearing", () => {
  // The name states an invariant about the TIER. Asserting classify() returns
  // the string "unclassified" is an identity check that leaves the invariant
  // itself unguarded, so assert the consequence: it must not auto-apply.
  assert(classify("some/new/thing.mjs") === "unclassified", "unclassified path changed meaning");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-unc-"));
  fs.mkdirSync(path.join(dir, "evolution", "proposals"), { recursive: true });
  const r = writeProposal(dir, {
    title: "touch something unrecognised", targets: ["some/new/thing.mjs"],
    rationale: "x", evidence: "x", change: "x",
  });
  assert(r.tier === "load-bearing",
    `an unclassified target produced tier "${r.tier}" — it must fail closed to a human merge`);
  assert(!autoAppliable("some/new/thing.mjs", { evolve: { autoApplyAdvisory: true } }),
    "an unclassified target was treated as auto-appliable");
});

check("ADVERSARIAL rate-limit text is recognised as retryable", () => {
  assert(isRetryable("Error: 429 rate limit exceeded"), "429 not treated as retryable");
  assert(isRetryable("usage limit reached"), "usage limit not treated as retryable");
  assert(!isRetryable("SyntaxError: unexpected token"), "a code error was treated as throttling");
});

// -------------------------------------------------- user-supplied fixtures

// ------------------------------------------------- installer completeness
//
// The v2.0 installer shipped a kit that could not work: PAYLOAD listed none of
// MISSION.md, CONTEXT.md, sessions/, references/, evolution/ or package.json, so
// the installed CLAUDE.md instructed the orchestrator to read files that were
// never copied. Nothing caught it because nothing compared the installer's output
// to what the docs promise. These two checks are that comparison.

const kitRoot = path.resolve(here, "../..");

// setup.mjs is deliberately not part of the payload, so in an INSTALLED tree it is
// absent and these three checks have nothing to assert — an installed repo has no
// PAYLOAD of its own to verify. Skip rather than crash: the suite must run in both
// places, and it is the kit repo that needs this coverage.
const setupPath = path.join(kitRoot, "setup.mjs");
const installer = fs.existsSync(setupPath)
  // pathToFileURL, not a bare path — dynamic import() of an absolute Windows path
  // fails with ERR_UNSUPPORTED_ESM_URL_SCHEME because "C:" reads as a URL scheme.
  ? await import(pathToFileURL(setupPath).href)
  : null;

if (!installer) {
  console.log("  (installer checks skipped — setup.mjs is not present in an installed tree)");
}

const { PAYLOAD, NOT_INSTALLED, referencedPaths, verifyInstall } = installer ?? {};

if (installer) check("ADVERSARIAL every top-level entry is installed or explicitly excluded", () => {
  const known = new Set([...PAYLOAD, ...NOT_INSTALLED]);
  const unclassified = fs.readdirSync(kitRoot).filter((e) => !known.has(e));
  assert(unclassified.length === 0,
    `top-level entries in neither PAYLOAD nor NOT_INSTALLED: ${unclassified.join(", ")}. ` +
    `Add to one list — silence here is how sessions/ went missing.`);
});

if (installer) check("the kit itself satisfies its own install assertion", () => {
  const missing = verifyInstall(kitRoot);
  assert(missing.length === 0,
    `docs reference paths that do not exist: ${missing.map((m) => `${m.ref} (from ${m.doc})`).join(", ")}`);
});

if (installer) check("ADVERSARIAL referencedPaths ignores runtime and glob paths", () => {
  const found = referencedPaths(
    "Read `MISSION.md` and `sessions/01_ingest/CONTEXT.md`. Never edit `.trellis/state.json` " +
    "or `.worktrees/`. Layer 3 is `references/**`. Stage contracts live at `sessions/NN_stage/CONTEXT.md`. " +
    "This is `prose` and this is `two words`."
  );
  assert(found.includes("MISSION.md"), "should find a plain doc path");
  assert(found.includes("sessions/01_ingest/CONTEXT.md"), "should find a concrete nested path");
  assert(!found.some((p) => p.startsWith(".trellis")), "must skip runtime state paths");
  assert(!found.some((p) => p.startsWith(".worktrees")), "must skip worktree paths");
  assert(!found.some((p) => p.includes("*")), "must skip globs");
  assert(!found.some((p) => p.includes("NN_")), "must skip placeholders");
  assert(!found.includes("prose"), "bare words are prose, not paths");
});

// ------------------------------------------------------- skill activation
//
// A skill is an instruction file the orchestrator reads, which makes it the
// highest-privilege artifact in the system — an unaudited one needs no code at all
// to do damage. The audit gate is therefore a security boundary, and these checks
// exist to try to get around it rather than to confirm it works on the happy path.

const REG = {
  schema: "trellis.skill-registry/1",
  entries: [
    { name: "always-on", kind: "skill", audit_status: "trusted-provenance", activation: { always: true } },
    { name: "cases-only", kind: "skill", audit_status: "audited", activation: { stage: ["03_cases"] } },
    { name: "design", kind: "skill", audit_status: "audited", activation: { applies_to: { kinds: ["frontend"] } } },
    { name: "secrets-lens", kind: "skill", audit_status: "audited", activation: { applies_to: { surfaces: ["secrets"] } } },
    { name: "opt-in", kind: "skill", audit_status: "audited", activation: { manual: true } },
    { name: "a-lens", kind: "lens", audit_status: "audited", activation: { always: true } },
    { name: "a-connector", kind: "connector", audit_status: "audited", activation: { always: true } },
    { name: "unvetted", kind: "skill", audit_status: "pending", activation: { always: true } },
    { name: "refused", kind: "skill", audit_status: "rejected", activation: { always: true } },
    { name: "no-status", kind: "skill", activation: { always: true } },
  ],
};
const names = (r) => r.map((x) => x.name).sort();

check("ADVERSARIAL a pending skill never activates, even marked always", () => {
  const active = names(resolveActive(REG, { stage: "03_cases", sliceNodes: [] }));
  assert(!active.includes("unvetted"), `pending skill activated: ${active.join(", ")}`);
  assert(!active.includes("refused"), `rejected skill activated: ${active.join(", ")}`);
});

check("ADVERSARIAL an entry with no audit_status fails closed", () => {
  assert(!names(resolveActive(REG, {})).includes("no-status"),
    "an entry with no audit_status must not activate — unclassified fails closed");
});

check("ADVERSARIAL a manual override cannot smuggle in an unaudited skill", () => {
  const active = names(resolveActive(REG, { manual: ["unvetted", "refused", "opt-in"] }));
  assert(!active.includes("unvetted") && !active.includes("refused"),
    `manual override bypassed the audit gate: ${active.join(", ")}`);
  assert(active.includes("opt-in"), "an audited manual entry should still activate when named");
});

check("ADVERSARIAL lenses and connectors never load as skills", () => {
  const active = names(resolveActive(REG, {}));
  assert(!active.includes("a-lens"), "a lens is Layer 3 reference, not an auto-loaded skill");
  assert(!active.includes("a-connector"), "a connector is wired via .mcp.json, not .claude/skills");
});

check("ADVERSARIAL stage AND applies_to means both, not either", () => {
  // A browser-testing skill declaring stage 04_tests and kind frontend must not
  // load into a backend-only project just because the stage matched.
  const reg = { entries: [{ name: "web-test", kind: "skill", audit_status: "audited",
    activation: { stage: ["04_tests"], applies_to: { kinds: ["frontend"] } } }] };
  const backend = names(resolveActive(reg, { stage: "04_tests", sliceNodes: [{ kind: "backend" }] }));
  assert(!backend.includes("web-test"), "stage alone must not satisfy a rule that also names a kind");

  const wrongStage = names(resolveActive(reg, { stage: "02_slice", sliceNodes: [{ kind: "frontend" }] }));
  assert(!wrongStage.includes("web-test"), "kind alone must not satisfy a rule that also names a stage");

  const both = names(resolveActive(reg, { stage: "04_tests", sliceNodes: [{ kind: "frontend" }] }));
  assert(both.includes("web-test"), "both conditions met should activate");
});

check("stage gating loads a stage skill only in its stage", () => {
  assert(names(resolveActive(REG, { stage: "03_cases" })).includes("cases-only"));
  assert(!names(resolveActive(REG, { stage: "04_tests" })).includes("cases-only"));
});

check("applies_to derives activation from the slice, not from the SPEC", () => {
  const backendOnly = resolveActive(REG, { sliceNodes: [{ kind: "backend", surfaces: ["none"] }] });
  assert(!names(backendOnly).includes("design"), "design loaded with no frontend node present");

  const withFrontend = resolveActive(REG, {
    sliceNodes: [{ kind: "backend", surfaces: ["none"] }, { kind: "frontend", surfaces: [] }],
  });
  assert(names(withFrontend).includes("design"), "design should load when any node is frontend");

  const withSecrets = resolveActive(REG, { sliceNodes: [{ kind: "backend", surfaces: ["secrets"] }] });
  assert(names(withSecrets).includes("secrets-lens"), "surface matching should activate");
});

check("an always skill loads with no stage and an empty slice", () => {
  assert(names(resolveActive(REG, {})).includes("always-on"));
});

check("blockedByAudit reports what is queued rather than dropping it silently", () => {
  const blocked = blockedByAudit(REG, { stage: "03_cases" }).map((b) => b.name).sort();
  assert(blocked.includes("unvetted") && blocked.includes("refused"),
    `expected the unaudited entries to be reported, got: ${blocked.join(", ")}`);
});

check("the shipped registry parses and activates nothing unaudited", () => {
  const real = JSON.parse(fs.readFileSync(path.join(kitRoot, "SKILLS/REGISTRY.json"), "utf8"));
  assert(Array.isArray(real.entries) && real.entries.length > 0, "registry has no entries");
  for (const stage of DEFAULT_CHAIN.filter((s) => s.prompt).map((s) => s.id)) {
    for (const a of resolveActive(real, { stage, sliceNodes: [{ kind: "frontend", surfaces: ["secrets"], lenses: ["security"] }] })) {
      const e = real.entries.find((x) => x.name === a.name);
      assert(["trusted-provenance", "audited"].includes(e.audit_status),
        `${a.name} activated at ${stage} with audit_status "${e.audit_status}"`);
    }
  }
});

check("every shipped skill entry has files, and every skill directory is registered", () => {
  const real = JSON.parse(fs.readFileSync(path.join(kitRoot, "SKILLS/REGISTRY.json"), "utf8"));
  const dir = path.join(kitRoot, "SKILLS/skills");
  const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const name of onDisk) {
    assert(real.entries.some((e) => e.name === name),
      `SKILLS/skills/${name} is not in REGISTRY.json — unregistered skills have no provenance record`);
    assert(fs.existsSync(path.join(dir, name, "SKILL.md")), `SKILLS/skills/${name} has no SKILL.md`);
  }
});

check("ADVERSARIAL every shipped SKILL.md has frontmatter that can actually trigger", () => {
  const dir = path.join(kitRoot, "SKILLS/skills");
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const src = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
    assert(src.startsWith("---"), `${name}/SKILL.md has no YAML frontmatter, so it can never trigger`);
    const fm = src.slice(3, src.indexOf("\n---", 3));
    const declared = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    assert(declared === name,
      `${name}/SKILL.md declares name "${declared}" — a mismatch with the directory breaks the trigger`);
    assert(/^description:\s*\S/m.test(fm), `${name}/SKILL.md has no description, so dispatch cannot choose it`);
  }
});

// ------------------------------------------------------- vocabulary (codes)
//
// The vocabulary exists so the same idea spelled three ways stops counting as
// three ideas. These checks defend the other half of that bargain: an unnamed
// code must stay visible without ever becoming able to act.

const CFG = { paths: { state: ".trellis" } };

/** A throwaway repo root carrying a real CODES.md and a triage record. */
function triageRoot(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-codes-"));
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  fs.copyFileSync(path.join(kitRoot, CODES_DOC), path.join(dir, CODES_DOC));
  fs.writeFileSync(
    path.join(dir, ".trellis", "triage.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  return dir;
}

const reject = (code, node = "n01") => ({ node, verdict: "reject", code, reason: "x" });

check("the shipped vocabulary parses and every code is explained in prose", () => {
  const codes = loadCodes(kitRoot);
  assert(!codes.missing, `${CODES_DOC} is missing — it is the vocabulary`);
  const defined = allCodes(codes);
  assert(defined.length > 0, "the codes block defines nothing");
  const undocumented = defined.filter((c) => !codes.documented.has(c));
  assert(undocumented.length === 0,
    `defined but never explained: ${undocumented.join(", ")}. An unexplained code gets guessed at.`);
});

check("a known code reaching the run threshold is actionable", () => {
  const root = triageRoot([
    { run: "r1", decisions: [reject("unhandled-error-path")] },
    { run: "r2", decisions: [reject("unhandled-error-path")] },
    { run: "r3", decisions: [reject("unhandled-error-path")] },
  ]);
  const found = actionable(root, CFG, { minRuns: 3 });
  assert(found.length === 1 && found[0].code === "unhandled-error-path",
    `expected the known code to surface, got: ${JSON.stringify(found)}`);
});

check("ADVERSARIAL an unknown code never becomes actionable, at any run count", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    run: `r${i}`,
    decisions: [reject("something-nobody-ever-named")],
  }));
  const root = triageRoot(rows);
  assert(actionable(root, CFG, { minRuns: 3 }).length === 0,
    "a bucketed code reached the threshold — the loop can now invent its own evidence");
  const unknown = unknownCodes(root, CFG);
  assert(unknown.length === 1 && unknown[0].runs === 50,
    "the bucketed code should still be VISIBLE as vocabulary pressure, just not actionable");
});

check("ADVERSARIAL drifted spellings do not pool into a threshold", () => {
  const root = triageRoot([
    { run: "r1", decisions: [reject("unhandled-erroneous")] },
    { run: "r2", decisions: [reject("mishandled-error-branch")] },
    { run: "r3", decisions: [reject("no-error-coverage")] },
  ]);
  assert(actionable(root, CFG, { minRuns: 3 }).length === 0,
    "three different spellings were treated as one code");
});

check("ADVERSARIAL ten rejections in one run is one observation, not ten", () => {
  const root = triageRoot([
    { run: "r1", decisions: Array.from({ length: 10 }, (_, i) => reject("design-slop", `n${i}`)) },
  ]);
  assert(actionable(root, CFG, { minRuns: 3 }).length === 0,
    "one bad slice produced a threshold — runs, not nodes, is the unit of recurrence");
});

check("ADVERSARIAL other: normalisation is idempotent", () => {
  const codes = loadCodes(kitRoot);
  for (const raw of ["other:other:x", "Other: Foo", "other: other:  bar", "made-up"]) {
    const once = normaliseCode(raw, codes, "rejection");
    const twice = normaliseCode(once, codes, "rejection");
    assert(once === twice,
      `normalising ${JSON.stringify(raw)} twice changed it: ${once} -> ${twice}. ` +
        `One observation would count under two keys.`);
    assert(!/other:other:/.test(once), `nested bucket produced: ${once}`);
  }
});

check("ADVERSARIAL near-duplicate grouping is display-only, never summed", () => {
  const root = triageRoot([
    { run: "r1", decisions: [reject("flaky-timing-thing")] },
    { run: "r2", decisions: [reject("flaky-timing-thing")] },
    { run: "r3", decisions: [reject("timing-flaky-thing")] },
    { run: "r4", decisions: [reject("timing-flaky-thing")] },
  ]);
  const unknown = unknownCodes(root, CFG);
  const grouped = groupSimilar(unknown.map((u) => u.code));
  assert(grouped.some((g) => g.members.length > 1),
    "the two spellings should be shown together for a human to notice");
  for (const u of unknown) {
    assert(u.runs === 2,
      `grouping leaked into counting: ${u.code} shows ${u.runs} runs, should be 2. ` +
        `Summing near-matches lets a threshold be reached by varying spelling.`);
  }
  assert(actionable(root, CFG, { minRuns: 3 }).length === 0, "grouped buckets became actionable");
});

// -------------------------------------------------- triage leaves evidence
//
// triage.json is what the next slice reads. triage.jsonl is the only thing
// self-improvement ever sees. Verifying just the former let a stage report
// success having written no evidence at all.

const triageVerify = STAGES.find((s) => s.id === "06_triage").verify;

/** A root with state.json, triage.json, and whatever jsonl records you pass. */
function triageStageRoot({
  runId = "run-1",
  decisions = [{ node: "n01", verdict: "accept" }],
  jsonl,
  frictionRows = [{ run: "run-1", stage: "06_triage", kind: "none" }],
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-triage-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  const w = (f, o) => fs.writeFileSync(path.join(dir, ".trellis", f), JSON.stringify(o));
  const wl = (f, rows) =>
    fs.writeFileSync(
      path.join(dir, ".trellis", f),
      rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")
    );
  if (runId !== null) w("state.json", { runId });
  w("triage.json", { decisions });
  if (jsonl !== undefined) wl("triage.jsonl", jsonl);
  if (frictionRows !== undefined) wl("friction.jsonl", frictionRows);
  return dir;
}

check("triage passes when it leaves a jsonl record for this run", () => {
  const root = triageStageRoot({ jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }] });
  const r = triageVerify(root, CFG);
  assert(r.ok, `expected pass, got: ${r.detail}`);
});

check("ADVERSARIAL triage.json alone does not satisfy the stage", () => {
  const root = triageStageRoot({});
  const r = triageVerify(root, CFG);
  assert(!r.ok, "a stage that wrote no cross-run evidence was accepted");
  assert(/triage\.jsonl/.test(r.detail), `detail should name the missing file, got: ${r.detail}`);
});

check("ADVERSARIAL an empty triage.jsonl does not satisfy the stage", () => {
  const root = triageStageRoot({ jsonl: [] });
  assert(!triageVerify(root, CFG).ok, "an empty evidence file was accepted as evidence");
});

check("ADVERSARIAL a triage record from a different run does not satisfy this one", () => {
  const root = triageStageRoot({ runId: "run-2", jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }] });
  const r = triageVerify(root, CFG);
  assert(!r.ok, "last run's evidence was accepted as this run's");
  assert(/run-2/.test(r.detail), `detail should name the run it wanted, got: ${r.detail}`);
});

check("ADVERSARIAL an unstamped triage record does not satisfy the stage", () => {
  const root = triageStageRoot({ jsonl: [{ decisions: [reject("design-slop")] }] });
  assert(!triageVerify(root, CFG).ok,
    "a line with no run id was accepted — it can never be counted, so it is not evidence");
});

check("ADVERSARIAL a run-stamped record carrying no decisions does not satisfy the stage", () => {
  const root = triageStageRoot({ jsonl: [{ run: "run-1", decisions: [] }] });
  assert(!triageVerify(root, CFG).ok, "an empty decision list was accepted as a triage record");
});

// ------------------------------------------------------------ attempt kinds
//
// kinds.mjs mirrors literals that live in protected files. The mirror is what
// lets a load-bearing module read the vocabulary without protected code ever
// importing load-bearing code — a dependency that would put a hole in the
// protection boundary that classify() could not see. These checks are the price
// of the mirror: they catch drift, which is the only thing a shared enum would
// have bought.

check("ADVERSARIAL the kinds table matches the literals in the source, both ways", () => {
  const read = (rel) => fs.readFileSync(path.join(kitRoot, rel), "utf8");
  const inSource = new Set();

  // gate.mjs and worker.mjs assign `kind: "..."` / `record.kind = "..."`.
  for (const rel of ["kit/lib/gate.mjs", "kit/lib/worker.mjs"]) {
    const src = read(rel);
    for (const m of src.matchAll(/\bkind:\s*"([a-z-]+)"/g)) inSource.add(m[1]);
    for (const m of src.matchAll(/\.kind\s*=\s*"([a-z-]+)"/g)) inSource.add(m[1]);
    for (const m of src.matchAll(/\.kind\s*=\s*\w+\s*(?:instanceof\s+\w+\s*)?\?\s*"([a-z-]+)"\s*:\s*"([a-z-]+)"/g)) {
      inSource.add(m[1]);
      inSource.add(m[2]);
    }
  }

  // extract.mjs adds FLAGS, which worstFlag maps to kinds.
  const ex = read("kit/lib/extract.mjs");
  const flags = new Set([...ex.matchAll(/flags\.add\("([a-z-]+)"\)/g)].map((m) => m[1]));
  assert(flags.size > 0, "found no flags.add() literals in extract.mjs — the extractor changed shape");

  const mappedFlags = new Set(Object.keys(FLAG_TO_KIND));
  const flagOnlyInSource = [...flags].filter((f) => !mappedFlags.has(f));
  const flagOnlyInTable = [...mappedFlags].filter((f) => !flags.has(f));
  assert(flagOnlyInSource.length === 0,
    `extract.mjs raises flags absent from FLAG_TO_KIND: ${flagOnlyInSource.join(", ")}`);
  assert(flagOnlyInTable.length === 0,
    `FLAG_TO_KIND maps flags extract.mjs no longer raises: ${flagOnlyInTable.join(", ")}`);

  for (const f of flags) inSource.add(FLAG_TO_KIND[f]);

  const onlyInSource = [...inSource].filter((k) => !KINDS.has(k));
  const onlyInTable = [...KINDS].filter((k) => !inSource.has(k));
  assert(onlyInSource.length === 0,
    `kinds assigned in source but missing from KINDS: ${onlyInSource.join(", ")}. ` +
      `A kind the aggregation does not know about is evidence that silently vanishes.`);
  assert(onlyInTable.length === 0,
    `KINDS lists kinds no longer assigned anywhere: ${onlyInTable.join(", ")}`);
});

/** Ledger records, shaped like ledger.recordsFor output. */
const ledgerRec = (over = {}) => ({
  // Shape pinned against recordsFor() by the check below — survivingMutations is
  // a COUNT, not an array, which is how a dead clause hid for a whole commit.
  runId: "r1",
  nodeId: "n01",
  tags: ["api"],
  status: "merged",
  landedTier: "cheap",
  survivingMutations: 0,
  failureKinds: [],
  attemptsByTier: {},
  ...over,
});

check("a failure kind on exhausted nodes across three runs is actionable", () => {
  const history = ["r1", "r2", "r3"].map((runId) =>
    ledgerRec({ runId, status: "exhausted", landedTier: null, failureKinds: ["no-files", "no-files"] })
  );
  const found = kindActionable(null, CFG, { minRuns: 3, history });
  assert(found.length === 1 && found[0].kind === "no-files" && found[0].tag === "api",
    `expected no-files|api to surface, got: ${JSON.stringify(found)}`);
});

check("ADVERSARIAL test-failure on nodes that landed never reaches actionable", () => {
  // Five runs, every node fails twice then lands on the cheap tier. This is the
  // tier ladder working. If it produces a pattern, the scoping is broken and the
  // shortlist will be nothing but noise forever.
  const history = ["r1", "r2", "r3", "r4", "r5"].map((runId) =>
    ledgerRec({ runId, status: "merged", landedTier: "cheap", failureKinds: ["test-failure", "test-failure"] })
  );
  assert(kindActionable(null, CFG, { minRuns: 3, history }).length === 0,
    "retries that later landed produced a pattern — the costly-node scoping is not holding");
  // ...and the same data DOES surface when a human deliberately widens the scope.
  assert(kindActionable(null, CFG, { minRuns: 3, scope: "all", history }).length > 0,
    "--all-nodes should still be able to see it; the default just should not");
});

check("ADVERSARIAL ten exhausted nodes in one run is one observation", () => {
  const history = Array.from({ length: 10 }, (_, i) =>
    ledgerRec({ runId: "r1", nodeId: `n${i}`, status: "exhausted", landedTier: null, failureKinds: ["out-of-scope"] })
  );
  const counts = kindCounts(null, CFG, { history });
  const e = counts.get("out-of-scope|api");
  assert(e && e.runs === 1 && e.attempts === 10,
    `expected 1 run / 10 attempts, got ${JSON.stringify(e)}`);
  assert(kindActionable(null, CFG, { minRuns: 3, history }).length === 0,
    "one bad slice reached the threshold — runs, not nodes, is the unit of recurrence");
});

check("ADVERSARIAL one node retried within a run counts once per run", () => {
  const history = [
    ledgerRec({ runId: "r1", status: "exhausted", landedTier: null, failureKinds: ["timeout", "timeout", "timeout"] }),
    ledgerRec({ runId: "r2", status: "exhausted", landedTier: null, failureKinds: ["timeout"] }),
  ];
  const e = kindCounts(null, CFG, { history }).get("timeout|api");
  assert(e.runs === 2 && e.nodes === 2,
    `three retries in one run inflated the count: ${JSON.stringify(e)}`);
});

check("ADVERSARIAL the costly-node fixtures match what the ledger actually writes", () => {
  // The fixtures below are hand-built. If their shape drifts from recordsFor's
  // output, every check using them tests a fiction — which is exactly how the
  // surviving-mutation clause stayed dead: the fixture used [], the ledger
  // writes a number, and `?.length` on a number is undefined.
  const state = {
    runId: "r1", project: "p",
    nodes: { n01: { status: "merged", tier: "cheap", attempts: [{ tier: "cheap", ok: true, kind: "pass" }], survivingMutations: ["m1", "m2"] } },
  };
  const [real] = recordsFor(state, new Map([["n01", { id: "n01", tags: ["api"], write: [], tests: [], deps: [] }]]));
  assert(real !== undefined, "recordsFor produced nothing for a merged node");
  assert(typeof real.survivingMutations === "number",
    `recordsFor writes survivingMutations as ${typeof real.survivingMutations}; fixtures must match`);
  assert(typeof ledgerRec().survivingMutations === typeof real.survivingMutations,
    `fixture survivingMutations is ${typeof ledgerRec().survivingMutations}, ledger writes ${typeof real.survivingMutations}`);
  for (const k of ["status", "landedTier", "failureKinds", "attemptsByTier", "tags", "runId", "nodeId"]) {
    assert(k in real, `recordsFor no longer emits ${k}; the aggregation reads it`);
  }
});

check("a node that landed with a live mutant counts as costly", () => {
  // Built through recordsFor, not by hand, so the shape cannot drift.
  const history = ["r1", "r2", "r3"].map((runId) => {
    const state = {
      runId, project: "p",
      nodes: { n01: { status: "merged", tier: "cheap", survivingMutations: ["m1"],
        attempts: [{ tier: "cheap", ok: false, kind: "out-of-scope" }, { tier: "cheap", ok: true, kind: "pass" }] } },
    };
    return recordsFor(state, new Map([["n01", { id: "n01", tags: ["api"], write: [], tests: [], deps: [] }]]))[0];
  });
  assert(history[0].survivingMutations > 0, "precondition: the fixture has a live mutant");
  const found = kindActionable(null, CFG, { minRuns: 3, history });
  assert(found.length === 1 && found[0].kind === "out-of-scope",
    `a node that merged with a surviving mutant was not treated as costly: ${JSON.stringify(found)}`);
});

check("a node that landed on the strong tier counts as costly", () => {
  const history = ["r1", "r2", "r3"].map((runId) =>
    ledgerRec({ runId, status: "merged", landedTier: "strong", failureKinds: ["timeout"] })
  );
  const found = kindActionable(null, CFG, { minRuns: 3, history });
  assert(found.length === 1 && found[0].kind === "timeout",
    `needing the top tier is expensive and must be in the population: ${JSON.stringify(found)}`);
});

check("ADVERSARIAL an unrecognised kind is dropped rather than counted", () => {
  const history = ["r1", "r2", "r3", "r4"].map((runId) =>
    ledgerRec({ runId, status: "exhausted", landedTier: null, failureKinds: ["invented-kind"] })
  );
  assert(kindActionable(null, CFG, { minRuns: 3, history }).length === 0,
    "a kind absent from KINDS became actionable — drift would be laundered into evidence");
});

// --------------------------------------------------------- the deletion half
//
// A self-improvement loop that can only add is not a loop. These checks defend
// the retirement signal against the two ways it would quietly stop working:
// speaking too early, and letting the arsenal move without a human.

const reg = (entries) => ({ schema: "trellis.skill-registry/1", entries });
const skillEntry = (name, over = {}) => ({
  name,
  kind: "skill",
  audit_status: "audited",
  activation: { stage: ["03_cases"] },
  ...over,
});
const act = (run, name) => ({ ts: "t", run, stage: "03_cases", name, reason: "stage:03_cases" });

check("a skill that never activated across enough runs is reported", () => {
  const r = neverActivated(
    reg([skillEntry("used"), skillEntry("unused")]),
    [act("r1", "used"), act("r2", "used"), act("r3", "used")],
    { minRuns: 3 }
  );
  assert(r.ready, "three distinct runs should be enough evidence to speak");
  assert(r.skills.length === 1 && r.skills[0].name === "unused",
    `expected only "unused", got: ${r.skills.map((s) => s.name).join(", ")}`);
});

check("ADVERSARIAL retirement stays silent below the run threshold", () => {
  const r = neverActivated(
    reg([skillEntry("used"), skillEntry("unused")]),
    [act("r1", "used"), act("r2", "used")],
    { minRuns: 3 }
  );
  assert(!r.ready && r.skills.length === 0,
    "two runs produced a retirement recommendation — one slice that happened not to match " +
      "a skill is not a fact about the skill");
});

check("ADVERSARIAL a manual-only entry is never recommended for retirement", () => {
  // Manual entries activate when a human names them in skills.manual and never
  // otherwise. Reporting them as dead weight names most of the registry every
  // time, and a signal that fires on everything is one nobody reads.
  const r = neverActivated(
    reg([skillEntry("used"), skillEntry("opt-in", { activation: { manual: true } })]),
    [act("r1", "used"), act("r2", "used"), act("r3", "used")],
    { minRuns: 3 }
  );
  assert(r.skills.length === 0,
    `a manual-only entry was proposed for deletion: ${r.skills.map((s) => s.name).join(", ")}`);
});

check("an entry with no rule at all is reported as unreachable, not as unused", () => {
  const r = neverActivated(
    reg([skillEntry("used"), skillEntry("stranded", { activation: {} })]),
    [act("r1", "used")],
    { minRuns: 3 }
  );
  assert(r.unreachable.some((u) => u.name === "stranded"),
    "an entry no rule can ever reach was not reported");
  assert(!r.skills.some((s) => s.name === "stranded"),
    "unreachable and unused are different findings and must not be merged");
});

check("ADVERSARIAL an unaudited entry is never recommended for retirement", () => {
  // It never activated because the audit gate withheld it, not because it is
  // useless. Recommending deletion here would turn "not yet reviewed" into
  // "delete it", which is the wrong direction entirely.
  const r = neverActivated(
    reg([skillEntry("used"), skillEntry("pending-review", { audit_status: "pending" })]),
    [act("r1", "used"), act("r2", "used"), act("r3", "used")],
    { minRuns: 3 }
  );
  assert(r.skills.length === 0,
    `an unaudited entry was proposed for deletion: ${r.skills.map((s) => s.name).join(", ")}`);
});

check("ADVERSARIAL the arsenal is load-bearing, never advisory", () => {
  for (const p of ["SKILLS/REGISTRY.json", "SKILLS/skills/trellis-plan/SKILL.md", "SKILLS/"]) {
    assert(classify(p) === "load-bearing",
      `${p} classified "${classify(p)}" — an arsenal change that auto-applies is one nobody saw`);
  }
});

// ---------------------------------------------------------------- friction
//
// You cannot verify a self-report. What these defend is the weaker thing that IS
// achievable: silence becomes a signed statement, and a false statement shows up
// as a pattern across runs rather than an accusation against one session.

check("ADVERSARIAL an empty friction record set does not satisfy the stage", () => {
  const root = triageStageRoot({
    jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }],
    frictionRows: [],
  });
  const r = triageVerify(root, CFG);
  assert(!r.ok, "a stage that said nothing about friction was accepted");
  assert(/friction/.test(r.detail), `detail should name friction, got: ${r.detail}`);
});

check("ADVERSARIAL friction from another run or another stage does not satisfy this one", () => {
  for (const wrong of [
    { run: "run-0", stage: "06_triage", kind: "none" },
    { run: "run-1", stage: "03_cases", kind: "none" },
  ]) {
    const root = triageStageRoot({
      jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }],
      frictionRows: [wrong],
    });
    assert(!triageVerify(root, CFG).ok,
      `a record for ${wrong.run}/${wrong.stage} satisfied run-1/06_triage`);
  }
});

check("an explicit none satisfies the stage", () => {
  const root = triageStageRoot({ jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }] });
  const r = triageVerify(root, CFG);
  assert(r.ok, `asserting none should pass, got: ${r.detail}`);
  assert(/none/.test(r.detail), `detail should record that none was asserted, got: ${r.detail}`);
});

check("ADVERSARIAL validate refuses records that could never be counted", () => {
  const cases = [
    [{ stage: "06_triage", kind: "invented-kind", code: "x" }, /not one of/],
    [{ kind: "manual-edit", code: "x" }, /stage is required/],
    [{ stage: "06_triage", kind: "manual-edit" }, /code is required/],
    [{ stage: "06_triage", kind: "manual-edit", code: "x", count: 0 }, /count/],
    [{ stage: "06_triage", kind: "manual-edit", code: "x", note: "z".repeat(200) }, /note/],
  ];
  for (const [rec, want] of cases) {
    const errors = friction.validate(rec);
    assert(errors.length > 0, `accepted an uncountable record: ${JSON.stringify(rec)}`);
    assert(errors.some((e) => want.test(e)),
      `rejected ${JSON.stringify(rec)} but not for the expected reason: ${errors.join("; ")}`);
  }
  assert(friction.validate({ stage: "06_triage", kind: "none" }).length === 0,
    "a bare none-assertion must be valid — it is the whole mechanism");
});

check("ADVERSARIAL the per-stage-run record cap is enforced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-friction-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  const rec = { stage: "06_triage", kind: "manual-edit", code: "hand-tightened-contract" };
  for (let i = 0; i < friction.MAX_PER_STAGE_RUN; i++) {
    friction.append(dir, CFG, rec, { run: "run-1" });
  }
  let threw = false;
  try { friction.append(dir, CFG, rec, { run: "run-1" }); } catch { threw = true; }
  assert(threw, "the cap did not hold — verbosity must not be rewarded any more than silence is");
  // The cap is per stage-run, so a different run is unaffected.
  friction.append(dir, CFG, rec, { run: "run-2" });
});

check("ADVERSARIAL append stamps run itself and refuses an unattributable record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-friction-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  const row = friction.append(
    dir, CFG,
    { stage: "06_triage", kind: "manual-edit", code: "hand-tightened-contract", run: "forged", ts: "1999" },
    { run: "run-1" }
  );
  assert(row.run === "run-1", `run was taken from the record instead of the caller: ${row.run}`);
  assert(row.ts !== "1999", "ts was taken from the record instead of the clock");

  let threw = false;
  try { friction.append(dir, CFG, { stage: "06_triage", kind: "none" }, { run: null }); } catch { threw = true; }
  assert(threw, "a record with no run id was written — it can never be counted, so it is not evidence");
});

check("ADVERSARIAL a contradicted none is counted but never fails the stage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-friction-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  for (const run of ["r1", "r2", "r3"]) {
    friction.append(dir, CFG, { stage: "06_triage", kind: "none" }, { run });
  }
  const ledgerRecords = ["r1", "r2", "r3"].map((runId) => ({ runId, nodeId: "n01", status: "exhausted" }));
  const found = friction.contradictions(dir, CFG, { ledgerRecords });
  assert(found.length === 3,
    `expected all three none-assertions to be contradicted, got ${found.length}`);

  // The other half, and the one that keeps reporting honestly cheap: the stage
  // still passes. Nothing a session says about friction can fail it.
  for (const run of ["r1", "r2", "r3"]) {
    const r = friction.assertedFor(dir, CFG, { run, stage: "06_triage" });
    assert(r.ok, `asserting none failed the stage for ${run} — that makes silence the safe answer`);
  }
});

/** A friction root carrying a real CODES.md, written by hand as a human could. */
function frictionRoot(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-fr-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.copyFileSync(path.join(kitRoot, CODES_DOC), path.join(dir, CODES_DOC));
  fs.writeFileSync(
    path.join(dir, ".trellis", "friction.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  return dir;
}

check("ADVERSARIAL an invented friction code never clears the threshold", () => {
  // friction.jsonl is a plain file a human can edit (MISSION invariant 5), so
  // the CLI normalising on write proves nothing about what counts on read. This
  // exact payload used to produce { runs: 3, count: 297 } and land on the
  // shortlist pointing at a protected file.
  const root = frictionRoot(["r1", "r2", "r3"].map((run) => ({
    ts: "t", run, stage: "06_triage", kind: "missing-tool",
    code: "gate.mjs is too strict", count: 99, target: "kit/lib/gate.mjs",
  })));
  const c = friction.counts(root, CFG);
  const keys = Object.keys(c);
  assert(keys.length === 1 && keys[0].startsWith("other:"),
    `free text reached the shortlist uncoded: ${JSON.stringify(keys)}`);
  assert(c[keys[0]].count <= friction.MAX_PER_STAGE_RUN * 3,
    `a hand-written count of 99 was taken at face value (${c[keys[0]].count}); ` +
      `occurrences order the shortlist, so it reorders what stage 07 may see`);
});

check("a known friction code still counts under its own name", () => {
  const root = frictionRoot(["r1", "r2", "r3"].map((run) => ({
    ts: "t", run, stage: "06_triage", kind: "manual-edit", code: "hand-tightened-contract",
  })));
  const c = friction.counts(root, CFG);
  assert(c["hand-tightened-contract"]?.runs === 3,
    `the normalisation swallowed a legitimate code: ${JSON.stringify(Object.keys(c))}`);
});

check("ADVERSARIAL a code named __proto__ is neutralised, not executed", () => {
  const root = frictionRoot([
    { ts: "t", run: "r1", stage: "06_triage", kind: "missing-tool", code: "__proto__", count: 5 },
    { ts: "t", run: "r2", stage: "06_triage", kind: "missing-tool", code: "constructor" },
  ]);
  const c = friction.counts(root, CFG);   // used to throw
  assert(!Object.hasOwn(Object.prototype, "count"),
    "Object.prototype was mutated process-wide by a line in a data file");
  for (const k of Object.keys(c)) {
    assert(k.startsWith("other:"), `${k} was treated as a known code`);
  }
});

check("ADVERSARIAL a malformed evidence line does not take the command down", () => {
  // A torn or hand-edited file must degrade, not throw: this reader backs
  // `trellis evolve` and the 07_evolve verify predicate.
  const root = triageRoot([
    null,
    { run: "r1", decisions: { not: "an array" } },
    { run: "r1" },
    "a string",
    { run: "r2", decisions: [null, { verdict: "reject" }, { verdict: "reject", code: "design-slop" }] },
  ]);
  const counts = rejectionCountsFn(root, CFG);   // must not throw
  assert(counts["design-slop"]?.runs === 1, `the one good decision was lost: ${JSON.stringify(counts)}`);
  assert(!Object.hasOwn(Object.prototype, "count"), "Object.prototype was mutated");
});

check("ADVERSARIAL a run with no exhausted nodes is not a contradiction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-friction-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  friction.append(dir, CFG, { stage: "06_triage", kind: "none" }, { run: "r1" });
  const ledgerRecords = [{ runId: "r1", nodeId: "n01", status: "merged" }];
  assert(friction.contradictions(dir, CFG, { ledgerRecords }).length === 0,
    "a smooth run was flagged as a contradiction — the detector must only fire on real friction");
});

// -------------------------------------------------------- tooling proposals
//
// The addition side of the loop. A tooling proposal is where a recurring pattern
// turns into a standing cost, so the things that make that cost visible and
// reversible have to be enforced rather than encouraged.

function proposalRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-propose-"));
  fs.mkdirSync(path.join(dir, "evolution", "proposals"), { recursive: true });
  return dir;
}

const toolingArgs = (over = {}) => ({
  title: "add a graph differ skill",
  targets: ["SKILLS/REGISTRY.json"],
  kind: "tooling",
  evidence: "missing-tool in 4 runs",
  alternatives: "a check cannot do it because the comparison needs judgement",
  cost: "12 skills today, 13 after",
  reversal: "zero activations across 10 runs",
  ...over,
});

check("ADVERSARIAL a tooling proposal without a retirement condition is refused", () => {
  for (const missing of [undefined, "", "   "]) {
    let threw = false;
    try {
      writeProposal(proposalRoot(), toolingArgs({ reversal: missing }));
    } catch { threw = true; }
    assert(threw,
      `a tooling proposal with reversal=${JSON.stringify(missing)} was written. ` +
        `The pre-commitment IS the deletion mechanism; without it the arsenal only grows.`);
  }
  // The same proposal WITH one is fine — the check must not be blanket refusal.
  const r = writeProposal(proposalRoot(), toolingArgs());
  assert(r.kind === "tooling", `expected a tooling proposal, got ${r.kind}`);
});

check("ADVERSARIAL an unknown proposal kind throws", () => {
  let threw = false;
  try { writeProposal(proposalRoot(), toolingArgs({ kind: "improvement" })); } catch { threw = true; }
  assert(threw, "an unrecognised kind was accepted, so the template silently degraded to default");
});

check("a tooling proposal carries alternatives, cost, and retirement", () => {
  const root = proposalRoot();
  const r = writeProposal(root, toolingArgs());
  const text = fs.readFileSync(path.join(root, r.file), "utf8");
  for (const heading of ["## Alternatives considered", "## Cost", "## Retirement condition"]) {
    assert(text.includes(heading), `tooling template is missing ${heading}`);
  }
  assert(/- \[ \] Does a contract fix or a plain check do this instead\?/.test(text),
    "the reviewer checklist must lead with the cheaper-mechanism question");
});

check("the legacy argument shape still produces the mechanism template", () => {
  // Pins the two call sites inside this file. If a required parameter ever
  // appears, they break, and they live in a protected file.
  const root = proposalRoot();
  const r = writeProposal(root, {
    title: "reword something",
    targets: ["README.md"],
    rationale: "x",
    evidence: "y",
    change: "z",
  });
  const text = fs.readFileSync(path.join(root, r.file), "utf8");
  assert(r.kind === "mechanism", `default kind changed to ${r.kind}`);
  assert(text.includes("## Why this fixes the cause, not the symptom"), "mechanism template changed shape");
  assert(text.includes("## Proposed change"), "mechanism template lost its change section");
  assert(!text.includes("## Retirement condition"), "mechanism proposals should not grow a tooling section");
});

check("ADVERSARIAL a proposal touching the vocabulary never auto-applies", () => {
  // references/CODES.md is prose, so it classifies advisory and would otherwise
  // apply with nobody in the path. It is also the definition of what counts as
  // evidence, which makes it the one advisory file a loop could use to
  // manufacture a threshold.
  assert(classify(CODES_DOC) === "advisory", "precondition: CODES.md is advisory prose");
  // Every spelling, not just the canonical one. `references//CODES.md` used to
  // classify advisory AND auto-apply, because the carve-out compared exact
  // strings while classify() compared prefixes.
  for (const spelling of [CODES_DOC, "references//CODES.md", "references/./CODES.md", "REFERENCES/CODES.MD", ".\\references\\CODES.md"]) {
    assert(!autoAppliable(spelling, { evolve: { autoApplyAdvisory: true } }),
      `"${spelling}" auto-applies — the loop can widen its own definition of evidence`);
  }
  assert(autoAppliable("README.md", { evolve: { autoApplyAdvisory: true } }),
    "the carve-out must stay narrow; blanket review trains reviewers to skim");

  const root = proposalRoot();
  const r = writeProposal(root, {
    title: "add a code", targets: [CODES_DOC], evidence: "e", rationale: "r", change: "c",
  });
  const text = fs.readFileSync(path.join(root, r.file), "utf8");
  assert(/\*\*Applies:\*\* only when a human merges it/.test(text),
    "a vocabulary proposal was marked auto-applying");
  assert(r.held === true, "the proposal did not record that it is held");
});

check("ADVERSARIAL anything written by the evolve stage waits for a human", () => {
  // Otherwise the system writes prose about how it should behave and that prose
  // applies with nobody in the path.
  const root = proposalRoot();
  const r = writeProposal(root, {
    title: "reword a reference", targets: ["references/conventions.md"],
    evidence: "e", rationale: "r", change: "c", fromEvolveStage: true,
  });
  const text = fs.readFileSync(path.join(root, r.file), "utf8");
  assert(r.tier === "advisory", "precondition: this target is advisory");
  assert(r.held === true && /only when a human merges it/.test(text),
    "model-authored advisory prose auto-applied — that is a closed loop with no human in it");
});

check("references/TOOLING.md exists and stays short enough to read every pass", () => {
  const p = path.join(kitRoot, "references/TOOLING.md");
  assert(fs.existsSync(p), "the decision table is missing");
  const lines = fs.readFileSync(p, "utf8").split("\n").length;
  assert(lines <= 150, `TOOLING.md is ${lines} lines; it enters an Opus context on every evolve pass`);
});

// ----------------------------------------------------------- the evolve stage

const evolveVerify = STAGES.find((s) => s.id === "07_evolve").verify;

check("ADVERSARIAL 07_evolve is not in the default auto chain", () => {
  // Without this, adding a periodic stage silently makes every ordinary run
  // spend an extra expensive session, and nothing else in the system would
  // report it as a change.
  assert(DEFAULT_CHAIN.map((s) => s.id).join(",") === "01_ingest,02_slice,03_cases,04_tests,05_build,06_triage",
    `the default chain changed: ${DEFAULT_CHAIN.map((s) => s.id).join(",")}`);
  assert(STAGES.some((s) => s.id === "07_evolve" && s.periodic),
    "07_evolve must exist and be marked periodic");
});

/** A root with a shortlist-producing ledger and whatever evolve.json you pass. */
function evolveRoot(evolveJson, { tags = ["api"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-evolve-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evolution", "proposals"), { recursive: true });
  fs.copyFileSync(path.join(kitRoot, CODES_DOC), path.join(dir, CODES_DOC));
  fs.writeFileSync(path.join(dir, ".trellis", "state.json"), JSON.stringify({ runId: "r3" }));
  // Three runs of exhausted nodes per tag: one actionable pattern per tag.
  const rows = [];
  for (const runId of ["r1", "r2", "r3"]) {
    for (const tag of tags) {
      rows.push(JSON.stringify(ledgerRec({
        runId, nodeId: `n-${tag}`, tags: [tag], status: "exhausted", landedTier: null,
        failureKinds: ["no-files"],
      })));
    }
  }
  fs.writeFileSync(path.join(dir, ".trellis", "ledger.jsonl"), rows.join("\n") + "\n");
  if (evolveJson !== undefined) {
    fs.writeFileSync(path.join(dir, ".trellis", "evolve.json"), JSON.stringify(evolveJson));
  }
  return dir;
}

/** A real proposal on disk, written the way the stage is told to write one. */
function realProposal(root, title = "fix the slicer") {
  return writeProposal(root, {
    title, targets: ["sessions/02_slice/CONTEXT.md"], evidence: "e", rationale: "r", change: "c",
  }).file.replace(/\\/g, "/");
}

check("07_evolve passes when every shortlisted pattern is accounted for", () => {
  const root = evolveRoot({ run: "r3", consideredCodes: ["no-files|api"], proposals: [], declined: [{ code: "no-files|api", row: "nothing", why: "one project's habit" }] });
  const r = evolveVerify(root, CFG);
  assert(r.ok, `expected pass, got: ${r.detail}`);
});

check("ADVERSARIAL 07_evolve fails when it omits a code the shortlist reports", () => {
  // The stage-06 rule transplanted: silence on a shortlisted pattern is not a
  // decline. Deciding to do nothing is fine; not mentioning it is not.
  const root = evolveRoot({ run: "r3", consideredCodes: [], proposals: [], declined: [] });
  const r = evolveVerify(root, CFG);
  assert(!r.ok, "a pass that ignored the evidence it was shown was accepted");
  assert(/no-files\|api/.test(r.detail), `detail should name what was ignored, got: ${r.detail}`);
});

check("ADVERSARIAL 07_evolve fails when considered codes are not all dispositioned", () => {
  const root = evolveRoot({ run: "r3", consideredCodes: ["no-files|api"], proposals: [], declined: [] });
  assert(!evolveVerify(root, CFG).ok,
    "a considered pattern with neither a proposal nor a decline was accepted");
});

check("ADVERSARIAL 07_evolve fails when it names a proposal that does not exist", () => {
  const root = evolveRoot({
    run: "r3",
    consideredCodes: ["no-files|api"],
    proposals: ["evolution/proposals/999-imaginary.md"],
    declined: [],
  });
  const r = evolveVerify(root, CFG);
  assert(!r.ok, "a proposal that was never written was accepted as written");
  assert(/not written proposals/.test(r.detail), `detail should say so, got: ${r.detail}`);
});

check("ADVERSARIAL any readable file does not count as a proposal", () => {
  // `proposals: ["references/CODES.md"]` used to pass: the check was only that
  // the path existed. A proposal is a file writeProposal made, where it makes
  // them — anything else is a claim of completion rather than proof of it.
  for (const fake of ["references/CODES.md", "evolution/proposals/../../MISSION.md", "evolution/proposals/notes.txt"]) {
    const root = evolveRoot({ run: "r3", consideredCodes: ["no-files|api"], proposals: [fake], declined: [] });
    fs.writeFileSync(path.join(root, "MISSION.md"), "x");
    fs.writeFileSync(path.join(root, "evolution", "proposals", "notes.txt"), "x");
    assert(!evolveVerify(root, CFG).ok, `"${fake}" was accepted as a written proposal`);
  }
});

check("ADVERSARIAL a decline must name what it declined", () => {
  // Without this the arithmetic is satisfied by an array of the right length:
  // `declined: [1,2,3]` used to pass.
  for (const declined of [[1], [{}], [{ code: "no-files|api" }], [{ why: "x" }]]) {
    const root = evolveRoot({ run: "r3", consideredCodes: ["no-files|api"], proposals: [], declined });
    assert(!evolveVerify(root, CFG).ok, `a decline of ${JSON.stringify(declined)} was accepted`);
  }
  // ...and a decline for something never considered is not accounting either.
  const stray = evolveRoot({
    run: "r3", consideredCodes: ["no-files|api"], proposals: [],
    declined: [{ code: "something-else", why: "x" }],
  });
  assert(!evolveVerify(stray, CFG).ok, "a decline for an unconsidered code was accepted");
});

check("ADVERSARIAL a stale evolve.json from an earlier pass does not satisfy the stage", () => {
  // cmdAuto pre-checks verify and skips when it passes, so an unattributed
  // artifact would retire the stage permanently.
  const root = evolveRoot({
    run: "r1", consideredCodes: ["no-files|api"], proposals: [],
    declined: [{ code: "no-files|api", row: "nothing", why: "x" }],
  });
  const r = evolveVerify(root, CFG);
  assert(!r.ok, "last pass's artifact satisfied this run");
  assert(/r3/.test(r.detail), `detail should name the run it wanted, got: ${r.detail}`);
});

check("ADVERSARIAL 07_evolve is not deadlocked by more patterns than it is shown", () => {
  // The verify predicate used to enumerate the WHOLE shortlist while the stage
  // contract feeds it `--json --top N`. With more than N actionable patterns the
  // stage was required to account for codes it could not see, and could never
  // pass again. Both now call evolve.shortlist().
  const tags = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
  const probe = evolveRoot(undefined, { tags });
  const shown = shortlist(probe, CFG, { minRuns: 3, top: EVOLVE_TOP }).map((r) => r.code);
  assert(shown.length === EVOLVE_TOP,
    `precondition: expected the cap to bite, got ${shown.length} of ${tags.length}`);

  const root = evolveRoot({
    run: "r3",
    consideredCodes: shown,
    proposals: [],
    declined: shown.map((code) => ({ code, row: "nothing", why: "one project's habit" })),
  }, { tags });
  const r = evolveVerify(root, CFG);
  assert(r.ok, `accounting for exactly what the stage was shown still failed: ${r.detail}`);
});

check("a real proposal written by writeProposal is accepted", () => {
  const root = evolveRoot(undefined);
  const file = realProposal(root);
  fs.writeFileSync(path.join(root, ".trellis", "evolve.json"), JSON.stringify({
    run: "r3", consideredCodes: ["no-files|api"], proposals: [file], declined: [],
  }));
  const r = evolveVerify(root, CFG);
  assert(r.ok, `a genuine proposal was rejected: ${r.detail}`);
});

check("every stage in STAGES has a contract with the canonical headings", () => {
  // Closes the drift this repo already had four copies of. STAGES becomes the
  // enforced registry rather than the nominal one.
  for (const stage of STAGES) {
    const p = path.join(kitRoot, "sessions", stage.id, "CONTEXT.md");
    assert(fs.existsSync(p), `sessions/${stage.id}/CONTEXT.md does not exist`);
    const text = fs.readFileSync(p, "utf8");
    assert(text.startsWith(`# Stage ${stage.id.slice(0, 2)}`), `${stage.id} contract has the wrong title line`);
    // 05_build is an anti-contract — no model runs it, so only Outputs applies.
    const required = stage.run === "runner" ? ["## Outputs"] : ["## Inputs", "## Process", "## Outputs", "## Verify"];
    for (const h of required) {
      assert(text.includes(h), `sessions/${stage.id}/CONTEXT.md is missing ${h}`);
    }
  }
});

// -------------------------------------------------- what the gate can see
//
// changedPaths() is the input to BOTH scope enforcement and frozen-test
// detection. If it returns a wrong path, the gate silently stops protecting the
// oracle. These use a real git repo because the bug that motivated them was
// invisible to every synthetic fixture in this file: fixtures create new files,
// and only MODIFIED files carry the leading-space status that triggered it.

function gitRepoWith(files, modify = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-wt-"));
  const g = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q", ".");
  g("config", "user.email", "a@b.c");
  g("config", "user.name", "t");
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  g("add", "-A");
  g("commit", "-qm", "init");
  for (const [rel, body] of Object.entries(modify)) fs.writeFileSync(path.join(dir, rel), body);

  // A fixture that produced no change would make every assertion below pass
  // against an empty list. That is the exact shape of the vacuous test this
  // whole section exists to replace, so the helper refuses to return one.
  if (Object.keys(modify).length) {
    const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
    if (!porcelain.trim()) {
      throw new Error("fixture produced no git changes — the assertions would pass vacuously");
    }
  }
  return dir;
}

check("ADVERSARIAL changedPaths reports modified files exactly, first record included", () => {
  // "a_tests" sorts before "src", so the tampered oracle is the FIRST porcelain
  // record — the position where the path used to lose its first character.
  const dir = gitRepoWith(
    { "a_tests/t.mjs": "assert(real)\n", "src/a.mjs": "original\n" },
    { "a_tests/t.mjs": "assert(true)\n", "src/a.mjs": "changed\n" }
  );
  const got = changedPaths(dir).sort();
  assert(got.length === 2, `expected 2 changed paths, got ${JSON.stringify(got)}`);
  assert(got[0] === "a_tests/t.mjs" && got[1] === "src/a.mjs",
    `changedPaths corrupted a path: ${JSON.stringify(got)}. ` +
      `A wrong path here means a tampered test no longer matches node.tests, and the gate ` +
      `runs against an oracle the worker edited.`);
});

check("ADVERSARIAL a tampered frozen test is still detected when it sorts first", () => {
  // The consequence, stated as the gate states it: the intersection of changed
  // paths with node.tests must be non-empty.
  const dir = gitRepoWith(
    { "a_tests/t.mjs": "assert(real)\n", "src/a.mjs": "original\n" },
    { "a_tests/t.mjs": "assert(true)\n" }
  );
  const touchedTests = changedPaths(dir).filter((p) => matchAny(p, ["a_tests/**"]));
  assert(touchedTests.length === 1,
    `frozen-test tampering went undetected: changed=${JSON.stringify(changedPaths(dir))}`);
});

check("ADVERSARIAL a modified in-scope file is not misreported as out-of-scope", () => {
  // The other half. Every refactor/fix node modifies existing files; a corrupted
  // path fails the write-scope check, gets "reverted" against a path that does
  // not exist, and the node burns every tier to exhaustion on a harness bug.
  const dir = gitRepoWith({ "src/a.mjs": "original\n" }, { "src/a.mjs": "changed\n" });
  const outOfScope = changedPaths(dir).filter((p) => !matchAny(p, ["src/**"]));
  assert(outOfScope.length === 0,
    `an in-scope modification was reported out of scope: ${JSON.stringify(outOfScope)}`);
});

check("changedPaths still sees untracked files and rename sources", () => {
  const dir = gitRepoWith({ "src/a.mjs": "original\n" });
  fs.writeFileSync(path.join(dir, "src", "new.mjs"), "added\n");
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g("mv", "src/a.mjs", "src/b.mjs");
  const got = changedPaths(dir);
  assert(got.includes("src/new.mjs"), `untracked file missed: ${JSON.stringify(got)}`);
  assert(got.includes("src/a.mjs") && got.includes("src/b.mjs"),
    `rename must report both sides so neither escapes scope checking: ${JSON.stringify(got)}`);
});

// ------------------------------------------- things the last audit found bare
//
// Each of these guards something a mutation proved was unguarded: the mutant
// survived all three suites.

check("ADVERSARIAL every evidence file honours cfg.paths.state", () => {
  // Every fixture in this file sets state: ".trellis", so hard-coding the
  // default back into the path helpers was invisible — the commit that added
  // the config routing shipped with no test of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-state-"));
  const cfg = { paths: { state: "evidence" } };
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });

  for (const [name, fn] of [
    ["triage.jsonl", triagePath],
    ["friction.jsonl", friction.frictionPath],
    ["skills.jsonl", activationPath],
    ["ledger.jsonl", ledgerPath],
  ]) {
    const p = fn(dir, cfg).replace(/\\/g, "/");
    assert(p.endsWith(`evidence/${name}`),
      `${name} resolved to ${p} — cfg.paths.state was ignored`);
    assert(!p.includes("/.trellis/"), `${name} fell back to the default state dir`);
  }

  // And end to end: a record written under the configured dir is read back.
  friction.append(dir, cfg, { stage: "06_triage", kind: "manual-edit", code: "hand-tightened-contract" }, { run: "r1" });
  assert(fs.existsSync(path.join(dir, "evidence", "friction.jsonl")), "friction.jsonl was not written under evidence/");
  assert(!fs.existsSync(path.join(dir, ".trellis", "friction.jsonl")), "friction.jsonl leaked into .trellis/");
  assert(friction.read(dir, cfg).length === 1, "the record could not be read back from the configured dir");
});

check("ADVERSARIAL materialise only removes directories it wrote", () => {
  // Its docblock promises a hand-placed project skill is never destroyed by a
  // stage transition. Making it delete everything under .claude/skills/ left all
  // three suites green.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-mat-"));
  const dest = path.join(dir, ".claude", "skills");
  fs.mkdirSync(path.join(dest, "hand-placed"), { recursive: true });
  fs.writeFileSync(path.join(dest, "hand-placed", "SKILL.md"), "mine\n");
  fs.mkdirSync(path.join(dir, "SKILLS", "skills", "shipped"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILLS", "skills", "shipped", "SKILL.md"), "theirs\n");

  materialise(dir, [{ name: "shipped", kind: "skill", reason: "always" }]);
  assert(fs.existsSync(path.join(dest, "hand-placed", "SKILL.md")),
    "a hand-placed skill was destroyed by a stage transition");
  assert(fs.existsSync(path.join(dest, "shipped", "SKILL.md")), "the active skill was not materialised");

  // ...and the next stage, wanting nothing, removes only what it put there.
  materialise(dir, []);
  assert(fs.existsSync(path.join(dest, "hand-placed", "SKILL.md")), "hand-placed skill removed on the second pass");
  assert(!fs.existsSync(path.join(dest, "shipped")), "a skill it wrote was left behind after deactivation");
});

check("ADVERSARIAL writeProposal never overwrites an existing proposal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-num-"));
  const dir = path.join(root, "evolution", "proposals");
  fs.mkdirSync(dir, { recursive: true });
  const args = (title) => ({ title, targets: ["README.md"], evidence: "e", rationale: "r", change: "c" });

  const first = writeProposal(root, args("fix the slicer")).file;
  writeProposal(root, args("other thing"));
  // The obvious reviewer action: mark one as merged.
  fs.renameSync(path.join(root, first), path.join(root, `${first}.merged`));

  const third = writeProposal(root, args("a third thing")).file;
  const numOf = (f) => /(\d{3})-/.exec(path.basename(f))?.[1];
  assert(numOf(third) === "003",
    `numbering reused ${numOf(third)} after a proposal was renamed; numbers must never be recycled`);

  // The overwrite this protects against: same title again, same slug, same
  // number. Under count-based numbering that silently replaced a live file.
  const again = writeProposal(root, args("other thing")).file;
  assert(numOf(again) === "004", `re-proposing a title reused number ${numOf(again)}`);
  const bodies = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert(bodies.length === 3, `a proposal was overwritten: found ${bodies.join(", ")}`);
  assert(new Set(bodies.map(numOf)).size === bodies.length, `duplicate numbers on disk: ${bodies.join(", ")}`);

  // A title with no usable characters must not collapse to a bare number.
  const odd = writeProposal(root, args("!!! ???")).file;
  assert(/\d{3}-[a-z]/.test(odd), `a title of punctuation produced "${odd}"`);
});

check("ADVERSARIAL friction's per-stage cap is per stage, not just per run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-cap2-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  const rec = (stage) => ({ stage, kind: "manual-edit", code: "hand-tightened-contract" });
  for (let i = 0; i < friction.MAX_PER_STAGE_RUN; i++) friction.append(dir, CFG, rec("06_triage"), { run: "r1" });
  // A different stage in the SAME run has its own budget.
  friction.append(dir, CFG, rec("03_cases"), { run: "r1" });
  let threw = false;
  try { friction.append(dir, CFG, rec("06_triage"), { run: "r1" }); } catch { threw = true; }
  assert(threw, "the cap is not being applied per stage");
});

// ----------------------------------------------- what the gate hands a worker

check("ADVERSARIAL the gate does not hand the provider key to worker-authored code", () => {
  // The gate runs code a cheap model just wrote, with shell:true, as the host
  // user. Every path check happens before that point and none of them constrain
  // what the command does once it starts — so the credential funding the run
  // should not be sitting in its environment.
  const cfg = {
    tiers: [{ name: "cheap", apiKeyEnv: "OPENROUTER_API_KEY" }, { name: "strong", apiKeyEnv: "ANTHROPIC_API_KEY" }],
    gate: { stripEnv: ["MY_DEPLOY_TOKEN"] },
  };
  const base = { OPENROUTER_API_KEY: "sk-canary", ANTHROPIC_API_KEY: "sk-canary2", MY_DEPLOY_TOKEN: "t", PATH: "/usr/bin" };
  const env = gateEnv(cfg, base);
  for (const leaked of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "MY_DEPLOY_TOKEN"]) {
    assert(!(leaked in env), `${leaked} is readable by the gate command`);
  }
  assert(env.PATH === "/usr/bin", "stripping removed more than it should — the gate still needs to run");
});

check("ADVERSARIAL the shipped config's tier keys are the ones actually stripped", () => {
  // Guards the wiring, not just the helper: a tier added to the config with a
  // new apiKeyEnv must be covered without anyone remembering to update a list.
  const cfg = JSON.parse(fs.readFileSync(path.join(kitRoot, "trellis.config.json"), "utf8"));
  const named = (cfg.tiers ?? []).map((t) => t.apiKeyEnv).filter(Boolean);
  assert(named.length > 0, "the shipped config names no apiKeyEnv; this check has stopped meaning anything");
  const env = gateEnv(cfg, Object.fromEntries(named.map((n) => [n, "secret"])));
  assert(Object.keys(env).length === 0, `these survived stripping: ${Object.keys(env).join(", ")}`);
});

check("ADVERSARIAL a node with no frozen test cannot validate", () => {
  // MISSION invariant 1: nothing merges that was not proven against an oracle
  // written before the implementation existed. A node with tests: [] was a
  // WARNING, so it validated, ran, and merged on a gate command that proved
  // whatever the project's test runner happened to say — including nothing.
  const g = {
    schema: "trellis.graph/1",
    nodes: [{ id: "n01", title: "t", role: "implementer", write: ["src/**"], tests: [], gate: "npm test", deps: [] }],
  };
  const { errors } = validateGraph(g, { boundaries: { denyWrite: [] } }, kitRoot, { requireTests: true });
  assert(errors.some((e) => /test/i.test(e) && /n01/.test(e)),
    `a node with no frozen test validated clean: errors=${JSON.stringify(errors)}`);
});

check("--plan keeps the no-test case a warning, so planning still works", () => {
  // The escape hatch has to stay: at slice time the tests do not exist yet.
  const g = {
    schema: "trellis.graph/1",
    nodes: [{ id: "n01", title: "t", role: "implementer", write: ["src/**"], tests: [], gate: "npm test", deps: [] }],
  };
  const { errors, warnings } = validateGraph(g, { boundaries: { denyWrite: [] } }, kitRoot, { requireTests: false });
  assert(!errors.some((e) => /n01/.test(e) && /test/i.test(e)), `--plan should not hard-fail: ${JSON.stringify(errors)}`);
  assert(warnings.some((w) => /test/i.test(w)), "the missing test should still be warned about");
});

// ------------------------------------------------ case folding at the boundary

check("ADVERSARIAL a deny list catches the case-variant that opens the same file", () => {
  // On Windows and macOS `.GIT/config` and `KIT/lib/gate.mjs` reach the real
  // files. The patterns meant to stop them are lowercase, and the matcher was
  // case-sensitive, so both sailed through screening AND the gate.
  const deny = [".git/**", ".env", "kit/**", "**/*.pem", ".claude/**"];
  for (const probe of [".GIT/config", ".Git/config", ".ENV", "KIT/lib/gate.mjs", "secret.PEM", ".CLAUDE/hooks/x.mjs"]) {
    assert(matchDeny(probe, deny), `${probe} was not denied — it opens the real file on this filesystem`);
  }
  // Folding a deny list must not start denying unrelated paths.
  for (const ok of ["src/app.mjs", "tests/t.mjs", "docs/git.md"]) {
    assert(!matchDeny(ok, deny), `${ok} was wrongly denied`);
  }
});

check("ADVERSARIAL a frozen test is protected under a case-variant path", () => {
  const tests = ["tests/add.test.mjs"];
  assert(matchDeny("TESTS/ADD.TEST.MJS", tests),
    "a case-variant of the frozen oracle was not recognised — the worker could edit its own test");
});

check("an allow list follows the filesystem, and does not widen scope where it should not", () => {
  // Allow and deny want opposite caution. Folding a deny list is free; folding
  // an allow list on a case-sensitive filesystem WIDENS a worker's write scope,
  // because there SRC/a.mjs really is a different file.
  assert(matchAllow("src/a.mjs", ["src/**"]), "the plain case stopped matching");
  assert(matchAllow("SRC/a.mjs", ["src/**"]) === FS_CASE_INSENSITIVE,
    `allow-list folding must track the filesystem (FS_CASE_INSENSITIVE=${FS_CASE_INSENSITIVE})`);
  assert(!matchAllow("other/a.mjs", ["src/**"]), "allow list matched something outside the scope");
});

check("ADVERSARIAL the shipped denyWrite covers the files a gate command reads", () => {
  // A worker that can write package.json can author the `npm test` its own gate
  // runs, so the gate proves whatever the worker wants it to prove. Same for
  // every other runner's config file.
  const cfg = JSON.parse(fs.readFileSync(path.join(kitRoot, "trellis.config.json"), "utf8"));
  const deny = cfg.boundaries.denyWrite;
  const runnerConfig = [
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "jest.config.js", "jest.config.mjs", "vitest.config.ts", ".mocharc.json",
    "conftest.py", "pytest.ini", "tox.ini", "pyproject.toml", "setup.cfg",
    "Makefile", "justfile", "go.mod", "Cargo.toml",
  ];
  const uncovered = runnerConfig.filter((f) => !matchDeny(f, deny));
  assert(uncovered.length === 0,
    `a worker could author the command its own gate runs via: ${uncovered.join(", ")}`);
  // Nested ones too — a monorepo package can carry its own runner config.
  for (const nested of ["packages/api/package.json", "services/x/conftest.py"]) {
    assert(matchDeny(nested, deny), `${nested} is not denied`);
  }
});

const fixDir = path.join(here, "fixtures");
if (fs.existsSync(fixDir)) {
  for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith(".json"))) {
    const spec = JSON.parse(fs.readFileSync(path.join(fixDir, f), "utf8"));
    check(`fixture ${f} expects ${spec.expect}`, () => {
      const { errors } = validateProductGraph(spec.graph);
      if (spec.expect === "valid") {
        assert(errors.length === 0, `expected valid, got: ${errors.join("; ")}`);
      } else {
        assert(errors.length > 0, "expected rejection, graph was accepted");
        if (spec.match) {
          assert(errors.some((e) => new RegExp(spec.match, "i").test(e)),
            `rejected, but not for the expected reason (${spec.match})`);
        }
      }
    });
  }
}

// -------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\nREGRESSION FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
  for (const f of failures) console.error(`  x ${f}`);
  console.error("\nIf an ADVERSARIAL check failed, a gate stopped catching something it used to.\n");
  process.exit(1);
}

console.log(`regression: ${pass} checks passed (happy + adversarial)`);
