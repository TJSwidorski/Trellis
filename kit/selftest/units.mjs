// Focused tests for everything added in v1.1
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import assert from "node:assert"; import { spawnSync } from "node:child_process";
import { startMockServer } from "./mock-server.mjs";
import { loadConfig } from "../lib/config.mjs";
import { loadGraph, validateGraph, normalizeNode, ancestors, levels } from "../lib/graph.mjs";
import { run } from "../lib/runner.mjs";
import { verifyTests, buildStub, importedNames } from "../lib/verify.mjs";
import { planTiers } from "../lib/routing.mjs";
import { tierStats, recordsFor, summarise } from "../lib/ledger.mjs";
import { scopeBullets } from "../lib/spec.mjs";
import { detectEnvFailure } from "../lib/envfail.mjs";
import { meterSession, summariseArm, compare } from "../bench/meter.mjs";
import * as ledger from "../lib/ledger.mjs";
import * as st from "../lib/state.mjs";

const R=[]; const check=(n,f)=>{try{f();R.push(["pass",n])}catch(e){R.push(["FAIL",n,e.message])}};
const g=(cwd,...a)=>spawnSync("git",a,{cwd,encoding:"utf8"});
const FILE=(p,b)=>`### FILE: ${p}\n\`\`\`js\n${b}\n\`\`\`\n`;
const W=(root,rel,c)=>{const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,c);};

// ---------- unit: spec scope parsing ----------
check("scopeBullets reads only the in-scope section", () => {
  const bullets = scopeBullets(`
## Scope for this run
- [ ] Alpha thing
- [x] Beta thing
## Explicitly not in scope
- [ ] Gamma thing
`);
  assert.deepStrictEqual(bullets, ["Alpha thing", "Beta thing"]);
});

// ---------- unit: stub generation ----------
check("importedNames finds named + aliased imports of the target", () => {
  const src = `import { a, b as c } from '../src/x.mjs';\nimport { z } from '../src/other.mjs';`;
  const got = importedNames(src, "/r/tests/t.test.mjs", "src/x.mjs", "/r");
  assert.deepStrictEqual(got.names.sort(), ["a","b"]);
});
check("buildStub produces importable inert exports", () => {
  const s = buildStub(["foo","bar"]);
  assert.ok(s.includes("export const foo"));
  assert.ok(s.includes("export const bar"));
});

// Four of six realistic import forms used to produce no stub at all: the gate
// then ran against a repo where the target simply did not exist, and a
// module-not-found error was reported as non-vacuity established. Each row
// here failed before the extension-agnostic comparison and require()/import()
// patterns were added to importedNames.
check("importedNames resolves an extensionless specifier", () => {
  const got = importedNames("import { a } from '../src/calc';", "/r/tests/t.test.mjs", "src/calc.mjs", "/r");
  assert.deepStrictEqual(got.names, ["a"]);
});
check("importedNames resolves the TS .js-specifier-for-a-.ts-file convention", () => {
  const got = importedNames("import { a } from '../src/calc.js';", "/r/tests/t.test.mjs", "src/calc.ts", "/r");
  assert.deepStrictEqual(got.names, ["a"]);
});
check("importedNames resolves require() with destructuring", () => {
  const got = importedNames("const { a, b } = require('../src/calc.mjs');", "/r/tests/t.test.mjs", "src/calc.mjs", "/r");
  assert.deepStrictEqual(got.names.sort(), ["a", "b"]);
});
check("importedNames resolves a bare require() as a namespace reference", () => {
  const got = importedNames("const calc = require('../src/calc.mjs');", "/r/tests/t.test.mjs", "src/calc.mjs", "/r");
  assert.strictEqual(got.namespace, true);
});
check("importedNames resolves dynamic import() with destructuring", () => {
  const got = importedNames("const { a } = await import('../src/calc.mjs');", "/r/tests/t.test.mjs", "src/calc.mjs", "/r");
  assert.deepStrictEqual(got.names, ["a"]);
});
check("importedNames resolves a bare dynamic import() as a namespace reference", () => {
  const got = importedNames("const mod = await import('../src/calc.mjs');", "/r/tests/t.test.mjs", "src/calc.mjs", "/r");
  assert.strictEqual(got.namespace, true);
});
check("importedNames resolves a directory import against its index file", () => {
  const got = importedNames("import { a } from '../src/calc';", "/r/tests/t.test.mjs", "src/calc/index.mjs", "/r");
  assert.deepStrictEqual(got.names, ["a"]);
});

