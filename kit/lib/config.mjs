import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  project: "unnamed-project",
  baseBranch: "main",
  concurrency: 3,
  tiers: [],
  headers: {},
  gate: {
    defaultCommand: null, timeoutMs: 300000, feedbackChars: 4000,
    sandbox: { enabled: false, maxMemoryMb: 2048, maxCpuSeconds: 300, maxFileSizeMb: 500 },
  },
  worker: { requestTimeoutMs: 180000, maxContextFileBytes: 40000 },
  boundaries: { denyWrite: [] },
  budget: { maxTotalAttempts: null, maxWorkerTokens: null, maxWallClockMs: null, maxCostUsd: null },
  routing: { enabled: false, minObservations: 5, minSuccessRate: 0.15 },
  verify: {
    mutationsOnPass: true, onSurvivor: "warn", requirePrecondition: true,
    structuralMutants: true, structuralMutantLimit: 8, proposeOnSurvivor: true,
  },
  specPath: null,
  paths: { state: ".trellis", worktrees: ".worktrees", graph: ".trellis/graph.json" },
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (k.startsWith("$")) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (obj && typeof obj === "object") {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("$")) continue;
      o[k] = stripComments(v);
    }
    return o;
  }
  return obj;
}

export function loadConfig(repoRoot, file) {
  const p = file || path.join(repoRoot, "trellis.config.json");
  if (!fs.existsSync(p)) {
    throw new Error(`No config found at ${p}. Copy trellis.config.json into your repo root.`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`trellis.config.json is not valid JSON: ${e.message}`);
  }
  const cfg = deepMerge(DEFAULTS, stripComments(raw));
  cfg.__file = p;
  cfg.__root = repoRoot;

  if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0) {
    throw new Error("config.tiers must contain at least one tier.");
  }
  cfg.tiers.forEach((t, i) => {
    for (const k of ["name", "baseUrl", "model"]) {
      if (!t[k]) throw new Error(`config.tiers[${i}] is missing "${k}".`);
    }
    t.maxAttempts = t.maxAttempts ?? 2;
    t.temperature = t.temperature ?? 0.1;
    // Whole-file emission at 8000 was the truncation source, and escalating
    // a tier to solve a token cap pays for capability that was never the
    // problem — worker.mjs's per-attempt cap doubling (up to maxTokensCeiling)
    // handles genuinely large nodes on top of this.
    t.maxTokens = t.maxTokens ?? 16000;
  });
  return cfg;
}

/** Resolve the API key for a tier. Returns null if unset (doctor reports it). */
export function tierKey(tier) {
  if (!tier.apiKeyEnv) return null;
  return process.env[tier.apiKeyEnv] || null;
}
