/**
 * P2b — the gateway's child-process registry.
 *
 * WHY THIS EXISTS
 *
 * `src/child_registry.rs` has done exactly this for the Rust engine since it was
 * written: "tracks every MCP server child process spawned by vodou-core; ensures
 * all children are killed on exit — normal, watchdog, signal, or atexit."
 *
 * The gateway had no equivalent, across **98 spawn sites**. Nothing tracked a
 * child, nothing reaped one, and nothing could answer "what are we running".
 *
 * That is not theoretical. Measured 2026-08-29, while auditing this very phase:
 * two `Vodou-channels` servers had been parentless for **fifteen hours**, left by
 * ordinary force-restarts earlier the same day. This repo has a 425-process
 * incident on record from the same cause.
 *
 * WHAT THIS IS NOT
 *
 * Not a timeout. Long-lived children are long-lived ON PURPOSE — the CLI session
 * pool, the channels server, service starts, the updater. The original plan said
 * to "add missing timeouts to ~75 spawns", and applying that uniformly would kill
 * the pool mid-session and abort updates. The registry bounds a child's life to
 * the GATEWAY's life, which is the actual invariant: no child should outlive the
 * process that spawned it.
 *
 * Shaped after the Rust one deliberately — same three verbs, same two-phase kill —
 * so there is one idea about child processes in this repo, not two.
 */
import type { ChildProcess } from 'node:child_process';

interface TrackedChild {
  child: ChildProcess;
  /** What it is, for `activeChildren()` — "channels", "claude-cli pool", … */
  label: string;
  at: number;
}

const _children = new Map<number, TrackedChild>();
let _handlersInstalled = false;

/**
 * Register a freshly-spawned child.
 *
 * Self-unregistering: the `exit` listener removes it, so a child that ends
 * normally leaves no entry behind and a recycled PID cannot be killed by
 * mistake — the hazard `unregister` exists for on the Rust side.
 */
export function registerChild(child: ChildProcess, label: string): ChildProcess {
  installExitHandlers();
  const pid = child.pid;
  if (typeof pid !== 'number') return child;   // spawn failed; nothing to track
  _children.set(pid, { child, label, at: Date.now() });
  child.once('exit', () => { _children.delete(pid); });
  child.once('error', () => { _children.delete(pid); });
  return child;
}

export function unregisterChild(pid: number | undefined): void {
  if (typeof pid === 'number') _children.delete(pid);
}

/** What are we running, and for how long. The question nothing could answer. */
export function activeChildren(): Array<{ pid: number; label: string; ageMs: number }> {
  const now = Date.now();
  return [...
    _children.entries()].map(([pid, t]) => ({ pid, label: t.label, ageMs: now - t.at }));
}

/**
 * Kill every registered child. SIGTERM, then SIGKILL for survivors.
 *
 * Returns how many were signalled, so a caller can log it rather than guess.
 *
 * The delay is NOT awaited on the `exit` path: Node's `exit` handler is
 * synchronous-only, and anything asynchronous there is silently dropped. So the
 * escalation is scheduled and only actually runs when we were called with time
 * to spare (SIGINT/SIGTERM). On a hard exit the SIGTERM has still gone out,
 * which is the part that matters.
 */
export function killAllChildren(graceMs = 200): number {
  const snapshot = [...(_children.values())];
  if (!snapshot.length) return 0;

  for (const { child } of snapshot) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  const escalate = () => {
    for (const { child } of snapshot) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      catch { /* already gone */ }
    }
  };
  if (graceMs > 0) setTimeout(escalate, graceMs).unref?.();
  else escalate();

  return snapshot.length;
}

/**
 * Installed once, on first registration rather than at import: a module that
 * attaches process-wide signal handlers merely by being imported is a surprise,
 * and this one is imported by tests.
 */
function installExitHandlers(): void {
  if (_handlersInstalled) return;
  _handlersInstalled = true;

  process.on('exit', () => { killAllChildren(0); });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      const n = killAllChildren();
      if (n) console.error(`[child-registry] ${sig}: signalled ${n} child process(es)`);
      // Re-raise so the default disposition still applies — swallowing the
      // signal here would make the gateway unkillable by ordinary means.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

/** Test seam: drop all tracking without signalling anything. */
export function __resetChildRegistryForTest(): void {
  _children.clear();
}
