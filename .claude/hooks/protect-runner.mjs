#!/usr/bin/env node
// PreToolUse (Edit|Write) — keep the orchestrator out of the runner's territory.
// Run state and live worktrees belong to kit/lib/runner.mjs, not to Claude.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let p = "";
  try { p = JSON.parse(raw || "{}")?.tool_input?.file_path || ""; } catch { process.exit(0); }
  const f = String(p).replace(/\\/g, "/");

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
  process.exit(0);
});
