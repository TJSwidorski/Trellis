import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatWithBackoff, ProviderError } from "./provider.mjs";
import { parseBlocks, screenBlocks, worstFlag } from "./extract.mjs";
import { runGate } from "./gate.mjs";
import { commitWorktree } from "./worktree.mjs";
import { safeRelative, matchDeny } from "./paths.mjs";
import * as log from "./log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = path.join(HERE, "..", "roles");

function roleTemplate(role) {
  const p = path.join(ROLES_DIR, `${role}.md`);
  if (!fs.existsSync(p)) return fs.readFileSync(path.join(ROLES_DIR, "implementer.md"), "utf8");
  return fs.readFileSync(p, "utf8");
}

const OUTPUT_CONTRACT = `
## How to respond

Emit complete files. Never emit a diff, a patch, or a partial file with
"... rest unchanged ...". Each file you write must be the entire final contents.

For every file:

### FILE: relative/path/from/repo/root.ext
\`\`\`
<complete file contents>
\`\`\`

To remove a file:

### DELETE: relative/path/to/file.ext

Before the file blocks, write at most three sentences explaining your approach.
After them, write nothing. Do not explain the code.
`.trim();

/**
 * `node.read` was the one path list nothing checked.
 *
 * Writes go through safeRelative and the deny globs; reads went through
 * `path.join(root, rel)` and nothing else. A node declaring
 * `read: ["../../.env"]` read the host's secrets and inlined them into the
 * prompt POSTed to the provider — and validateGraph never inspected `read` at
 * all, so no earlier stage would have objected either.
 *
 * Same two rules the write side already uses: inside the tree, and not denied.
 * denyWrite is named for writes but its contents are "things a worker has no
 * business touching", which reads as much as writes.
 */
function readFileSafe(root, rel, maxBytes, { denyWrite = [] } = {}) {
  const safe = safeRelative(root, rel);
  if (!safe.ok) return null;
  if (matchDeny(safe.rel, denyWrite)) return null;
  const p = safe.abs;
  if (!fs.existsSync(p)) return null;
  const stat = fs.statSync(p);
  if (!stat.isFile()) return null;
  const buf = fs.readFileSync(p);
  const truncated = buf.length > maxBytes;
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    truncated,
  };
}

function fence(rel, text, truncated) {
  const ext = path.extname(rel).slice(1) || "";
  return `#### ${rel}${truncated ? "  (truncated)" : ""}\n\`\`\`${ext}\n${text}\n\`\`\``;
}

/**
 * Build the single user message for a node.
 * Deliberately narrow: contract, frozen tests, a few read files, and the write
 * scope. Cheap models degrade fast with long context — do not hand them the repo.
 */
export function buildPrompt(cfg, node, worktree) {
  const max = cfg.worker.maxContextFileBytes;
  const deny = cfg.boundaries?.denyWrite ?? [];
  const sections = [];

  sections.push(`# Task: ${node.title}\n\n${node.goal}`);

  if (node.acceptance) sections.push(`## Acceptance criteria\n\n${node.acceptance}`);
  if (node.notes) sections.push(`## Notes\n\n${node.notes}`);

  const testBlocks = [];
  for (const t of node.tests || []) {
    const f = readFileSafe(worktree, t, max, { denyWrite: deny });
    if (f) testBlocks.push(fence(t, f.text, f.truncated));
  }
  if (testBlocks.length) {
    sections.push(
      `## Frozen tests — these define correctness\n\n` +
      `These files already exist and you may NOT modify them. Your code must make them pass ` +
      `exactly as written.\n\n${testBlocks.join("\n\n")}`
    );
  }

  const readBlocks = [];
  for (const r of node.read || []) {
    const f = readFileSafe(worktree, r, max, { denyWrite: deny });
    if (f) readBlocks.push(fence(r, f.text, f.truncated));
  }
  if (readBlocks.length) {
    sections.push(`## Existing code for reference (read-only)\n\n${readBlocks.join("\n\n")}`);
  }

  const existing = [];
  for (const w of node.write || []) {
    if (w.includes("*")) continue;
    const f = readFileSafe(worktree, w, max, { denyWrite: deny });
    if (f) existing.push(fence(w, f.text, f.truncated));
  }
  if (existing.length) {
    sections.push(`## Current contents of files you may edit\n\n${existing.join("\n\n")}`);
  }

  sections.push(
    `## Your write scope\n\nYou may create or modify ONLY these paths:\n` +
    (node.write || []).map((w) => `- ${w}`).join("\n") +
    `\n\nAnything you write outside this list is discarded and counts as a failed attempt.`
  );

  sections.push(`## Gate\n\nYour work is accepted only when this exits 0:\n\n\`\`\`\n${node.gate}\n\`\`\``);

  sections.push(OUTPUT_CONTRACT);

  return sections.join("\n\n---\n\n");
}

