import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { norm } from "./paths.mjs";

/**
 * `raw: true` suppresses the trim on stdout.
 *
 * Trimming is right for the callers that read a single value — a branch name, a
 * SHA, a toplevel path. It is catastrophic for `--porcelain -z`, where each
 * record is `XY<space>path` and the status of an unstaged modification begins
 * with a SPACE. Trimming ate that space, shifted the first record by one
 * character, and handed every consumer a path with its first letter missing.
 */
export function git(cwd, args, opts = {}) {
  const { raw = false, ...spawnOpts } = opts;
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
    ...spawnOpts,
  });
  const stdout = r.stdout || "";
  // `r.error` is spawnSync's own failure — git not on PATH (ENOENT), the
  // process killed by a signal, or `maxBuffer` exceeded — as opposed to git
  // running to completion and exiting non-zero. It used to be dropped
  // entirely, so every one of those made `out` "" exactly like a genuinely
  // empty, successful result: isClean() read a failed spawn as "the tree is
  // clean" and changedPaths() read one as "nothing changed", both fail-OPEN
  // in the direction that matters (merging into dirty work; telling a model
  // its correct changes don't exist).
  const spawnFailed = Boolean(r.error);
  return {
    code: r.status ?? -1,
    out: raw ? stdout : stdout.trim(),
    err: spawnFailed ? r.error.message : (r.stderr || "").trim(),
    ok: r.status === 0 && !spawnFailed,
    spawnFailed,
  };
}

