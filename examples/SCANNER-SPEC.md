# GitHub Repo Safety Scanner

## What this is

A command-line tool that audits a public GitHub repository for supply-chain and
prompt-injection risk **without downloading it**, and prints a verdict you can act
on before deciding whether to acquire it at all.

```
scan https://github.com/OWNER/REPO
```

## The governing constraint

**The tool never clones, downloads, installs, or writes repository content to
disk.** It reads GitHub over its API and holds what it reads in memory.

This is the whole point, not a limitation to design around. The risks being audited
include: an editor or agent executing project-scoped configuration the moment a
folder is opened; install scripts that run before any code is deliberately invoked;
and instruction files that are dangerous purely by being *read* by an AI assistant,
with no code execution at all. A tool that requires you to acquire a repository
before it can tell you whether acquiring it is safe has inverted its own purpose.

Two consequences that shape everything:

1. **This is a program, not an assistant.** Untrusted bytes are pattern-matched by
   deterministic code. They are never placed in the context window of a language
   model. Any design that routes repository content through an AI model to "review
   it" reintroduces the exact attack surface the tool exists to close.

2. **The report is itself a delivery vector.** Findings quote untrusted content,
   and a person or an AI assistant then reads that report. Emitting raw quoted
   bytes would faithfully forward the payload the tool just detected. Every quoted
   excerpt must be neutralised before it is written out.

## Stack

- Node.js 20+, ESM.
- **Zero runtime dependencies.** Built-in `fetch`, `node:test` for tests.
- Authentication: a `GITHUB_TOKEN` environment variable, **read-only with no
  scopes** — public repositories require none. A token with write or `repo` scope
  must be refused at startup: a tool that demands broad credentials in order to
  detect credential theft is self-refuting.

## How it must be built

All network access lives behind one thin fetch layer that produces a plain
in-memory `RepoSnapshot` object. **Every check is a pure function from a
`RepoSnapshot` to a list of findings.** No check performs I/O.

Tests run entirely offline against **synthetic fixtures written by hand** — API
responses and hostile repositories composed for the purpose. A test suite that
needs the network is not a test suite.

**Fixtures must be authored, never harvested.** No fixture may be produced by
fetching a real third-party repository, and no third-party repository content may
be committed to this project. That is not a stylistic preference — capturing a
suspicious repo to test against would acquire exactly the untrusted content this
tool exists to let you avoid acquiring, and would then store it permanently in
your own tree. The temptation is real, because "test it against a genuinely
malicious repo" sounds like rigor; it is the one thing this tool must never do.

Authored fixtures are also strictly better tests: you know the ground truth,
each fixture isolates one pattern, and the suite is deterministic. A harvested
repo gives you an unlabelled blob you must first audit to know what it contains —
using the tool you have not finished building.

## Scope for this run

- [ ] Fetch a repository's complete file inventory, metadata, commit history,
      contributor list, and star history over the GitHub API, into a `RepoSnapshot`.
- [ ] Refuse to run with a `GITHUB_TOKEN` that carries more than read access.
- [ ] Degrade to an explicit `INCOMPLETE` verdict — never a clean one — when the
      file inventory is truncated, an API quota is exhausted, or a file is too
      large to retrieve. Silent under-scanning is the worst outcome this tool can
      produce, because it manufactures confidence rather than merely lacking it.
- [ ] Assess repository provenance: account age against star count, star growth
      shape (organic curves versus step functions), whether commit history is
      incremental or a single bulk drop, contributor diversity, recent ownership
      transfer, and names that are near-misses of well-known projects.
- [ ] Assess maintainer provenance: account age, contribution history predating the
      repository, and whether other repositories look like a real portfolio.
- [ ] Assess published-package provenance where the repository publishes to npm or
      PyPI: whether the package links back to this repository, whether version
      history is incremental, whether download counts are consistent with
      popularity, and whether the name is a typo-squat or a plausible-sounding
      hallucinated name someone has since registered.
- [ ] Detect instructions that would have the reader run a piped shell installer,
      disable a sandbox or permission system, or run an installer with elevated
      privileges. Any of these is an immediate reject.
- [ ] Detect code that executes at install time or on folder open: package manager
      lifecycle scripts, Python build hooks and test-collection hooks, default
      build targets that fetch from the network, CI workflows that run untrusted
      pull-request code or expose secrets, development-container commands
      (including those that run on the **host** rather than in the container),
      editor tasks configured to run when a folder opens, directory-entry shell
      hooks, and committed version-control hooks.
- [ ] Detect configuration that an AI coding assistant loads automatically:
      project-scoped settings containing lifecycle hooks, broad permission grants,
      or injected environment variables; project-scoped tool-server declarations;
      and every convention-named instruction file that assistants read on startup.
- [ ] Detect prompt-injection patterns in any instruction text, README, docstring,
      code comment, or tool description: sentences addressed to an AI assistant
      rather than to the reader, requests for secrecy, requests for data unrelated
      to the stated purpose, external URLs to fetch or transmit to, attempts to
      override prior instructions, and instructions to auto-approve actions.
- [ ] Detect text that is invisible or deceptive when rendered: zero-width
      characters, **Unicode tag-block characters**, bidirectional overrides that
      make code display in a different order than it executes, private-use
      characters, homoglyph substitutions in identifiers and domain names, HTML
      comments, and content hidden past long-line or trailing-whitespace
      boundaries.
- [ ] Detect references to credential storage locations — SSH keys, cloud provider
      credentials, package registry tokens, container and cluster configuration, AI
      assistant configuration, environment files, keychains, browser stores, wallet
      files, shell history — and wholesale enumeration of environment variables or
      the user's home directory.
