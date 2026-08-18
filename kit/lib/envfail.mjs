// Telling "the environment is broken" apart from "the code is wrong".
//
// The gate is an opaque shell command, so a missing Python library and a genuinely
// failing test produce the same thing: a non-zero exit. Trellis used to call both
// `test-failure`, which meant a missing import was retried, escalated cheap → mid →
// strong, and finally recorded as EXHAUSTED. Real money, three tiers, on a problem
// no model could ever fix — and the evaluation sheet then counted it under "model
// capability", pointing at exactly the wrong remedy.
//
// A node that cannot import its dependencies is not a node that failed. It is a
// run that should not have started.
//
// Bias: these patterns are deliberately narrow. A false negative costs what the
// old behaviour always cost. A false positive halts the run with a loud, specific
// message, which is recoverable in seconds — but it would be maddening if it fired
// on a legitimate assertion, so nothing here matches a bare word like "import".

const SIGNATURES = [
  // --- Python ---
  { re: /ModuleNotFoundError:\s*No module named ['"]?([\w.]+)/i, hint: (m) => `Python cannot import "${m[1]}"` },
  { re: /ImportError:\s*No module named ['"]?([\w.]+)/i, hint: (m) => `Python cannot import "${m[1]}"` },
  { re: /ImportError:\s*cannot import name ['"]?([\w.]+)['"]? from ['"]?([\w.]+)/i,
    hint: (m) => `"${m[2]}" has no "${m[1]}" — usually a version mismatch, not missing code` },

  // --- Node ---
  // Specific before generic: Node emits both "Cannot find package 'x'" and
  // ERR_MODULE_NOT_FOUND for the same fault, and matching the generic one first
  // would throw away the package name that makes the message actionable.
  { re: /Cannot find module ['"]([^'"]+)['"]/i, hint: (m) => `Node cannot resolve "${m[1]}"` },
  { re: /Cannot find package ['"]([^'"]+)['"]/i, hint: (m) => `Node cannot resolve package "${m[1]}"` },
  { re: /ERR_MODULE_NOT_FOUND/, hint: () => "Node module resolution failed" },

  // --- the interpreter or test runner itself is absent ---
  // Windows phrasing first; it is the one most often forgotten.
  { re: /'([^']+)' is not recognized as an internal or external command/i,
    hint: (m) => `"${m[1]}" is not on PATH` },
  { re: /(?:^|\n).*?([\w.\-/\\]+): command not found/i, hint: (m) => `"${m[1]}" is not on PATH` },
  { re: /\[spawn error\][^\n]*ENOENT/i, hint: () => "the gate command itself could not be spawned" },
  { re: /The term ['"]([^'"]+)['"] is not recognized as the name of a cmdlet/i,
    hint: (m) => `"${m[1]}" is not on PATH` },

  // --- toolchain present but unprovisioned ---
  { re: /error TS2307: Cannot find module/i, hint: () => "TypeScript cannot resolve an import" },
  { re: /No such file or directory.*node_modules/i, hint: () => "node_modules is missing — run your install step" },
];

// A RELATIVE import that cannot be resolved is a different failure from a missing
// package: the file was supposed to be in the repo. The most common cause on a
// managed Windows machine is antivirus quarantine — security tooling deletes test
// fixtures that contain malware patterns, because that is what makes them
// fixtures. Observed: HP Wolf Security removing a scanner's positive-control
// fixture seconds after it was written.
const LOCAL_PATH = /^[.\/\\]/;

/**
 * Inspect gate output. Returns null when this looks like an ordinary test
 * failure, or { hint, matched } when the environment is at fault.
 */
export function detectEnvFailure(output) {
  const text = String(output || "");
  if (!text) return null;
  for (const { re, hint } of SIGNATURES) {
    const m = text.match(re);
    if (!m) continue;
    const target = m[1];
    if (target && LOCAL_PATH.test(target)) {
      return {
        hint:
          `"${target}" is a file in this repo that is missing. This is not a missing ` +
          `dependency — check whether antivirus quarantined it. Security tooling ` +
          `routinely deletes test fixtures containing malware patterns`,
        matched: m[0].trim().slice(0, 200),
        likelyQuarantine: true,
      };
    }
    return { hint: hint(m), matched: m[0].trim().slice(0, 200) };
  }
  return null;
}

/**
 * The operator-facing message. Says what broke, what it is not, and what to do —
 * a run that halts without telling you which of those three it is has just traded
 * one opaque failure for another.
 */
export function envFailureMessage({ hint, matched }, { nodeId, command } = {}) {
  return [
    `Environment failure${nodeId ? ` on node "${nodeId}"` : ""}: ${hint}.`,
    ``,
    `  gate: ${command ?? "(unknown)"}`,
    `  saw:  ${matched}`,
    ``,
    `This is not a model failure, so retrying and escalating tiers would spend money`,
    `to reproduce the same error. The run has stopped instead.`,
    ``,
    `Install the missing dependency, then re-run with --resume. Nothing is corrupted:`,
    `no node was marked exhausted on account of this.`,
  ].join("\n");
}