// ---------- unit: routing ----------
const hist = (tag, tier, landed, n) => Array.from({length:n},(_,i)=>({
  runId:"r1", nodeId:`n${i}`, tags:[tag], landedTier: landed?tier:null,
  attemptsByTier: { [tier]: { attempts: 3, landed } },
}));
check("routing is inert without enough observations", () => {
  const cfg = { tiers:[{name:"cheap"},{name:"mid"}], routing:{enabled:true,minObservations:5,minSuccessRate:0.15} };
  const p = planTiers(cfg, {tags:["adapter"]}, hist("adapter","cheap",false,2));
  assert.strictEqual(p.tiers.length, 2);
  assert.strictEqual(p.reason, null);
});
check("routing skips a cheap tier that reliably fails a tag", () => {
  const cfg = { tiers:[{name:"cheap"},{name:"mid"}], routing:{enabled:true,minObservations:5,minSuccessRate:0.15} };
  const p = planTiers(cfg, {tags:["algorithm"]}, hist("algorithm","cheap",false,12));
  assert.deepStrictEqual(p.tiers.map(t=>t.name), ["mid"]);
  assert.ok(/skipped cheap/.test(p.reason));
});
check("routing leaves a healthy tag alone", () => {
  const cfg = { tiers:[{name:"cheap"},{name:"mid"}], routing:{enabled:true,minObservations:5,minSuccessRate:0.15} };
  const p = planTiers(cfg, {tags:["adapter"]}, hist("adapter","cheap",true,12));
  assert.deepStrictEqual(p.tiers.map(t=>t.name), ["cheap","mid"]);
});
check("routing never skips the last tier", () => {
  const cfg = { tiers:[{name:"cheap"}], routing:{enabled:true,minObservations:1,minSuccessRate:0.99} };
  const p = planTiers(cfg, {tags:["x"]}, hist("x","cheap",false,20));
  assert.strictEqual(p.tiers.length, 1);
});

check("a multi-tagged node counts once, not once per tag", () => {
  // One node with three tags must not look like three observations.
  const recs = [{ runId:"r1", nodeId:"fitbit", tags:["adapter","parser","csv"],
                  attemptsByTier:{ cheap:{attempts:3,landed:false} } }];
  const st2 = tierStats(recs);
  assert.strictEqual(st2.get("adapter|cheap").seen, 1);
  const cfg = { tiers:[{name:"cheap"},{name:"mid"}], routing:{enabled:true,minObservations:3,minSuccessRate:0.15} };
  const p = planTiers(cfg, {tags:["adapter","parser","csv"]}, recs);
  assert.strictEqual(p.reason, null, "3 tags on 1 node must not satisfy minObservations of 3");
});

check("weak-tests and review count as the tier having succeeded", () => {
  const nodes = new Map([
    ["a", { role:"implementer", risk:"low", tags:["x"], deps:[], write:["a"], tests:[], mutations:[] }],
    ["b", { role:"implementer", risk:"high", tags:["x"], deps:[], write:["b"], tests:[], mutations:[] }],
  ]);
  const state = { runId:"r", project:"p", nodes: {
    a: { status:"weak-tests", tier:"cheap", attempts:[{tier:"cheap",ok:true}] },
    b: { status:"review",     tier:"cheap", attempts:[{tier:"cheap",ok:true}] },
  }};
  const recs = recordsFor(state, nodes);
  assert.strictEqual(recs.find(r=>r.nodeId==="a").landedTier, "cheap", "weak-tests merged, so it landed");
  assert.strictEqual(recs.find(r=>r.nodeId==="b").landedTier, "cheap", "review passed its gate");
  const sum = summarise(recs);
  assert.strictEqual(sum.get("x").landed, 2);
});

// --------------------------------------------------------------- bench meter

