import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chatWithBackoff } from "./provider.mjs";
import { parseBlocks } from "./extract.mjs";
import { exec, gateEnv } from "./gate.mjs";
import { copyRepo } from "./verify.mjs";
import { safeRelative, matchDeny, matchAllow } from "./paths.mjs";

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
 * @returns {Promise<{ checked:number, survivors:Array<{mutation:string,reason:string}>, skipped:string[] }>}
 */
export async function checkMutations(cfg, node, worktree, root, { onStep } = {}) {
  const mutations = node.mutations || [];
  if (!mutations.length) return { checked: 0, survivors: [], skipped: [] };

  const tier = cfg.tiers[0]; // mutation is mechanical; always use the cheapest
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
  if (!impl.length) return { checked: 0, survivors: [], skipped: ["no concrete implementation files to mutate"] };

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

    const blocks = parseBlocks(reply.text).filter((b) => b.kind === "write");
    if (!blocks.length) {
      skipped.push(`${mutation} — mutator produced no file (likely not applicable)`);
      continue;
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `trellis-mut-`));
    try {
      copyRepo(worktree, scratch, cfg);
      let wrote = 0;
      for (const b of blocks) {
        const safe = safeRelative(scratch, b.path);
        if (!safe.ok) continue;
        // A mutant may only touch the node's own implementation — never the tests.
        if (matchDeny(safe.rel, node.tests || [])) continue;
        if (!matchAllow(safe.rel, node.write || [])) continue;
        fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
        fs.writeFileSync(safe.abs, b.content);
        wrote++;
      }
      if (!wrote) {
        skipped.push(`${mutation} — mutator wrote nothing inside the node's scope`);
        continue;
      }

      const r = await exec(node.gate, scratch, cfg.gate.timeoutMs, gateEnv(cfg));
      checked++;
      if (r.code === 0) {
        survivors.push({
          mutation,
          reason: "the gate still passed with this defect present, so the tests do not detect it",
        });
        onStep?.({ mutation, survived: true });
      } else {
        onStep?.({ mutation, survived: false });
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  return { checked, survivors, skipped };
}
