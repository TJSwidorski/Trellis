import { spawn } from "node:child_process";
import { changedPaths, revertPaths, ignoredPaths } from "./worktree.mjs";
import { matchDeny, matchAllow } from "./paths.mjs";
import { detectEnvFailure, envFailureMessage } from "./envfail.mjs";

/**
 * Three checks, in order. The first two are free and catch the failure modes
 * cheap models actually exhibit; the third is the real oracle.
 *
 *   1. scope   — every changed path, including untracked, is inside node.write
 *   2. frozen  — no declared test file was touched
 *   3. command — the node's gate command exits 0
 */
export async function runGate(cfg, node, worktree) {
  // ---- 1 & 2: what actually changed on disk ----
  const changed = changedPaths(worktree);
  if (changed.length === 0) {
    return {
      ok: false,
      kind: "no-op",
      feedback: "You produced no file changes. Emit at least one `### FILE:` block with a complete file.",
      changed,
    };
  }

  // Ignored paths are invisible to `git status` even with --untracked-files=all,
  // so a write into one used to escape all three checks below. Included for
  // DETECTION only and never for the revert list: these entries can be whole
  // collapsed directories, and reverting node_modules/ would be its own outage.
  const ignored = ignoredPaths(worktree);
  const seen = [...changed, ...ignored];

  const tampered = seen.filter((p) => matchDeny(p, node.tests || []));
  if (tampered.length) {
    revertPaths(worktree, tampered);
    return {
      ok: false,
      kind: "test-tampering",
      feedback:
        `You modified frozen test files: ${tampered.join(", ")}. Those changes have been reverted.\n` +
        `The tests are the specification. Do not change them — change your implementation so the ` +
        `existing tests pass exactly as written.`,
      changed,
    };
  }

  // A denied path reached through an ignored one is still a denied path — and
  // it is the interesting case, because it is the one that was invisible.
  const deniedIgnored = ignored.filter((p) => matchDeny(p, cfg.boundaries.denyWrite));
  if (deniedIgnored.length) {
    return {
      ok: false,
      kind: "out-of-scope",
      feedback:
        `These paths are ignored by git and outside your write scope: ${deniedIgnored.join(", ")}.\n` +
        `They were not reverted — git does not track them — so remove them yourself and ` +
        `keep your changes inside: ${(node.write || []).join(", ")}.`,
      changed: seen,
    };
  }

  const outOfScope = changed.filter(
    (p) => !matchAllow(p, node.write || []) || matchDeny(p, cfg.boundaries.denyWrite)
  );
  if (outOfScope.length) {
    revertPaths(worktree, outOfScope);
    return {
      ok: false,
      kind: "out-of-scope",
      feedback:
        `These paths are outside your write scope and have been reverted: ${outOfScope.join(", ")}.\n` +
        `You may only create or modify: ${(node.write || []).join(", ")}.\n` +
        `If the task genuinely needs another file, say so in plain prose instead of writing it.`,
      changed,
    };
  }

  // ---- 3: the command ----
  const cmd = node.gate;
  if (!cmd) {
    return { ok: false, kind: "no-gate", feedback: "No gate command configured for this node.", changed };
  }

  const res = await exec(cmd, worktree, cfg.gate.timeoutMs, gateEnv(cfg));
  if (res.timedOut) {
    return {
      ok: false,
      kind: "timeout",
      feedback: `The gate command "${cmd}" did not finish within ${cfg.gate.timeoutMs}ms. Look for an infinite loop or a blocking call.`,
      changed,
      exitCode: null,
    };
  }
  if (res.code === 0) {
    return { ok: true, kind: "pass", changed, exitCode: 0, output: tail(res.output, 1000) };
  }

  // A missing library exits non-zero exactly like a failing assertion. Separating
  // them here is what stops the runner escalating tiers against an ImportError.
  const env = detectEnvFailure(res.output);
  if (env) {
    return {
      ok: false,
      kind: "env-failure",
      env,
      feedback: envFailureMessage(env, { nodeId: node.id, command: cmd }),
      changed,
      exitCode: res.code,
    };
  }

  return {
    ok: false,
    kind: "test-failure",
    feedback:
      `The gate command "${cmd}" exited ${res.code}. Output (tail):\n\n` +
      tail(res.output, cfg.gate.feedbackChars),
    changed,
    exitCode: res.code,
  };
}

function tail(s, n) {
  const str = String(s || "");
  return str.length <= n ? str : "...\n" + str.slice(str.length - n);
}

/**
 * The environment the gate command runs in.
 *
 * The gate executes code a cheap model just wrote, with shell:true, as the host
 * user. That is inherent to running tests and is not the finding. The finding
 * was that it inherited process.env entire, so the provider API key funding the
 * whole run was readable by every gate command, in every worktree, on every
 * attempt — including attempts by the model whose output was being judged.
 *
 * Path checks all happen BEFORE this point. None of them constrain what the
 * command does once it starts, so the credential should not be there to take.
 *
 * Scoped deliberately: this removes the keys Trellis itself introduced, named
 * by cfg.tiers[].apiKeyEnv plus cfg.gate.stripEnv. It is not a sandbox and does
 * not pretend to be one — a project whose own tests need a secret still has it.
 */
export function gateEnv(cfg, base = process.env) {
  const strip = new Set([
    ...(cfg?.tiers ?? []).map((t) => t.apiKeyEnv).filter(Boolean),
    ...(cfg?.gate?.stripEnv ?? []),
  ]);
  const env = { ...base };
  for (const name of strip) delete env[name];
  return env;
}

export function exec(command, cwd, timeoutMs, env = process.env) {
  return new Promise((resolve) => {
    // shell:true so "npm test -- foo" and Windows .cmd shims both work.
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env });
    let out = "";
    let timedOut = false;
    const cap = (d) => {
      out += d.toString();
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: out + `\n[spawn error] ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut });
    });
  });
}