export function gitOrThrow(cwd, args) {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed:\n${r.err || r.out}`);
  return r.out;
}

export function repoRoot(from = process.cwd()) {
  const r = git(from, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return null;
  return path.resolve(r.out);
}

export function isClean(root) {
  const r = git(root, ["status", "--porcelain"]);
  // Fail closed: every caller of isClean() treats `false` as the safe
  // answer (runner.mjs refuses to start; `trellis doctor` reports a
  // problem), so a git status we could not even run must never read as
  // "clean" by falling through to the empty-string default below.
  if (r.spawnFailed) return false;
  return r.out === "";
}

export function currentBranch(root) {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
}

export function branchName(nodeId) {
  return `trellis/${nodeId}`;
}

/**
 * Every change in the worktree, including untracked files.
 * `git diff --name-only HEAD` misses untracked files entirely — a worker could
 * add a whole new module and the gate would never see it. Porcelain does not.
 *
 * `raw: true` is load-bearing, not a detail. Records are `XY<space>path`, and an
 * unstaged modification has the status " M" — a LEADING SPACE. Trimming stdout
 * removed it, so `entry.slice(3)` dropped the first character of the first path.
 * Two consequences, both silent: a tampered test file whose path sorted first no
 * longer matched `node.tests` and the gate ran against a worker-edited oracle,
 * and any node that MODIFIED an existing file saw its correct work reported
 * out-of-scope and burned every tier to exhaustion.
 *
 * The whole test suite missed it because every fixture creates new files, and
 * untracked records ("??") have no leading space.
 */
export function changedPaths(wt) {
  const r = git(wt, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true });
  // Unlike isClean(), there is no single safe default here: an empty array
  // reads as "no-op" to gate.mjs's caller, which is exactly backwards when
  // the real answer is "unknown" -- a worker that just wrote a correct
  // implementation would be told its changes don't exist. Throw instead, so
  // a broken git status surfaces as a loud, attributable failure on the one
  // node that hit it rather than a silent, indistinguishable no-op verdict.
  if (r.spawnFailed) throw new Error(`git status failed in ${wt}: ${r.err}`);
  const out = r.out;
  if (!out) return [];
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    // Renames/copies emit the source path as the next NUL-separated record.
    if (status[0] === "R" || status[0] === "C") {
      const src = parts[++i];
      if (src) files.push(norm(src));
    }
    if (file) files.push(norm(file));
  }
  return [...new Set(files)];
}

/**
 * Paths git is ignoring, which `changedPaths` cannot see.
 *
 * `--untracked-files=all` still omits ignored files, so a write into an ignored
 * path was invisible to the gate: it escaped the scope check, the frozen-test
 * check, and the revert. Screening in extract.mjs is path-based rather than
 * git-based and still catches an out-of-scope block, so this is the second
 * layer rather than the only one — but the second layer is exactly what is
 * supposed to catch a file the first layer was talked into allowing.
 *
 * `--ignored=traditional` collapses whole ignored directories to a single entry
 * (`node_modules/`), which is the point: `matching` enumerates every file inside
 * them and can run to hundreds of thousands of paths on a normal project. The
 * caller only needs to know that something ignored was touched and roughly
 * where, never to revert it — reverting node_modules would be its own outage.
 */
export function ignoredPaths(wt) {
  const r = git(
    wt,
    // --untracked-files must be on: ignored files ARE untracked, so `-uno`
    // suppresses the very entries this function exists to surface.
    ["status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=normal"],
    { raw: true }
  );
  // Same reasoning as changedPaths(): this function exists specifically to
  // catch a write into a path the first layer of screening was talked into
  // allowing, so a git failure silently read as "nothing ignored" would
  // defeat exactly the case it is the second layer against.
  if (r.spawnFailed) throw new Error(`git status --ignored failed in ${wt}: ${r.err}`);
  const out = r.out;
  if (!out) return [];
  const files = [];
  for (const entry of out.split("\0").filter(Boolean)) {
    if (entry.slice(0, 2) !== "!!") continue;
    const file = norm(entry.slice(3));
    if (file) files.push(file);
  }
  return [...new Set(files)];
}

/** Is this path ignored by git? One question, one answer. */
export function isIgnored(wt, rel) {
  return git(wt, ["check-ignore", "-q", "--", rel]).code === 0;
}

export function createWorktree(root, cfg, nodeId) {
  const dir = path.join(root, cfg.paths.worktrees, nodeId);
  const branch = branchName(nodeId);

  removeWorktree(root, cfg, nodeId, { quiet: true });

  fs.mkdirSync(path.join(root, cfg.paths.worktrees), { recursive: true });
  const r = git(root, ["worktree", "add", "-B", branch, dir, cfg.baseBranch]);
  if (!r.ok) throw new Error(`Could not create worktree for ${nodeId}:\n${r.err}`);
  return { dir, branch };
}

export function removeWorktree(root, cfg, nodeId, { quiet = false } = {}) {
  const dir = path.join(root, cfg.paths.worktrees, nodeId);
  const r = git(root, ["worktree", "remove", "--force", dir]);
  if (!r.ok && !quiet && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
  }
  return r.ok;
}

/**
 * Commit the worktree's current state. Returns `{ ok, message }`, not a bare
 * boolean: a failed `git commit` (no identity configured, gpgsign
 * misconfigured, disk full) used to be indistinguishable from a genuine
 * success to the one caller that reads this — which then reported the node
 * merged, force-removed the worktree, and left main with zero lines of the
 * work the gate had actually just proven correct. `message` carries what git
 * actually said, since the caller needs to explain the failure, not just
 * detect it.
 */
export function commitWorktree(wt, message) {
  git(wt, ["add", "-A"]);
  const r = git(wt, ["commit", "-m", message, "--no-verify"]);
  const ok = r.ok || /nothing to commit/i.test(r.out + r.err);
  return { ok, message: ok ? "" : (r.err || r.out || "git commit exited non-zero with no output") };
}

/**
 * Revert specific paths in the worktree back to their committed state.
 *
 * `git checkout HEAD -- ...paths` validates every pathspec before it acts: one
 * path that does not exist in HEAD — a file the worker only just created —
 * aborts the WHOLE checkout with a non-zero exit, silently leaving every
 * tracked path in the same list un-reverted. The caller had no way to see that
 * from the old signature (nothing was returned), so gate.mjs told the model its
 * tampering "has been reverted" when none of it had been.
 *
 * Partition first — checkout only the paths that exist in HEAD, remove the
 * rest — and return what was actually reverted so callers can report the
 * truth instead of assuming success.
 */
export function revertPaths(wt, paths) {
  if (!paths.length) return [];

  const tracked = [];
  const untracked = [];
  for (const p of paths) {
    (git(wt, ["ls-files", "--error-unmatch", "--", p]).ok ? tracked : untracked).push(p);
  }

  const reverted = [];
  if (tracked.length) {
    const r = git(wt, ["checkout", "HEAD", "--", ...tracked]);
    if (r.ok) reverted.push(...tracked);
    // else: none of these were reverted either. Omission from the return value
    // is the signal — there is nothing more specific to report per-path from a
    // single checkout call.
  }
  for (const p of untracked) {
    const full = path.join(wt, p);
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
    reverted.push(p);
  }
  return reverted;
}

/** Merge a node branch into the base branch. Returns { ok, conflict, message }. */
export function mergeNode(root, cfg, nodeId) {
  const branch = branchName(nodeId);
  const head = currentBranch(root);
  if (head !== cfg.baseBranch) {
    return { ok: false, conflict: false, message: `Repo is on "${head}", expected "${cfg.baseBranch}".` };
  }
  const before = git(root, ["rev-parse", "HEAD"]).out;
  const r = git(root, ["merge", "--no-ff", "-m", `trellis: merge ${nodeId}`, branch]);
  if (r.ok) {
    // "Already up to date." is a SUCCESSFUL exit from git's perspective, but
    // it means the branch had nothing to contribute — most likely because
    // whatever was supposed to land on it never actually got committed there
    // (worker.mjs now catches that specific case before this is ever
    // reached, but this stays as the general-purpose guard: nothing here
    // should ever be able to report a node MERGED when the base branch's
    // HEAD did not move).
    const after = git(root, ["rev-parse", "HEAD"]).out;
    if (after === before) {
      return {
        ok: false,
        conflict: false,
        message: `git reported the merge as already up to date — "${branch}" contributed no new ` +
          `commit, so nothing landed on ${cfg.baseBranch} even though the merge command exited 0.`,
      };
    }
    return { ok: true, conflict: false, message: r.out };
  }
  const conflicted = git(root, ["diff", "--name-only", "--diff-filter=U"]).out;
  git(root, ["merge", "--abort"]);
  return {
    ok: false,
    conflict: Boolean(conflicted),
    message: conflicted ? `Merge conflict in:\n${conflicted}` : r.err || r.out,
  };
}

// ---------- VS Code multi-root workspace sync ----------

const WS_MARKER = "trellis";

export function syncWorkspaceFile(root, cfg, activeNodeIds) {
  const wsPath = path.join(root, "trellis.code-workspace");
  let ws = { folders: [], settings: {} };
  if (fs.existsSync(wsPath)) {
    try { ws = JSON.parse(fs.readFileSync(wsPath, "utf8")); } catch { /* rebuild */ }
  }
  const keep = (ws.folders || []).filter((f) => !f[WS_MARKER]);
  if (!keep.some((f) => f.path === ".")) {
    keep.unshift({ path: ".", name: "◆ orchestrator" });
  }
  const added = activeNodeIds.map((id) => ({
    path: `${cfg.paths.worktrees}/${id}`,
    name: `↳ ${id}`,
    [WS_MARKER]: true,
  }));
  ws.folders = [...keep, ...added];
  ws.settings = {
    ...(ws.settings || {}),
    "files.exclude": {
      ...((ws.settings || {})["files.exclude"] || {}),
      [`${cfg.paths.worktrees}/`]: true,
    },
  };
  fs.writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n");
  return wsPath;
}
