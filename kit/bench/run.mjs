#!/usr/bin/env node
// A/B harness: Trellis vs. plain Claude Code on an identical spec.
//
//   node kit/bench/run.mjs --spec SPEC.md --out .bench --arm both
//   node kit/bench/run.mjs --spec SPEC.md --dry-run      (no spend; validates the rig)
//
// THE METHODOLOGY POINT, because everything else is downstream of it:
//
//   Both arms are scored by a held-out acceptance suite that NEITHER arm can see.
//
// Trellis writes its own tests and merges nodes when those tests pass. Score it on
// its own tests and it wins by construction, and the whole experiment says nothing.
// So the held-out suite is authored from the spec, independently, before either arm
// runs, and is kept outside both working repos.
//
// Both arms are driven the same way — `claude -p --output-format stream-json` —
// so they differ in WHAT is asked, not HOW it is invoked.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { meterSession, summariseArm, compare, WINDOW } from "./meter.mjs";
import { scoreHeldOut, armSelfGrade } from "./score.mjs";
import { STAGES } from "../lib/driver.mjs";
import { loadConfig } from "../lib/config.mjs";

// verify(root, cfg) — the second argument is not optional in spirit: 06_triage
// and 07_evolve route through cfg.paths.state. Omitting it silently read the
// default location and, for 07, threw.
const cfgFor = (dir) => { try { return loadConfig(dir); } catch { return undefined; } };
import { renderReport } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d = null) => {
  const i = argv.indexOf(`--${f}`);
  return i < 0 || !argv[i + 1] || argv[i + 1].startsWith("--") ? d : argv[i + 1];
};

const DRY = has("dry-run");
const OUT = path.resolve(val("out", ".bench"));
const SPEC = val("spec", "SPEC.md");
const ARM = val("arm", "both");
// Fraction of a 5-hour window this run may consume before it stops itself.
// 0.8 leaves room to look at what it produced; --max-window 0 disables.
const WINDOW_CAP = Number(val("max-window", "0.8")) || null;

// The prompts are the experiment's independent variable, so they live in an
// editable file rather than inline here — otherwise what ran and what the report
// claims ran can drift apart without anyone noticing.
const PROMPTS = JSON.parse(fs.readFileSync(path.join(HERE, "prompts.json"), "utf8"));

// ---------------------------------------------------------------- session

/**
 * One headless Claude Code session, capturing stream-json for metering.
 *
 * In --dry-run this emits a canned transcript instead of spawning anything, so the
 * whole rig — metering, comparison, report — can be validated before a cent is
 * spent. A measurement apparatus you have not tested is not a measurement.
 */
