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
import { classify, writeProposal, PROTECTED } from "../lib/evolve.mjs";
import { isRetryable } from "../lib/driver.mjs";
import { resolveActive, blockedByAudit } from "../lib/skills.mjs";

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

check("ADVERSARIAL every protected path classifies as protected", () => {
  for (const p of PROTECTED) {
    const probe = p.endsWith("/") ? `${p}anything.mjs` : p;
    assert(classify(probe) === "protected", `${probe} was not protected`);
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
  assert(classify("some/new/thing.mjs") === "unclassified", "unclassified path changed meaning");
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
  for (const stage of ["01_ingest", "02_slice", "03_cases", "04_tests", "06_triage"]) {
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
