import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { chatWithBackoff } from "./provider.mjs";
import { parseBlocks } from "./extract.mjs";
import { exec, gateEnv } from "./gate.mjs";
import { detectEnvFailure } from "./envfail.mjs";
import { copyRepo } from "./verify.mjs";
import { safeRelative, matchDeny, matchAllow } from "./paths.mjs";
import { structurallyMutable, generateStructuralMutants } from "./structuralMutants.mjs";

/** How many mechanical, zero-token structural mutants run per node at most —
 *  bounds gate-execution cost on a file with many operators. Configurable
 *  via verify.structuralMutantLimit; see trellis.config.json. */
const DEFAULT_STRUCTURAL_LIMIT = 8;

/**
 * Post-gate mutation check — the third of Opus's run-1 verifications, automated.
 *
 * The idea: a passing gate proves the tests accept the implementation. It does
 * NOT prove the tests would REJECT a plausible-wrong one. Opus knows which wrong
 * implementations are plausible — that judgement is worth Opus tokens — but it
 * costs only a line of `mutations` in graph.json, not a hand-written test suite.
 *
 * We mutate the implementation the worker actually produced rather than a
 * throwaway reference, so no work is duplicated and the check is against real
 * accepted code.
 *
 * A surviving mutant means the tests are weak. It does not mean the code is
 * wrong — it means the gate would not have noticed if it were.
 */

const MUTATOR_SYSTEM = `
You are a mutation-testing engine. You are given working code and a description of
a specific defect. Reintroduce exactly that defect and nothing else.

Rules:
- Change only what the described defect requires. Do not fix, tidy, or refactor.
- The result must still parse and still import cleanly.
- Emit complete files using: ### FILE: path  followed by a fenced block.
- If the described defect does not apply to this code, emit no file blocks and say
  "NOT APPLICABLE" in one line of prose.
`.trim();

/**
 * Copy the worktree to a scratch dir, write `files` over it, run the gate,
 * and score the result — the part shared by an LLM-authored mutation (whose
 * file contents come back as ### FILE: blocks) and a structural one (whose
 * file contents are a single regex substitution). Mutates `survivors` /
 * `skipped` / running `checked` count in place via the returned outcome
 * rather than returning a new object per call, so callers stay simple.
 *
 * @returns {Promise<{outcome:"survived"|"killed"|"skipped", detail?:string}>}
 */
