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

  const graph = {
    version: 1,
    project: "e2e",
    nodes: [
      { id: "add", title: "add", goal: "export add(a,b)", tags: ["algorithm"], covers: ["Addition"], write: ["src/add.mjs"], tests: ["tests/add.test.mjs"], gate: "node tests/add.test.mjs" },
      { id: "mul", title: "mul", goal: "export mul(a,b)", tags: ["algorithm"], covers: ["Multiplication"], write: ["src/mul.mjs"], tests: ["tests/mul.test.mjs"], gate: "node tests/mul.test.mjs" },
      { id: "combo", title: "combo", goal: "export combo using add and mul", deps: ["add", "mul"], write: ["src/combo.mjs"], read: ["src/add.mjs"], tests: ["tests/combo.test.mjs"], gate: "node tests/combo.test.mjs" },
      { id: "risky", title: "risky", goal: "export risky()", risk: "high", write: ["src/risky.mjs"], tests: ["tests/risky.test.mjs"], gate: "node tests/risky.test.mjs" },
      { id: "impossible", title: "impossible", goal: "export impossible()", write: ["src/impossible.mjs"], tests: ["tests/impossible.test.mjs"], gate: "node tests/impossible.test.mjs" },
      { id: "downstream", title: "downstream", goal: "depends on impossible", deps: ["impossible"], write: ["src/downstream.mjs"], tests: [], gate: "node -e \"process.exit(0)\"" },
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

  // ---- auto driver, build stage ----
  //
  // `trellis auto` chains sessions headless. Every stage but 05_build spawns a
  // Claude Code session, so only 05_build is testable offline — which is exactly
  // the stage that was broken: it called run() with an options object where the
  // config belongs, so cfg.tiers was undefined and the stage threw. `auto` is off
  // by default, so nothing ever exercised this branch.
  const aRoot = makeRepo();
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
