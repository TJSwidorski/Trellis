import { tierKey } from "./config.mjs";

const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  constructor(message, { status, transient = false, truncated = false } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
    // A too-small output cap, not a broken endpoint. Retrying the identical
    // request changes nothing, so this must never be `transient` — see the
    // empty-completion throw below.
    this.truncated = truncated;
  }
}

/**
 * One chat completion against any OpenAI-compatible endpoint.
 * Returns { text, usage, model, ms, finish }.
 *
 * `maxTokens` overrides `tier.maxTokens` for this call only, so a caller that
 * hit a truncated reply can retry the same tier with more room without
 * mutating the tier config or affecting other nodes.
 */
export async function chat(cfg, tier, messages, { signal, maxTokens } = {}) {
  const key = tierKey(tier);
  if (tier.apiKeyEnv && !key) {
    throw new ProviderError(`Environment variable ${tier.apiKeyEnv} is not set (tier "${tier.name}").`);
  }

  const url = tier.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    ...(cfg.headers || {}),
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...(tier.headers || {}),
  };

  const body = {
    model: tier.model,
    messages,
    temperature: tier.temperature,
    max_tokens: maxTokens ?? tier.maxTokens,
    stream: false,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.worker.requestTimeoutMs);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e.name === "AbortError";
    throw new ProviderError(
      aborted ? `Request to ${tier.name} timed out after ${cfg.worker.requestTimeoutMs}ms.` : `Network error calling ${tier.name}: ${e.message}`,
      { transient: true }
    );
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 600);
    try { detail = JSON.stringify(JSON.parse(raw).error ?? JSON.parse(raw)).slice(0, 600); } catch { /* raw */ }
    throw new ProviderError(`${tier.name} returned HTTP ${res.status}: ${detail}`, {
      status: res.status,
      transient: TRANSIENT.has(res.status),
    });
  }

  let json;
  try { json = JSON.parse(raw); } catch {
    throw new ProviderError(`${tier.name} returned non-JSON: ${raw.slice(0, 300)}`, { transient: true });
  }

  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text.trim()) {
    // finish_reason=length means the model hit the output cap before writing
    // anything usable — a too-small max_tokens, not a flaky endpoint. This
    // used to be transient:true unconditionally, so chatWithBackoff retried
    // the identical request up to three times at the identical cap: same
    // failure, same reason, three times over, before the caller ever saw it.
    // Only genuine provider flakiness should retry blind; a truncation needs
    // a bigger cap, which only the caller (runNode) can decide to grant.
    const truncated = choice?.finish_reason === "length";
    throw new ProviderError(`${tier.name} returned an empty completion (finish_reason=${choice?.finish_reason}).`, {
      transient: !truncated,
      truncated,
    });
  }

  return {
    text,
    model: json.model || tier.model,
    usage: json.usage || null,
    finish: choice?.finish_reason || null,
    ms: Date.now() - started,
  };
}

/** chat() with backoff on transient failures only. */
export async function chatWithBackoff(cfg, tier, messages, { attempts = 3, maxTokens } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chat(cfg, tier, messages, { maxTokens });
    } catch (e) {
      last = e;
      if (!(e instanceof ProviderError) || !e.transient || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i) + Math.random() * 500));
    }
  }
  throw last;
}

/** Ask the provider which models exist. Used by `trellis doctor`. */
export async function listModels(cfg, tier) {
  const key = tierKey(tier);
  const url = tier.baseUrl.replace(/\/+$/, "") + "/models";
  const res = await fetch(url, {
    headers: { ...(cfg.headers || {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  });
  if (!res.ok) throw new ProviderError(`GET /models returned HTTP ${res.status}`, { status: res.status });
  const json = await res.json();
  return (json.data || []).map((m) => m.id).filter(Boolean);
}