async function runMutantAgainstGate(cfg, node, worktree, files) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `trellis-mut-`));
  try {
    copyRepo(worktree, scratch, cfg);
    let wrote = 0;
    for (const f of files) {
      const safe = safeRelative(scratch, f.path);
      if (!safe.ok) continue;
      // A mutant may only touch the node's own implementation — never the tests.
      if (matchDeny(safe.rel, node.tests || [])) continue;
      if (!matchAllow(safe.rel, node.write || [])) continue;
      fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
      fs.writeFileSync(safe.abs, f.content);
      wrote++;
    }
    if (!wrote) return { outcome: "skipped", detail: "wrote nothing inside the node's scope" };

    const r = await exec(node.gate, scratch, cfg.gate.timeoutMs, gateEnv(cfg), cfg.gate?.sandbox);

    // A missing dependency exits non-zero exactly like a killed mutant —
    // verify.mjs's own null-stub check already treats this as disqualifying
    // rather than as proof of anything (see its comment: "a missing
    // dependency makes every test look strong"), and that reasoning was
    // never carried over here. Without it, a mutator that emits code with a
    // stray syntax error, an unbalanced brace, or an import of something
    // copyRepo's scratch tree does not have produces a non-zero exit for a
    // reason that has nothing to do with whether the tests discriminate —
    // scored as "killed" regardless, so a systematically broken mutator (or
    // environment) reports a perfect, meaningless mutation score forever.
    const env = r.code !== 0 ? detectEnvFailure(r.output) : null;
    if (env) return { outcome: "skipped", detail: `environment broken, not evaluated: ${env.hint}` };

    return { outcome: r.code === 0 ? "survived" : "killed" };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * @returns {Promise<{ checked:number, survivors:Array<{mutation:string,reason:string}>, skipped:string[] }>}
 */
export async function checkMutations(cfg, node, worktree, root, { onStep, onCall } = {}) {
  const mutations = node.mutations || [];
  const survivors = [];
  const skipped = [];
  let checked = 0;

  // The implementation as accepted, straight from the node's worktree.
  const impl = [];
  for (const w of node.write || []) {
    if (w.includes("*")) continue;
    const abs = path.join(worktree, w);
    if (fs.existsSync(abs)) impl.push({ path: w, content: fs.readFileSync(abs, "utf8") });
  }
  if (!impl.length) {
    return mutations.length
      ? { checked: 0, survivors: [], skipped: ["no concrete implementation files to mutate"] }
      : { checked: 0, survivors: [], skipped: [] };
  }

  if (mutations.length) {
    const tier = cfg.tiers[0]; // mutation is mechanical; always use the cheapest
    for (const mutation of mutations) {
      const user =
        `## Working implementation\n\n` +
        impl.map((f) => `### FILE: ${f.path}\n\`\`\`\n${f.content}\`\`\``).join("\n\n") +
        `\n\n## Defect to reintroduce\n\n${mutation}\n\n` +
        `Emit the complete mutated file(s) using the ### FILE: format.`;

      let reply;
      try {
        reply = await chatWithBackoff(cfg, tier, [
          { role: "system", content: MUTATOR_SYSTEM },
          { role: "user", content: user },
        ], { attempts: 2 });
      } catch (e) {
        skipped.push(`${mutation} — mutator call failed: ${e.message}`);
        continue;
      }
      // One provider call per mutation per node, and none of it reached
      // Budget before this — onAttempt only fires from runNode. At 40 nodes x
      // 3 mutations that is ~120 unmetered completions: maxCostUsd and
      // maxTotalAttempts were enforced against roughly half the real spend.
      onCall?.({ tier: tier.name, usage: reply.usage });

      const blocks = parseBlocks(reply.text).filter((b) => b.kind === "write");
      if (!blocks.length) {
        skipped.push(`${mutation} — mutator produced no file (likely not applicable)`);
        continue;
      }

      const result = await runMutantAgainstGate(cfg, node, worktree, blocks);
      if (result.outcome === "skipped") {
        skipped.push(`${mutation} — ${result.detail}`);
        onStep?.({ mutation, envFailure: /environment broken/.test(result.detail || "") });
        continue;
      }
      checked++;
      if (result.outcome === "survived") {
        survivors.push({
          mutation,
          reason: "the gate still passed with this defect present, so the tests do not detect it",
        });
        onStep?.({ mutation, survived: true });
      } else {
        onStep?.({ mutation, survived: false });
      }
    }
  }

  // ---- mechanical, zero-token structural mutants ----
  //
  // Runs whether or not the graph declared any `mutations` — Opus's
  // semantic judgement and this mechanical sweep test different things and
  // neither substitutes for the other. Capped and syntax-checked before
  // ever reaching the gate, so a mutation that would not even parse never
  // occupies a "checked" slot as a meaningless free kill.
  if (cfg.verify?.structuralMutants ?? true) {
    const limit = cfg.verify?.structuralMutantLimit ?? DEFAULT_STRUCTURAL_LIMIT;
    let structuralBudget = limit;
    for (const f of impl) {
      if (structuralBudget <= 0) break;
      if (!structurallyMutable(f.path)) continue;
      const candidates = generateStructuralMutants(f.content, { limit: structuralBudget });
      for (const candidate of candidates) {
        if (structuralBudget <= 0) break;
        const mutatedSource = candidate.mutate();
        // `node --check` on stdin always parses as CommonJS, rejecting a
        // perfectly valid .mjs file's `export`/`import` as a syntax error —
        // the check needs the real extension on disk, the same way
        // verify.mjs's own --check call works against a real file path
        // rather than piped source.
        const checkFile = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "trellis-mutcheck-")),
          path.basename(f.path)
        );
        let syntaxOk;
        try {
          fs.writeFileSync(checkFile, mutatedSource);
          syntaxOk = spawnSync(process.execPath, ["--check", checkFile], { encoding: "utf8" }).status === 0;
        } finally {
          fs.rmSync(path.dirname(checkFile), { recursive: true, force: true });
        }
        if (!syntaxOk) continue; // not a real mutant — never occupied the budget's "checked" count
        structuralBudget--;

        const label = `[structural] ${f.path}: ${candidate.description}`;
        const outcome = await runMutantAgainstGate(cfg, node, worktree,
          [{ path: f.path, content: mutatedSource }]);
        if (outcome.outcome === "skipped") {
          skipped.push(`${label} — ${outcome.detail}`);
          onStep?.({ mutation: label, envFailure: /environment broken/.test(outcome.detail || "") });
          continue;
        }
        checked++;
        if (outcome.outcome === "survived") {
          survivors.push({
            mutation: label,
            reason: "the gate still passed with this mechanical mutation present, so the tests do not detect it",
          });
          onStep?.({ mutation: label, survived: true });
        } else {
          onStep?.({ mutation: label, survived: false });
        }
      }
    }
  }

  return { checked, survivors, skipped };
}
