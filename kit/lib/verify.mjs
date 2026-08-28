import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { exec, gateEnv } from "./gate.mjs";
import { detectEnvFailure } from "./envfail.mjs";
import { norm, matchDeny } from "./paths.mjs";

/**
 * Pre-run checks on the frozen tests themselves.
 *
 * Once a cheaper model writes the tests, the tests stop being trustworthy by
 * construction and have to be *verified*. Two of the three checks Opus did by
 * hand in run 1 are purely mechanical and belong here — no model calls, no
 * network, no cost:
 *
 *   1. every test file parses
 *   2. every test FAILS against an auto-generated null stub
 *
 * The third — that a plausible-wrong implementation is caught — needs a real
 * implementation to mutate, so it runs after the node passes. See mutate.mjs.
 */

/**
 * The languages the stub check actually understands.
 *
 * Everything below — `node --check`, the ESM import parser, the Proxy stub — is
 * JavaScript. Run against a Python or Go test this produced a `syntax` finding
 * on every node and killed the command, while the docs described non-vacuity as
 * a general guarantee. Neither the failure nor the guarantee was honest.
 *
 * So the scope is named. A test file in another language is reported as
 * unchecked rather than as broken, and `ok` does not depend on it — the same
 * treatment `no-tests` already gets. Better to say "this was not verified" than
 * to say "verified" when nothing was.
 */
export const CHECKABLE_EXT = new Set([".mjs", ".js", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

export function isCheckable(rel) {
  return CHECKABLE_EXT.has(path.extname(String(rel)).toLowerCase());
}

const IMPORT_RE =
  /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g;

// `const { a, b } = require('./x')` / `const mod = require('./x')`, and the
// dynamic-import equivalents `const { a } = await import('./x')` /
// `const mod = await import('./x')`. Both hand back the whole module rather
// than naming imports in the statement itself, so a destructuring pattern is
// the only place names ever appear; a bare binding is treated like
// `import * as mod`, which is what it is.
const REQUIRE_DESTRUCTURE_RE =
  /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_BARE_RE =
  /(?:const|let|var)\s+[\w$]+\s*=\s*(?:await\s+)?(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Extension-agnostic comparison between a resolved import specifier and a
 * declared write-scope path.
 *
 * Four of six realistic import forms used to fail an exact string comparison:
 * an extensionless specifier (`from '../src/calc'`), the TypeScript
 * `.js`-specifier-for-a-`.ts`-file convention, and (handled upstream, not
 * here) `require()` / dynamic `import()` were simply never matched by
 * IMPORT_RE at all. When comparison failed, `verifyTests` silently wrote no
 * stub and let the gate run against a repo where the implementation was
 * simply absent — reporting the resulting module-not-found error as
 * "non-vacuous" when nothing had been proven.
 *
 * Stripping a known extension from both sides before comparing the stem
 * handles the extensionless and `.js`-for-`.ts` cases in one rule. The
 * `/index` case handles a specifier that names a directory whose target
 * resolves through an index file.
 */
export function specMatchesTarget(resolvedSpec, targetRel) {
  const a = norm(resolvedSpec);
  const b = norm(targetRel);
  if (a === b) return true;
  const stripExt = (p) => (CHECKABLE_EXT.has(path.extname(p)) ? p.slice(0, -path.extname(p).length) : p);
  const aStem = stripExt(a);
  const bStem = stripExt(b);
  if (aStem === bStem) return true;
  if (bStem.endsWith("/index") && aStem === bStem.slice(0, -"/index".length)) return true;
  return false;
}

/** Names a test file imports from a given module path. */
export function importedNames(testSource, testFilePath, targetRel, root) {
  const names = new Set();
  let ns = false;

  const resolveAndMatch = (spec) => {
    if (!spec.startsWith(".")) return false;
    const resolved = path.relative(root, path.resolve(path.dirname(testFilePath), spec));
    return specMatchesTarget(resolved, targetRel);
  };

  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(testSource))) {
    const [, defaultWithBraces, braced, star, bare, spec] = m;
    if (!resolveAndMatch(spec)) continue;
    if (star) ns = true;
    if (bare || defaultWithBraces) names.add("__default__");
    for (const part of (braced || "").split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add(as[0].trim());
    }
  }

  REQUIRE_DESTRUCTURE_RE.lastIndex = 0;
  while ((m = REQUIRE_DESTRUCTURE_RE.exec(testSource))) {
    const [, braced, spec] = m;
    if (!resolveAndMatch(spec)) continue;
    for (const part of braced.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s*:\s*/); // destructured rename: `{ a: renamed }`
      names.add(as[0].trim());
    }
  }

  REQUIRE_BARE_RE.lastIndex = 0;
  while ((m = REQUIRE_BARE_RE.exec(testSource))) {
    const [, spec] = m;
    if (!resolveAndMatch(spec)) continue;
    ns = true;
  }

  return { names: [...names], namespace: ns };
}

