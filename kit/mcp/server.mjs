#!/usr/bin/env node
/**
 * Optional. The runner does NOT use this — it calls providers directly.
 *
 * This exists for the one case the graph does not cover: you are mid-conversation
 * with Opus, you want one small thing written by a cheap model, and spinning up a
 * whole graph run is overkill. All retries happen in here; Opus gets one compact
 * result, never the intermediate attempts.
 *
 * Registered in .mcp.json. Speaks MCP over stdio (JSON-RPC 2.0, line-delimited).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { chatWithBackoff } from "../lib/provider.mjs";
import { parseBlocks } from "../lib/extract.mjs";
import { exec } from "../lib/gate.mjs";
import { repoRoot } from "../lib/worktree.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = repoRoot() || process.cwd();
const cfg = loadConfig(root);

const TOOLS = [
  {
    name: "delegate",
    description:
      "Send one self-contained coding task to a cheap open-source model. Retries and tier " +
      "escalation happen internally; you get only the final result. Use for small isolated " +
      "work. For anything with dependencies, use a Trellis graph instead.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What must exist when this is done." },
        context: { type: "string", description: "Interfaces, types, or code the worker must call. Keep short." },
        verify: { type: "string", description: "Optional shell command that must exit 0 for the result to count." },
        role: { type: "string", enum: ["implementer", "fixer", "refactorer", "tester"], default: "implementer" },
      },
      required: ["goal"],
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function delegate({ goal, context = "", verify = null, role = "implementer" }) {
  const fs = await import("node:fs");
  const system = fs.readFileSync(path.join(HERE, "..", "roles", `${role}.md`), "utf8");
  const attempts = [];
  let feedback = null;

  for (const tier of cfg.tiers) {
    for (let a = 1; a <= tier.maxAttempts; a++) {
      const user =
        `# Task\n\n${goal}\n\n` +
        (context ? `## Context\n\n${context}\n\n` : "") +
        (verify ? `## Verification\n\nYour work must make this exit 0:\n\`\`\`\n${verify}\n\`\`\`\n\n` : "") +
        `## Output\n\nEmit complete files as:\n\n### FILE: relative/path.ext\n\`\`\`\n<contents>\n\`\`\`\n` +
        (feedback ? `\n## Previous attempt failed\n\n${feedback}\n` : "");

      let r;
      try {
        r = await chatWithBackoff(cfg, tier, [
          { role: "system", content: system },
          { role: "user", content: user },
        ]);
      } catch (e) {
        attempts.push(`${tier.name}#${a}: ${e.message}`);
        break;
      }

      const blocks = parseBlocks(r.text).filter((b) => b.kind === "write");
      if (!blocks.length) {
        attempts.push(`${tier.name}#${a}: no parseable file blocks`);
        feedback = "You produced no `### FILE:` blocks. Use exactly that format.";
        continue;
      }

      if (!verify) {
        return { ok: true, tier: tier.name, attempts: attempts.length + 1, files: blocks, text: r.text };
      }

      // Verification runs against files written to a scratch dir, never the repo.
      const os = await import("node:os");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-delegate-"));
      for (const b of blocks) {
        const p = path.join(tmp, b.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, b.content);
      }
      const res = await exec(verify, tmp, cfg.gate.timeoutMs);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (res.code === 0) {
        return { ok: true, tier: tier.name, attempts: attempts.length + 1, files: blocks, text: r.text };
      }
      attempts.push(`${tier.name}#${a}: verify exited ${res.code}`);
      feedback = `Verification failed (exit ${res.code}):\n${String(res.output).slice(-2000)}`;
    }
  }
  return { ok: false, attempts, reason: "exhausted every tier" };
}

let buf = "";
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "trellis-broker", version: "1.0.0" },
      });
    } else if (msg.method === "tools/list") {
      reply(msg.id, { tools: TOOLS });
    } else if (msg.method === "tools/call") {
      if (msg.params?.name !== "delegate") {
        replyErr(msg.id, -32601, `Unknown tool: ${msg.params?.name}`);
        continue;
      }
      try {
        const out = await delegate(msg.params.arguments || {});
        const summary = out.ok
          ? `Delegated to ${out.tier} in ${out.attempts} attempt(s). Files:\n\n` +
            out.files.map((f) => `### FILE: ${f.path}\n\`\`\`\n${f.content}\`\`\``).join("\n\n")
          : `Delegation exhausted. Trail:\n- ${out.attempts.join("\n- ")}\n\nTake this one yourself or split it.`;
        reply(msg.id, { content: [{ type: "text", text: summary }], isError: !out.ok });
      } catch (e) {
        replyErr(msg.id, -32603, e.message);
      }
    } else if (msg.id !== undefined) {
      replyErr(msg.id, -32601, `Unsupported method: ${msg.method}`);
    }
  }
});
