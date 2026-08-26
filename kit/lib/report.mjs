import fs from "node:fs";
import path from "node:path";
import { indexNodes } from "./graph.mjs";
import * as st from "./state.mjs";

/**
 * This file is the entire interface back to the orchestrator. Opus reads it
 * once, not a stream of worker chatter. Keep it dense and keep it short —
 * every line here costs Opus context.
 */
export function writeReport(root, cfg, graph, state) {
  const byId = indexNodes(graph);
  const { counts, total, done, stuck } = st.rollup(state);
  const usage = st.usageByTier(state);
  const L = [];

  L.push(`# Trellis run report`);
  L.push("");
  L.push(`- project: ${state.project}`);
  L.push(`- run: ${state.runId}`);
  L.push(`- graph: ${state.graphHash}`);
  L.push(`- finished: ${state.finishedAt || "(in progress)"}`);
  L.push(`- result: **${done}/${total} landed**${stuck ? `, ${stuck} need attention` : ""}`);
  if (state.budget?.breach) L.push(`- **run cut short: ${state.budget.breach}**`);
  L.push("");

  L.push(`## Status`);
  L.push("");
  L.push(`| node | status | tier | attempts | title |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const [id, s] of Object.entries(state.nodes)) {
    L.push(`| \`${id}\` | ${s.status} | ${s.tier || "-"} | ${(s.attempts || []).length} | ${byId.get(id)?.title || ""} |`);
  }
  L.push("");

  const needsWork = Object.entries(state.nodes).filter(([, s]) =>
    [st.STATUS.EXHAUSTED, st.STATUS.CONFLICT].includes(s.status)
  );

  if (needsWork.length) {
    L.push(`## Needs orchestrator decision`);
    L.push("");
    L.push(`Read only this section. For each node below, choose one:`);
    L.push(`re-decompose it into smaller nodes, rewrite its contract or tests, or take it yourself.`);
    L.push("");
    for (const [id, s] of needsWork) {
      const n = byId.get(id);
      L.push(`### \`${id}\` — ${n?.title || ""}`);
      L.push("");
      L.push(`- status: ${s.status}`);
      L.push(`- reason: ${s.reason || "(none)"}`);
      L.push(`- write scope: ${(n?.write || []).join(", ")}`);
      L.push(`- worktree kept at: \`${path.posix.join(cfg.paths.worktrees, id)}\``);
      const failures = (s.attempts || []).map((a) => `${a.tier}#${a.attempt}: ${a.kind}`);
      L.push(`- failure trail: ${failures.join(" → ") || "(none)"}`);
      // What the gate actually said, preferred over what kind of failure it was.
      // `reason` on a gate failure is just the kind again, so this block used to
      // repeat the last word of the failure trail and nothing else.
      const withOutput = (s.attempts || []).filter((a) => a.feedback).pop();
      const last = (s.attempts || []).filter((a) => a.reason).pop();
      const body = withOutput?.feedback || last?.reason;
      if (body) {
        L.push("");
        L.push(withOutput?.feedback ? `Last gate output (${withOutput.tier}#${withOutput.attempt}):` : "");
        L.push("```");
        L.push(String(body).slice(0, 1200));
        L.push("```");
      }
      L.push("");
    }
  }

  const weak = Object.entries(state.nodes).filter(([, s]) => (s.survivingMutations || []).length);
  if (weak.length) {
    L.push(`## Weak tests — a mutant survived`);
    L.push("");
    L.push(`These nodes passed their gates, and then a deliberately broken version of`);
    L.push(`the same code ALSO passed. The gate would not have caught the defect.`);
    L.push(`This says nothing about whether the code is right — it says the test cannot tell.`);
    L.push("");
    for (const [id, s] of weak) {
      L.push(`### \`${id}\` — ${byId.get(id)?.title || ""}`);
      L.push("");
      L.push(`- status: ${s.status} (${s.status === st.STATUS.WEAK_TESTS ? "merged anyway" : "held"})`);
      L.push(`- mutants checked: ${s.mutationsChecked ?? "?"}, survived: ${s.survivingMutations.length}`);
      for (const m of s.survivingMutations) L.push(`  - survived: ${m.mutation}`);
      L.push(`- fix: strengthen \`${(byId.get(id)?.tests || []).join(", ")}\` until each mutant fails, then re-run.`);
      L.push("");
    }
  }

  const audit = Object.entries(state.nodes).filter(([, s]) => s.status === st.STATUS.AUDIT);
  if (audit.length) {
    L.push(`## Merged, flagged for audit`);
    L.push("");
    L.push(`Tagged \`risk: audit\` — merged so dependants could proceed, but worth your eyes.`);
    L.push("");
    for (const [id, s] of audit) {
      L.push(`- \`${id}\` — ${byId.get(id)?.title || ""}  \`git show ${s.branch}\``);
    }
    L.push("");
  }

  const budgetStopped = Object.entries(state.nodes).filter(([, s]) => s.status === st.STATUS.BUDGET);
  if (budgetStopped.length) {
    L.push(`## Never attempted — budget stop`);
    L.push("");
    L.push(`${state.budget?.breach}. Resume with \`node kit/bin/cli.mjs run --resume\` after raising the ceiling.`);
    L.push("");
    for (const [id] of budgetStopped) L.push(`- \`${id}\``);
    L.push("");
  }

  const review = Object.entries(state.nodes).filter(([, s]) => s.status === st.STATUS.REVIEW);
  if (review.length) {
    L.push(`## Passed, held for review (high risk)`);
    L.push("");
    L.push(`These passed their gates but were tagged \`risk: high\`, so nothing was merged.`);
    L.push(`Review each diff, then merge:`);
    L.push("");
    for (const [id, s] of review) {
      L.push(`- \`${id}\` — ${byId.get(id)?.title || ""}`);
      L.push(`  - \`git diff ${cfg.baseBranch}...${s.branch}\``);
      L.push(`  - \`git merge --no-ff ${s.branch}\``);
    }
    L.push("");
  }

  const blocked = Object.entries(state.nodes).filter(([, s]) => s.status === st.STATUS.BLOCKED);
  if (blocked.length) {
    L.push(`## Blocked (never attempted)`);
    L.push("");
    for (const [id, s] of blocked) L.push(`- \`${id}\` — ${s.reason}`);
    L.push("");
  }

  L.push(`## Cost`);
  L.push("");
  L.push(`| tier | attempts | prompt tok | completion tok |`);
  L.push(`| --- | --- | --- | --- |`);
  for (const [tier, u] of Object.entries(usage)) {
    L.push(`| ${tier} | ${u.attempts} | ${u.prompt} | ${u.completion} |`);
  }
  if (!Object.keys(usage).length) L.push(`| (none) | 0 | 0 | 0 |`);
  L.push("");
  if (state.budget) {
    const b = state.budget;
    L.push(`Attempts: ${b.attempts} · elapsed ${(b.elapsedMs / 1000).toFixed(1)}s` +
      (b.costUsd !== null ? ` · est. $${b.costUsd.toFixed(4)}` : ""));
    L.push("");
  }
  L.push(`Orchestrator tokens spent during the run: **0**. Everything above ran headless.`);
  L.push("");

  const escalated = Object.entries(state.nodes).filter(
    ([, s]) => s.tier && s.tier !== cfg.tiers[0].name
  );
  if (escalated.length) {
    L.push(`## Decomposition signal`);
    L.push("");
    L.push(`${escalated.length} node(s) needed a stronger tier than \`${cfg.tiers[0].name}\`.`);
    L.push(`Consistent escalation usually means the node was too large or its contract too vague,`);
    L.push(`not that the model was too weak. Consider splitting these next time:`);
    L.push("");
    for (const [id, s] of escalated) L.push(`- \`${id}\` (landed on \`${s.tier}\`)`);
    L.push("");
  }

  const p = path.join(root, cfg.paths.state, "REPORT.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, L.join("\n"));
  return p;
}
