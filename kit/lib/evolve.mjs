// Self-improvement, gated.
//
// The failure mode this file exists to prevent: the cheapest way to make runs go
// green is to weaken the gate that keeps failing. A system that can edit its own
// gates and its own regression suite will find that path, and every metric will
// improve while the product gets worse.
//
// So: evidence before proposal, proposal before change, and a protected set that
// no proposal may touch at all.

import fs from "node:fs";
import path from "node:path";

// Never proposable. See MISSION.md. Prefix match on repo-relative paths.
export const PROTECTED = [
  "MISSION.md",
  "kit/lib/gate.mjs",
  "kit/lib/verify.mjs",
  "kit/lib/mutate.mjs",
  "kit/lib/worktree.mjs",
  "kit/schema/",
  "kit/regression/",
  ".claude/hooks/",
];

// Proposable, but a human merges. Correctness lives here.
export const LOAD_BEARING = [
  "kit/lib/",
  "kit/bin/",
  "kit/mcp/",
  "trellis.config.json",
  "sessions/",
];

// Proposable and auto-applied when the regression suite is green. Prose only.
export const ADVISORY = [
  "README.md",
  "QUICKSTART.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "references/",
  ".claude/skills/",
  "kit/roles/",
];

export function classify(relPath) {
  const p = relPath.replace(/\\/g, "/");
  if (PROTECTED.some((x) => p === x || p.startsWith(x))) return "protected";
  // Advisory is checked before load-bearing so references/ and .claude/skills/
  // are not swallowed by a broader prefix later.
  if (ADVISORY.some((x) => p === x || p.startsWith(x))) return "advisory";
  if (LOAD_BEARING.some((x) => p === x || p.startsWith(x))) return "load-bearing";
  return "unclassified";
}

// ------------------------------------------------------------------ evidence

// Triage records structured rejection codes, not prose. "the error handling is
// sloppy" cannot be counted; REJECT:unhandled-error-path across nine runs is a
// signal that the cases skill is missing a category.
export function rejectionCounts(root) {
  const p = path.resolve(root, ".trellis/triage.jsonl");
  if (!fs.existsSync(p)) return {};
  const counts = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n").filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    for (const d of row.decisions ?? []) {
      if (d.verdict !== "reject" || !d.code) continue;
      counts[d.code] ??= { count: 0, nodes: new Set(), runs: new Set() };
      counts[d.code].count++;
      counts[d.code].nodes.add(d.node ?? "?");
      if (row.run) counts[d.code].runs.add(row.run);
    }
  }
  return Object.fromEntries(
    Object.entries(counts).map(([code, v]) => [
      code,
      { count: v.count, nodes: [...v.nodes], runs: v.runs.size },
    ])
  );
}

// A pattern is actionable when the same code appears across enough distinct runs.
// Distinct runs, not distinct nodes: one bad slice producing the same code eight
// times is one observation about that slice, not eight about Trellis.
export function actionable(root, { minRuns = 3 } = {}) {
  return Object.entries(rejectionCounts(root))
    .filter(([, v]) => v.runs >= minRuns)
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.runs - a.runs);
}

// ------------------------------------------------------------------ proposal

export function writeProposal(root, { title, targets, rationale, evidence, change }) {
  const bad = targets.filter((t) => classify(t) === "protected");
  if (bad.length) {
    throw new Error(
      `Refusing to write a proposal touching protected paths: ${bad.join(", ")}\n` +
        `These are the immutable core. Editing them is a human decision, not a refinement.`
    );
  }

  const tier = targets.some((t) => classify(t) === "load-bearing" || classify(t) === "unclassified")
    ? "load-bearing"
    : "advisory";

  const dir = path.resolve(root, "evolution/proposals");
  fs.mkdirSync(dir, { recursive: true });
  const n = String(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length + 1).padStart(3, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const file = path.join(dir, `${n}-${slug}.md`);

  fs.writeFileSync(
    file,
    [
      `# ${title}`,
      "",
      `- **Tier:** ${tier}`,
      `- **Targets:** ${targets.join(", ")}`,
      `- **Written:** ${new Date().toISOString()}`,
      `- **Applies:** ${tier === "advisory" ? "automatically once the regression suite is green" : "only when a human merges it"}`,
      "",
      "## Evidence",
      "",
      evidence,
      "",
      "## Why this fixes the cause, not the symptom",
      "",
      rationale,
      "",
      "## Proposed change",
      "",
      change,
      "",
      "## Reviewer checklist",
      "",
      "- [ ] Does this weaken any gate, threshold, or acceptance condition?",
      "- [ ] Would the adversarial fixtures still fail if this ships?",
      "- [ ] Does it serve a MISSION.md invariant, or only make runs greener?",
      "",
    ].join("\n"),
    "utf8"
  );

  return { file: path.relative(root, file), tier };
}
