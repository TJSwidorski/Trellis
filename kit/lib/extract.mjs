import { safeRelative, matchAny, matchDeny, matchAllow, norm } from "./paths.mjs";

/**
 * Workers must emit files in this exact shape:
 *
 *   ### FILE: src/thing.js
 *   ```js
 *   ...contents...
 *   ```
 *
 * and deletions as:
 *
 *   ### DELETE: src/old.js
 *
 * Anything outside those blocks is prose and is discarded.
 */
const FILE_RE = /^[ \t]*#{2,4}[ \t]*FILE:[ \t]*(.+?)[ \t]*$/;
const DELETE_RE = /^[ \t]*#{2,4}[ \t]*DELETE:[ \t]*(.+?)[ \t]*$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

export function parseBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const del = lines[i].match(DELETE_RE);
    if (del) {
      blocks.push({ kind: "delete", path: cleanPath(del[1]) });
      i++;
      continue;
    }
    const m = lines[i].match(FILE_RE);
    if (!m) { i++; continue; }
    const filePath = cleanPath(m[1]);
    i++;
    // skip blank lines between header and fence
    while (i < lines.length && lines[i].trim() === "") i++;
    const f = lines[i]?.match(FENCE_RE);
    if (!f) { blocks.push({ kind: "error", path: filePath, reason: "no code fence after FILE header" }); continue; }
    const fence = f[1];
    i++;
    const body = [];
    let closed = false;
    while (i < lines.length) {
      const close = lines[i].match(FENCE_RE);
      if (close && close[1].startsWith(fence[0]) && close[1].length >= fence.length && close[2].trim() === "") {
        closed = true;
        i++;
        break;
      }
      body.push(lines[i]);
      i++;
    }
    if (!closed) { blocks.push({ kind: "error", path: filePath, reason: "unterminated code fence" }); continue; }
    blocks.push({ kind: "write", path: filePath, content: body.join("\n") + "\n" });
  }
  return blocks;
}

function cleanPath(p) {
  return norm(String(p).replace(/^[`'"]|[`'"]$/g, "").replace(/[:,]$/, "").trim());
}

/**
 * Decide which blocks are allowed. Returns { writes, deletes, rejections }.
 * Rejection is not a crash — it becomes feedback the worker sees on retry.
 */
export function screenBlocks(blocks, { worktree, allowWrite, denyWrite, frozen }) {
  const writes = [];
  const deletes = [];
  const rejections = [];
  const flags = new Set();

  for (const b of blocks) {
    if (b.kind === "error") {
      flags.add("malformed");
      rejections.push(`${b.path}: ${b.reason}`);
      continue;
    }
    const safe = safeRelative(worktree, b.path);
    if (!safe.ok) { flags.add("traversal"); rejections.push(safe.reason); continue; }
    const rel = safe.rel;

    if (matchDeny(rel, denyWrite)) {
      flags.add("denied");
      rejections.push(`${rel}: refused — protected path (secrets, git internals, or Trellis' own files).`);
      continue;
    }
    if (matchDeny(rel, frozen)) {
      flags.add("frozen");
      rejections.push(
        `${rel}: refused — this is a frozen test file. Tests define the contract you must satisfy; ` +
        `you may not modify them. Change your implementation instead.`
      );
      continue;
    }
    if (!matchAllow(rel, allowWrite)) {
      flags.add("out-of-scope");
      rejections.push(
        `${rel}: refused — outside this task's write scope. You may only write: ${allowWrite.join(", ")}`
      );
      continue;
    }
    if (b.kind === "delete") deletes.push({ path: rel, abs: safe.abs });
    else writes.push({ path: rel, abs: safe.abs, content: b.content });
  }

  return { writes, deletes, rejections, flags };
}

/**
 * Most serious problem first. A model that edited its own tests is a different
 * (and more interesting) failure than one whose code merely didn't work, and the
 * report should say so.
 */
export function worstFlag(flags) {
  for (const f of ["frozen", "traversal", "denied", "out-of-scope", "malformed"]) {
    if (flags.has(f)) return f === "frozen" ? "test-tampering" : f;
  }
  return null;
}
