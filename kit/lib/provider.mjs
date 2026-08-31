import { tierKey } from "./config.mjs";

const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Same convention as worktree.mjs's git() maxBuffer and gate.mjs's exec()
// output cap: a hard ceiling on how much of a single response this process
// will hold in memory, independent of any timeout.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Read a Response body with a hard byte ceiling, so a provider that starts
 * streaming and never stops cannot grow this process's memory without bound.
 * Falls back to `res.text()` when the runtime does not expose a streaming
 * body (some test doubles don't) — that path has no cap of its own, but it
 * is not the shape a real, malicious-or-broken HTTP server can produce.
 */
export async function readCapped(res, maxBytes) {
  if (!res.body?.getReader) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ProviderError(`response body exceeded ${maxBytes} bytes without completing`, { transient: false });
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    try { reader.releaseLock(); } catch { /* already released or errored */ }
  }
}

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
export async function chat(cfg, tier, messages, { signal, maxTokens, user } = {}) {
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
    // OpenAI's own `user` field (an opaque per-end-user identifier), reused
    // here as a stable per-NODE identifier instead — a gateway that routes
    // on it for cache or session affinity (OpenRouter does, for sticky
    // provider-backend routing) then sends every attempt on the same node
    // to the same backend replica, which is what makes a provider-side
    // cache_control hit anything at all across retries. Omitted entirely
    // when the caller has none, rather than sent as an empty string.
    ...(user ? { user } : {}),
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

  // `clearTimeout` used to fire here, right after the response HEADERS
  // arrived — so `requestTimeoutMs` only ever bounded getting a 200, and a
  // provider that returned headers and then stalled (or streamed forever)
  // had no timeout and no size cap anywhere in the system. The abort
  // controller stays live through the body read below, and the timer is
  // only cleared once that read has actually finished.
  let raw;
  try {
    raw = await readCapped(res, MAX_RESPONSE_BYTES);
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ProviderError && !e.transient) throw e; // the size-cap case: not a flaky endpoint, don't retry blind
    const timedOut = ac.signal.aborted;
    throw new ProviderError(
      timedOut
        ? `Request to ${tier.name} timed out after ${cfg.worker.requestTimeoutMs}ms while reading the response body.`
        : `Network error reading ${tier.name}'s response: ${e.message}`,
      { transient: true }
    );
  }
  clearTimeout(timer);

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
export async function chatWithBackoff(cfg, tier, messages, { attempts = 3, maxTokens, user } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chat(cfg, tier, messages, { maxTokens, user });
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
