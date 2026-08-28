#!/usr/bin/env node
// PreToolUse (Bash) — the one-way doors stay out of a headless session's reach.
//
// MISSION.md is explicit under Non-goals: "A replacement for review on
// irreversible decisions. One-way doors get human eyes." `trellis accept
// --merge` on a high-risk node is exactly that door, and until this hook
// existed nothing mechanical stopped a headless stage session from opening it
// — `.claude/hooks/` matched only Read|Edit|Write, and Bash was wide open
// under `permissionMode: acceptEdits`.
//
// Gated on TRELLIS_STAGE, which the driver stamps on every spawned session
// (kit/lib/driver.mjs) and which `trellis propose` already trusts for the
// same reason (kit/bin/cli.mjs, the --from-evolve-stage hold). A human
// running these commands at an interactive prompt has no TRELLIS_STAGE set
// and is never touched by this file.
//
// Why a session cannot route around it: this hook runs in the harness,
// OUTSIDE the session's shell, before the Bash tool call executes. The
// session's own `env -u TRELLIS_STAGE` cannot unset what THIS PROCESS already
// read from its own environment — that env var came from the harness that
// spawned the session, not from the command string being screened.
//
// What this file genuinely cannot catch, named rather than pretended away: a
// command that copies cli.mjs somewhere else first and runs the copy no
// longer contains any string this hook recognises. String matching is a
// second layer over a permission the session should not need in the first
// place, not a sandbox — see references/worker-trust.md for the same
// admission about the gate itself.

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  if (!process.env.TRELLIS_STAGE) process.exit(0); // interactive / human session

  let cmd = "";
  try { cmd = String(JSON.parse(raw || "{}")?.tool_input?.command || ""); } catch { process.exit(0); }
  if (!cmd.trim()) process.exit(0);

  const deny = (why) => {
    process.stderr.write(
      `Blocked: ${why}\n` +
      `This stage session (TRELLIS_STAGE=${process.env.TRELLIS_STAGE}) may not run this command.\n` +
      `Command was: ${cmd}\n`
    );
    process.exit(2);
  };

  // Obfuscation gets refused outright rather than decoded and re-checked. A
  // stage session has no legitimate need for base64, eval, command
  // substitution, or a scrubbed environment anywhere near cli.mjs, the
  // "trellis" bin, or .claude.
  if (/\b(base64\s+-d|eval\b|env\s+-[ui]\b)|`|\$\(/.test(cmd) && /(cli\.mjs|\btrellis\b|\.claude)/.test(cmd)) {
    deny("the command obfuscates itself near the CLI or .claude — refused rather than parsed.");
  }

  // The one-way door named in MISSION.md's Non-goals: merging an unmerged
  // high-risk node is a human decision. `trellis apply-triage` deliberately
  // never calls this path either (see kit/bin/cli.mjs) — it appends to
  // .trellis/checkpoint.json instead.
  //
  // Matched against BOTH invocation forms: the full `node .../cli.mjs accept`
  // and the package.json "trellis" bin shortcut. Matching only the former
  // left `trellis accept x --merge` — a perfectly normal way to invoke this
  // CLI — completely invisible to this check.
  if (/\bcli\.mjs\s+accept\b/.test(cmd) || /(^|[;&|]|\s)trellis\s+accept\b/.test(cmd)) {
    deny(
      "`trellis accept` merges a high-risk node. MISSION.md: one-way doors get human eyes.\n" +
      "Use `trellis apply-triage` for the reversible verdicts; anything needing accept lands in " +
      ".trellis/checkpoint.json for a human to run."
    );
  }

  // The raw git equivalents of the same door, plus history rewrites. A global
  // option BEFORE the subcommand can carry its own value token (`-C .`,
  // `-c foo=bar`), not just a bare flag, so tolerating "any number of dash-
  // prefixed tokens" still broke on `git -C . merge`: `.` is not dash-
  // prefixed. `(?:\s+\S+)*?`, non-greedy, tolerates ANY tokens before the
  // subcommand instead of trying to enumerate which flags take a value —
  // false positives here (blocking a "merge" that was actually someone's
  // commit message, say) are the safe direction to be wrong in a guard
  // whose job is stopping a one-way door. `pull` (a merge by another name)
  // and the two low-level history-rewrite commands were previously absent
  // from this list outright.
  if (/\bgit\b(?:\s+\S+)*?\s+(merge|push|pull|reset\s+--hard|rebase|cherry-pick|branch\s+-D|update-ref|commit-tree)\b/.test(cmd)) {
    deny("raw git history/merge operations are a human decision in this system, not a stage session's.");
  }

  // The guard's own territory, and the rest of the protected set. Matched
  // against every way a shell can write a file, not just `>`. kit/bin/cli.mjs
  // itself is included: a session with no business rewriting the CLI it is
  // being run through.
  const protectedPaths =
    "\\.claude/hooks|\\.claude/settings\\.json|MISSION\\.md|" +
    "kit/lib/(gate|verify|mutate|worktree)\\.mjs|kit/bin/cli\\.mjs|kit/schema|kit/regression";
  const writeVerbs = "(>{1,2}|\\btee\\b|\\bsed\\s+-i|\\bcp\\b|\\bmv\\b|\\brm\\b|\\bnode\\s+-e|" +
    "\\bpython[0-9.]*\\s+-c|\\bgit\\s+checkout\\s+--|\\bgit\\s+restore\\b)";
  if (new RegExp(writeVerbs).test(cmd) && new RegExp(protectedPaths).test(cmd)) {
    deny("this command writes to a path a stage session may not touch: the protected set, or this guard itself.");
  }

  process.exit(0);
});