function session(cwd, prompt, { stage = null, model = null } = {}) {
  if (DRY) {
    const canned = [
      { type: "assistant", message: { model: model ?? "claude-opus-4-5", usage: {
        input_tokens: 4200, output_tokens: 800, cache_creation_input_tokens: 12000, cache_read_input_tokens: 0 } } },
      { type: "assistant", message: { model: model ?? "claude-opus-4-5", usage: {
        input_tokens: 300, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 12000 } } },
      { type: "result", subtype: "success" },
    ].map((r) => JSON.stringify(r));
    return Promise.resolve({ lines: canned, exitCode: 0, ms: 1000 });
  }

  // PERMISSIONS — the single most expensive lesson this harness has learned.
  //
  // A headless session cannot answer a permission prompt, so anything requiring
  // one is declined in silence. The first real run made zero writes across five
  // sessions and still paid full price for 7.8M tokens.
  //
  // `acceptEdits` was the first fix and it is NOT sufficient: it auto-approves
  // Edit/Write, but every Trellis artifact is produced by a Bash call
  // (`node kit/bin/cli.mjs ingest|slice|...`), and Bash is not an edit. Arm A
  // needs unrestricted Bash too — npm install, test runs — and an allowlist
  // narrow enough to be safe would handicap Arm A and bias the comparison.
  //
  // So: bypassPermissions, scoped to a throwaway repo under .bench/ that is
  // rm -rf'd at the start of every run. The repo's own PreToolUse hooks
  // (block-secrets, protect-runner) still fire — those are not permissions.
  // `--safe-permissions` reverts to acceptEdits if you want to watch it fail.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  args.push("--permission-mode", has("safe-permissions") ? "acceptEdits" : "bypassPermissions");

  const started = Date.now();
  return new Promise((resolve) => {
    // Same latent bug as kit/lib/driver.mjs's runSession, same fix — see
    // that file's docblock. A globally-installed npm "claude" resolves to a
    // .cmd shim on Windows, which Node refuses to exec with shell:false;
    // shell:true needs each arg quoted or a multi-word prompt gets torn
    // into separate argv entries.
    const isWin = process.platform === "win32";
    const winQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;
    let c;
    try {
      c = spawn("claude", isWin ? args.map(winQuote) : args, {
        cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: isWin,
      });
    } catch (e) {
      resolve({ lines: [], exitCode: -1, ms: Date.now() - started, error: e.message });
      return;
    }
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", (e) => resolve({ lines: [], exitCode: -1, ms: Date.now() - started, error: e.message }));
    c.on("close", (code) => resolve({
      lines: out.split("\n").filter(Boolean),
      exitCode: code, ms: Date.now() - started, stderr: err,
    }));
  });
}

// ------------------------------------------------------------------- arms

/**
 * Persist the raw stream-json before metering it.
 *
 * The first run's report said $0.0000 against 7.8M tokens — a meter bug — and the
 * transcripts had not been kept, so the run could not be re-priced and the money
 * was simply gone. Cost accounting is derived data; the transcript is the source.
 * Never discard the source.
 */
function saveTranscript(arm, stage, lines) {
  const dir = path.join(OUT, "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${arm}-${stage}.jsonl`), lines.join("\n"));
}

/**
 * Stop before the window is gone, not after.
 *
 * The runner's Budget class caps worker spend; nothing capped orchestrator spend,
 * which is what a subscription actually rations. This is that brake: after each
 * stage, if the run has already eaten more of the 5-hour window than allowed, it
 * stops with artifacts intact rather than discovering the ceiling mid-stage.
 */
function windowGuard(metered, cap) {
  const used = metered.reduce((a, s) => a + (s.window?.pct ?? 0), 0);
  return { used, breached: cap != null && used >= cap };
}

function scratchRepo(name) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "bench@example.com");
  g("config", "user.name", "Trellis Bench");
  g("config", "commit.gpgsign", "false");
  return dir;
}

/** Arm A: plain Claude Code. The spec, an empty repo, nothing else. */
async function armA(specText) {
  const dir = scratchRepo("arm-a");
  fs.writeFileSync(path.join(dir, "SPEC.md"), specText);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "spec"], { cwd: dir });

  const started = Date.now();
  const r = await session(dir, PROMPTS.armA.prompt, { stage: "single" });
  saveTranscript("arm-a", "single", r.lines);
  const metered = [meterSession(r.lines, { stage: "single" })];

  // Arm B has six verify gates; Arm A had none, so a silently-declined Arm A
  // would have been scored as a legitimate 0% rather than as a broken run. It
  // gets the weakest possible check — did it write ANY file it was not given —
  // because anything stronger would prescribe method.
  const wrote = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout ?? "";
  if (!DRY && !wrote.trim()) {
    console.error(`\nSTOPPING: Arm A wrote nothing at all.`);
    console.error(`  ${r.exitCode !== 0 ? `session exited ${r.exitCode}` : "session exited cleanly — check --permission-mode"}`);
    console.error(`  Transcript kept at ${path.join(OUT, "transcripts/arm-a-single.jsonl")}`);
    process.exit(1);
  }

  return { dir, summary: summariseArm("A (plain Claude Code)", metered, { wallMs: Date.now() - started }) };
}

