#!/usr/bin/env node
/**
 * Install Trellis into a target repo, or verify the current one.
 *
 *   node setup.mjs --into C:\path\to\your\repo
 *   node setup.mjs --probe
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
};
const has = (n) => argv.includes(`--${n}`);

const g = (s) => `\u001b[32m${s}\u001b[0m`;
const r = (s) => `\u001b[31m${s}\u001b[0m`;
const y = (s) => `\u001b[33m${s}\u001b[0m`;
const d = (s) => `\u001b[2m${s}\u001b[0m`;

// Everything an installed Trellis needs to actually work. This list was missing
// every v2.0 asset — the installed CLAUDE.md told the orchestrator to read
// MISSION.md and a contract under sessions/, neither of which was ever copied.
// verifyInstall() below is the guard that stops that recurring: it checks the
// installed tree against what the docs claim, rather than trusting this array.
export const PAYLOAD = [
  "kit",
  "sessions",
  "references",
  "evolution",
  "SKILLS",
  ".claude",
  ".vscode",
  "examples",
  "trellis.config.json",
  "MISSION.md",
  "CLAUDE.md",
  "CONTEXT.md",
  ".mcp.json",
  "trellis.code-workspace",
  "package.json",
  "README.md",
  "QUICKSTART.md",
  "UPGRADING.md",
  "CHANGELOG.md",
];

// Top-level entries deliberately not installed. Anything present in the kit but
// absent from both lists trips the regression fixture — a new asset cannot be
// silently forgotten the way sessions/ and references/ were.
export const NOT_INSTALLED = [
  ".gitignore",      // appended to the target's own, never copied over it
  "setup.mjs",       // the installer does not install itself
  ".trellis-seed",   // empty, unreferenced
  ".bench",          // A/B harness output: scratch repos and REPORT.md
  "tasks",           // this repo's own working notes; a target repo keeps its own
  ".github",         // this repo's own CI; a target repo keeps its own
  ".git",
  "node_modules",
];

let justInstalled = false;

// ---------------------------------------------------------------- completeness

// Paths the orchestrator is told to read but which are created at runtime rather
// than shipped. Referencing these is correct; their absence at install time is
// not a defect.
const RUNTIME_PATHS = [
  ".trellis", ".worktrees", "run.jsonl", "REPORT.md", "graph.json",
  // The cross-run evidence files. Written by triage and by `trellis friction`
  // as runs happen; absent on a fresh install, and that is correct.
  "triage.jsonl", "friction.jsonl", "skills.jsonl", "ledger.jsonl", "evolve.json",
  "cycle.json", "cases.json", "checkpoint.json",
];

/**
 * Every backtick-quoted path-looking token in a doc file.
 *
 * Globs and placeholders (`references/**`, `sessions/NN_stage/CONTEXT.md`) are
 * dropped rather than resolved — the point is to catch a whole missing tree, and
 * the concrete siblings in the same doc already prove the tree is there.
 */
