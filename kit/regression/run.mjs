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
import { classify, writeProposal, PROTECTED, actionable, unknownCodes } from "../lib/evolve.mjs";
import { isRetryable, STAGES } from "../lib/driver.mjs";
import { resolveActive, blockedByAudit, neverActivated } from "../lib/skills.mjs";
import { loadCodes, normaliseCode, allCodes, groupSimilar, CODES_DOC } from "../lib/codes.mjs";
import { KINDS, FLAG_TO_KIND, COSTLY_KINDS } from "../lib/kinds.mjs";
import { kindActionable, kindCounts } from "../lib/evolve.mjs";
import os from "node:os";

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

/** A root with state.json, triage.json, and whatever triage.jsonl you pass. */
function triageStageRoot({ runId = "run-1", decisions = [{ node: "n01", verdict: "accept" }], jsonl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-triage-"));
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  const w = (f, o) => fs.writeFileSync(path.join(dir, ".trellis", f), JSON.stringify(o));
  if (runId !== null) w("state.json", { runId });
  w("triage.json", { decisions });
  if (jsonl !== undefined) {
    fs.writeFileSync(
      path.join(dir, ".trellis", "triage.jsonl"),
      jsonl.map((r) => JSON.stringify(r)).join("\n") + (jsonl.length ? "\n" : "")
    );
  }
  return dir;
}

check("triage passes when it leaves a jsonl record for this run", () => {
  const root = triageStageRoot({ jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }] });
  const r = triageVerify(root);
  assert(r.ok, `expected pass, got: ${r.detail}`);
});

check("ADVERSARIAL triage.json alone does not satisfy the stage", () => {
  const root = triageStageRoot({});
  const r = triageVerify(root);
  assert(!r.ok, "a stage that wrote no cross-run evidence was accepted");
  assert(/triage\.jsonl/.test(r.detail), `detail should name the missing file, got: ${r.detail}`);
});

check("ADVERSARIAL an empty triage.jsonl does not satisfy the stage", () => {
  const root = triageStageRoot({ jsonl: [] });
  assert(!triageVerify(root).ok, "an empty evidence file was accepted as evidence");
});

check("ADVERSARIAL a triage record from a different run does not satisfy this one", () => {
  const root = triageStageRoot({ runId: "run-2", jsonl: [{ run: "run-1", decisions: [reject("design-slop")] }] });
  const r = triageVerify(root);
  assert(!r.ok, "last run's evidence was accepted as this run's");
  assert(/run-2/.test(r.detail), `detail should name the run it wanted, got: ${r.detail}`);
});

check("ADVERSARIAL an unstamped triage record does not satisfy the stage", () => {
  const root = triageStageRoot({ jsonl: [{ decisions: [reject("design-slop")] }] });
  assert(!triageVerify(root).ok,
    "a line with no run id was accepted — it can never be counted, so it is not evidence");
});

check("ADVERSARIAL a run-stamped record carrying no decisions does not satisfy the stage", () => {
  const root = triageStageRoot({ jsonl: [{ run: "run-1", decisions: [] }] });
  assert(!triageVerify(root).ok, "an empty decision list was accepted as a triage record");
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

check("ADVERSARIAL test-failure and pass are never treated as costly", () => {
  for (const k of ["test-failure", "pass", "env-failure"]) {
    assert(!COSTLY_KINDS.has(k),
      `${k} in COSTLY_KINDS would drown every other signal in the loop working correctly`);
  }
});

/** Ledger records, shaped like ledger.recordsFor output. */
const ledgerRec = (over = {}) => ({
  runId: "r1",
  nodeId: "n01",
  tags: ["api"],
  status: "merged",
  landedTier: "cheap",
  survivingMutations: [],
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