/**
 * Arm B: Trellis. Same spec; the pipeline decides everything else.
 *
 * Stage 05_build spends zero orchestrator tokens by design — it is the runner, not
 * a session — so its wall time counts toward total but not toward attended time.
 */
async function armB(specText, kitRoot, graphPath) {
  const dir = scratchRepo("arm-b");
  spawnSync(process.execPath, [path.join(kitRoot, "setup.mjs"), "--into", dir], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "SPEC.md"), specText);

  // The product graph is Arm B's second input and the thing 01_ingest validates.
  // Without it the very first stage fails and the run is over before it starts.
  fs.mkdirSync(path.join(dir, ".trellis"), { recursive: true });
  fs.copyFileSync(graphPath, path.join(dir, ".trellis", "product-graph.json"));

  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "trellis + spec + product graph"], { cwd: dir });

  const metered = [];
  const started = Date.now();
  let attended = 0;

  for (const stage of PROMPTS.armB.stages) {
    if (stage.runner) {
      console.log(`\n→ ${stage.id} (runner, no model)`);
      if (!DRY) spawnSync(process.execPath, [path.join(dir, "kit/bin/cli.mjs"), "run"], { cwd: dir, stdio: "inherit" });
      // The runner stage used to skip verification because it spends no
      // orchestrator tokens. Spending nothing is not the same as doing
      // something: a run that dispatched zero nodes (missing OPENROUTER_API_KEY,
      // dead model slug) left no REPORT.md and 06_triage would then triage air.
      const built = STAGES.find((s) => s.id === stage.id)?.verify(dir, cfgFor(dir));
      console.log(`  ${built?.ok ? "✓" : "✗"} ${stage.id} — ${built?.detail ?? "no verify defined"}`);
      if (!DRY && built && !built.ok) {
        console.error(`\nSTOPPING: the build stage produced no report.`);
        console.error(`  ${built.detail}`);
        console.error(`  Check OPENROUTER_API_KEY and that every tier model slug resolves`);
        console.error(`  (npm run doctor). 06_triage has nothing to triage without this.`);
        process.exit(1);
      }
      continue;
    }

    console.log(`\n→ ${stage.id} started ${new Date().toLocaleTimeString()}`);
    const r = await session(dir, stage.prompt, { stage: stage.id });
    saveTranscript("arm-b", stage.id, r.lines);
    metered.push(meterSession(r.lines, { stage: stage.id }));
    attended += r.ms;

    // Verify on disk, exactly as kit/lib/driver.mjs does. Without this the bench
    // happily ran every stage against declined writes and reported a completed
    // run. A stage that produced no artifact did not happen, whatever it cost.
    const check = STAGES.find((s) => s.id === stage.id)?.verify(dir, cfgFor(dir));
    const w = windowGuard(metered, WINDOW_CAP);
    console.log(`  ${check?.ok ? "✓" : "✗"} ${stage.id} — ${check?.detail ?? "no verify defined"} (${(r.ms / 1000).toFixed(0)}s)`);
    console.log(`  window: this stage ${(metered.at(-1).window.pct * 100).toFixed(1)}%, run so far ${(w.used * 100).toFixed(1)}% of a 5h window`);

    // Canned transcripts write nothing, so under --dry-run the gate reports but
    // does not stop. Otherwise the rig could never be exercised past stage one,
    // and an untested measurement apparatus is the thing this file is against.
    if (check && !check.ok && !DRY) {
      console.error(`\nSTOPPING: ${stage.id} produced no usable artifact.`);
      console.error(`  ${check.detail}`);
      if (r.exitCode !== 0) console.error(`  session exited ${r.exitCode}`);
      const tail = (r.lines.join("\n").match(/declined|permission|denied/i) || [])[0];
      if (tail) console.error(`  saw "${tail}" in the transcript — check --permission-mode.`);
      console.error(`\nEvery later stage depends on this one. Continuing would spend`);
      console.error(`money to produce nothing, which is what happened before this check existed.`);
      process.exit(1);
    }

    if (w.breached) {
      console.error(`\nSTOPPING: this run has consumed ${(w.used * 100).toFixed(0)}% of a 5-hour window`);
      console.error(`(cap: ${(WINDOW_CAP * 100).toFixed(0)}%, set with --max-window).`);
      console.error(`Artifacts through ${stage.id} are intact in ${dir}.`);
      console.error(`Stopping here leaves enough window to inspect them; continuing would not.`);
      process.exit(1);
    }
  }

  const ledger = path.join(dir, ".trellis/ledger.jsonl");
  let workerCostUsd = 0, workerTokens = 0;
  if (fs.existsSync(ledger)) {
    for (const line of fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        workerCostUsd += rec.costUsd ?? 0;
        workerTokens += (rec.tokensIn ?? 0) + (rec.tokensOut ?? 0);
      } catch { /* skip malformed */ }
    }
  }

  return {
    dir,
    summary: summariseArm("B (Trellis)", metered, {
      workerCostUsd, workerTokens, wallMs: Date.now() - started, attendedMs: attended,
    }),
    sessions: metered,
  };
}

