import http from "node:http";

/**
 * Scripted OpenAI-compatible endpoint. Lets the e2e test drive every branch of
 * the ladder — wrong code, test tampering, out-of-scope writes, escalation,
 * and exhaustion — without touching the network.
 */
export function startMockServer(script) {
  const calls = [];
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
      const userText = parsed.messages.map((m) => m.content).join("\n");
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
      const idx = calls.filter((c) => c.node === key).length;
      const entry = seq[Math.min(idx, seq.length - 1)];
      calls.push({ node: key, model, idx, prompt: userText, maxTokens: parsed.max_tokens });

      if (entry?.httpError) {
        res.writeHead(entry.httpError, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "scripted failure" } }));
      }

      const content = typeof entry === "function" ? entry({ model, idx, prompt: userText }) : entry?.content ?? "";
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
