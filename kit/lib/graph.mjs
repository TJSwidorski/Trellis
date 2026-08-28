import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { norm, globsOverlap, matchAny, matchDeny, safeRelative } from "./paths.mjs";
import { isIgnored } from "./worktree.mjs";
import { scopeBullets, findSpec } from "./spec.mjs";
import { findCycle } from "./graphutil.mjs";

const ROLES = ["implementer", "fixer", "refactorer", "tester"];
const RISKS = ["low", "audit", "high"];

export function loadGraph(repoRoot, graphPath) {
  const p = path.isAbsolute(graphPath) ? graphPath : path.join(repoRoot, graphPath);
  if (!fs.existsSync(p)) {
    throw new Error(`No graph at ${p}. Run /trellis-plan in Claude Code first.`);
  }
  let g;
  try {
    g = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`graph.json is not valid JSON: ${e.message}`);
  }
  g.__path = p;
  g.__hash = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
  return g;
}

/**
 * Validate structure, dependency integrity, cycles, and — the important one —
 * that no two nodes able to run concurrently declare overlapping write paths.
 * Returns { errors: [], warnings: [] }.
 */
export function validateGraph(graph, cfg, repoRoot, { requireTests = true } = {}) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return { errors: ["graph.nodes must be a non-empty array."], warnings };
  }

  const byId = new Map();
  for (const n of graph.nodes) {
    if (!n.id) { errors.push(`A node is missing "id".`); continue; }
    if (!/^[a-zA-Z0-9._-]+$/.test(n.id)) {
      errors.push(`Node id "${n.id}" must be alphanumeric with . _ - only (it becomes a git branch name).`);
    }
    if (byId.has(n.id)) errors.push(`Duplicate node id "${n.id}".`);
    byId.set(n.id, n);
  }

  for (const n of graph.nodes) {
    const at = `node "${n.id}"`;
    if (!n.title) errors.push(`${at}: missing "title".`);
    if (!n.goal) errors.push(`${at}: missing "goal" (what the worker must achieve).`);
    if (n.role && !ROLES.includes(n.role)) {
      errors.push(`${at}: role "${n.role}" is not one of ${ROLES.join(", ")}.`);
    }
    if (n.risk && !RISKS.includes(n.risk)) {
      errors.push(`${at}: risk "${n.risk}" must be one of ${RISKS.join(", ")}. ` +
        `"high" holds the node unmerged for review and stalls its dependants; ` +
        `"audit" merges it and flags it for review afterwards.`);
    }
    if (n.tags && (!Array.isArray(n.tags) || n.tags.some((t) => typeof t !== "string"))) {
      errors.push(`${at}: "tags" must be an array of strings. Tags are how the ledger generalises across runs.`);
    }
    if (n.mutations && (!Array.isArray(n.mutations) || n.mutations.some((m) => typeof m !== "string"))) {
      errors.push(`${at}: "mutations" must be an array of plain-language defect descriptions.`);
    }
    if (n.covers && (!Array.isArray(n.covers) || n.covers.some((c) => typeof c !== "string"))) {
      errors.push(`${at}: "covers" must be an array of scope-bullet strings from the spec.`);
    }
    if (!Array.isArray(n.write) || n.write.length === 0) {
      errors.push(`${at}: "write" must list at least one path or glob the worker may modify.`);
    }
    if (!n.gate && !cfg.gate.defaultCommand) {
      errors.push(`${at}: no "gate" command and no config.gate.defaultCommand. A node with no gate cannot be accepted.`);
    }
    for (const d of n.deps || []) {
      if (!byId.has(d)) errors.push(`${at}: depends on unknown node "${d}".`);
    }

    // Write paths must not collide with hard boundaries.
    for (const w of n.write || []) {
      if (matchDeny(w, cfg.boundaries.denyWrite)) {
        errors.push(`${at}: write path "${w}" is inside a denied boundary.`);
      }
    }

    // `read` was never inspected at all. Its contents go straight into the
    // prompt POSTed to the provider, so a path outside the tree or inside a
    // denied boundary exfiltrates whatever it names. Caught here as well as at
    // read time, because a graph that ASKS for it is worth rejecting loudly.
    if (n.read && !Array.isArray(n.read)) {
      errors.push(`${at}: "read" must be an array of repo-relative paths.`);
    }
    for (const r of Array.isArray(n.read) ? n.read : []) {
      const safe = safeRelative(repoRoot, String(r).replace(/[*?].*$/, "") || ".");
      if (!safe.ok) {
        errors.push(`${at}: read path "${r}" ${safe.reason}. Reads are inlined into the worker prompt.`);
      } else if (matchDeny(r, cfg.boundaries.denyWrite)) {
        errors.push(`${at}: read path "${r}" is inside a denied boundary; its contents would be sent to the provider.`);
      }
    }

    // Tests must exist on disk before the run — they are the acceptance oracle.
    for (const t of n.tests || []) {
      // `read` and `write` both go through safeRelative; `tests` never did.
      // verify-tests and the mutation checker both interpolate this path into
      // a shell command (`node --check "${abs}"`) — a traversal or an absolute
      // path here is not just a scoping bug, it is a path an attacker chose
      // reaching a shell with shell:true. graph.json is orchestrator-authored,
      // but it is derived from a product graph handed in from outside Trellis,
      // which the rest of this function already treats as untrusted enough to
      // validate rather than trust.
      const safe = safeRelative(repoRoot, t);
      if (!safe.ok) {
        errors.push(`${at}: test path "${t}" ${safe.reason}.`);
        continue;
      }
      const tp = safe.abs;
      if (!fs.existsSync(tp)) {
        const msg = `${at}: test file "${t}" does not exist. /trellis-tests writes these; they must exist before \`run\`.`;
        (requireTests ? errors : warnings).push(msg);
      }
      if (matchDeny(t, n.write || [])) {
        errors.push(`${at}: test file "${t}" is also in "write". Tests are frozen — a worker that can edit its own test has no gate.`);
      }
      // An ignored oracle is an invisible oracle: `git status` omits ignored
      // files even with --untracked-files=all, so edits to it would not appear
      // in the gate's frozen-test check. Cheaper to forbid here than to detect
      // there, and there is no legitimate reason to gitignore a frozen test.
      if (fs.existsSync(tp) && isIgnored(repoRoot, t)) {
        errors.push(
          `${at}: test file "${t}" is ignored by git. The gate cannot see edits to an ignored ` +
            `file, so a worker could rewrite this oracle undetected. Un-ignore it.`
        );
      }
    }
    if (!n.tests || n.tests.length === 0) {
      // MISSION invariant 1: nothing merges that was not proven against an
      // oracle written before the implementation existed. As a warning this was
      // not an invariant, it was a preference — such a node validated, ran, and
      // merged on whatever its gate command happened to say, which for a worker
      // that could reach package.json was whatever it wanted it to say.
      //
      // Still a warning under --plan, because at slice time the tests do not
      // exist yet and that is the whole point of the flag.
      const msg =
        `${at}: no "tests" declared. Nothing pins behaviour to a contract, so the gate ` +
        `proves only that some command exited 0. Declare a frozen test, or drop the node.`;
      (requireTests ? errors : warnings).push(msg);
    }
  }

  // ---- cycle detection ----
  //
  // Runs even when field errors already exist above (a missing title, an
  // unclaimed scope bullet, ...) -- an author fixing one error class at a
  // time used to discover a cycle, then a write collision, only after every
  // earlier error was already fixed: three round trips where one report
  // would do. Shared with product.mjs's ingest-time check (graphutil.mjs) --
  // that version used to be a separate, RECURSIVE implementation, which is
  // exactly the kind of algorithm that blows the call stack on a long enough
  // chain; this one was already iterative for that reason, so unifying them
  // fixed both the duplication and the stack-overflow risk in the same move.
  const cyc = findCycle(byId);
  if (cyc) errors.push(`Dependency cycle: ${cyc.join(" -> ")}`);

  // The remaining checks assume a structurally sound, acyclic graph: write
  // collision detection walks ancestors() (memoizes incorrectly on a cycle
  // until it is hardened separately), and every check below indexes fields
  // (write, tags, covers) that a field error above may mean are malformed
  // rather than merely absent. Reporting the cycle above cost nothing extra;
  // running these against a graph already known to be broken could crash
  // instead of reporting a third class of error.
  if (errors.length) return { errors, warnings };

  // ---- concurrency collision detection ----
  const anc = ancestors(byId);
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const ordered = anc.get(a).has(b) || anc.get(b).has(a);
      if (ordered) continue; // one waits for the other; sequential merge, no race
      const hit = globsOverlap(byId.get(a).write, byId.get(b).write);
      if (hit) {
        errors.push(
          `Nodes "${a}" and "${b}" can run concurrently but both claim write access to overlapping paths ` +
          `("${hit[0]}" vs "${hit[1]}"). Add a dependency edge between them or narrow the write globs.`
        );
      }
    }
  }

  // ---- redundant tags ----
  // Two tags applied to exactly the same nodes carry the same information and
  // split the ledger's observations for nothing. Routing needs concentrated
  // history, not a wider vocabulary.
  const tagNodes = new Map();
  for (const n of graph.nodes) {
    for (const t of n.tags || []) {
      if (!tagNodes.has(t)) tagNodes.set(t, new Set());
      tagNodes.get(t).add(n.id);
    }
  }
  const tagList = [...tagNodes.keys()];
  for (let i = 0; i < tagList.length; i++) {
    for (let j = i + 1; j < tagList.length; j++) {
      const a = tagNodes.get(tagList[i]), b = tagNodes.get(tagList[j]);
      if (a.size !== b.size || a.size === 0) continue;
      if ([...a].every((x) => b.has(x))) {
        warnings.push(
          `tags "${tagList[i]}" and "${tagList[j]}" cover exactly the same nodes, so one of them is noise. ` +
          `Drop one — the ledger learns faster from fewer, more distinct tags.`
        );
      }
    }
  }
  for (const n of graph.nodes) {
    if ((n.tags || []).length > 3) {
      warnings.push(`node "${n.id}": ${n.tags.length} tags. Two is usually right; more dilutes the ledger.`);
    }
  }

  // ---- spec coverage ----
  const spec = findSpec(repoRoot, cfg);
  if (spec) {
    const bullets = scopeBullets(spec.text);
    if (bullets.length) {
      const claimed = new Set();
      for (const n of graph.nodes) for (const c of n.covers || []) claimed.add(normaliseBullet(c));
      const uncovered = bullets.filter((b) => !claimed.has(normaliseBullet(b)));
      if (uncovered.length) {
        errors.push(
          `${uncovered.length} scope item(s) in ${spec.rel} have no node claiming them via "covers". ` +
          `A graph that silently omits scope is failure mode 5.\n` +
          uncovered.map((b) => `      - ${b}`).join("\n")
        );
      }
      const known = new Set(bullets.map(normaliseBullet));
      for (const n of graph.nodes) {
        for (const c of n.covers || []) {
          if (!known.has(normaliseBullet(c))) {
            warnings.push(`node "${n.id}": covers "${c}", which matches no scope bullet in ${spec.rel}.`);
          }
        }
      }
    }
  } else if (cfg.specPath) {
    warnings.push(`No spec found at ${cfg.specPath}; skipping the coverage check.`);
  }

  return { errors, warnings };
}