// ------------------------------------------------------------------- main

async function main() {
  const kitRoot = path.resolve(HERE, "../..");
  const specPath = path.resolve(SPEC);
  if (!fs.existsSync(specPath)) {
    console.error(`No spec at ${specPath}. Both arms must receive the SAME spec file.`);
    process.exit(1);
  }
  const specText = fs.readFileSync(specPath, "utf8");

  // Arm B needs the product graph. Fail here with a clear message rather than
  // three minutes into a paid run when 01_ingest cannot find it.
  const graphPath = path.resolve(val("graph", "examples/scanner-product-graph.json"));
  if ((ARM === "both" || ARM === "b") && !fs.existsSync(graphPath)) {
    console.error(`No product graph at ${graphPath}.`);
    console.error(`Arm B cannot run without it — pass --graph <path>.`);
    process.exit(1);
  }

  // ---- pre-flight ----------------------------------------------------------
  // Everything below is checkable in milliseconds and each item, when absent,
  // costs a full window to discover. The rule: nothing that can be verified for
  // free happens after the first token is spent.
  if (!DRY) {
    const fail = (...msg) => { msg.forEach((m) => console.error(m)); process.exit(1); };

    // `claude` must be on PATH and runnable. A spawn failure mid-run reads as a
    // zero-token session, which is indistinguishable in the report from a
    // session that ran and did nothing.
    const probe = spawnSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
    if (probe.status !== 0) fail(`\`claude --version\` failed — the CLI is not runnable from here.`, String(probe.error ?? probe.stderr ?? "").trim());

    // Arm B's build stage dispatches to OpenRouter. Without the key every node
    // fails as env-failure, which examples/EVALUATION.md explicitly excludes
    // from the denominator — so the run would produce no capability measurement.
    if ((ARM === "both" || ARM === "b")) {
      const keys = new Set(
        JSON.parse(fs.readFileSync(path.join(kitRoot, "trellis.config.json"), "utf8"))
          .tiers.map((t) => t.apiKeyEnv).filter(Boolean)
      );
      const missing = [...keys].filter((k) => !process.env[k]);
      if (missing.length) fail(`Worker API key(s) not set: ${missing.join(", ")}.`, `Arm B's build stage would fail every node as env-failure.`);
    }

    // Anthropic key vs. subscription changes what the run costs and which limit
    // it hits, so the report must not be ambiguous about which one was used.
    console.log(process.env.ANTHROPIC_API_KEY
      ? `Auth: ANTHROPIC_API_KEY set — billed per token, documented limits, retryable 429s.`
      : `Auth: subscription credential — the 5-hour window is the binding constraint.\n` +
        `      Budget: ~${(WINDOW.budgetTokens / 1e6).toFixed(1)}M weighted tokens/window; this run stops at ${(WINDOW_CAP ?? 1) * 100}%.`);
  }

  // Refuse to score a run nothing can score. Both arms are graded by a held-out
  // suite neither can see; without it the run burns a subscription window and
  // produces two piles of code and no comparison.
  const heldOutPath = PROMPTS.scoring?.heldOutSuitePath;
  if (!DRY && heldOutPath && !fs.existsSync(heldOutPath)) {
    console.error(`Held-out suite configured but not present at ${heldOutPath}.`);
    console.error(`A configured path that does not exist scores nothing — check the path`);
    console.error(`in kit/bench/prompts.json before spending a window.`);
    process.exit(1);
  }
  if (!DRY && !heldOutPath) {
    console.error(`No held-out acceptance suite configured.`);
    console.error(`Set scoring.heldOutSuitePath in kit/bench/prompts.json first.`);
    console.error(``);
    console.error(`It must be authored from the SPEC alone, without the product graph in`);
    console.error(`context — a suite written by the graph's author inherits its blind spots,`);
    console.error(`and Arm B would be graded by its own assumptions.`);
    console.error(``);
    console.error(`Re-run with --dry-run to exercise the rig without it.`);
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });

  if (DRY) console.log("DRY RUN — canned transcripts, no sessions spawned, nothing spent.\n");

  const results = {};
  if (ARM === "both" || ARM === "a") results.a = await armA(specText);
  if (ARM === "both" || ARM === "b") results.b = await armB(specText, kitRoot, graphPath);

  // ---- score both arms, then compare -------------------------------------
  // Section 4 of the report ("Result — held-out suite") was structurally
  // always "—": compare() was called with an empty options object, so
  // heldOut/ownTests defaulted to {} and every derived per-node figure came
  // out null. Wire the real numbers in.
  //
  // scoreHeldOut() shells out to a suite in another repo, so score.mjs is not
  // importable from anything on the `npm test` path — this block is the only
  // caller. In --dry-run it is skipped and canned figures stand in, so the
  // section-4 render path is still exercised end to end with nothing spent.
  const scoring = PROMPTS.scoring ?? {};
  const heldOut = {};
  let ownTests = {};
  if (results.a && results.b) {
    if (DRY) {
      Object.assign(heldOut, { A: 0.62, B: 0.86 });
      ownTests = { passRate: 0.95, mergedNodes: 6 };
      console.log("\nDRY RUN — held-out scores are canned (A 62%, B 86%); nothing was executed.");
    } else {
      const opts = { suitePath: scoring.heldOutSuitePath, scanEntrypoint: scoring.scanEntrypoint };
      const hoA = scoreHeldOut(results.a.dir, opts);
      const hoB = scoreHeldOut(results.b.dir, opts);
      if (hoA) { heldOut.A = hoA.passRate; console.log(`\nheld-out · Arm A: ${hoA.pass}/${hoA.total} (${(hoA.passRate * 100).toFixed(1)}%)`); }
      if (hoB) { heldOut.B = hoB.passRate; console.log(`held-out · Arm B: ${hoB.pass}/${hoB.total} (${(hoB.passRate * 100).toFixed(1)}%)`); }
      if (!hoA && !hoB) console.error(`\nHeld-out suite produced no parseable totals — section 4 will read "—".`);
      const self = armSelfGrade(results.b.dir);
      if (self) ownTests = self;
    }
  }

  const cmp = results.a && results.b ? compare(results.a.summary, results.b.summary, { heldOut, ownTests }) : null;
  const report = renderReport({
    spec: specPath,
    dryRun: DRY,
    a: results.a?.summary ?? null,
    b: results.b?.summary ?? null,
    sessions: results.b?.sessions ?? [],
    comparison: cmp,
  });

  const outFile = path.join(OUT, "REPORT.md");
  fs.writeFileSync(outFile, report);
  fs.writeFileSync(path.join(OUT, "raw.json"), JSON.stringify({ a: results.a?.summary, b: results.b?.summary, comparison: cmp }, null, 2));
  console.log(report);
  console.log(`\nWritten to ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