- [ ] Detect outbound data channels: HTTP clients, raw sockets, **DNS-based
      exfiltration through dynamically constructed hostnames**, image and link
      beacons that transmit on render, known interaction-capture and request-bin
      services, messaging platform webhooks used as command channels, hardcoded or
      obfuscated network addresses, and telemetry that is enabled by default and
      sends more than a version string.
- [ ] Detect obfuscation: dynamic evaluation, decode-then-execute chains,
      fetch-then-execute chains, minified files with no corresponding build step,
      dense escape sequences, high-entropy blobs, and code that changes behaviour
      based on whether it detects a CI system, virtual machine, debugger, or
      specific hostname.
- [ ] Inventory non-text files and flag: serialisation formats that execute code on
      load, machine-learning weight files in executable formats where a safe format
      exists, model configuration that requires trusting remote code, and
      precompiled native binaries with no accompanying build script.
- [ ] Assess dependency hygiene: whether a lockfile is committed, floating or
      unpinned versions, dependencies pointing at mutable branches rather than
      fixed commits, redirection of well-known packages to alternate sources,
      committed configuration that changes the package registry or injects an
      authentication token, and transitive dependency count against project size.
- [ ] Produce a prioritised manual reading list — highest signal per minute first —
      because automated checks find patterns and cannot find intent.
- [ ] Produce adoption guidance: the exact immutable commit identifier to pin to,
      a baseline for re-auditing on update, and least-privilege recommendations.
- [ ] Produce a verdict — `REJECT`, `REVIEW`, `PASS`, or `INCOMPLETE` — with an
      immediate-reject path that stops analysis as soon as a disqualifying signal
      is found, and a fast triage mode for low-stakes cases.
- [ ] On an early stop, report **how far the audit got**: the finding that halted
      it, which checks ran and passed, and which were never reached. A stop at
      check 7 of 100 must never read like a completed audit that found one
      problem — it is one problem plus 93 unknowns, and the report must show that
      distinction plainly.
- [ ] Award `PASS` only when **every** check ran to completion against content
      actually fetched from the live repository. Any unrun check downgrades the
      verdict.
- [ ] Neutralise every quoted excerpt before writing it into the report: render
      invisible characters visibly, strip direction overrides, defang link and
      image syntax, escape markup, and truncate long lines.
- [ ] Emit both a human-readable report and machine-readable JSON.

## Explicitly not in scope

**The tool must state all of these in every report it produces** — a report silent
about its own blind spots is more dangerous than no report, because it converts
absence of evidence into apparent safety.

Deferred to the next version, because each requires *executing* code and this
version's whole premise is deciding whether acquisition is safe in the first place:

- [ ] Executing repository code in any form, sandboxed or otherwise.
- [ ] Observing runtime behaviour: network capture, DNS logging, system-call
      tracing, or canary-token detonation.
- [ ] Connecting to a repository's tool server to compare the descriptions it
      serves at runtime against those in its source. A server can serve different
      text than its repository shows, and no static reading detects that.

Permanently out of scope, for both versions:

- [ ] Detecting behavioural backdoors in machine-learning weights. Weights can
      behave normally except on a trigger phrase. Static analysis cannot see this,
      and neither can execution unless you happen to supply the trigger — so no
      version of this tool will ever clear them. Provenance is the only real
      control. What this tool *can* do is refuse the conditions that make a
      backdoor deliverable: flag executable weight formats where a safe one
      exists, flag configuration requiring remote code execution to load a model,
      and verify published hashes against the publisher.
- [ ] Judging whether flagged code is *malicious*. The tool reports what is present
      and why it is worth attention. Intent is a human judgement.

## Interfaces already decided

- `scan <url>` prints a report and exits `10` for `PASS`, `11` for `REVIEW`, `12`
  for `REJECT`, `13` for `INCOMPLETE`. These deliberately avoid `0`–`3`: a runtime
  that dies on an uncaught exception exits `1`, so if `1` also meant `REVIEW`, a
  crash and a considered verdict would be indistinguishable to any caller.
- Every completed run writes a machine-readable verdict marker to stdout. A caller
  must be able to tell "the tool ran and found nothing" from "the tool never ran"
  without inferring it from an exit code alone.
- `--json` emits machine-readable findings instead of prose.
- `--fast` runs the triage subset.
- Every finding carries: a stable rule identifier, a severity, a file path, a line
  number where applicable, and a neutralised excerpt.

## High-risk areas

- **Report neutralisation.** If this is wrong, the tool becomes a delivery
  mechanism for the payloads it detects.
- **Incomplete-scan detection.** If this is wrong, the tool reports `PASS` on a
  repository it only partially read.
- **Token scope refusal.** If this is wrong, the tool holds credentials far beyond
  what it needs.
- **Tag-block and zero-width detection.** These are invisible to human review, so
  the automated check is the only line of defence.

## A check that finds nothing must fail

Every detection check ships with a **positive control** — a fixture containing the
exact pattern that check exists to find, which it is required to flag — and a
**negative control** it must leave alone.

This is not redundant with ordinary testing. A check that has been quietly
disabled, or narrowed just enough to miss one codepoint range, still passes every
test that only asserts "no false positives on clean input". It reports nothing, and
nothing is what a clean repository also produces. The positive control is the only
test that distinguishes "found no problems" from "no longer looking".

For a tool whose entire output is an absence-of-findings claim, this is the
load-bearing test.

## Definition of done

- Every check is a pure function over a snapshot, with a test that fails when the
  check is removed.
- The full suite runs offline with no network and no credentials.
- Scanning a repository built to contain one instance of every detectable pattern
  finds all of them.
- Scanning a known-clean repository produces no findings above informational.
- A truncated or quota-limited scan reports `INCOMPLETE`, never `PASS`.
- A report containing a detected invisible-character payload can be safely read by
  a person and by an AI assistant, with the payload rendered inert and visible.
