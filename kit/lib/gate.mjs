import { spawn } from "node:child_process";
import { changedPaths, revertPaths, ignoredPaths } from "./worktree.mjs";
import { matchDeny, matchAllow } from "./paths.mjs";
import { detectEnvFailure, envFailureMessage } from "./envfail.mjs";
import { killTree, DETACH_FOR_TREE_KILL } from "./proc.mjs";
import { wrapForSandbox } from "./sandbox.mjs";

/**
 * Three checks, in order. The first two are free and catch the failure modes
 * cheap models actually exhibit; the third is the real oracle.
 *
 *   1. scope   — every changed path, including untracked, is inside node.write
 *   2. frozen  — no declared test file was touched
 *   3. command — the node's gate command exits 0
 *
 * 1 and 2 also run again, after 3. The command is untrusted code that just ran
 * with shell:true as the host user, and nothing above constrains what it does
 * once it starts — it can rewrite its own test file at import time, or append
 * to .trellis/triage.jsonl, as a side effect of running rather than as a
 * `### FILE:` block. That used to be invisible until the NEXT attempt's
 * pre-check ran, which never happens if THIS attempt is the one that passes
 * and merges. See the re-check after `exec` below.
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
    // Ignored paths can be whole collapsed directory entries (ignoredPaths'
    // docblock) — never hand those to revertPaths, only what changedPaths saw.
    const reverted = revertPaths(worktree, tampered.filter((p) => changed.includes(p)));
    const remaining = tampered.filter((p) => !reverted.includes(p));
    return {
      ok: false,
      kind: "test-tampering",
      feedback:
        `You modified frozen test files: ${tampered.join(", ")}.\n` +
        (reverted.length ? `Reverted: ${reverted.join(", ")}.\n` : "") +
        (remaining.length
          ? `NOT reverted — remove these yourself: ${remaining.join(", ")}.\n`
          : "") +
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
    const reverted = revertPaths(worktree, outOfScope);
    const remaining = outOfScope.filter((p) => !reverted.includes(p));
    return {
      ok: false,
      kind: "out-of-scope",
      feedback:
        `These paths are outside your write scope.\n` +
        (reverted.length ? `Reverted: ${reverted.join(", ")}.\n` : "") +
        (remaining.length
          ? `NOT reverted — remove these yourself: ${remaining.join(", ")}.\n`
          : "") +
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

  const res = await exec(cmd, worktree, cfg.gate.timeoutMs, gateEnv(cfg), cfg.gate?.sandbox);
  if (res.timedOut) {
    return {
      ok: false,
      kind: "timeout",
      feedback: `The gate command "${cmd}" did not finish within ${cfg.gate.timeoutMs}ms. Look for an infinite loop or a blocking call.`,
      changed,
      exitCode: null,
    };
  }
  // ---- 1 & 2 again: what changed WHILE the command ran ----
  // Getting here means the pre-checks above found nothing wrong with anything
  // on disk before `exec` started — otherwise this function would already have
  // returned. So any violation found now was caused by the command itself:
  // an import-time write, a test-runner plugin, a script the gate invoked.
  // This runs before the exit-code branches below on purpose — a rewritten
  // oracle that happens to make the suite pass is a worse outcome than one
  // that makes it fail, and neither exit code should be trusted once this
  // fires.
  const changedDuring = changedPaths(worktree);
  const ignoredDuring = ignoredPaths(worktree);
  const seenDuring = [...changedDuring, ...ignoredDuring];
  const tamperedDuring = seenDuring.filter((p) => matchDeny(p, node.tests || []));
  const deniedDuring = seenDuring.filter((p) => matchDeny(p, cfg.boundaries.denyWrite));
  const outOfScopeDuring = changedDuring.filter((p) => !matchAllow(p, node.write || []));
  const tampering = [...new Set([...tamperedDuring, ...deniedDuring, ...outOfScopeDuring])];
  if (tampering.length) {
    // Only hand changedPaths entries to revertPaths — an ignored one can be a
    // whole collapsed directory (node_modules/), and reverting that would be
    // its own outage. See ignoredPaths' docblock in worktree.mjs.
    const reverted = revertPaths(worktree, tampering.filter((p) => changedDuring.includes(p)));
    const remaining = tampering.filter((p) => !reverted.includes(p));
    return {
      ok: false,
      kind: "gate-tampering",
      feedback:
        `Running the gate command changed something it should not have: ${tampering.join(", ")}.\n` +
        (reverted.length ? `Reverted: ${reverted.join(", ")}.\n` : "") +
        (remaining.length
          ? `NOT reverted — remove these yourself: ${remaining.join(", ")}.\n`
          : "") +
        `This happened as a SIDE EFFECT of running your code — an import, a script, a plugin — not ` +
        `from a ### FILE: block. Whatever your implementation does at import or run time, make it stop ` +
        `touching test files, denied paths, or anything outside your write scope.`,
      changed: seenDuring,
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

export function exec(command, cwd, timeoutMs, env = process.env, sandbox = null) {
  return new Promise((resolve) => {
    // shell:true so "npm test -- foo" and Windows .cmd shims both work. That
    // makes `child` the SHELL, not the gate command itself — see killTree's
    // docblock in proc.mjs for why a timeout used to leave the real test
    // runner running forever, holding the stdio pipes open and hanging this
    // promise, instead of the command actually being killed. The same shell
    // is what lets wrapForSandbox prepend `ulimit` builtins ahead of the
    // real command when the (opt-in, off by default) sandbox is enabled.
    // `detached` (POSIX only; a no-op flag on Windows) puts the shell in its
    // own process group so killTree can signal the whole group, not just it.
    const child = spawn(wrapForSandbox(command, sandbox), {
      cwd, shell: true, windowsHide: true, env, detached: DETACH_FOR_TREE_KILL,
    });
    let out = "";
    let timedOut = false;
    // Per-stream decoders, not `d.toString()` per chunk: a multi-byte UTF-8
    // character (a non-ASCII assertion message, a `✓`/`✗` reporter glyph)
    // landing on a pipe chunk boundary used to decode each half independently
    // to U+FFFD, corrupting both the feedback text sent back to the model and
    // detectEnvFailure's own pattern matching against `output` below — which
    // could misclassify a real ModuleNotFoundError as an ordinary test
    // failure exactly when the corruption lands inside the matched text.
    // `{ stream: true }` holds any trailing incomplete byte sequence for the
    // next chunk instead of decoding it prematurely; stdout and stderr get
    // independent decoders because they are logically separate byte streams
    // that happen to interleave into the same accumulator.
    const stdoutDecoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");
    const cap = (decoder) => (d) => {
      out += decoder.decode(d, { stream: true });
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
    };
    child.stdout?.on("data", cap(stdoutDecoder));
    child.stderr?.on("data", cap(stderrDecoder));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    // Flush whatever a decoder is still holding — at most 3 bytes of a
    // not-yet-complete UTF-8 sequence — so the very last character of output
    // is never silently dropped.
    const flush = () => { out += stdoutDecoder.decode() + stderrDecoder.decode(); };
    child.on("error", (e) => {
      clearTimeout(timer);
      flush();
      resolve({ code: -1, output: out + `\n[spawn error] ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      flush();
      resolve({ code, output: out, timedOut });
    });
  });
}
