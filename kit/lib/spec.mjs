import fs from "node:fs";
import path from "node:path";

/**
 * Reading the spec is how `validate` closes failure mode 5 — a required step
 * silently missing from the graph. The spec's "Scope for this run" checkboxes
 * are the required steps; every one of them must be claimed by some node.
 */

export function findSpec(root, cfg) {
  const candidates = [];
  if (cfg.specPath) candidates.push(cfg.specPath);
  candidates.push("SPEC.md");
  for (const f of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (/^SPEC[-_].*\.md$/i.test(f)) candidates.push(f);
  }
  for (const c of candidates) {
    const abs = path.join(root, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { rel: c, abs, text: fs.readFileSync(abs, "utf8") };
    }
  }
  return null;
}

/**
 * Pull the checkbox lines out of the "Scope for this run" section. Stops at the
 * next heading of the same or higher level so "Explicitly not in scope" is never
 * mistaken for work.
 */
export function scopeBullets(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s+scope for this run\b/i.test(l.trim()));
  if (start === -1) return [];
  const level = (lines[start].match(/^#+/) || ["##"])[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    const m = l.match(/^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}