check("meter separates cache reads from fresh input", () => {
  const m = meterSession([
    JSON.stringify({ message: { model: "claude-opus-4-5", usage: {
      input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ message: { model: "claude-opus-4-5", usage: {
      input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000 } } }),
  ]);
  assert.strictEqual(m.input, 1100);
  assert.strictEqual(m.cacheRead, 20000, "cache reads must not be folded into input");
  assert.strictEqual(m.cacheWrite, 20000);
  assert.strictEqual(m.requests, 2);
});

check("meter isolates the always-on load from the first turn", () => {
  const m = meterSession([
    JSON.stringify({ message: { model: "claude-opus-4-5", usage: {
      input_tokens: 4000, output_tokens: 10, cache_creation_input_tokens: 12000, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ message: { model: "claude-opus-4-5", usage: {
      input_tokens: 999999, output_tokens: 10, cache_read_input_tokens: 0 } } }),
  ]);
  // 4000 + 12000 from turn one only; later turns must not inflate the tax.
  assert.strictEqual(m.alwaysOn, 16000);
});

check("ADVERSARIAL arm totals stay split, never collapsed to one number", () => {
  const s = summariseArm("B", [meterSession([JSON.stringify({ message: { model: "claude-opus-4-5",
    usage: { input_tokens: 1000, output_tokens: 1000 } } })])], { workerCostUsd: 0.25 });
  assert.ok(s.costUsd.orchestrator > 0, "orchestrator cost must be reported on its own");
  assert.strictEqual(s.costUsd.worker, 0.25, "worker cost must be reported on its own");
  assert.strictEqual(
    Number((s.costUsd.total).toFixed(6)),
    Number((s.costUsd.orchestrator + s.costUsd.worker).toFixed(6)),
    "total must be the sum of the two, and both parts must remain visible"
  );
});

check("the window meter weights output heavily and cache reads barely", () => {
  const m = meterSession([
    JSON.stringify({ message: { model: "claude-opus-4-5", usage: {
      input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 100 } } }),
  ]);
  // 100(×1) + 100(×5) + 100(×1.25) + 100(×0.1) = 735
  assert.strictEqual(m.window.weightedTokens, 735);
  assert.ok(m.window.pct > 0 && m.window.pct < 1, "share of a window, not a token count");
});

check("ADVERSARIAL a run that spends the window is never reported as free", () => {
  // The first real run's exact failure: real tokens, no resolvable model, and a
  // report claiming $0.0000. Dollars may be unknown; the window never is.
  const m = meterSession([
    JSON.stringify({ usage: { input_tokens: 446, output_tokens: 38536,
      cache_creation_input_tokens: 641724, cache_read_input_tokens: 7785168 } }),
  ]);
  assert.strictEqual(m.model, null, "no model id in the transcript");
  assert.strictEqual(m.costUsd, null, "unpriceable must be null, never 0");
  assert.strictEqual(m.costSource, "unknown");
  const s = summariseArm("B", [m]);
  assert.strictEqual(s.costUsd.total, null, "a total built from unpriced sessions is a lie");
  assert.strictEqual(s.unpricedSessions, 1);
  assert.ok(s.window.pct > 0.4, "the window cost is knowable without any price table");
});

check("the CLI's own cost figure beats the local price table", () => {
  const m = meterSession([
    JSON.stringify({ message: { model: "claude-opus-4-5", usage: { input_tokens: 1000, output_tokens: 1000 } } }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.4242 }),
  ]);
  assert.strictEqual(m.costUsd, 0.4242, "the CLI knows the real model and TTL; the table guesses");
  assert.strictEqual(m.costSource, "cli");
});

check("the self-grade gap measures own-tests minus held-out", () => {
  const a = summariseArm("A", []);
  const b = summariseArm("B", []);
  const c = compare(a, b, { heldOut: { A: 0.5, B: 0.6 }, ownTests: { passRate: 0.95, mergedNodes: 10 } });
  // Trellis's gates were 95% green; the spec was only 60% satisfied.
  assert.strictEqual(c.selfGradeGap, 0.35);
});

// ------------------------------------------------------ env-failure detection

check("env detection catches a missing Python module", () => {
  const r = detectEnvFailure(`Traceback (most recent call last):
  File "tests/test_x.py", line 3, in <module>
    import pandas as pd
ModuleNotFoundError: No module named 'pandas'`);
  assert.ok(r, "should have detected");
  assert.match(r.hint, /pandas/);
});

check("env detection catches a missing Node module", () => {
  const r = detectEnvFailure("Error: Cannot find module 'vitest'\n    at Module._resolveFilename");
  assert.ok(r, "should have detected");
  assert.match(r.hint, /vitest/);
});

check("env detection catches an absent binary on Windows and POSIX", () => {
  const win = detectEnvFailure("'pytest' is not recognized as an internal or external command,\noperable program or batch file.");
  assert.ok(win, "windows phrasing must be detected");
  assert.match(win.hint, /pytest/);
  const posix = detectEnvFailure("/bin/sh: 1: pytest: command not found");
  assert.ok(posix, "posix phrasing must be detected");
  assert.match(posix.hint, /pytest/);
});

// The value of this classifier is that it does NOT fire on ordinary failures. A
// false positive halts a healthy run, so these matter more than the cases above.
check("ADVERSARIAL env detection ignores an ordinary assertion failure", () => {
  assert.strictEqual(detectEnvFailure(`
AssertionError: expected 5 to equal 6
    at Object.<anonymous> (tests/add.test.mjs:4:8)
1 failing
`), null);
});

check("ADVERSARIAL env detection ignores prose that merely mentions imports", () => {
  assert.strictEqual(detectEnvFailure(
    "FAIL: the import of the config module should be lazy, but 2 modules were loaded eagerly"
  ), null);
  assert.strictEqual(detectEnvFailure("1 test failed: cannot find the user record"), null);
});

// ---------- unit: validateGraph surfaces every error class in one pass ----------
//
// validateGraph used to `return` the instant it found a field error, so a
// graph with both a missing field AND a real dependency cycle only ever
// reported the field error -- an author fixing errors one class at a time
// discovered the cycle only after the earlier round trip. Cycle detection
// now runs unconditionally; the collision/tags/coverage checks stay gated
// on acyclicity, since they assume well-formed fields and a hardened
// transitive-closure walk.
const graphCfg = { boundaries: { denyWrite: [] }, gate: {} };
check("validateGraph reports a cycle in the same pass as an unrelated field error", () => {
  const g = {
    nodes: [
      // missing "title" -- a field error
      { id: "a", goal: "do a", write: ["a.mjs"], gate: "true", deps: ["b"] },
      { id: "b", title: "b", goal: "do b", write: ["b.mjs"], gate: "true", deps: ["a"] },
    ],
  };
  const { errors } = validateGraph(g, graphCfg, os.tmpdir(), { requireTests: false });
  assert.ok(errors.some((e) => /missing "title"/.test(e)), `expected the field error, got: ${JSON.stringify(errors)}`);
  assert.ok(errors.some((e) => /Dependency cycle/.test(e)), `expected the cycle to surface too, got: ${JSON.stringify(errors)}`);
});
check("validateGraph does not attempt the collision scan on a cyclic graph", () => {
  // Two nodes claiming the SAME write path would normally be a collision
  // error too, but they're also mutually dependent -- a cyclic graph must
  // report only the cycle, not crash or double-report while walking
  // ancestors() on data that is not yet known to be acyclic.
  const g = {
    nodes: [
      { id: "a", title: "a", goal: "do a", write: ["shared.mjs"], gate: "true", deps: ["b"] },
      { id: "b", title: "b", goal: "do b", write: ["shared.mjs"], gate: "true", deps: ["a"] },
    ],
  };
  const { errors } = validateGraph(g, graphCfg, os.tmpdir(), { requireTests: false });
  assert.strictEqual(errors.length, 1, `expected exactly the cycle error, got: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /Dependency cycle/);
});
check("validateGraph still runs the collision scan when the graph is acyclic and otherwise valid", () => {
  const g = {
    nodes: [
      { id: "a", title: "a", goal: "do a", write: ["shared.mjs"], gate: "true" },
      { id: "b", title: "b", goal: "do b", write: ["shared.mjs"], gate: "true" },
    ],
  };
  const { errors } = validateGraph(g, graphCfg, os.tmpdir(), { requireTests: false });
  assert.ok(errors.some((e) => /can run concurrently but both claim write access/.test(e)),
    `expected the write-collision error, got: ${JSON.stringify(errors)}`);
});

// ---------- unit: ancestors() is cycle-safe ----------
check("ancestors computes the same transitive closure as before on an acyclic graph", () => {
  // a -> b -> c, a -> c directly too (diamond-ish), d is unrelated.
  const byId = new Map([
    ["a", { deps: ["b", "c"] }],
    ["b", { deps: ["c"] }],
    ["c", { deps: [] }],
    ["d", { deps: [] }],
  ]);
  const anc = ancestors(byId);
  assert.deepStrictEqual([...anc.get("a")].sort(), ["b", "c"]);
  assert.deepStrictEqual([...anc.get("b")].sort(), ["c"]);
  assert.deepStrictEqual([...anc.get("c")].sort(), []);
  assert.deepStrictEqual([...anc.get("d")].sort(), []);
});
check("ADVERSARIAL ancestors terminates and stays sound on a cyclic graph", () => {
  // a <-> b, both depending on c, plus an unrelated node d. A real cycle is
  // already rejected by validateGraph before this is ever reached in
  // practice; the property this proves is that a future caller cannot get a
  // crash, an infinite loop, or a false-POSITIVE ordering claim out of it --
  // only ever a possibly-incomplete (never over-complete) answer.
  const byId = new Map([
    ["a", { deps: ["b", "c"] }],
    ["b", { deps: ["a"] }],
    ["c", { deps: [] }],
    ["d", { deps: [] }],
  ]);
  const anc = ancestors(byId); // must return, not hang or throw
  // Soundness: every id ancestors() claims for a node must be reachable by
  // actually walking that node's own deps graph -- no fabricated edges.
  // Deliberately does NOT pre-seed `seen` with `start`: in a real cycle,
  // walking back to `start` via an actual edge chain is a sound thing for
  // ancestors() to report (b -> a -> b is a genuine, if trivial, closed
  // path), so self-reachability must be provable the same way as any other
  // node's, not excluded by construction.
  const reachable = (start, limit = 10) => {
    const seen = new Set();
    const stack = [...(byId.get(start)?.deps || [])];
    let steps = 0;
    while (stack.length && steps++ < limit) {
      const d = stack.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      for (const dd of byId.get(d)?.deps || []) stack.push(dd);
    }
    return seen;
  };
  for (const [id, set] of anc) {
    const real = reachable(id);
    for (const claimed of set) {
      assert.ok(real.has(claimed), `ancestors() claimed "${id}" -> "${claimed}" with no such reachable edge`);
    }
  }
  // d is untouched by the cycle and must be reported exactly.
  assert.deepStrictEqual([...anc.get("d")], []);
});

// ---------- unit: levels() is a longest-path, cycle-safe, iterative primitive ----------
check("levels computes longest-path depth, not shortest", () => {
  // a is a root. b and c both depend only on a (depth 1 each). e depends on
  // c (depth 2). d depends on BOTH b (depth 1) and e (depth 2) -- its own
  // depth must be 1 + the DEEPEST dependency, not the shallowest.
  const g = { nodes: [
    { id: "a", deps: [] },
    { id: "b", deps: ["a"] },
    { id: "c", deps: ["a"] },
    { id: "e", deps: ["c"] },
    { id: "d", deps: ["b", "e"] },
  ] };
  const depth = levels(g);
  assert.strictEqual(depth.get("a"), 0);
  assert.strictEqual(depth.get("b"), 1);
  assert.strictEqual(depth.get("c"), 1);
  assert.strictEqual(depth.get("e"), 2);
  assert.strictEqual(depth.get("d"), 3, `d must be 1 + its DEEPEST dep (e, depth 2), not its shallowest (b, depth 1)`);
});
check("ADVERSARIAL levels terminates and covers every node on a cyclic graph", () => {
  const g = { nodes: [
    { id: "a", deps: ["b"] },
    { id: "b", deps: ["a"] },
    { id: "d", deps: [] }, // unrelated, must still get a real depth
  ] };
  const depth = levels(g); // must return, not hang or throw
  assert.strictEqual(depth.size, 3, "every node must appear in the map, even one on a cycle");
  assert.strictEqual(depth.get("d"), 0);
  assert.strictEqual(typeof depth.get("a"), "number");
  assert.strictEqual(typeof depth.get("b"), "number");
});

for (const [s,n,m] of R) console.log(s==="pass"?`  \u001b[32m✓\u001b[0m ${n}`:`  \u001b[31m✗ ${n}\u001b[0m\n      ${m}`);
console.log(`\n${R.filter(r=>r[0]==="pass").length}/${R.length} unit checks passed`);
export const failed = R.some(r=>r[0]!=="pass");
if (process.argv[1]?.endsWith("units.mjs")) process.exit(failed?1:0);
