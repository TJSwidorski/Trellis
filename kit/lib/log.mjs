import fs from "node:fs";
import path from "node:path";

const NO_COLOR = process.env.NO_COLOR || process.env.TRELLIS_NO_COLOR;
const c = (code) => (s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
export const dim = c("2");
export const bold = c("1");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const blue = c("34");
export const magenta = c("35");

let stream = null;

export function openRunLog(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const p = path.join(stateDir, "run.jsonl");
  stream = fs.createWriteStream(p, { flags: "a" });
  return p;
}

export function event(type, payload = {}) {
  const rec = { ts: new Date().toISOString(), type, ...payload };
  if (stream) stream.write(JSON.stringify(rec) + "\n");
}

/**
 * Returns a promise that resolves once the stream has actually finished
 * flushing to disk. `stream.end()` alone begins that process asynchronously
 * — a caller that reads run.jsonl right after calling this with no await
 * (as a test verifying the last event a run wrote is exactly this shape)
 * could race the final buffered write and see a truncated file. Existing
 * fire-and-forget callers are unaffected: an unawaited resolved promise
 * behaves exactly like the `undefined` this returned before.
 */
export function closeRunLog() {
  const s = stream;
  stream = null;
  if (!s) return Promise.resolve();
  return new Promise((resolve) => s.end(resolve));
}

export function info(msg) {
  process.stdout.write(msg + "\n");
}
export function node(id, msg, color = blue) {
  process.stdout.write(`${color(`[${id}]`)} ${msg}\n`);
}
export function warn(msg) {
  process.stdout.write(yellow(`! ${msg}`) + "\n");
}
export function fail(msg) {
  process.stdout.write(red(`x ${msg}`) + "\n");
}
export function ok(msg) {
  process.stdout.write(green(`+ ${msg}`) + "\n");
}
