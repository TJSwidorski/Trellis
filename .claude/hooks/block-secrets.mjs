#!/usr/bin/env node
// PreToolUse (Read|Edit|Write) — refuse credential material.
// Exit 2 blocks the call and returns stderr to the model as feedback.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let p = "";
  try { p = JSON.parse(raw || "{}")?.tool_input?.file_path || ""; } catch { process.exit(0); }
  const f = String(p).replace(/\\/g, "/");
  const DENY = [
    /(^|\/)\.env($|\.)/i,
    /(^|\/)secrets?\.(json|ya?ml|toml|ini|env)$/i,
    /(^|\/)credentials?($|\.)/i,
    /\.(pem|key|p12|pfx|keystore)$/i,
    /(^|\/)id_(rsa|ed25519|ecdsa)/i,
    /(^|\/)\.(ssh|aws|gnupg)\//i,
    /(^|\/)\.npmrc$/i,
  ];
  if (DENY.some((r) => r.test(f))) {
    process.stderr.write(
      `Blocked: ${p} holds credential material. Trellis never reads or writes these. ` +
      `If you need a value from it, ask the human to expose it as an environment variable.\n`
    );
    process.exit(2);
  }
  process.exit(0);
});