/**
 * Whether a module path resolves to CommonJS rather than ESM under Node's own
 * rules, so buildStub can emit syntax the test's own `require()` (importedNames
 * already parses REQUIRE_DESTRUCTURE_RE / REQUIRE_BARE_RE, so CJS test files
 * are an explicitly supported input) can actually load.
 *
 * `.mjs`/`.mts` are always ESM; `.cjs`/`.cts` are always CommonJS; anything
 * else (`.js`, `.jsx`, `.ts`, `.tsx`) depends on the nearest ancestor
 * package.json's `"type"` field, exactly as Node resolves it — ESM only when
 * that field is literally `"module"`, CommonJS otherwise (including when no
 * package.json is found at all, which is Node's own default).
 */
export function isCJSTarget(root, targetRel) {
  const ext = path.extname(targetRel);
  if (ext === ".mjs" || ext === ".mts") return false;
  if (ext === ".cjs" || ext === ".cts") return true;
  let dir = path.resolve(root, path.dirname(targetRel));
  const top = path.resolve(root);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.type !== "module";
      } catch { /* an unparsable package.json is not this function's problem */ }
    }
    if (dir === top || dir === path.dirname(dir)) break; // reached repo root or filesystem root
    dir = path.dirname(dir);
  }
  return true; // Node's own default with no package.json found
}

/**
 * A stub that imports cleanly and does nothing useful. Importable matters: a
 * module-not-found error would prove only that the file is absent, not that the
 * tests discriminate.
 */
export function buildStub(names, { cjs = false } = {}) {
  // Each export must survive being used as a function, an object, an array, or a
  // primitive without throwing — otherwise the test dies on a TypeError and we
  // learn nothing about whether it actually asserts anything. A callable Proxy
  // absorbs every access shape and yields null.
  const lines = [
    "// Auto-generated by `trellis verify-tests`. Never written to your repo.",
    "// Every export is inert. A gate that passes against this file asserts nothing.",
    "",
    "const inert = () => new Proxy(function () {}, {",
    "  apply: () => null,",
    "  construct: () => ({}),",
    "  get(_t, p) {",
    "    if (p === Symbol.toPrimitive) return () => null;",
    "    if (p === Symbol.iterator) return function* () {};",
    "    if (p === Symbol.toStringTag) return 'Inert';",
    "    if (p === 'length' || p === 'size') return 0;",
    "    if (p === 'then' || p === 'constructor') return undefined;",
    "    return undefined;",
    "  },",
    "  has: () => false,",
    "  ownKeys: () => [],",
    "  getOwnPropertyDescriptor: () => undefined,",
    "});",
    "",
  ];
  // Only the export syntax below differs between the two module systems —
  // `require('./calc.js')` on a CommonJS-resolved target throws a bare
  // SyntaxError on the `export` keyword before the test ever runs, which
  // used to be scored as a non-zero exit indistinguishable from a real
  // assertion failure, i.e. "non-vacuous" — a test asserting nothing was
  // certified as having teeth.
  if (cjs) {
    lines.push("module.exports = {");
    for (const n of names) lines.push(`  ${n === "__default__" ? "default" : n}: inert(),`);
    lines.push("};");
  } else {
    for (const n of names) {
      if (n === "__default__") continue;
      lines.push(`export const ${n} = inert();`);
    }
    if (names.includes("__default__")) lines.push(`export default inert();`);
    if (!names.length) lines.push("export {};");
  }
  return lines.join("\n") + "\n";
}

/**
 * Run the mechanical checks. Returns { ok, findings: [{ nodeId, kind, message }] }.
 * Never touches the repo — everything happens in a temp copy.
 */