export function referencedPaths(markdown) {
  const out = new Set();
  for (const [, tok] of markdown.matchAll(/`([^`\n]+)`/g)) {
    const t = tok.trim().replace(/[.,;:]$/, "");
    if (!/^[\w.@-]+(\/[\w.@-]+)*\/?$/.test(t)) continue;   // path-shaped only
    if (!/[/.]/.test(t)) continue;                          // bare words are prose
    if (t.includes("*") || /\bNN_/.test(t)) continue;       // glob or placeholder
    if (RUNTIME_PATHS.some((r) => t === r || t.startsWith(`${r}/`))) continue;
    out.add(t.replace(/\/$/, ""));
  }
  return [...out];
}

/**
 * Assert the installed tree contains everything CLAUDE.md and CONTEXT.md tell the
 * orchestrator to read. Checking the docs rather than the PAYLOAD array is the
 * whole point: the array was already wrong, and nothing noticed.
 */
export function verifyInstall(dest) {
  const missing = [];
  for (const doc of ["CLAUDE.md", "CONTEXT.md"]) {
    const p = path.join(dest, doc);
    if (!fs.existsSync(p)) { missing.push({ doc: "(payload)", ref: doc }); continue; }
    for (const ref of referencedPaths(fs.readFileSync(p, "utf8"))) {
      if (!fs.existsSync(path.join(dest, ref))) missing.push({ doc, ref });
    }
  }
  return missing;
}

/**
 * Copy the kit's own skills into .claude/skills and record a manifest claiming
 * them, so per-stage gating can later narrow or remove them. Without the manifest
 * the driver would treat them as hand-placed and refuse to touch them, and every
 * session would load all five regardless of stage.
 */
function bootstrapSkills(dest) {
  const src = path.join(dest, "SKILLS", "skills");
  if (!fs.existsSync(src)) return [];
  const names = fs.readdirSync(src).filter((n) => n.startsWith("trellis-"));
  if (!names.length) return [];

  const out = path.join(dest, ".claude", "skills");
  fs.mkdirSync(out, { recursive: true });
  for (const n of names) {
    fs.cpSync(path.join(src, n), path.join(out, n), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(out, ".manifest.json"), JSON.stringify({ written: names }, null, 2) + "\n");
  return names;
}

function probe(root) {
  let bad = 0;
  const say = (ok, msg, hint) => {
    console.log(`  ${ok ? g("+") : r("x")} ${msg}`);
    if (!ok) { bad++; if (hint) console.log(d(`      ${hint}`)); }
  };

  const major = Number(process.versions.node.split(".")[0]);
  say(major >= 20, `node ${process.versions.node}`, "Trellis needs Node 20+ (built-in fetch, stable worktree handling).");

  const gitv = spawnSync("git", ["--version"], { encoding: "utf8" });
  say(gitv.status === 0, `git ${(gitv.stdout || "").trim().replace("git version ", "")}`, "Install Git for Windows.");

  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  say(top.status === 0, `inside a git repo`, "Run `git init` in the target repo first — Trellis isolates workers with worktrees.");

  if (top.status === 0) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    say(head.status === 0, "repo has at least one commit", "Make an initial commit before running Trellis.");

    const clean = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    const dirty = (clean.stdout || "").trim();
    // Right after an install the only dirty files are the ones we just wrote, which
    // is expected — say so instead of reporting it as a problem.
    const onlyOurs = dirty && dirty.split("\n").every((l) =>
      PAYLOAD.some((item) => l.slice(3).replace(/^"|"$/g, "").startsWith(item)) ||
      l.slice(3).replace(/^"|"$/g, "").startsWith(".gitignore"));
    if (dirty && onlyOurs && justInstalled) {
      console.log(`  ${g("+")} working tree has the files just installed ${d("(commit them next)")}`);
    } else {
      say(dirty === "", "working tree clean", "Commit or stash — Trellis merges node branches into this branch.");
    }

    const wt = spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" });
    say(wt.status === 0, "git worktree available");
  }

  const cfgPath = path.join(root, "trellis.config.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const missing = [...new Set(
        (cfg.tiers || []).map((t) => t.apiKeyEnv).filter((e) => e && !process.env[e])
      )];
      say(missing.length === 0,
        missing.length ? `API key${missing.length > 1 ? "s" : ""} not set: ${missing.join(", ")}` : "tier API keys present",
        "setx OPENROUTER_API_KEY \"sk-or-...\"   then open a NEW terminal");

      // Env the project under construction needs, not env Trellis needs.
      const needed = (cfg.requiredEnv || []).map((e) => (typeof e === "string" ? { name: e } : e));
      const absent = needed.filter((e) => !process.env[e.name]);
      if (needed.length) {
        say(absent.length === 0,
          absent.length
            ? `project env not set: ${absent.map((e) => e.name).join(", ")}`
            : `project env present (${needed.map((e) => e.name).join(", ")})`,
          absent.map((e) => `${e.name}${e.why ? ` — ${e.why}` : ""}`).join("; "));
      }
    } catch {
      say(false, "trellis.config.json parses", "Fix the JSON syntax.");
    }
  }

  return bad;
}

function install(into) {
  const dest = path.resolve(into);
  if (!fs.existsSync(dest)) {
    console.log(r(`Target does not exist: ${dest}`));
    console.log(d(`Create it first, or check the path.`));
    process.exit(1);
  }
  if (!fs.statSync(dest).isDirectory()) {
    console.log(r(`Target is a file, not a directory: ${dest}`));
    process.exit(1);
  }
  if (path.resolve(HERE) === dest) {
    console.log(r(`That is the kit's own folder. Point --into at the repo you want to build.`));
    process.exit(1);
  }
  console.log(`Installing Trellis into ${dest}\n`);

  let copied = 0, skipped = 0;
  for (const item of PAYLOAD) {
    const from = path.join(HERE, item);
    const to = path.join(dest, item);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to) && !has("force")) {
      console.log(`  ${y("~")} ${item} ${d("already exists, skipped (use --force to overwrite)")}`);
      skipped++;
      continue;
    }
    fs.cpSync(from, to, { recursive: true, force: true });
    console.log(`  ${g("+")} ${item}`);
    copied++;
  }

  // .gitignore is appended to, never replaced
  const giFrom = fs.readFileSync(path.join(HERE, ".gitignore"), "utf8");
  const giTo = path.join(dest, ".gitignore");
  const existing = fs.existsSync(giTo) ? fs.readFileSync(giTo, "utf8") : "";
  const add = giFrom.split("\n").filter((l) => l.trim() && !existing.includes(l.trim()));
  if (add.length) {
    fs.writeFileSync(giTo, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + "\n# Trellis\n" + add.join("\n") + "\n");
    console.log(`  ${g("+")} .gitignore ${d(`(${add.length} line(s) appended)`)}`);
  }

  console.log(`\n${copied} copied, ${skipped} skipped\n`);
  console.log(d("  trellis.code-workspace is gitignored — the runner rewrites it during runs.\n"));

  // A half-installed Trellis is worse than none: the orchestrator reads CLAUDE.md,
  // is told to open files that do not exist, and improvises. Fail here instead.
  const missing = verifyInstall(dest);
  if (missing.length) {
    console.log(r("Install is incomplete — the docs reference files that were not copied:\n"));
    for (const { doc, ref } of missing) console.log(`  ${r("x")} ${ref} ${d(`(referenced by ${doc})`)}`);
    console.log(d(`
This is a bug in setup.mjs PAYLOAD, not in your target repo.
Nothing further will work correctly — the orchestrator would read CLAUDE.md and
be told to open files that are not there.`));
    process.exit(1);
  }
  console.log(`  ${g("+")} install verified ${d("(every path CLAUDE.md and CONTEXT.md reference exists)")}\n`);

  // SKILLS/skills is the single source of truth; .claude/skills is a materialised
  // view of it. Seed that view with the kit's own skills so the manual workflow
  // (/trellis-plan in an interactive session) works straight after install. The
  // driver narrows this per stage once a run starts.
  const seeded = bootstrapSkills(dest);
  if (seeded.length) {
    console.log(`  ${g("+")} .claude/skills seeded with ${seeded.length} kit skill(s) ${d("(the driver narrows this per stage)")}\n`);
  }

  justInstalled = true;
  console.log("Preflight:");
  const bad = probe(dest);

  console.log("");
  if (bad) {
    console.log(y(`${bad} thing(s) to fix before your first run. See QUICKSTART.md.`));
  } else {
    console.log(g("Ready."));
  }
  console.log(d(`
Next:
  cd ${dest}
  node kit/bin/cli.mjs doctor
  code trellis.code-workspace
  copy examples\\SPEC.template.md SPEC.md   (then fill it in)
  /trellis-plan SPEC.md                     (in Claude Code, Opus selected)
`));
}

// Only act when run as a script. The regression suite imports verifyInstall and
// referencedPaths from here, and importing must not install anything.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, "setup.mjs");

if (!isMain) {
  // imported for its helpers; do nothing
} else if (has("into")) {
  const target = val("into");
  if (!target) {
    console.log(r(`--into needs a path after it.`));
    console.log(d(`
To install into the folder you are standing in, the dot is required:

  node setup.mjs --into .

Or give an explicit path:

  node setup.mjs --into C:\\Users\\you\\PersonalProgams\\my-repo
`));
    process.exit(1);
  }
  install(target);
} else if (has("probe")) {
  console.log("Preflight:");
  const bad = probe(process.cwd());
  console.log(bad ? `\n${y(`${bad} problem(s).`)}` : `\n${g("Ready.")}`);
  process.exit(bad ? 1 : 0);
} else {
  console.log(`
Trellis setup

  node setup.mjs --into <path>   Install into a target repo
      --force                    Overwrite files that already exist
  node setup.mjs --probe         Check the current directory only
`);
}