/** Loose match so wording drift between spec and graph doesn't cause false failures. */
function normaliseBullet(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Map id -> Set of all transitive dependencies.
 *
 * `validateGraph` only ever calls this after its own cycle check has already
 * passed, but this function is exported and has nothing to stop a future
 * caller (the level-aware slicing work is one) from reaching it on data that
 * has not been through that check. The old recursive version was unsound on
 * a cycle: `visit(id)` short-circuited to an empty `new Set()` the instant it
 * re-entered a node already on the current call stack, and that placeholder
 * then got permanently cached via `memo.set(id, out)` -- so a node whose
 * closure happened to be computed WHILE a cycle above it was still open
 * memoized a silently incomplete answer, reused by every later caller.
 *
 * Rewritten so no id's memo entry is ever written until its own walk has
 * finished, and a walk never consults another node's memo entry while that
 * node is still being resolved as part of the SAME walk (the `visiting` set
 * below) -- so a node cannot inherit its own not-yet-finished, and therefore
 * possibly incomplete, closure back through a memo lookup. On an acyclic
 * graph this computes exactly the same sets as before. On a cyclic one
 * (already rejected elsewhere, but this function has no way to enforce
 * that) the error is one-directional and safe for every caller that treats
 * the result as "definitely an ancestor, not exhaustively every ancestor":
 * a set here can be a subset of the true transitive closure, never a
 * superset, so `.has()` can wrongly say no but never wrongly say yes.
 */
export function ancestors(byId) {
  const memo = new Map();
  const resolve = (start) => {
    if (memo.has(start)) return memo.get(start);
    const out = new Set();
    const visiting = new Set([start]);
    const stack = [...(byId.get(start)?.deps || [])];
    while (stack.length) {
      const d = stack.pop();
      if (out.has(d) || visiting.has(d)) continue; // already counted, or folds back into this walk
      out.add(d);
      if (memo.has(d)) {
        for (const x of memo.get(d)) out.add(x);
        continue;
      }
      visiting.add(d);
      for (const dd of byId.get(d)?.deps || []) stack.push(dd);
    }
    memo.set(start, out);
    return out;
  };
  for (const id of byId.keys()) resolve(id);
  return memo;
}

export function indexNodes(graph) {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

/**
 * Longest-path depth per node: root nodes (no deps) are level 0, and every
 * other node is one more than the deepest of its own dependencies. Used
 * today only for `trellis validate`'s human-readable printout, and about to
 * become load-bearing for level-aware slicing and level-boundary re-gating
 * -- promoted to a hardened shared primitive now, on the low-stakes
 * presentation path, before it carries scheduling weight.
 *
 * The old recursive version had the same unsoundness `ancestors()` did: a
 * node re-entered while already on the current path returned a placeholder
 * depth of 0 (`if (seen.has(id)) return 0`), which then got permanently
 * cached via `depth.set(id, d)` for the node ABOVE the re-entry point in the
 * same call chain -- not just the one that closed the loop. On a graph this
 * function does not itself validate as acyclic, that under-reports depth
 * for every node whose longest path happens to pass through the cycle,
 * silently sorting them into an earlier level than their real dependency
 * chain implies.
 *
 * Rewritten as an iterative topological pass so a node's depth is only ever
 * computed once every one of its dependencies has a KNOWN depth, and a
 * dependency still unresolved when the graph runs out of visitable nodes
 * (only possible via a cycle) is reported rather than silently defaulted.
 * `validateGraph`'s own cycle check always runs before anything here does in
 * practice, so this mirrors `ancestors()`'s posture: not reachable as a live
 * bug today, hardened because the function is exported and level-aware
 * scheduling is about to depend on it being right.
 */
export function levels(graph) {
  const byId = indexNodes(graph);
  const depth = new Map();
  const indegree = new Map();
  const dependants = new Map(); // id -> ids that depend on it
  for (const id of byId.keys()) { indegree.set(id, 0); dependants.set(id, []); }
  for (const [id, n] of byId) {
    const deps = (n.deps || []).filter((d) => byId.has(d));
    indegree.set(id, deps.length);
    for (const d of deps) dependants.get(d).push(id);
  }

  const queue = [...byId.keys()].filter((id) => indegree.get(id) === 0);
  for (const id of queue) depth.set(id, 0);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const dep of dependants.get(id)) {
      const d = depth.get(dep) ?? -1;
      const candidate = depth.get(id) + 1;
      if (candidate > d) depth.set(dep, candidate);
      indegree.set(dep, indegree.get(dep) - 1);
      if (indegree.get(dep) === 0) queue.push(dep);
    }
  }
  // A node whose indegree never reached 0 sits on or downstream of a cycle
  // validateGraph should already have rejected. Fall back to depth 0 rather
  // than leaving it out of the map entirely -- every caller here indexes
  // every node id, and an absent entry is a worse surprise than a wrong one.
  for (const id of byId.keys()) if (!depth.has(id)) depth.set(id, 0);
  return depth;
}

export function normalizeNode(n, cfg) {
  return {
    id: n.id,
    title: n.title,
    goal: n.goal,
    role: n.role || "implementer",
    deps: n.deps || [],
    write: (n.write || []).map(norm),
    read: (n.read || []).map(norm),
    tests: (n.tests || []).map(norm),
    gate: n.gate || cfg.gate.defaultCommand,
    risk: n.risk || "low",
    notes: n.notes || "",
    acceptance: n.acceptance || "",
    tags: n.tags || [],
    mutations: n.mutations || [],
    covers: n.covers || [],
  };
}