export async function verifyTests(cfg, graph, nodes, root, { log = () => {} } = {}) {
  const findings = [];
  // Node ids that reached the genuine non-vacuous success path below, for
  // callers that persist "this node's tests were proven, at this content"
  // as a precondition for a later `trellis run` rather than treating
  // verify-tests as advisory.
  const proven = [];

  for (const node of nodes.values()) {
    const tests = node.tests || [];
    if (!tests.length) {
      findings.push({ nodeId: node.id, kind: "no-tests", message: "declares no frozen tests; nothing pins its behaviour" });
      continue;
    }

    // Existence is language-independent and is checked for every test.
    let syntaxOk = true;
    for (const t of tests) {
      if (!fs.existsSync(path.join(root, t))) {
        findings.push({ nodeId: node.id, kind: "missing-test", message: `${t} does not exist` });
        syntaxOk = false;
      }
    }
    if (!syntaxOk) continue;

    // Everything past here is JavaScript-specific. Say so rather than emitting a
    // parse error for every Python file and calling the node broken.
    const foreign = tests.filter((t) => !isCheckable(t));
    if (foreign.length) {
      findings.push({
        nodeId: node.id,
        kind: "unsupported-language",
        message:
          `${foreign.join(", ")} — verify-tests checks JavaScript and TypeScript only, so ` +
          `non-vacuity was NOT established for this node. Its gate still runs during \`run\`; ` +
          `what is missing is the proof that the test rejects a do-nothing implementation.`,
      });
      continue;
    }

    // ---- 1. syntax ----
    // Argv, not an interpolated shell string. `t` comes from node.tests in
    // graph.json — derived from a product graph authored outside Trellis —
    // and `validateGraph` runs it through safeRelative before this can ever
    // be reached, but this call gets the second layer for free: spawnSync
    // with an argv array and no shell treats `abs` as one literal argument,
    // so a `$(...)`, a backtick, or a `"` in the path has no shell to reach.
    for (const t of tests) {
      const abs = path.join(root, t);
      const r = spawnSync(process.execPath, ["--check", abs], { cwd: root, encoding: "utf8", timeout: 30000 });
      const code = r.status ?? -1;
      if (code !== 0) {
        const output = (r.stdout || "") + (r.stderr || "");
        findings.push({ nodeId: node.id, kind: "syntax", message: `${t} does not parse:\n${output.slice(0, 500)}` });
        syntaxOk = false;
      }
    }
    if (!syntaxOk) continue;

    // ---- 2. non-vacuity against a null stub ----
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `trellis-verify-${node.id}-`));
    try {
      copyRepo(root, scratch, cfg);

      const targets = (node.write || []).filter((w) => !w.includes("*") && CHECKABLE_EXT.has(path.extname(w)));
      if (!targets.length) {
        findings.push({ nodeId: node.id, kind: "unstubbable", message: `write scope has no concrete module path, so non-vacuity cannot be checked` });
        continue;
      }

      let stubbedCount = 0;
      for (const target of targets) {
        const names = new Set();
        let ns = false;
        for (const t of tests) {
          const src = fs.readFileSync(path.join(root, t), "utf8");
          const got = importedNames(src, path.join(root, t), target, root);
          got.names.forEach((n) => names.add(n));
          ns ||= got.namespace;
        }
        if (!names.size && !ns) continue; // this test file doesn't import this target
        stubbedCount++;
        const abs = path.join(scratch, target);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buildStub([...names], { cjs: isCJSTarget(scratch, target) }));
      }

      // Every target skipped means no test in this node imports anything from
      // its write scope. The gate below would then run against a repo where
      // the implementation is simply ABSENT — a module-not-found error exits
      // non-zero exactly like a real assertion failure, and reporting that as
      // "non-vacuous" proves nothing. This is a HARD finding: unlike
      // `unstubbable` above (no concrete path exists to check at all), there
      // IS a concrete path here and the tests simply never reference it.
      if (!stubbedCount) {
        findings.push({
          nodeId: node.id,
          kind: "unstubbed",
          message:
            `none of this node's tests (${tests.join(", ")}) import anything from its write scope ` +
            `(${targets.join(", ")}) — non-vacuity could NOT be established. Either the tests import a ` +
            `different path than the contract declares, or they do not test what the node builds.`,
        });
        continue;
      }

      const r = await exec(node.gate, scratch, cfg.gate.timeoutMs, gateEnv(cfg), cfg.gate?.sandbox);
      if (r.code === 0) {
        findings.push({
          nodeId: node.id,
          kind: "vacuous",
          message:
            `the gate PASSES against a stub whose exports all return null. ` +
            `These tests assert nothing a worker must actually satisfy — a node with ` +
            `vacuous tests will go green without working.`,
        });
      } else {
        // A non-zero exit is the signal that the test has teeth — but a missing
        // dependency exits non-zero too, which would make every test in a broken
        // environment look strong and green-light a run that then fails on every
        // node. This is the cheapest place in the whole system to catch that: the
        // gates all run here, before any worker and before any money is spent.
        const env = detectEnvFailure(r.output);
        if (env) {
          findings.push({
            nodeId: node.id,
            kind: "env-failure",
            message:
              `the gate failed for an environment reason, not a test reason: ${env.hint}.\n` +
              `Non-vacuity could NOT be established — a missing dependency makes every ` +
              `test look strong. Install it and re-run verify-tests before running.`,
          });
        } else {
          log(node.id, "non-vacuous");
          proven.push(node.id);
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // `ok` means "nothing was found that makes a test untrustworthy". A node whose
  // language this cannot check has not been shown to be untrustworthy, only
  // unverified — the same standing as no-tests. Callers that need to know how
  // much was actually proven read SOFT_FINDINGS out of `findings`.
  return { ok: findings.filter((f) => !SOFT_FINDINGS.has(f.kind)).length === 0, findings, proven };
}

/** Findings that report a limit of this check rather than a defect in a test. */
export const SOFT_FINDINGS = new Set(["no-tests", "unstubbable", "unsupported-language"]);

/** Copy the working tree (minus git, worktrees) into a scratch dir, linking
 * node_modules rather than copying it. */
export function copyRepo(root, dest, cfg) {
  const skip = new Set([".git", "node_modules", cfg.paths.worktrees.replace("./", ""), cfg.paths.state.replace("./", "")]);

  // The scratch copy lands in os.tmpdir() — world-readable on most systems, and
  // outside whatever protects the repo — and then the gate command executes
  // there. Copying credentials into it served no purpose: the gate runs against
  // a stub, and gateEnv() already withholds the provider key. A SIGKILL between
  // the copy and the `finally` that removes it left them behind.
  //
  // denyWrite is the existing list of "things a worker has no business
  // touching", which is exactly the right list to not duplicate here.
  const deny = cfg.boundaries?.denyWrite ?? [];

  fs.cpSync(root, dest, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = norm(path.relative(root, src));
      if (!rel) return true;
      const top = rel.split("/")[0];
      if (skip.has(top)) return false;
      // Directories must stay traversable or their permitted children vanish;
      // the files inside are filtered on their own paths.
      if (fs.statSync(src).isDirectory()) return true;
      return !matchDeny(rel, deny);
    },
  });

  // node_modules is excluded from the copy above — copying it in full would
  // be slow (and pointless: dependencies aren't user code a check needs a
  // fresh view of) — but without it AT ALL, a gate like `npx vitest run` or
  // `npm test` cannot find its own test runner. Every gate on a project with
  // real dependencies then exits non-zero for a reason that has nothing to
  // do with vacuity: verifyTests' own detectEnvFailure catches this and
  // reports env-failure for every node, but mutate.mjs's mutation scorer has
  // no such check, and reads the identical failure as "every mutant killed"
  // — a systematically broken environment producing a perfect, meaningless
  // mutation score. Link instead of copying: same effect for Node's own
  // module resolution, none of the copy cost. `junction` on win32 because a
  // true directory symlink there needs admin rights or Developer Mode; a
  // junction needs neither and Node's fs API treats the two identically for
  // read access.
  const nodeModules = path.join(root, "node_modules");
  if (fs.existsSync(nodeModules)) {
    try {
      fs.symlinkSync(nodeModules, path.join(dest, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // A restrictive filesystem, or a leftover path from a prior run, can
      // make linking fail. Fall through and leave node_modules missing —
      // the same degraded behavior this function always had — rather than
      // letting a link failure crash verification outright.
    }
  }
}
