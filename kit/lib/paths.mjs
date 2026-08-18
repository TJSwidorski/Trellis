import path from "node:path";

/** Normalize any path to forward-slash, repo-relative form. */
export function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Compile a glob to a RegExp.
 * Supports: ** (any depth incl. none), * (one segment), ? (one char), {a,b} alternation.
 */
export function globToRegExp(glob) {
  const g = norm(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` should also match zero directories
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
      } else {
        const opts = g.slice(i + 1, close).split(",");
        re += "(?:" + opts.map((o) => o.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = close;
      }
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

const _cache = new Map();
export function matchGlob(filePath, glob) {
  let r = _cache.get(glob);
  if (!r) {
    r = globToRegExp(glob);
    _cache.set(glob, r);
  }
  return r.test(norm(filePath));
}

export function matchAny(filePath, globs) {
  return (globs || []).some((g) => matchGlob(filePath, g));
}

/**
 * Reject anything that would escape the worktree.
 * Returns { ok, reason, rel } — rel is the safe repo-relative path.
 */
export function safeRelative(root, candidate) {
  const raw = String(candidate || "").trim();
  if (!raw) return { ok: false, reason: "empty path" };
  if (raw.includes("\0")) return { ok: false, reason: "null byte in path" };
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return { ok: false, reason: `absolute path not allowed: ${raw}` };
  }
  if (norm(raw).split("/").includes("..")) {
    return { ok: false, reason: `parent traversal not allowed: ${raw}` };
  }
  const abs = path.resolve(root, raw);
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `path escapes worktree: ${raw}` };
  }
  return { ok: true, rel: norm(rel), abs };
}

/** Do two sets of write-globs potentially overlap? Conservative: literal-prefix compare. */
export function globsOverlap(aList, bList) {
  for (const a of aList) {
    for (const b of bList) {
      if (a === b) return [a, b];
      // If either glob matches the other's literal prefix, treat as overlapping.
      const aLit = a.split(/[*?{]/)[0];
      const bLit = b.split(/[*?{]/)[0];
      if (matchGlob(bLit || b, a) || matchGlob(aLit || a, b)) return [a, b];
      if (aLit && bLit && (aLit.startsWith(bLit) || bLit.startsWith(aLit))) {
        if (a.includes("*") || b.includes("*")) return [a, b];
      }
    }
  }
  return null;
}
