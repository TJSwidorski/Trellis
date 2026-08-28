// The attempt-failure vocabulary, declared for consumers.
//
// This file is a MIRROR, not a source of truth. The kinds are assigned as string
// literals in gate.mjs, worker.mjs, and extract.mjs, and they stay there.
//
// The temptation is to invert that — export KINDS from here and have gate.mjs
// import it, so there is one definition. Do not. gate.mjs is PROTECTED and this
// file is load-bearing, so a load-bearing proposal to kinds.mjs could change the
// behaviour of protected code without ever naming a protected path. classify()
// would return "load-bearing" and the protection boundary would have a hole in it
// that no check can see.
//
// The cost of mirroring is drift. That is paid for by an adversarial regression
// check which reads the source text of all three files, extracts every kind and
// flag literal, and asserts set-equality in both directions with this table. Add
// a kind and forget this file and the suite goes red — which is everything a
// shared enum would have bought, with the dependency arrow pointing the safe way.

/** Write-screening flags (extract.mjs) and the attempt kind each becomes. */
export const FLAG_TO_KIND = Object.freeze({
  frozen: "test-tampering", // a worker editing its own oracle is the interesting one
  traversal: "traversal",
  denied: "denied",
  "out-of-scope": "out-of-scope",
  truncated: "truncated",
  malformed: "malformed",
});

/** The one kind that means the attempt succeeded. */
export const PASS = "pass";

export const KINDS = Object.freeze(
  new Set([
    // gate.mjs
    "pass",
    "no-op",
    "no-gate",
    "timeout",
    "test-failure",
    "test-tampering",
    "gate-tampering",
    "out-of-scope",
    "env-failure",
    // worker.mjs
    "no-files",
    "provider-error",
    "error",
    "truncated",
    // extract.mjs, via worstFlag
    "traversal",
    "denied",
    "malformed",
  ])
);

export function isKnownKind(k) {
  return typeof k === "string" && KINDS.has(k);
}
