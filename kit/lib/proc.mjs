import { spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Kill a spawned child AND everything it spawned, not just the process this
 * module handed a handle to.
 *
 * Both call sites that need this (gate.mjs's `exec`, driver.mjs's
 * `runSession`) launch with `shell:true`, so the process `spawn()` returns a
 * handle to is the SHELL (`cmd.exe` on Windows, `/bin/sh` elsewhere) — the
 * command actually being run (a test runner, a Claude Code session) is a
 * GRANDCHILD. `child.kill()` only ever signals that one shell process; the
 * grandchild inherits the stdio pipes and survives, keeping them open
 * forever. Since Node's `'close'` event fires only once the process has
 * exited AND its stdio streams have closed, an orphaned grandchild means
 * `'close'` never fires — the caller's promise never settles, and whatever
 * timeout was meant to bound the operation instead hangs it.
 *
 * POSIX: the caller must spawn with `detached: true`, which puts the child
 * in its own new process group (`pgid === child.pid`). Signalling the
 * NEGATIVE pid delivers the signal to every process in that group — shell
 * and every descendant it launched.
 *
 * Windows has no equivalent to a POSIX process group reachable from Node's
 * `child_process`; `taskkill /T` walks the real parent-child process tree
 * instead and is the standard tool for exactly this.
 */
export function killTree(child) {
  if (!child?.pid) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // The process (or its group) may already be gone by the time this runs
    // -- that is success, not a failure worth reporting. Fall back to a
    // plain kill of the immediate child in case the tree-kill path itself
    // couldn't run (taskkill missing, or the child was never actually
    // detached for some reason).
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Whether the caller should pass `detached: true` to `spawn()` for killTree
 * to be able to take out the whole process group. Windows has no equivalent
 * concept here — `killTree` uses `taskkill /T` there regardless. */
export const DETACH_FOR_TREE_KILL = !IS_WINDOWS;
