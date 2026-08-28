/**
 * Best-effort resource containment for gate commands, opt-in and off by
 * default (`gate.sandbox.enabled`). This is deliberately NOT a security
 * boundary: it does not isolate the network, the filesystem outside the
 * worktree, or other processes on the host. Achieving that would need a
 * native dependency (a container runtime, a namespacing library) or root
 * privileges this zero-dependency kit does not assume are available — see
 * MISSION.md on scope. What it DOES bound, using nothing but the POSIX
 * shell's own `ulimit` builtin: a runaway gate command (an infinite loop
 * that burns CPU forever, a fork bomb, a multi-gigabyte write from a buggy
 * or malicious implementation) that would otherwise degrade or fill the
 * host running the whole system.
 *
 * `ulimit` is a shell builtin, not a program, so it only works because
 * gate.mjs's exec() already runs commands via `shell:true` — it cannot be
 * bolted onto a `spawn` that skips the shell. It also does not exist on
 * Windows: cmd.exe and PowerShell have no equivalent, and Node exposes no
 * cross-platform primitive for process resource limits without a native
 * addon. `sandboxSupported()` reports that platform gap so callers show it
 * instead of silently running unsandboxed when `enabled: true` — see
 * `trellis doctor`, which surfaces exactly this.
 */

/** True where `ulimit` in the gate's shell can actually enforce these limits. */
export function sandboxSupported(platform = process.platform) {
  return platform !== "win32";
}

/**
 * Rewrite a gate command to run under `ulimit` limits when the sandbox is
 * enabled and this platform supports it. Unchanged otherwise — including
 * when `enabled: true` but the platform can't enforce it, so the caller
 * (gate.mjs's exec) runs the real command rather than a broken one; doctor
 * is where that gap gets surfaced, not here.
 *
 * Block-size units for `ulimit -f` (max file size) vary by shell/OS — POSIX
 * says 512-byte blocks, some shells use 1024. This does not attempt to be
 * exact for that reason: it is a coarse backstop against "wrote gigabytes to
 * disk", not a precise quota.
 */
export function wrapForSandbox(command, sandbox, platform = process.platform) {
  if (!sandbox?.enabled) return command;
  if (!sandboxSupported(platform)) return command;

  const limits = [];
  if (sandbox.maxMemoryMb) limits.push(`ulimit -v ${Math.round(sandbox.maxMemoryMb * 1024)}`);
  if (sandbox.maxCpuSeconds) limits.push(`ulimit -t ${Math.round(sandbox.maxCpuSeconds)}`);
  if (sandbox.maxFileSizeMb) limits.push(`ulimit -f ${Math.round(sandbox.maxFileSizeMb * 1024)}`);
  if (!limits.length) return command;

  // `exec` replaces the shell with the command instead of running it as a
  // child of the shell, so the limits set above apply to the command itself
  // (and anything it execs in turn) rather than just the short-lived `sh -c`
  // wrapper that set them.
  return `${limits.join("; ")}; exec ${command}`;
}