function applyBlocks({ writes, deletes }) {
  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.abs), { recursive: true });
    fs.writeFileSync(w.abs, w.content, "utf8");
  }
  for (const d of deletes) {
    if (fs.existsSync(d.abs)) fs.rmSync(d.abs, { force: true });
  }
}

/**
 * Run one node to completion or exhaustion.
 * Walks tiers in order; within each tier, repairs up to maxAttempts using gate
 * feedback. Every attempt is recorded. Returns { status, attempts, tier }.
 */
export async function runNode(cfg, node, worktree, { onAttempt } = {}) {
  const system = roleTemplate(node.role);
  const attempts = [];
  let lastFeedback = null;

  for (const tier of cfg.tiers) {
    // A too-small output cap is answered with a bigger cap on the SAME tier,
    // not by escalating to a more expensive model — a stronger model does not
    // write shorter files. Capped at two free retries per tier so a
    // pathologically large node cannot spin forever; past that it escalates
    // like any other failure.
    let cap = tier.maxTokens;
    let truncationRetries = 0;
    const ceiling = tier.maxTokensCeiling ?? tier.maxTokens * 4;

    for (let a = 1; a <= tier.maxAttempts; a++) {
      // Rebuilt every attempt, not just once before the loop. The worktree
      // holds whatever the PREVIOUS attempt wrote — applyBlocks ran before
      // this point on any earlier iteration — so "Current contents of files
      // you may edit" reflects it. Built once up front, a retry asked the
      // model to fix code it could not see; for a brand-new file that
      // section was simply absent from the prompt.
      const prompt = buildPrompt(cfg, node, worktree);
      const messages = [{ role: "system", content: system }];
      if (lastFeedback) {
        messages.push({ role: "user", content: prompt });
        messages.push({ role: "assistant", content: "(previous attempt — files omitted)" });
        messages.push({
          role: "user",
          content:
            `Your previous attempt did not pass the gate.\n\n${lastFeedback}\n\n` +
            `Fix it. Re-emit every file you change, complete, using the same ### FILE: format.`,
        });
      } else {
        messages.push({ role: "user", content: prompt });
      }

      const record = { tier: tier.name, model: tier.model, attempt: a, startedAt: new Date().toISOString() };
      let reply;
      try {
        reply = await chatWithBackoff(cfg, tier, messages, { maxTokens: cap });
      } catch (e) {
        record.ok = false;
        // A plain if, not a nested ternary: the regression suite extracts kind
        // literals from source text via a single-level ternary regex, and a
        // third branch nested into the existing one would make "provider-error"
        // and "error" invisible to it — see kit/regression/run.mjs's kinds check.
        if (e instanceof ProviderError && e.truncated) {
          record.kind = "truncated";
          record.reason = e.message;
          attempts.push(record);
          onAttempt?.(record);
          if (truncationRetries < 2) {
            truncationRetries++;
            cap = Math.min(cap * 2, ceiling);
            lastFeedback = "Your previous reply was cut off before any file completed. Re-emit every file, complete.";
            a--; // free retry: does not consume the tier's attempt budget
            continue;
          }
          lastFeedback = null;
          break; // out of room even at the ceiling; a bigger model may fare better
        }
        record.kind = e instanceof ProviderError ? "provider-error" : "error";
        record.reason = e.message;
        attempts.push(record);
        onAttempt?.(record);
        lastFeedback = null; // provider trouble is not the model's fault; start clean
        break; // escalate tier rather than burn attempts on a broken endpoint
      }

      record.usage = reply.usage || null;
      record.ms = reply.ms;

      const blocks = parseBlocks(reply.text);
      const screened = screenBlocks(blocks, {
        worktree,
        allowWrite: node.write,
        denyWrite: cfg.boundaries.denyWrite,
        frozen: node.tests || [],
      });

      // Checked BEFORE the empty-writes test, not nested inside it. The
      // common truncation shape is two complete files and a third cut off
      // mid-fence — screened.writes.length is 2, not 0 — and nesting this
      // inside "produced nothing usable" meant that shape skipped straight
      // to applying the partial set and running the gate, which failed and
      // escalated a tier to solve what was never a capability problem.
      if (screened.flags.has("truncated")) {
        record.ok = false;
        record.kind = "truncated";
        record.reason = screened.rejections.join("; ");
        attempts.push(record);
        onAttempt?.(record);
        // Whatever DID complete is worth keeping — the next attempt's fresh
        // prompt will show it under "current contents", so the model only
        // has to finish what it started rather than regenerate everything.
        applyBlocks(screened);
        if (truncationRetries < 2) {
          truncationRetries++;
          cap = Math.min(cap * 2, ceiling);
          lastFeedback = "Your previous reply was cut off mid-file. Re-emit every file, complete.";
          a--; // free retry: does not consume the tier's attempt budget
          continue;
        }
        lastFeedback = "You keep running out of room. Re-emit every file, complete, as concisely as correctness allows.";
        continue;
      }

      if (!screened.writes.length && !screened.deletes.length) {
        record.ok = false;
        record.kind = "no-files";
        record.reason = screened.rejections.join("; ") || "model produced no parseable ### FILE: blocks";
        attempts.push(record);
        onAttempt?.(record);
        lastFeedback =
          `You produced no usable files.\n` +
          (screened.rejections.length ? `Rejected:\n- ${screened.rejections.join("\n- ")}\n` : "") +
          `Respond using exactly the "### FILE: path" + fenced block format.`;
        continue;
      }

      applyBlocks(screened);

      const gate = await runGate(cfg, node, worktree);
      record.ok = gate.ok;
      // A refused write is a more informative label than "the tests failed".
      record.kind = gate.ok ? gate.kind : (worstFlag(screened.flags) || gate.kind);
      record.gateKind = gate.kind;
      record.changed = gate.changed;
      if (gate.ok) {
        attempts.push(record);
        onAttempt?.(record);
        commitWorktree(worktree, `trellis(${node.id}): ${node.title}\n\ntier=${tier.name} attempt=${a}`);
        return { status: "passed", attempts, tier: tier.name };
      }

      // The environment, not the model. No stronger model can import a library
      // that is not installed, so retrying and escalating only spends money to
      // reproduce the same error. Bail out and let the runner halt the run.
      if (gate.kind === "env-failure") {
        record.reason = gate.kind;
        attempts.push(record);
        onAttempt?.(record);
        return { status: "env-failure", attempts, tier: tier.name, env: gate.env, feedback: gate.feedback };
      }

      record.reason = gate.kind;
      // Keep what the gate actually said, not just what kind of failure it was.
      // This text was going to the next model attempt and then being discarded,
      // so REPORT.md's fenced block for an exhausted node could only ever print
      // the word "test-failure" — and triage had to go run the gate by hand in
      // the kept worktree to learn anything. Truncated because it is stored per
      // attempt, per node, in state.json.
      record.feedback = String(gate.feedback || "").slice(-1200);
      attempts.push(record);
      onAttempt?.(record);
      lastFeedback =
        (screened.rejections.length ? `Some output was rejected:\n- ${screened.rejections.join("\n- ")}\n\n` : "") +
        gate.feedback;
    }

    if (cfg.tiers.indexOf(tier) < cfg.tiers.length - 1) {
      log.node(node.id, log.yellow(`escalating past "${tier.name}"`));
      lastFeedback = lastFeedback
        ? `A weaker model already tried and failed. Its last failure:\n\n${lastFeedback}`
        : null;
    }
  }

  return { status: "exhausted", attempts, tier: cfg.tiers[cfg.tiers.length - 1]?.name };
}
