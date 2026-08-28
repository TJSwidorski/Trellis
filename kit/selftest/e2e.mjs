import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawnSync, spawn } from "node:child_process";
import { startMockServer } from "./mock-server.mjs";
import { loadConfig } from "../lib/config.mjs";
import { loadGraph, validateGraph } from "../lib/graph.mjs";
import { run } from "../lib/runner.mjs";
import { verifyTests } from "../lib/verify.mjs";
import { normalizeNode } from "../lib/graph.mjs";
import { scopeBullets } from "../lib/spec.mjs";
import * as ledger from "../lib/ledger.mjs";
import * as st from "../lib/state.mjs";
import * as log from "../lib/log.mjs";

import { fileURLToPath } from "node:url";
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/cli.mjs");

const results = [];
function check(name, fn) {
  try { fn(); results.push(["pass", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}

const g = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-e2e-"));
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "Trellis Test");
  g(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const FILE = (p, body) => `### FILE: ${p}\n\`\`\`js\n${body}\n\`\`\`\n`;

async function main() {
  const root = makeRepo();

  // ---- fixture project: node-native tests, no dependencies ----
  write(root, "tests/add.test.mjs", `
import assert from "node:assert";
import { add } from "../src/add.mjs";
assert.strictEqual(add(2, 3), 5);
assert.strictEqual(add(-1, 1), 0);
console.log("add ok");
`.trim());

  write(root, "tests/mul.test.mjs", `
import assert from "node:assert";
import { mul } from "../src/mul.mjs";
assert.strictEqual(mul(3, 4), 12);
console.log("mul ok");
`.trim());

  write(root, "tests/combo.test.mjs", `
import assert from "node:assert";
import { combo } from "../src/combo.mjs";
assert.strictEqual(combo(2, 3), 11);
console.log("combo ok");
`.trim());

  write(root, "tests/risky.test.mjs", `
import assert from "node:assert";
import { risky } from "../src/risky.mjs";
assert.strictEqual(risky(), "ok");
console.log("risky ok");
`.trim());

  write(root, "tests/auditable.test.mjs", `
import assert from "node:assert";
import { auditable } from "../src/auditable.mjs";
assert.strictEqual(auditable(), "ok");
console.log("auditable ok");
`.trim());

  write(root, "tests/after.test.mjs", `
import assert from "node:assert";
import { after } from "../src/after.mjs";
import { auditable } from "../src/auditable.mjs";
assert.strictEqual(after(), "ok-after");
assert.strictEqual(auditable(), "ok");
console.log("after ok");
`.trim());

  // clamp(11) is NOT asserted, so an exclusive upper bound goes undetected —
  // a deliberately weak test, so the mutation gate has something to catch.
  write(root, "tests/weak.test.mjs", `
import assert from "node:assert";
import { clamp } from "../src/weak.mjs";
assert.strictEqual(clamp(5), 5);
assert.strictEqual(clamp(-1), 0);
console.log("weak ok");
`.trim());

  write(root, ".gitignore", [".trellis/state.json", ".trellis/run.jsonl",
    ".trellis/ledger.jsonl", ".trellis/REPORT.md", ".worktrees/", "trellis.code-workspace"].join("\n") + "\n");

  write(root, "SPEC.md", [
    "# fixture",
    "",
    "## Scope for this run",
    "",
    "- [ ] Addition",
    "- [ ] Multiplication",
    "",
    "## Explicitly not in scope",
    "",
    "- [ ] Division",
  ].join("\n"));

  write(root, "tests/impossible.test.mjs", `
import assert from "node:assert";
import { impossible } from "../src/impossible.mjs";
assert.strictEqual(impossible(), "never");
console.log("impossible ok");
`.trim());

  // downstream is never attempted — it is blocked by impossible — but it still
  // declares a frozen test. This fixture used to carry `tests: []` and a gate of
  // `node -e "process.exit(0)"`, which is the exact anti-pattern MISSION
  // invariant 1 exists to forbid: a node that merges on a command proving
  // nothing. Validation now rejects it, and the fixture was the first thing the
  // new rule caught.
  write(root, "tests/downstream.test.mjs", `
import assert from "node:assert";
import { downstream } from "../src/downstream.mjs";
assert.strictEqual(downstream(), "ok-downstream");
console.log("downstream ok");
`.trim());

  const graph = {
    version: 1,
    project: "e2e",
    nodes: [
      { id: "add", title: "add", goal: "export add(a,b)", tags: ["algorithm"], covers: ["Addition"], write: ["src/add.mjs"], tests: ["tests/add.test.mjs"], gate: "node tests/add.test.mjs" },
      { id: "mul", title: "mul", goal: "export mul(a,b)", tags: ["algorithm"], covers: ["Multiplication"], write: ["src/mul.mjs"], tests: ["tests/mul.test.mjs"], gate: "node tests/mul.test.mjs" },
      { id: "combo", title: "combo", goal: "export combo using add and mul", deps: ["add", "mul"], write: ["src/combo.mjs"], read: ["src/add.mjs"], tests: ["tests/combo.test.mjs"], gate: "node tests/combo.test.mjs" },
      { id: "risky", title: "risky", goal: "export risky()", risk: "high", write: ["src/risky.mjs"], tests: ["tests/risky.test.mjs"], gate: "node tests/risky.test.mjs" },
      { id: "impossible", title: "impossible", goal: "export impossible()", write: ["src/impossible.mjs"], tests: ["tests/impossible.test.mjs"], gate: "node tests/impossible.test.mjs" },
      { id: "downstream", title: "downstream", goal: "depends on impossible", deps: ["impossible"], write: ["src/downstream.mjs"], tests: ["tests/downstream.test.mjs"], gate: "node tests/downstream.test.mjs" },
      { id: "auditable", title: "auditable", goal: "export auditable()", risk: "audit", tags: ["glue"], write: ["src/auditable.mjs"], tests: ["tests/auditable.test.mjs"], gate: "node tests/auditable.test.mjs" },
      { id: "afterAudit", title: "afterAudit", goal: "depends on an audit node", deps: ["auditable"], tags: ["glue"], write: ["src/after.mjs"], tests: ["tests/after.test.mjs"], gate: "node tests/after.test.mjs" },
      { id: "weak", title: "weak", goal: "export clamp(n)", tags: ["algorithm"], write: ["src/weak.mjs"], tests: ["tests/weak.test.mjs"], gate: "node tests/weak.test.mjs",
        mutations: ["the upper bound is exclusive instead of inclusive"] },
    ],
  };
  write(root, ".trellis/graph.json", JSON.stringify(graph, null, 2));

  const mock = await startMockServer({
    models: ["mock/cheap", "mock/mid", "mock/strong"],
    responses: {
      // attempt 1 tampers with the frozen test; attempt 2 writes out of scope; attempt 3 is correct
      add: [
        { content: FILE("tests/add.test.mjs", "// deleted the hard assertion") + FILE("src/add.mjs", "export const add=(a,b)=>0;") },
        { content: FILE("src/secret.mjs", "export const x=1;") + FILE("src/add.mjs", "export const add=(a,b)=>a-b;") },
        { content: FILE("src/add.mjs", "export const add=(a,b)=>a+b;") },
      ],
      mul: [{ content: FILE("src/mul.mjs", "export const mul=(a,b)=>a*b;") }],
      // fails through the whole cheap tier, lands on mid — proves escalation
      combo: [
        { content: FILE("src/combo.mjs", "export const combo=(a,b)=>0;") },
        { content: FILE("src/combo.mjs", "export const combo=(a,b)=>1;") },
        { content: FILE("src/combo.mjs", "export const combo=(a,b)=>2;") },
        { content: FILE("src/combo.mjs", "import {add} from './add.mjs';import {mul} from './mul.mjs';export const combo=(a,b)=>add(a,b)+mul(a,b);") },
      ],
      risky: [{ content: FILE("src/risky.mjs", "export const risky=()=>'ok';") }],
      // never passes -> EXHAUSTED across all tiers, and blocks `downstream`
      impossible: [{ content: FILE("src/impossible.mjs", "export const impossible=()=>'wrong';") }],
      downstream: [{ content: FILE("src/downstream.mjs", "export const d=1;") }],
      auditable: [{ content: FILE("src/auditable.mjs", "export const auditable=()=>'ok';") }],
      afterAudit: [{ content: FILE("src/after.mjs", "export const after=()=>'ok-after';") }],
      weak: [{ content: FILE("src/weak.mjs", "export const clamp=(n)=>n<0?0:(n>10?10:n);") }],
    },
    // The mutated clamp uses an exclusive upper bound. The weak test never asserts
    // clamp(11), so it cannot tell the difference — the mutant must SURVIVE.
    mutants: {
      "upper bound is exclusive": FILE("src/weak.mjs", "export const clamp=(n)=>n<0?0:(n>=10?9:n);"),
    },
  });

  write(root, "trellis.config.json", JSON.stringify({
    project: "e2e",
    baseBranch: "main",
    concurrency: 2,
    tiers: [
      { name: "cheap", baseUrl: mock.url, model: "mock/cheap", maxAttempts: 3 },
      { name: "mid", baseUrl: mock.url, model: "mock/mid", maxAttempts: 1 },
    ],
    gate: { timeoutMs: 30000, feedbackChars: 2000 },
    routing: { enabled: false },
    verify: { mutationsOnPass: true, onSurvivor: "warn" },
    budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));

  g(root, "add", "-A");
  g(root, "commit", "-qm", "fixture");

  const cfg = loadConfig(root);
  const gr = loadGraph(root, cfg.paths.graph);

  const v = validateGraph(gr, cfg, root);
  check("graph validates clean", () => assert.deepStrictEqual(v.errors, []));

  const state = st.initState(root, cfg, gr);
  const { reportPath } = await run(cfg, gr, state, {});
  await mock.close();

  const S = (id) => state.nodes[id].status;

  // Regression: concurrency 0 used to make the launch loop a no-op while the ready
  // set stayed non-empty — an infinite spin with no output. Must throw instead.
  let concErr = null;
  try {
    await run({ ...cfg, concurrency: 0 }, gr, st.initState(root, cfg, gr), {});
  } catch (e) { concErr = e.message; }
  check("concurrency 0 is refused, not spun on", () =>
    assert.ok(concErr && /concurrency/.test(concErr), `expected a concurrency error, got ${concErr}`));

  check("independent nodes merge", () => {
    assert.strictEqual(S("add"), "merged");
    assert.strictEqual(S("mul"), "merged");
  });

  check("test tampering is rejected and reverted", () => {
    const a = state.nodes.add.attempts[0];
    assert.strictEqual(a.kind, "test-tampering");
    assert.strictEqual(a.gateKind, "test-failure", "gate still ran on the surviving files");
    const onDisk = fs.readFileSync(path.join(root, "tests/add.test.mjs"), "utf8");
    assert.ok(onDisk.includes("assert.strictEqual(add(2, 3), 5)"), "frozen test survived");
  });

  check("out-of-scope writes are rejected", () => {
    const a = state.nodes.add.attempts[1];
    assert.strictEqual(a.kind, "out-of-scope");
    assert.ok(!fs.existsSync(path.join(root, "src/secret.mjs")), "secret.mjs never landed");
  });

  check("dependent node ran only after deps merged", () => {
    assert.strictEqual(S("combo"), "merged");
    assert.ok(fs.existsSync(path.join(root, "src/combo.mjs")));
  });

  check("escalation to the next tier happens", () => {
    assert.strictEqual(state.nodes.combo.tier, "mid");
    assert.ok(state.nodes.combo.attempts.some((a) => a.tier === "cheap" && !a.ok));
  });

  check("high-risk node passes but is held, not merged", () => {
    assert.strictEqual(S("risky"), "review");
    assert.ok(!fs.existsSync(path.join(root, "src/risky.mjs")), "not merged into main");
    assert.ok(g(root, "rev-parse", "--verify", "trellis/risky").status === 0, "branch kept");
  });

  check("unfixable node exhausts across all tiers", () => {
    assert.strictEqual(S("impossible"), "exhausted");
    const tiers = new Set(state.nodes.impossible.attempts.map((a) => a.tier));
    assert.deepStrictEqual([...tiers].sort(), ["cheap", "mid"]);
    assert.strictEqual(state.nodes.impossible.attempts.length, 4);
  });

  check("downstream of an exhausted node is blocked, not attempted", () => {
    assert.strictEqual(S("downstream"), "blocked");
    assert.strictEqual(state.nodes.downstream.attempts.length, 0);
  });

  check("exhausted worktree is kept for inspection", () => {
    assert.ok(fs.existsSync(path.join(root, ".worktrees", "impossible")));
  });

  check("REPORT.md renders every section including EXHAUSTED", () => {
    const r = fs.readFileSync(reportPath, "utf8");
    assert.ok(r.includes("Needs orchestrator decision"), "exhausted section");
    assert.ok(r.includes("`impossible`"), "names the exhausted node");
    assert.ok(r.includes("Passed, held for review"), "review section");
    assert.ok(r.includes("Blocked (never attempted)"), "blocked section");
    assert.ok(r.includes("Decomposition signal"), "escalation signal");
    assert.ok(/\| cheap \| \d+ \|/.test(r), "cost table");

    // The exhausted node's block must carry what the gate actually said. This
    // is the end-to-end half: the regression fixture supplies `feedback`
    // directly, so only a real run proves the worker stores it. Without it the
    // fenced block printed the word "test-failure" and triage had to open the
    // kept worktree and re-run the gate by hand to learn anything.
    const block = r.slice(r.indexOf("### `impossible`"));
    assert.ok(/Last gate output \(/.test(block), "no gate output recorded for the exhausted node");
    const fenced = /```\n([\s\S]*?)```/.exec(block)?.[1] ?? "";
    assert.ok(fenced.trim() && fenced.trim() !== "test-failure",
      `the fenced block is still just the failure kind: ${JSON.stringify(fenced.slice(0, 80))}`);
  });

  check("workspace file lists only kept worktrees", () => {
    const ws = JSON.parse(fs.readFileSync(path.join(root, "trellis.code-workspace"), "utf8"));
    const names = ws.folders.filter((f) => f.trellis).map((f) => path.basename(f.path));
    assert.deepStrictEqual(names.sort(), ["impossible", "risky"]);
  });

  check("base branch is green after the run", () => {
    const r = spawnSync("node", ["tests/add.test.mjs"], { cwd: root, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    const r2 = spawnSync("node", ["tests/combo.test.mjs"], { cwd: root, encoding: "utf8" });
    assert.strictEqual(r2.status, 0, r2.stderr);
  });

  check("audit-risk node merges instead of stalling its dependants", () => {
    assert.strictEqual(S("auditable"), "audit");
    assert.ok(fs.existsSync(path.join(root, "src/auditable.mjs")), "merged into main");
    assert.strictEqual(S("afterAudit"), "merged", "dependant ran, unlike under risk:high");
  });

  check("a surviving mutant flags weak tests but still merges under onSurvivor=warn", () => {
    assert.strictEqual(S("weak"), "weak-tests");
    assert.strictEqual(state.nodes.weak.survivingMutations.length, 1);
    assert.ok(/exclusive/.test(state.nodes.weak.survivingMutations[0].mutation));
    assert.ok(fs.existsSync(path.join(root, "src/weak.mjs")), "merged despite weak tests");
  });

  check("REPORT.md calls out the weak tests and the audit node", () => {
    const r = fs.readFileSync(reportPath, "utf8");
    assert.ok(r.includes("Weak tests"), "weak section");
    assert.ok(r.includes("Merged, flagged for audit"), "audit section");
  });

  check("ledger records every node with per-tier detail", () => {
    const recs = ledger.read(root, cfg);
    assert.strictEqual(recs.length, Object.keys(state.nodes).length);
    const combo = recs.find((r) => r.nodeId === "combo");
    assert.strictEqual(combo.landedTier, "mid");
    assert.strictEqual(combo.attemptsByTier.cheap.landed, false);
    assert.strictEqual(combo.attemptsByTier.cheap.attempts, 3);
    assert.strictEqual(combo.attemptsByTier.mid.landed, true);
    const imp = recs.find((r) => r.nodeId === "impossible");
    assert.strictEqual(imp.landedTier, null);
    assert.deepStrictEqual(recs.find((r) => r.nodeId === "add").tags, ["algorithm"]);
  });

  check("spec coverage: an unclaimed scope bullet fails validation", () => {
    const g2 = JSON.parse(JSON.stringify(gr));
    g2.nodes.find((n) => n.id === "mul").covers = [];
    const v2 = validateGraph(g2, cfg, root);
    assert.ok(v2.errors.some((e) => /scope item/.test(e) && /Multiplication/.test(e)),
      `expected an uncovered-scope error, got: ${v2.errors.join(" | ")}`);
  });

  check("a foundational node tagged risk:high still stalls (why audit exists)", () => {
    assert.strictEqual(S("risky"), "review");
    assert.ok(!fs.existsSync(path.join(root, "src/risky.mjs")));
  });

  // ---- accept closes the review loop ----
  const g2 = (...a) => g(root, ...a);
  g2("checkout", "-q", "main");
  const beforeAccept = state.nodes.risky.status;
  const accept = spawnSync("node", [CLI, "accept", "risky", "--merge"],
    { cwd: root, encoding: "utf8" });
  const afterState = st.loadState(root, cfg);
  check("accept merges a held node and unblocks its dependants", () => {
    assert.strictEqual(beforeAccept, "review");
    assert.strictEqual(accept.status, 0, accept.stdout + accept.stderr);
    assert.strictEqual(afterState.nodes.risky.status, "merged");
    assert.ok(fs.existsSync(path.join(root, "src/risky.mjs")), "branch merged into main");
  });
  check("accept refuses a node that was never held", () => {
    const bad = spawnSync("node", [CLI, "accept", "add"],
      { cwd: root, encoding: "utf8" });
    assert.notStrictEqual(bad.status, 0);
    assert.ok(/not awaiting review/.test(bad.stdout + bad.stderr));
  });
  g2("add", "-A"); g2("commit", "-qm", "post-accept");
  Object.assign(state.nodes, afterState.nodes);

  // ---- budget ceiling: a fresh run with a hard attempt cap ----
  const bState = st.initState(root, cfg, gr);
  const bCfg = { ...cfg, budget: { ...cfg.budget, maxTotalAttempts: 2 }, concurrency: 1 };
  g(root, "checkout", "-q", "main");
  const bRun = await run(bCfg, gr, bState, {});
  check("budget ceiling stops launching and leaves the rest resumable", () => {
    assert.ok(bRun.budget.breach, "a breach was recorded");
    assert.ok(/attempt ceiling/.test(bRun.budget.breach), bRun.budget.breach);
    const stopped = Object.values(bState.nodes).filter((n) => n.status === "budget-stopped");
    assert.ok(stopped.length > 0, "untried nodes marked budget-stopped, not failed");
    assert.ok(bState.nodes.add.attempts.length <= 3, "stopped early rather than running everything");
  });
  check("budget report says the run was cut short", () => {
    const r = fs.readFileSync(bRun.reportPath, "utf8");
    assert.ok(r.includes("run cut short"), "header states it");
    assert.ok(r.includes("Never attempted — budget stop"), "section present");
  });

  // ---- verify-tests: catches a vacuous test ----
  const vRoot = makeRepo();
  write(vRoot, "tests/real.test.mjs", `
import assert from "node:assert";
import { half } from "../src/real.mjs";
assert.strictEqual(half(10), 5);
`.trim());
  write(vRoot, "tests/vacuous.test.mjs", `
import { anything } from "../src/vacuous.mjs";
// asserts nothing whatsoever
`.trim());
  write(vRoot, "trellis.config.json", JSON.stringify({
    project: "v", baseBranch: "main", tiers: [{ name: "cheap", baseUrl: "http://x/v1", model: "m" }],
    gate: { timeoutMs: 20000 },
  }, null, 2));
  g(vRoot, "add", "-A"); g(vRoot, "commit", "-qm", "f");
  const vCfg = loadConfig(vRoot);
  const vNodes = new Map([
    ["real", normalizeNode({ id: "real", title: "real", goal: "g", write: ["src/real.mjs"], tests: ["tests/real.test.mjs"], gate: "node tests/real.test.mjs" }, vCfg)],
    ["vac", normalizeNode({ id: "vac", title: "vac", goal: "g", write: ["src/vacuous.mjs"], tests: ["tests/vacuous.test.mjs"], gate: "node tests/vacuous.test.mjs" }, vCfg)],
  ]);
  const vres = await verifyTests(vCfg, { nodes: [] }, vNodes, vRoot);
  check("verify-tests flags the vacuous test and clears the real one", () => {
    const vac = vres.findings.filter((f) => f.kind === "vacuous").map((f) => f.nodeId);
    assert.deepStrictEqual(vac, ["vac"], `findings: ${JSON.stringify(vres.findings)}`);
    assert.strictEqual(vres.ok, false);
  });

  // verify-tests decides a test is strong because its gate exits non-zero. A
  // missing dependency exits non-zero too, so a broken environment used to make
  // every test look strong — the worst possible moment to be wrong, since this is
  // the check that authorises spending money on a run.
  write(vRoot, "tests/envbroken.test.mjs", `
import { half } from "../src/envbroken.mjs";
import "a-package-that-is-definitely-not-installed";
`.trim());
  const vNodes2 = new Map([
    ["envbroken", normalizeNode({ id: "envbroken", title: "envbroken", goal: "g",
      write: ["src/envbroken.mjs"], tests: ["tests/envbroken.test.mjs"],
      gate: "node tests/envbroken.test.mjs" }, vCfg)],
  ]);
  const vres2 = await verifyTests(vCfg, { nodes: [] }, vNodes2, vRoot);
  check("ADVERSARIAL verify-tests will not call a test strong when the env is broken", () => {
    const kinds = vres2.findings.map((f) => f.kind);
    assert.ok(kinds.includes("env-failure"),
      `expected an env-failure finding, got: ${JSON.stringify(vres2.findings)}`);
    assert.strictEqual(vres2.ok, false, "a broken environment must not report ok");
  });

  // A node whose declared tests never import anything from its own write scope
  // used to skip stubbing silently, then run the gate against a repo where the
  // implementation simply does not exist — a module-not-found error exits
  // non-zero exactly like a real assertion, and that used to be reported as
  // "non-vacuous". There IS a concrete path here (unlike `unstubbable`, which
  // fires when the write scope is a glob); the tests just never reference it.
  write(vRoot, "tests/orphan.test.mjs", `
import assert from "node:assert";
import { somethingElseEntirely } from "../src/unrelated.mjs";
assert.ok(somethingElseEntirely);
`.trim());
  write(vRoot, "src/orphan.mjs", "export const orphan = () => 1;\n");
  write(vRoot, "src/unrelated.mjs", "export const somethingElseEntirely = () => 1;\n");
  const vNodes3 = new Map([
    ["orphan", normalizeNode({ id: "orphan", title: "orphan", goal: "g",
      write: ["src/orphan.mjs"], tests: ["tests/orphan.test.mjs"],
      gate: "node tests/orphan.test.mjs" }, vCfg)],
  ]);
  const vres3 = await verifyTests(vCfg, { nodes: [] }, vNodes3, vRoot);
  check("ADVERSARIAL a node whose tests import nothing from its write scope is a hard failure, not a pass", () => {
    const orphanFindings = vres3.findings.filter((f) => f.nodeId === "orphan");
    assert.ok(orphanFindings.some((f) => f.kind === "unstubbed"),
      `expected an unstubbed finding, got: ${JSON.stringify(orphanFindings)}`);
    assert.strictEqual(vres3.ok, false, "a node nothing was stubbed for must not report ok");
  });

  fs.rmSync(vRoot, { recursive: true, force: true });

  // ---- environment failure does not escalate tiers ----
  //
  // A missing dependency exits non-zero exactly like a failing assertion, so the
  // runner used to retry it, escalate cheap → mid, and record EXHAUSTED: real
  // money spent reproducing an error no model can fix. The gate must recognise it
  // and the run must stop. The import below is genuinely unresolvable — this is a
  // real ERR_MODULE_NOT_FOUND, not a simulated error string.
  const eRoot = makeRepo();
  write(eRoot, "tests/envfail.test.mjs", `
import { thing } from "a-package-that-is-definitely-not-installed";
console.log(thing);
`.trim());
  write(eRoot, ".trellis/graph.json", JSON.stringify({
    version: 1,
    project: "envfail",
    nodes: [
      { id: "envfail", title: "envfail", goal: "export thing", write: ["src/thing.mjs"],
        tests: ["tests/envfail.test.mjs"], gate: "node tests/envfail.test.mjs" },
    ],
  }, null, 2));
  const eMock = await startMockServer({
    models: ["mock/cheap", "mock/mid"],
    responses: { envfail: [{ content: FILE("src/thing.mjs", "export const thing=1;") }] },
  });
  write(eRoot, "trellis.config.json", JSON.stringify({
    project: "envfail",
    baseBranch: "main",
    concurrency: 1,
    // Two tiers, three attempts each: six chances to burn money on an ImportError.
    tiers: [
      { name: "cheap", baseUrl: eMock.url, model: "mock/cheap", maxAttempts: 3 },
      { name: "mid", baseUrl: eMock.url, model: "mock/mid", maxAttempts: 3 },
    ],
    gate: { timeoutMs: 30000 },
    routing: { enabled: false },
    verify: { mutationsOnPass: false },
    budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(eRoot, "add", "-A"); g(eRoot, "commit", "-qm", "fixture");

  const eCfg = loadConfig(eRoot);
  const eGraph = loadGraph(eRoot, eCfg.paths.graph);
  const eState = st.initState(eRoot, eCfg, eGraph);
  await run(eCfg, eGraph, eState, {});
  await eMock.close();

  check("ADVERSARIAL an env failure does not escalate tiers", () => {
    const attempts = eState.nodes.envfail.attempts ?? [];
    assert.strictEqual(attempts.length, 1,
      `expected to stop after 1 attempt, made ${attempts.length}: ${JSON.stringify(attempts.map((a) => `${a.tier}#${a.attempt}:${a.kind}`))}`);
    assert.strictEqual(attempts[0].kind, "env-failure", `kind was ${attempts[0].kind}`);
  });
  check("ADVERSARIAL an env failure leaves the node resumable, not exhausted", () => {
    assert.strictEqual(eState.nodes.envfail.status, st.STATUS.PENDING,
      `status was ${eState.nodes.envfail.status} — exhausted would blame the model for a missing package`);
  });
  check("an env failure is recorded on the run with an actionable hint", () => {
    assert.ok(eState.envHalt, "state.envHalt should say the run stopped for the environment");
    assert.match(eState.envHalt.hint, /a-package-that-is-definitely-not-installed/);
  });
  fs.rmSync(eRoot, { recursive: true, force: true });

  // ---- ADVERSARIAL: an env halt must not leave OTHER nodes silently PENDING ----
  //
  // The single-node fixture above proves the failing node itself stays
  // resumable. It says nothing about a graph where other, independent nodes
  // were simply never launched — those used to stay PENDING forever, which
  // rollup() counts as neither done nor stuck, finishedAt was still stamped,
  // and `trellis run` exited 0 having built nothing. This is the actual
  // failure scenario: a real multi-node graph where the halt is invisible.
  const emRoot = makeRepo();
  write(emRoot, "tests/envfail.test.mjs", `
import { thing } from "a-package-that-is-definitely-not-installed";
console.log(thing);
`.trim());
  write(emRoot, ".trellis/graph.json", JSON.stringify({
    version: 1,
    project: "envhalt-multi",
    nodes: [
      { id: "envfail", title: "envfail", goal: "export thing", write: ["src/thing.mjs"],
        tests: ["tests/envfail.test.mjs"], gate: "node tests/envfail.test.mjs" },
      // No dependency relationship to envfail at all — independently ready
      // from the first tick, and never given a chance to launch.
      { id: "untouched", title: "untouched", goal: "export other", write: ["src/other.mjs"],
        tests: ["tests/other.test.mjs"], gate: "node tests/other.test.mjs" },
    ],
  }, null, 2));
  write(emRoot, "tests/other.test.mjs", `
import { other } from "../src/other.mjs";
if (other !== 1) throw new Error("nope");
`.trim());
  const emMock = await startMockServer({
    models: ["mock/cheap"],
    responses: { envfail: [{ content: FILE("src/thing.mjs", "export const thing=1;") }] },
  });
  write(emRoot, "trellis.config.json", JSON.stringify({
    project: "envhalt-multi",
    baseBranch: "main",
    concurrency: 1,
    tiers: [{ name: "cheap", baseUrl: emMock.url, model: "mock/cheap", maxAttempts: 1 }],
    gate: { timeoutMs: 30000 },
    routing: { enabled: false },
    verify: { mutationsOnPass: false },
    budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(emRoot, "add", "-A"); g(emRoot, "commit", "-qm", "fixture");

  const emCfg = loadConfig(emRoot);
  const emGraph = loadGraph(emRoot, emCfg.paths.graph);
  const emState = st.initState(emRoot, emCfg, emGraph);
  await run(emCfg, emGraph, emState, {});
  await emMock.close();

  check("ADVERSARIAL an env halt marks every other untried node, not just the one that failed", () => {
    assert.strictEqual(emState.nodes.envfail.status, st.STATUS.PENDING,
      "the node that actually failed stays PENDING so --resume retries it in place");
    assert.strictEqual(emState.nodes.untouched.status, st.STATUS.BUDGET,
      `expected the never-launched node to be marked ${st.STATUS.BUDGET}, was ${emState.nodes.untouched.status}`);
  });
  check("ADVERSARIAL an env-halted run does not report success", () => {
    const { stuck } = st.rollup(emState);
    assert.ok(stuck > 0, "rollup must count the halted run as stuck, not silently finished");
  });
  check("ADVERSARIAL the report explains an env halt, not a budget ceiling", () => {
    const reportPath = path.join(emRoot, ".trellis", "REPORT.md");
    const r = fs.readFileSync(reportPath, "utf8");
    assert.ok(r.includes("environment"), "report should name the environment as the cause");
    assert.ok(!/raising the ceiling/.test(r), "must not tell the operator to raise a budget ceiling for an env halt");
  });
  fs.rmSync(emRoot, { recursive: true, force: true });

  // ---- ADVERSARIAL: --only naming a node without its dependency must not report success ----
  //
  // `run --only b` where b depends on a, and a is not also named: a is
  // excluded from readySet() by the --only filter, b is excluded because a
  // never lands. markBlocked() only recognises a DOOMED dependency
  // (exhausted/blocked/conflict/review); a merely unattempted one is neither
  // doomed nor ready, so this used to deadlock with zero attempts and zero
  // status changes -- rollup() counted both nodes as neither done nor
  // stuck, and the run reported "0/2 landed" with exit code 0.
  const onlyRoot = makeRepo();
  write(onlyRoot, ".trellis/graph.json", JSON.stringify({
    version: 1,
    project: "only-deadlock",
    nodes: [
      { id: "a", title: "a", goal: "g", write: ["src/a.mjs"], tests: [], gate: "true" },
      { id: "b", title: "b", goal: "g", write: ["src/b.mjs"], tests: [], gate: "true", deps: ["a"] },
    ],
  }, null, 2));
  write(onlyRoot, "trellis.config.json", JSON.stringify({
    project: "only-deadlock", baseBranch: "main", concurrency: 1,
    tiers: [{ name: "cheap", baseUrl: "http://127.0.0.1:1", model: "m", apiKeyEnv: null, maxAttempts: 1, maxTokens: 100 }],
    routing: { enabled: false },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(onlyRoot, "add", "-A"); g(onlyRoot, "commit", "-qm", "fixture");

  const onlyCfg = loadConfig(onlyRoot);
  const onlyGraph = loadGraph(onlyRoot, onlyCfg.paths.graph);
  const onlyState = st.initState(onlyRoot, onlyCfg, onlyGraph);
  await run(onlyCfg, onlyGraph, onlyState, { only: ["b"] });

  check("ADVERSARIAL --only naming a node without its dependency marks both unreachable, not silently pending", () => {
    assert.strictEqual(onlyState.nodes.a.status, "blocked",
      `expected "a" (excluded by --only) marked unreachable, got ${onlyState.nodes.a.status}`);
    assert.strictEqual(onlyState.nodes.b.status, "blocked",
      `expected "b" (dep never lands) marked unreachable, got ${onlyState.nodes.b.status}`);
    assert.match(onlyState.nodes.b.reason, /unreachable/);
  });
  check("ADVERSARIAL a deadlocked --only run does not report success", () => {
    const { stuck, done } = st.rollup(onlyState);
    assert.strictEqual(done, 0, "nothing was actually built");
    assert.ok(stuck > 0, "rollup must count the deadlock as stuck, not silently finished");
  });
  fs.rmSync(onlyRoot, { recursive: true, force: true });

  // ---- ADVERSARIAL: verify.onSurvivor="hold" logs exactly like the high-risk hold ----
  //
  // Structurally the same disposition as the risk:"high" branch immediately
  // above it in runner.mjs (STATUS.REVIEW, held unmerged) -- but it used to
  // emit neither a console line nor a run.jsonl event, so a held-on-survivor
  // node vanished from both, distinguishable from the high-risk case only by
  // reading state.json's `reason` field by hand.
  const holdRoot = makeRepo();
  write(holdRoot, "tests/weak.test.mjs", "import { clamp } from '../src/weak.mjs';\nif (clamp(5) !== 5) throw new Error('nope');\n");
  write(holdRoot, ".trellis/graph.json", JSON.stringify({
    version: 1, project: "hold",
    nodes: [{ id: "weak", title: "weak", goal: "export clamp(n)", write: ["src/weak.mjs"],
      tests: ["tests/weak.test.mjs"], gate: "node tests/weak.test.mjs",
      mutations: ["the upper bound is exclusive instead of inclusive"] }],
  }, null, 2));
  const holdMock = await startMockServer({
    models: ["mock/cheap"],
    responses: { weak: [{ content: FILE("src/weak.mjs", "export const clamp=(n)=>n<0?0:(n>10?10:n);") }] },
    // The test never asserts clamp(11), so it cannot tell an inclusive bound
    // from an exclusive one -- the mutant must SURVIVE.
    mutants: { "upper bound is exclusive": FILE("src/weak.mjs", "export const clamp=(n)=>n<0?0:(n>=10?9:n);") },
  });
  write(holdRoot, "trellis.config.json", JSON.stringify({
    project: "hold", baseBranch: "main", concurrency: 1,
    tiers: [{ name: "cheap", baseUrl: holdMock.url, model: "mock/cheap", maxAttempts: 1 }],
    gate: { timeoutMs: 20000 },
    routing: { enabled: false },
    verify: { mutationsOnPass: true, onSurvivor: "hold" },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(holdRoot, "add", "-A"); g(holdRoot, "commit", "-qm", "fixture");

  const holdCfg = loadConfig(holdRoot);
  const holdGraph = loadGraph(holdRoot, holdCfg.paths.graph);
  const holdState = st.initState(holdRoot, holdCfg, holdGraph);
  log.openRunLog(path.join(holdRoot, ".trellis"));
  await run(holdCfg, holdGraph, holdState, {});
  await log.closeRunLog();
  await holdMock.close();

  check("ADVERSARIAL onSurvivor=hold reaches STATUS.REVIEW, same as a high-risk hold", () => {
    assert.strictEqual(holdState.nodes.weak.status, "review",
      `expected the surviving-mutant node held for review, got ${holdState.nodes.weak.status}`);
  });
  check("ADVERSARIAL onSurvivor=hold logs a node.review event, not silence", () => {
    const runLog = fs.readFileSync(path.join(holdRoot, ".trellis", "run.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const reviewEvent = runLog.find((r) => r.type === "node.review" && r.id === "weak");
    assert.ok(reviewEvent, `expected a node.review event for "weak" in run.jsonl, got: ${JSON.stringify(runLog)}`);
    assert.strictEqual(reviewEvent.reason, "onSurvivor-hold",
      `expected the event to distinguish this from a high-risk hold, got: ${JSON.stringify(reviewEvent)}`);
  });
  fs.rmSync(holdRoot, { recursive: true, force: true });

  // ---- auto driver, build stage ----
  //
  // `trellis auto` chains sessions headless. Every stage but 05_build spawns a
  // Claude Code session, so only 05_build is testable offline — which is exactly
  // the stage that was broken: it called run() with an options object where the
  // config belongs, so cfg.tiers was undefined and the stage threw. `auto` is off
  // by default, so nothing ever exercised this branch.
  const aRoot = makeRepo();
  // The REAL shipped .gitignore, not a hand-picked subset — a partial one
  // here previously let this fixture pass while missing state.json/
  // REPORT.md/run.jsonl/ledger.jsonl/sessions.jsonl/trellis.code-workspace,
  // every one of which auto's commit step then reports as "unexpected".
  // Copying the actual file is what keeps this fixture from drifting from
  // reality the same way QUICKSTART.md once did.
  write(aRoot, ".gitignore", fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.gitignore"), "utf8"));
  // `auto` refuses to start at all without a Bash-matched PreToolUse hook
  // registered — see requireBashGuard in cli.mjs. Real operators configure
  // this once at install time; this fixture stands in for that.
  write(aRoot, ".claude/settings.json", JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/guard-bash.mjs" }] }] },
  }));
  write(aRoot, "tests/auto.test.mjs", `
import assert from "node:assert";
import { auto } from "../src/auto.mjs";
assert.strictEqual(auto(), "ok");
`.trim());
  write(aRoot, ".trellis/graph.json", JSON.stringify({
    version: 1,
    project: "auto",
    nodes: [
      { id: "auto", title: "auto", goal: "export auto()", write: ["src/auto.mjs"],
        tests: ["tests/auto.test.mjs"], gate: "node tests/auto.test.mjs" },
    ],
  }, null, 2));
  const aMock = await startMockServer({
    models: ["mock/cheap"],
    responses: { auto: [{ content: FILE("src/auto.mjs", "export const auto=()=>'ok';") }] },
  });
  write(aRoot, "trellis.config.json", JSON.stringify({
    project: "auto",
    baseBranch: "main",
    concurrency: 1,
    driver: { enabled: true, command: "claude", maxTurns: 10, maxAttempts: 1 },
    tiers: [{ name: "cheap", baseUrl: aMock.url, model: "mock/cheap", maxAttempts: 1 }],
    gate: { timeoutMs: 30000 },
    routing: { enabled: false },
    verify: { mutationsOnPass: false },
    budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(aRoot, "add", "-A"); g(aRoot, "commit", "-qm", "fixture");

  // Async spawn, not spawnSync: the mock server runs in THIS process, and
  // spawnSync would block the event loop that has to answer the child's HTTP
  // calls — the parent and child would deadlock waiting on each other.
  const auto = await new Promise((resolve) => {
    const c = spawn("node", [CLI, "auto", "--stage", "05_build"], { cwd: aRoot });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  await aMock.close();

  check("auto --stage 05_build runs the runner instead of crashing", () => {
    assert.strictEqual(auto.status, 0,
      `exit ${auto.status}\nstdout: ${auto.stdout}\nstderr: ${auto.stderr}`);
    assert.ok(!/TypeError|is not a function|undefined/i.test(auto.stderr),
      `driver threw: ${auto.stderr}`);
  });
  check("auto --stage 05_build leaves the REPORT.md its verify() looks for", () => {
    assert.ok(fs.existsSync(path.join(aRoot, ".trellis/REPORT.md")),
      `no REPORT.md\nstdout: ${auto.stdout}\nstderr: ${auto.stderr}`);
  });
  fs.rmSync(aRoot, { recursive: true, force: true });

  // ---- auto halts on a modification it did not declare, rather than sweeping
  // it into a commit. This is the check that would have caught this exact
  // mistake earlier in the design: a partial .gitignore in an earlier version
  // of THIS fixture made state.json/REPORT.md/run.jsonl/ledger.jsonl/
  // sessions.jsonl/trellis.code-workspace all look "unexpected" and halted
  // every run — the fix belonged in .gitignore, not in loosening this check.
  const hRoot = makeRepo();
  write(hRoot, ".gitignore", fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.gitignore"), "utf8"));
  write(hRoot, ".claude/settings.json", JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/guard-bash.mjs" }] }] },
  }));
  write(hRoot, "tests/halt.test.mjs", `
import assert from "node:assert";
import { halt } from "../src/halt.mjs";
assert.strictEqual(halt(), "ok");
`.trim());
  write(hRoot, ".trellis/graph.json", JSON.stringify({
    version: 1, project: "halt",
    nodes: [{ id: "halt", title: "halt", goal: "export halt()", write: ["src/halt.mjs"],
      tests: ["tests/halt.test.mjs"], gate: "node tests/halt.test.mjs" }],
  }, null, 2));
  write(hRoot, "trellis.config.json", JSON.stringify({
    project: "halt", baseBranch: "main", concurrency: 1,
    driver: { enabled: true, command: "claude", maxTurns: 10, maxAttempts: 1 },
    tiers: [{ name: "cheap", baseUrl: "http://127.0.0.1:1", model: "mock/cheap", maxAttempts: 1 }],
    gate: { timeoutMs: 30000 }, routing: { enabled: false }, verify: { mutationsOnPass: false },
    budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(hRoot, "add", "-A"); g(hRoot, "commit", "-qm", "fixture");
  // The file auto did not declare and cannot know about — simulates a stray
  // edit left in the working tree by anything other than this stage.
  write(hRoot, "NOTES.md", "an operator's scratch note, sitting in the tree\n");

  const halted = spawnSync("node", [CLI, "auto", "--stage", "05_build"], { cwd: hRoot, encoding: "utf8" });
  check("ADVERSARIAL an undeclared file in the tree is never swept into a commit", () => {
    // For 05_build specifically, the RUNNER's own pre-existing dirty-tree
    // check (kit/lib/runner.mjs) fires before commitStageOutput's newer,
    // narrower check ever gets a chance to — the runner refuses to start at
    // all on any dirty tree, which is a stricter, earlier gate for this one
    // stage. What matters here is the outcome both mechanisms exist to
    // guarantee: auto must never exit 0 with a stray file quietly committed.
    assert.notStrictEqual(halted.status, 0, "auto exited 0 despite an undeclared file in the tree");
    const stillDirty = g(hRoot, "status", "--porcelain").stdout;
    assert.ok(/NOTES\.md/.test(stillDirty), "NOTES.md should still be sitting there, untouched, not swept into a commit");
    const log = g(hRoot, "log", "--oneline").stdout;
    assert.ok(!/NOTES/.test(log), "NOTES.md ended up committed somewhere");
  });
  fs.rmSync(hRoot, { recursive: true, force: true });

  // ---- --dry-run runs nothing
  const dRoot = makeRepo();
  write(dRoot, "trellis.config.json", JSON.stringify({
    project: "dry", baseBranch: "main",
    driver: { enabled: true, command: "does-not-exist" },
    paths: { state: ".trellis", worktrees: ".worktrees", graph: ".trellis/graph.json" },
    tiers: [{ name: "cheap", baseUrl: "http://127.0.0.1:1", model: "m", apiKeyEnv: null, maxAttempts: 1, maxTokens: 100 }],
  }));
  write(dRoot, ".claude/settings.json", JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/guard-bash.mjs" }] }] },
  }));
  g(dRoot, "add", "-A"); g(dRoot, "commit", "-qm", "fixture");
  const dry = spawnSync("node", [CLI, "auto", "--dry-run"], { cwd: dRoot, encoding: "utf8" });
  check("auto --dry-run prints the plan and runs nothing", () => {
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.ok(/Stage plan/.test(dry.stdout), dry.stdout);
    assert.ok(!fs.existsSync(path.join(dRoot, ".trellis/cycle.json")), "--dry-run began a cycle");
    assert.ok(!fs.existsSync(path.join(dRoot, ".trellis/sessions.jsonl")), "--dry-run recorded a session");
  });
  fs.rmSync(dRoot, { recursive: true, force: true });

  // `trellis verify-tests` used to always exit 0 unless a HARD finding forced
  // `die()` — so a run where every node was soft-skipped (a language it does
  // not check) printed "Nothing here is proven" and still exited 0. Since
  // driver.mjs's stage-04 verify shells out to this exact command and reads
  // only its exit code, the headless chain reported non-vacuity established on
  // a run that established none of it. This must be exercised as a real
  // subprocess: the bug is in cmdVerifyTests's process.exitCode, not in
  // verifyTests() itself, which was already correct.
  const nRoot = makeRepo();
  write(nRoot, "tests/only.test.py", "assert True\n");
  write(nRoot, "src/only.mjs", "export const only = () => 1;\n");
  write(nRoot, ".trellis/graph.json", JSON.stringify({
    version: 1,
    project: "nothing-proven",
    nodes: [
      { id: "only", title: "only", goal: "g", write: ["src/only.mjs"],
        tests: ["tests/only.test.py"], gate: "python -c \"pass\"" },
    ],
  }, null, 2));
  write(nRoot, "trellis.config.json", JSON.stringify({
    project: "nothing-proven", baseBranch: "main",
    tiers: [{ name: "cheap", baseUrl: "http://x/v1", model: "m" }],
    gate: { timeoutMs: 20000 },
  }, null, 2));
  g(nRoot, "add", "-A"); g(nRoot, "commit", "-qm", "fixture");
  const nothingProven = await new Promise((resolve) => {
    const c = spawn("node", [CLI, "verify-tests"], { cwd: nRoot });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  check("ADVERSARIAL verify-tests exits non-zero when nothing was proven", () => {
    assert.notStrictEqual(nothingProven.status, 0,
      `expected a non-zero exit when every node is soft-skipped, got 0.\n` +
      `stdout: ${nothingProven.stdout}\nstderr: ${nothingProven.stderr}`);
  });
  fs.rmSync(nRoot, { recursive: true, force: true });

  // ---- resume salvage: a RUNNING node must not stay stuck forever ----
  //
  // The graph-changed salvage path used to copy state.nodes[id] verbatim,
  // including status. A node genuinely RUNNING when the process died — its
  // own contract untouched by whatever graph edit triggered the salvage —
  // stayed RUNNING forever after: invisible to readySet, invisible to
  // markBlocked, and the run reported "finished" with it silently unbuilt.
  const rRoot = makeRepo();
  // See the aRoot fixture above: resumeOrInit's lazy cycle-1 begin writes
  // .trellis/cycle.json as an untracked file, and the runner refuses to
  // start on a tree it just made dirty itself without this.
  write(rRoot, ".gitignore", ".trellis/cycle.json\n.trellis/checkpoint.json\n");
  write(rRoot, "tests/a.test.mjs", `
import assert from "node:assert";
import { a } from "../src/a.mjs";
assert.strictEqual(a(), 1);
`.trim());
  write(rRoot, "tests/b.test.mjs", `
import assert from "node:assert";
import { b } from "../src/b.mjs";
assert.strictEqual(b(), 1);
`.trim());
  const rGraph = {
    version: 1,
    project: "salvage",
    nodes: [
      { id: "a", title: "a", goal: "export a()", write: ["src/a.mjs"], tests: ["tests/a.test.mjs"], gate: "node tests/a.test.mjs" },
      { id: "b", title: "b", goal: "export b()", write: ["src/b.mjs"], tests: ["tests/b.test.mjs"], gate: "node tests/b.test.mjs" },
    ],
  };
  write(rRoot, ".trellis/graph.json", JSON.stringify(rGraph, null, 2));
  const rMock = await startMockServer({
    responses: {
      a: [{ content: FILE("src/a.mjs", "export const a = () => 1;") }],
      b: [{ content: FILE("src/b.mjs", "export const b = () => 1;") }],
    },
  });
  write(rRoot, "trellis.config.json", JSON.stringify({
    project: "salvage", baseBranch: "main", concurrency: 2,
    tiers: [{ name: "cheap", baseUrl: rMock.url, model: "mock/cheap", maxAttempts: 1 }],
    gate: { timeoutMs: 20000 },
    routing: { enabled: false },
    verify: { mutationsOnPass: false },
    budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
    boundaries: { denyWrite: [".git/**", ".trellis/**", "trellis.config.json"] },
  }, null, 2));
  g(rRoot, "add", "-A"); g(rRoot, "commit", "-qm", "fixture");

  // A well-formed prior state against the ORIGINAL graph, with the
  // interrupted status hand-injected: node "a" was RUNNING when the process
  // died. Built through initState rather than by hand so the hashes are real.
  const rCfg1 = loadConfig(rRoot);
  const rGraphLoaded1 = loadGraph(rRoot, rCfg1.paths.graph);
  const rState = st.initState(rRoot, rCfg1, rGraphLoaded1);
  rState.nodes.a.status = "running";
  st.saveState(rRoot, rCfg1, rState);

  // Edit the graph WITHOUT touching node "a"'s contract — only "b"'s title,
  // which nodeHash does not read — so this changes the FILE hash (triggering
  // the salvage path) while "a" still lands in `keep` (its own hash did not
  // change).
  rGraph.nodes[1].title = "b (renamed)";
  write(rRoot, ".trellis/graph.json", JSON.stringify(rGraph, null, 2));
  g(rRoot, "add", "-A"); g(rRoot, "commit", "-qm", "rename b");

  const rRun = await new Promise((resolve) => {
    const c = spawn("node", [CLI, "run", "--resume"], { cwd: rRoot });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const rFinalState = JSON.parse(fs.readFileSync(path.join(rRoot, ".trellis/state.json"), "utf8"));
  check("ADVERSARIAL a RUNNING node kept across a graph-changed salvage does not stay stuck forever", () => {
    assert.notStrictEqual(rFinalState.nodes.a.status, "running",
      `node "a" was RUNNING before the graph changed and is still "running" after --resume\n` +
      `stdout: ${rRun.stdout}\nstderr: ${rRun.stderr}`);
    assert.strictEqual(rFinalState.nodes.a.status, "merged",
      `expected node "a" to have been rebuilt and merged after the salvage, got "${rFinalState.nodes.a.status}"\n` +
      `stdout: ${rRun.stdout}`);
  });
  await rMock.close();
  fs.rmSync(rRoot, { recursive: true, force: true });

  // ---- reject / apply-triage: the false-positive fix and the mechanised half
  //
  // Real triage on a real run produced 14 rejects; `reject` refused all 14,
  // because an EXHAUSTED node's branch never diverged from the base tip —
  // commitWorktree only runs on a passing gate — so `git merge-base
  // --is-ancestor` trivially returned true for a node with zero commits, and
  // reject died with "already merged, revert that merge first". These prove
  // the status-based fix, and that apply-triage never merges a held node.
  const rjRoot = makeRepo();
  write(rjRoot, "trellis.config.json", JSON.stringify({
    project: "reject", baseBranch: "main",
    paths: { state: ".trellis", worktrees: ".worktrees", graph: ".trellis/graph.json" },
    tiers: [{ name: "cheap", baseUrl: "http://127.0.0.1:1", model: "m", apiKeyEnv: null, maxAttempts: 1, maxTokens: 100 }],
  }));
  write(rjRoot, ".trellis/graph.json", JSON.stringify({
    version: 1, project: "reject",
    nodes: [
      { id: "exh", title: "exh", goal: "g", write: ["src/exh.mjs"], tests: [], gate: "true" },
      { id: "merged1", title: "merged1", goal: "g", write: ["src/m1.mjs"], tests: [], gate: "true" },
      { id: "weak1", title: "weak1", goal: "g", write: ["src/w1.mjs"], tests: [], gate: "true" },
      { id: "held1", title: "held1", goal: "g", write: ["src/h1.mjs"], tests: [], gate: "true" },
    ],
  }, null, 2));
  g(rjRoot, "add", "-A"); g(rjRoot, "commit", "-qm", "fixture");

  const rjCfg = loadConfig(rjRoot);
  const rjGraph = loadGraph(rjRoot, rjCfg.paths.graph);
  const rjState = st.initState(rjRoot, rjCfg, rjGraph, { runId: "r1" });
  // Hand-set post-run statuses, since none of these need a real gate to pass.
  rjState.nodes.exh.status = "exhausted";
  rjState.nodes.merged1.status = "merged"; rjState.nodes.merged1.branch = "trellis/merged1";
  rjState.nodes.weak1.status = "weak-tests"; rjState.nodes.weak1.branch = "trellis/weak1";
  rjState.nodes.held1.status = "review"; rjState.nodes.held1.branch = "trellis/held1";
  st.saveState(rjRoot, rjCfg, rjState);

  check("ADVERSARIAL reject succeeds on an exhausted node with zero commits", () => {
    const r = spawnSync("node", [CLI, "reject", "exh"], { cwd: rjRoot, encoding: "utf8" });
    assert.strictEqual(r.status, 0, `reject refused an exhausted node: ${r.stdout}${r.stderr}`);
    const after = st.loadState(rjRoot, rjCfg);
    assert.strictEqual(after.nodes.exh.status, "pending", `expected pending, got ${after.nodes.exh.status}`);
  });
  check("reject still refuses a genuinely landed node", () => {
    const r = spawnSync("node", [CLI, "reject", "merged1"], { cwd: rjRoot, encoding: "utf8" });
    assert.notStrictEqual(r.status, 0, "reject was allowed to reset a merged node");
    assert.ok(/revert that merge/i.test(r.stdout + r.stderr), `wrong refusal reason: ${r.stdout}${r.stderr}`);
    const after = st.loadState(rjRoot, rjCfg);
    assert.strictEqual(after.nodes.merged1.status, "merged", "a landed node's status changed on a refused reject");
  });

  // Restore exh to exhausted for the apply-triage checks below (reject above consumed it).
  const rjState2 = st.loadState(rjRoot, rjCfg);
  rjState2.nodes.exh.status = "exhausted";
  st.saveState(rjRoot, rjCfg, rjState2);

  write(rjRoot, ".trellis/triage.json", JSON.stringify({
    decisions: [
      { node: "exh", verdict: "reject", code: "test-too-weak", reason: "contract underspecified" },
      { node: "merged1", verdict: "reject", code: "test-too-weak", reason: "should have been caught earlier" },
      { node: "weak1", verdict: "accept", reason: "mutation survivor reviewed, acceptable" },
      { node: "held1", verdict: "accept", reason: "looks fine, merge it" },
    ],
  }, null, 2));

  check("apply-triage --dry-run changes nothing", () => {
    const before = st.loadState(rjRoot, rjCfg);
    const r = spawnSync("node", [CLI, "apply-triage"], { cwd: rjRoot, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(/Dry run/.test(r.stdout), "did not announce itself as a dry run");
    const after = st.loadState(rjRoot, rjCfg);
    assert.deepStrictEqual(after.nodes.exh.status, before.nodes.exh.status, "dry run mutated state");
    assert.ok(!fs.existsSync(path.join(rjRoot, ".trellis/checkpoint.json")), "dry run wrote checkpoint.json");
  });

  const rjApplyResult = spawnSync("node", [CLI, "apply-triage", "--apply"], { cwd: rjRoot, encoding: "utf8" });
  const rjAfter = st.loadState(rjRoot, rjCfg);

  check("apply-triage resets a rejected non-landed node", () => {
    assert.strictEqual(rjApplyResult.status, 0, rjApplyResult.stdout + rjApplyResult.stderr);
    assert.strictEqual(rjAfter.nodes.exh.status, "pending", `expected pending, got ${rjAfter.nodes.exh.status}`);
  });
  check("ADVERSARIAL apply-triage refuses to revert a landed node's reject, does not touch it", () => {
    assert.strictEqual(rjAfter.nodes.merged1.status, "merged",
      "apply-triage reverted a merge — reverting a merge is a one-way door");
    assert.ok(/revert that merge|human decision|already landed/i.test(rjApplyResult.stdout),
      `no explanation printed for the refused node: ${rjApplyResult.stdout}`);
  });
  check("apply-triage bookkeeps an accept on an already-landed node without re-merging", () => {
    assert.strictEqual(rjAfter.nodes.weak1.status, "merged", `expected merged, got ${rjAfter.nodes.weak1.status}`);
    assert.ok(rjAfter.nodes.weak1.acceptedAt, "acceptedAt was not stamped");
  });
  check("ADVERSARIAL apply-triage NEVER merges a held review node — checkpoint only", () => {
    assert.strictEqual(rjAfter.nodes.held1.status, "review",
      "apply-triage merged a high-risk held node without a human — this is the one-way door MISSION.md protects");
    const cp = JSON.parse(fs.readFileSync(path.join(rjRoot, ".trellis/checkpoint.json"), "utf8"));
    assert.ok(cp.nodes.some((n) => n.id === "held1"), "held node was not written to checkpoint.json");
    assert.ok(!fs.existsSync(path.join(rjRoot, "src/h1.mjs")), "held node's branch was merged onto main");
  });

  // ---- Phase-4 blocker 5: checkpoint.json is never cleared ----
  //
  // A human reviews held1 and merges it by hand (simulated here — accept
  // --merge is the one-way door a real operator would run). A LATER
  // apply-triage call, on a run with nothing held, must show an EMPTY
  // checkpoint, not the stale entry from before. Writing checkpoint.json
  // only when rows.checkpoint was non-empty left the PRIOR checkpoint on
  // disk forever once its node was finally accepted, and `trellis auto`
  // reads this file unconditionally on every cycle.
  const rjState3 = st.loadState(rjRoot, rjCfg);
  rjState3.nodes.held1.status = "merged";
  rjState3.nodes.held1.acceptedAt = new Date().toISOString();
  st.saveState(rjRoot, rjCfg, rjState3);
  write(rjRoot, ".trellis/triage.json", JSON.stringify({
    decisions: [{ node: "held1", verdict: "accept", reason: "merged after human review" }],
  }, null, 2));
  const rjApplyResult2 = spawnSync("node", [CLI, "apply-triage", "--apply"], { cwd: rjRoot, encoding: "utf8" });
  check("ADVERSARIAL a stale checkpoint is cleared once nothing is held any more", () => {
    assert.strictEqual(rjApplyResult2.status, 0, rjApplyResult2.stdout + rjApplyResult2.stderr);
    const cp = JSON.parse(fs.readFileSync(path.join(rjRoot, ".trellis/checkpoint.json"), "utf8"));
    assert.deepStrictEqual(cp.nodes, [], `expected an empty checkpoint, still shows: ${JSON.stringify(cp.nodes)}`);
  });
  fs.rmSync(rjRoot, { recursive: true, force: true });

  // ---- run --resume must not silently rebuild a landed node in place ----
  //
  // resumePlan's own unit tests (kit/regression/run.mjs) prove the data-level
  // guard. This proves the CLI actually acts on it: `trellis run --resume`
  // after a merged node's contract changed must halt loudly, not reset the
  // node to pending and rebuild it from a base branch that still contains
  // its old merge -- exactly what `trellis reject` already refuses to do for
  // the same node, without a human reverting the merge first.
  const ldRoot = makeRepo();
  write(ldRoot, "trellis.config.json", JSON.stringify({
    project: "landeddirty", baseBranch: "main",
    paths: { state: ".trellis", worktrees: ".worktrees", graph: ".trellis/graph.json" },
    tiers: [{ name: "cheap", baseUrl: "http://127.0.0.1:1", model: "m", apiKeyEnv: null, maxAttempts: 1, maxTokens: 100 }],
  }));
  write(ldRoot, "tests/landed.test.mjs", "assert.strictEqual(1, 1);\n");
  write(ldRoot, ".trellis/graph.json", JSON.stringify({
    version: 1, project: "landeddirty",
    nodes: [{ id: "landed", title: "landed", goal: "original goal", write: ["src/landed.mjs"],
      tests: ["tests/landed.test.mjs"], gate: "true" }],
  }, null, 2));
  g(ldRoot, "add", "-A"); g(ldRoot, "commit", "-qm", "fixture");

  const ldCfg = loadConfig(ldRoot);
  const ldGraph0 = loadGraph(ldRoot, ldCfg.paths.graph);
  const ldState = st.initState(ldRoot, ldCfg, ldGraph0, { runId: "r1" });
  ldState.nodes.landed.status = "merged";
  ldState.nodes.landed.branch = "trellis/landed";
  st.saveState(ldRoot, ldCfg, ldState);

  // Change the landed node's own contract -- moves its hash, and moves
  // graph.__hash too, which is what routes `run --resume` into the salvage
  // path (resumeOrInit) rather than the ordinary resume path.
  const ldGraphEdited = JSON.parse(fs.readFileSync(path.join(ldRoot, ".trellis/graph.json"), "utf8"));
  ldGraphEdited.nodes[0].goal = "a materially different goal";
  write(ldRoot, ".trellis/graph.json", JSON.stringify(ldGraphEdited, null, 2));
  g(ldRoot, "add", "-A"); g(ldRoot, "commit", "-qm", "edit landed node's contract");

  const ldRun = spawnSync("node", [CLI, "run", "--resume"], { cwd: ldRoot, encoding: "utf8" });
  check("ADVERSARIAL run --resume refuses to silently rebuild a landed node whose contract changed", () => {
    assert.notStrictEqual(ldRun.status, 0,
      `run --resume must halt rather than rebuild a landed node in place\nstdout: ${ldRun.stdout}\nstderr: ${ldRun.stderr}`);
    assert.ok(/landed/.test(ldRun.stdout + ldRun.stderr), `the halt message did not name the affected node: ${ldRun.stdout}${ldRun.stderr}`);
    assert.ok(/revert/i.test(ldRun.stdout + ldRun.stderr),
      `expected the same "revert that merge" guidance trellis reject gives: ${ldRun.stdout}${ldRun.stderr}`);
    const after = st.loadState(ldRoot, ldCfg);
    assert.strictEqual(after.nodes.landed.status, "merged", "the landed node's status must not have been touched");
  });
  fs.rmSync(ldRoot, { recursive: true, force: true });

  // ---- report ----
  let failed = 0;
  for (const [status, name, msg] of results) {
    if (status === "pass") console.log(`  \u001b[32m✓\u001b[0m ${name}`);
    else { failed++; console.log(`  \u001b[31m✗ ${name}\u001b[0m\n      ${msg}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (!failed) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`\nrepo kept for inspection: ${root}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
