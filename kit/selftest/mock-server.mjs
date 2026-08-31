import http from "node:http";

/**
 * Scripted OpenAI-compatible endpoint. Lets the e2e test drive every branch of
 * the ladder — wrong code, test tampering, out-of-scope writes, escalation,
 * and exhaustion — without touching the network.
 */
export function startMockServer(script) {
  const calls = [];
  // Node id -> prompts seen so far, in first-seen order. The scripted
  // response index used to be "how many prior calls this node has made" —
  // correct only when every call carries a distinct prompt, which stops
  // being true the moment something (parallel sampling, item 14) issues
  // several concurrent requests sharing ONE attempt's identical prompt.
  // Counting distinct prompts instead means N calls with the same text are
  // all "attempt 0"; a genuinely new prompt (a retry with different file
  // contents or feedback appended) is what advances the index.
  const distinctPromptsByNode = new Map();
  // "node id + distinct-prompt index" -> how many calls have shared that
  // exact combination so far. Parallel sampling (item 14) issues several
  // concurrent calls with the IDENTICAL prompt for one attempt, all of
  // which resolve to the same `idx` above -- a script needs a way to tell
  // those apart to test that the real distinct SAMPLES actually differ, so
  // a function-entry callback gets `sample` (0-based, per node+idx) instead
  // of a second scripting mechanism alongside the existing one.
  const sampleCountByNodeIdx = new Map();
  const server = http.createServer((req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: script.models?.map((id) => ({ id })) || [] }));
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const model = parsed.model;
      // A message's content is either a plain string, or (prompt caching,
      // item 24) an array of {type:"text", text, cache_control?} parts --
      // join whichever shape arrived into the same flat text the rest of
      // this file's matching was written against.
      const contentText = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));
      const userText = parsed.messages.map((m) => contentText(m.content)).join("\n");
      // Mutator calls look nothing like node prompts — they carry a defect
      // description instead of a task heading. Route them separately.
      if (/Defect to reintroduce/.test(userText) && script.mutants) {
        const hit = Object.entries(script.mutants).find(([k]) => userText.includes(k));
        calls.push({ node: "__mutator__", model, mutation: hit?.[0] || null });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          id: "mock-mut", model,
          choices: [{ index: 0, message: { role: "assistant", content: hit ? hit[1] : "NOT APPLICABLE" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }));
      }

      const nodeId = (userText.match(/# Task: ([^\n]+)/) || [])[1] || "?";
      const key = `${nodeId}`;
      const seq = (script.responses[key] ||= []);
      const seenPrompts = (distinctPromptsByNode.get(key) ?? distinctPromptsByNode.set(key, []).get(key));
      let idx = seenPrompts.indexOf(userText);
      if (idx === -1) { idx = seenPrompts.length; seenPrompts.push(userText); }
      const entry = seq[Math.min(idx, seq.length - 1)];
      const sampleKey = `${key}:${idx}`;
      const sample = sampleCountByNodeIdx.get(sampleKey) ?? 0;
      sampleCountByNodeIdx.set(sampleKey, sample + 1);
      calls.push({
        node: key, model, idx, sample, prompt: userText, maxTokens: parsed.max_tokens,
        user: parsed.user, rawContent: parsed.messages.map((m) => m.content),
      });

      if (entry?.httpError) {
        res.writeHead(entry.httpError, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "scripted failure" } }));
      }

      const content = typeof entry === "function" ? entry({ model, idx, prompt: userText, sample }) : entry?.content ?? "";
      // finishReason lets a fixture script finish_reason:"length" — a truncated
      // reply, either empty (the provider-level truncation path) or carrying
      // whatever partial content the entry provides (the mid-file path).
      const finishReason = (typeof entry === "object" && entry?.finishReason) || "stop";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "mock",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
        usage: { prompt_tokens: Math.ceil(userText.length / 4), completion_tokens: Math.ceil(String(content).length / 4) },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
