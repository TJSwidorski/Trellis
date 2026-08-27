#!/usr/bin/env node
// PreToolUse (Edit|Write) — keep the orchestrator out of the runner's
// territory, and out of every path CLAUDE.md / CONTEXT.md claim is
// hook-protected. Before this, the hook covered only three run-state
// filenames and .worktrees/ — MISSION.md and kit/ were documented as
// protected and were not, in fact, protected by anything.
//
// PROTECTED is imported rather than restated: MISSION.md is the source of
// truth (a regression check holds evolve.mjs's PROTECTED to what MISSION.md's
// fenced list names), and a hook keeping its own copy is exactly the drift
// this whole mirror-and-check pattern exists to prevent.
import { PROTECTED } from "../../kit/lib/evolve.mjs";

// Beyond PROTECTED: evidence a gate process or a hand-edit could forge to
// steer self-improvement, and the proposal directory, which must only ever
// be written through `trellis propose` — that command is what enforces the
// refusals above; writing into it directly bypasses all of them.
const EXTRA_PROTECTED = ["references/CODES.md", "evolution/proposals/", ".claude/settings.json", ".claude/settings.local.json"];
const JSONL_EVIDENCE = /(^|\/)\.trellis\/(triage|friction|ledger|skills)\.jsonl$/;

function under(f, base) {
  const b = base.replace(/\/+$/, "").toLowerCase();
  const a = f.toLowerCase();
  return a === b || a.startsWith(b + "/");
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let p = "";
  try { p = JSON.parse(raw || "{}")?.tool_input?.file_path || ""; } catch { process.exit(0); }
  const f = String(p).replace(/\\/g, "/").replace(/^\.\//, "");

  if (/(^|\/)\.trellis\/(state\.json|run\.jsonl|REPORT\.md)$/.test(f)) {
    process.stderr.write(
      `Blocked: ${p} is written by the Trellis runner. Editing it desynchronises the run.\n` +
      `To change what runs, edit .trellis/graph.json instead. To re-run failed nodes, ` +
      `use: node kit/bin/cli.mjs run --resume --retry-failed\n`
    );
    process.exit(2);
  }

  if (/(^|\/)\.worktrees\//.test(f)) {
    process.stderr.write(
      `Blocked: ${p} is inside a live worker worktree. Those are throwaway branches owned ` +
      `by the runner.\nTo inspect a failed node, read the files; to fix it, change its node ` +
      `contract in .trellis/graph.json and re-run.\n`
    );
    process.exit(2);
  }

  if (JSONL_EVIDENCE.test(f)) {
    process.stderr.write(
      `Blocked: ${p} is evidence self-improvement reads. It is append-only and written by code ` +
      `(\`trellis friction\`, \`trellis triage\`, the runner), never edited directly — a hand-edited ` +
      `line cannot be told apart from a forged one.\n`
    );
    process.exit(2);
  }

  if (PROTECTED.some((base) => under(f, base)) || EXTRA_PROTECTED.some((base) => under(f, base))) {
    process.stderr.write(
      `Blocked: ${p} is protected — see MISSION.md's protected set (or references/CODES.md, ` +
      `evolution/proposals/, and this hook's own config, which sit alongside it). This is a ` +
      `human edit, or a command's job (e.g. \`trellis propose\`), never Claude Code's Edit/Write.\n`
    );
    process.exit(2);
  }

  process.exit(0);
});
