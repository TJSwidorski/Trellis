import path from "node:path";
import { indexNodes, normalizeNode } from "./graph.mjs";
import { createWorktree, removeWorktree, mergeNode, syncWorkspaceFile, isClean, currentBranch } from "./worktree.mjs";
import { runNode } from "./worker.mjs";
import { checkMutations } from "./mutate.mjs";
import { planTiers } from "./routing.mjs";
import { Budget } from "./budget.mjs";
import * as ledger from "./ledger.mjs";
import * as st from "./state.mjs";
import * as log from "./log.mjs";
import { writeReport } from "./report.mjs";

/**
 * The whole point of Trellis: this loop is deterministic code, not a model's
 * context. Opus produced graph.json and the contracts; from here on it is asleep.
 */
export async function run(cfg, graph, state, { dryRun = false, only = null, history = [] } = {}) {
  const root = cfg.__root;

  // Belt and braces: concurrency 0 makes the launch loop a no-op while the ready
  // set stays non-empty, which spins forever with no output. Never allow it, no
  // matter where the value came from.
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) {
    throw new Error(`concurrency must be a whole number >= 1, got ${JSON.stringify(cfg.concurrency)}.`);
  }

  const byId = indexNodes(graph);
  const nodes = new Map([...byId].map(([id, n]) => [id, normalizeNode(n, cfg)]));
  const budget = new Budget(cfg);
  // Set by the first node that hits a broken environment; stops further launches.
  let envHalt = null;

  if (!dryRun) {
    const branch = currentBranch(root);
    if (branch !== cfg.baseBranch) {
      throw new Error(`Repo is on branch "${branch}" but config.baseBranch is "${cfg.baseBranch}". Checkout ${cfg.baseBranch} first.`);
    }
    if (!isClean(root)) {
      throw new Error("Working tree is dirty. Commit or stash before running — Trellis merges into this branch.");
    }
  }

  const active = new Map();

  const depsSatisfied = (id) =>
    (nodes.get(id).deps || []).every((d) => st.LANDED.has(state.nodes[d]?.status));

  const depsDoomed = (id) =>
    (nodes.get(id).deps || []).some((d) =>
      [st.STATUS.EXHAUSTED, st.STATUS.BLOCKED, st.STATUS.CONFLICT, st.STATUS.REVIEW].includes(state.nodes[d]?.status)
    );

  const readySet = () =>
    [...nodes.keys()].filter(
      (id) =>
        state.nodes[id].status === st.STATUS.PENDING &&
        !active.has(id) &&
        (!only || only.includes(id)) &&
        depsSatisfied(id)
    );

  const markBlocked = () => {
    for (const id of nodes.keys()) {
      if (state.nodes[id].status === st.STATUS.PENDING && depsDoomed(id)) {
        state.nodes[id].status = st.STATUS.BLOCKED;
        const bad = (nodes.get(id).deps || []).filter((d) =>
          [st.STATUS.EXHAUSTED, st.STATUS.BLOCKED, st.STATUS.CONFLICT, st.STATUS.REVIEW].includes(state.nodes[d].status)
        );
        state.nodes[id].reason = `upstream not merged: ${bad.join(", ")}`;
        log.node(id, log.dim(`blocked (${state.nodes[id].reason})`));
        log.event("node.blocked", { id, deps: bad });
      }
    }
  };

  const launch = async (id) => {
    const node = nodes.get(id);
    state.nodes[id].status = st.STATUS.RUNNING;
    st.saveState(root, cfg, state);
    syncWorkspaceFile(root, cfg, [...active.keys(), id]);

    // ---- ledger-driven tier selection ----
    const plan = planTiers(cfg, node, history);
    const tierCfg = plan.tiers === cfg.tiers ? cfg : { ...cfg, tiers: plan.tiers };
    state.nodes[id].routing = plan.reason;
    if (plan.reason) log.node(id, log.dim(plan.reason));

    const riskTag = node.risk === "high" ? ", hold for review" : node.risk === "audit" ? ", audit after merge" : "";
    log.node(id, `${node.title}  ${log.dim(`[${node.role}${riskTag}]`)}`);
    log.event("node.start", { id, title: node.title, role: node.role, risk: node.risk, tags: node.tags });

    let wt;
    try {
      wt = createWorktree(root, cfg, id);
    } catch (e) {
      state.nodes[id].status = st.STATUS.EXHAUSTED;
      state.nodes[id].reason = `worktree: ${e.message}`;
      log.node(id, log.red(`worktree failed: ${e.message}`));
      return;
    }

    try {
      const result = await runNode(tierCfg, node, wt.dir, {
        onAttempt: (a) => {
          budget.record(a);
          const tag = a.ok ? log.green("pass") : log.red(a.kind);
          log.node(id, `${a.tier}#${a.attempt} ${tag}${a.reason && !a.ok ? log.dim(` — ${String(a.reason).slice(0, 90)}`) : ""}`);
          log.event("node.attempt", { id, ...a });
        },
      });

      state.nodes[id].attempts = result.attempts;
      state.nodes[id].tier = result.tier;
      state.nodes[id].branch = wt.branch;

      // The environment is broken, not the node. Leave it PENDING so --resume
      // retries it once the dependency is installed, and halt the run — every
      // other node shares this environment and would fail the same way.
      if (result.status === "env-failure") {
        state.nodes[id].status = st.STATUS.PENDING;
        state.nodes[id].reason = result.env?.hint ?? "environment failure";
        envHalt ??= { id, ...result.env, feedback: result.feedback };
        log.node(id, log.red(`environment failure — ${result.env?.hint ?? "see below"}`));
        log.event("node.env_failure", { id, ...result.env });
        return;
      }

      if (result.status !== "passed") {
        state.nodes[id].status = st.STATUS.EXHAUSTED;
        state.nodes[id].reason = `all ${result.attempts.length} attempts failed across ${plan.tiers.length} tier(s)`;
        log.node(id, log.red(`EXHAUSTED after ${result.attempts.length} attempts — worktree kept at ${path.relative(root, wt.dir)}`));
        log.event("node.exhausted", { id, attempts: result.attempts.length });
        return;
      }

      // ---- mutation check: do the tests REJECT plausible-wrong code? ----
      let weak = false;
      if ((node.mutations || []).length && (cfg.verify?.mutationsOnPass ?? true)) {
        const mut = await checkMutations(cfg, node, wt.dir, root, {
          onStep: ({ mutation, survived }) =>
            log.node(id, survived
              ? log.red(`mutant SURVIVED: ${mutation.slice(0, 70)}`)
              : log.dim(`mutant killed: ${mutation.slice(0, 60)}`)),
        });
        state.nodes[id].survivingMutations = mut.survivors;
        state.nodes[id].mutationsChecked = mut.checked;
        state.nodes[id].mutationsSkipped = mut.skipped;
        log.event("node.mutations", { id, checked: mut.checked, survived: mut.survivors.length });
        if (mut.survivors.length) {
          weak = true;
          log.node(id, log.yellow(`${mut.survivors.length} mutant(s) survived — tests are weak here`));
        }
      }

      // ---- disposition ----
      if (node.risk === "high") {
        state.nodes[id].status = st.STATUS.REVIEW;
        state.nodes[id].reason = "high-risk node held for orchestrator review";
        log.node(id, log.yellow(`passed — held unmerged on ${wt.branch}`));
        log.event("node.review", { id, branch: wt.branch });
        return;
      }
      if (weak && (cfg.verify?.onSurvivor ?? "warn") === "hold") {
        state.nodes[id].status = st.STATUS.REVIEW;
        state.nodes[id].reason = "surviving mutants; held unmerged by verify.onSurvivor=hold";
        return;
      }

      const merge = mergeNode(root, cfg, id);
      if (!merge.ok) {
        state.nodes[id].status = merge.conflict ? st.STATUS.CONFLICT : st.STATUS.EXHAUSTED;
        state.nodes[id].reason = merge.message;
        log.node(id, log.red(`merge failed: ${merge.message.split("\n")[0]}`));
        log.event("node.merge_failed", { id, conflict: merge.conflict, message: merge.message });
        return;
      }

      state.nodes[id].status = weak ? st.STATUS.WEAK_TESTS : node.risk === "audit" ? st.STATUS.AUDIT : st.STATUS.MERGED;
      state.nodes[id].mergedAt = new Date().toISOString();
      removeWorktree(root, cfg, id, { quiet: true });
      const label = state.nodes[id].status === st.STATUS.MERGED
        ? `merged into ${cfg.baseBranch}`
        : `merged into ${cfg.baseBranch} — flagged ${state.nodes[id].status}`;
      log.node(id, state.nodes[id].status === st.STATUS.MERGED ? log.green(label) : log.yellow(label));
      log.event("node.merged", { id, tier: result.tier, status: state.nodes[id].status });
    } finally {
      st.saveState(root, cfg, state);
    }
  };

  // ---------- the loop ----------
  markBlocked();

  for (;;) {
    // An environment fault stops launching for the same reason a budget breach
    // does: continuing cannot produce information, only cost.
    const breach = budget.check() || (envHalt ? "environment failure" : null);
    if (!breach) {
      while (active.size < cfg.concurrency) {
        const ready = readySet();
        if (!ready.length) break;
        const id = ready[0];
        const p = launch(id)
          .catch((e) => {
            state.nodes[id].status = st.STATUS.EXHAUSTED;
            state.nodes[id].reason = `runner error: ${e.message}`;
            log.node(id, log.red(`runner error: ${e.message}`));
          })
          .finally(() => {
            active.delete(id);
            syncWorkspaceFile(root, cfg, [...active.keys()]);
          });
        active.set(id, p);
      }
    }

    if (active.size === 0) {
      if (breach) break;
      markBlocked();
      if (readySet().length === 0) break;
      continue;
    }

    await Promise.race(active.values());
    markBlocked();
  }

  if (envHalt) {
    log.warn(envHalt.feedback);
    log.event("run.env_halt", { id: envHalt.id, hint: envHalt.hint, matched: envHalt.matched });
    state.envHalt = { id: envHalt.id, hint: envHalt.hint, matched: envHalt.matched };
  }

  // A budget stop leaves everything untried marked so `--resume` picks it up and
  // the report says plainly that the run was cut short rather than finished.
  const breach = budget.check();
  if (breach) {
    log.warn(`Budget stop: ${breach}. In-flight nodes finished; the rest are untouched.`);
    for (const id of nodes.keys()) {
      if (state.nodes[id].status === st.STATUS.PENDING) {
        state.nodes[id].status = st.STATUS.BUDGET;
        state.nodes[id].reason = breach;
      }
    }
    log.event("run.budget_stop", { reason: breach, ...budget.snapshot() });
  }

  state.finishedAt = new Date().toISOString();
  state.budget = budget.snapshot();
  st.saveState(root, cfg, state);
  syncWorkspaceFile(root, cfg, keptWorktrees(state));

  const records = ledger.recordsFor(state, nodes);
  const ledgerFile = ledger.append(root, cfg, records);

  const reportPath = writeReport(root, cfg, graph, state);
  return { state, reportPath, ledgerFile, budget: budget.snapshot() };
}

function keptWorktrees(state) {
  const keep = [st.STATUS.EXHAUSTED, st.STATUS.REVIEW, st.STATUS.CONFLICT];
  return Object.entries(state.nodes).filter(([, v]) => keep.includes(v.status)).map(([k]) => k);
}
