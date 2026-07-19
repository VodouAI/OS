/**
 * bootstrapHeadless.ts — start the Vodou agentic engine WITHOUT the HTTP/WS gateway.
 *
 * This is the subset of `index.ts main()` that the embedded CLI needs to run `chat()`
 * from any directory: auth init, the memory-flush wiring, an executor-health probe, and
 * the daemon+worker socket ensure (so tool calls go over the worker socket exactly like
 * the gateway does — never spawning `./do`/`brain` per turn; see CLAUDE.md process-
 * accumulation hazard). It deliberately does NOT call setupExpress/createServer/
 * setupWebSocket — there is no web server in CLI mode.
 *
 * The gateway keeps its own (richer) init in main(); this is the CLI's lean path.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { isConfigured, initAuth, triggerMemoryFlush, kickstartWarmCliPool } from './llm.js';
import { setFlushCallback } from './conversation.js';
import { checkExecutorHealth, callWorkerSocket } from './executor.js';
import { getProjectRoot } from './db.js';

export interface BootstrapResult {
  projectRoot: string;
  configured: boolean;
  executorOk: boolean;
}

/** Quick connect test — resolves false if the socket file is missing or stale. */
async function socketAlive(sock: string, timeoutMs = 1000): Promise<boolean> {
  if (!fs.existsSync(sock)) return false;
  return new Promise<boolean>((resolve) => {
    const c = net.createConnection(sock);
    const timer = setTimeout(() => { c.destroy(); resolve(false); }, timeoutMs);
    c.on('connect', () => { clearTimeout(timer); c.destroy(); resolve(true); });
    c.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function waitForSocket(sock: string, tries = 10, everyMs = 500): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (fs.existsSync(sock)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/**
 * Ensure daemon + worker sockets are up (mirrors index.ts main()'s ensure block, minus
 * the gateway's 30s periodic re-ensure interval — a short-lived CLI doesn't need it).
 */
async function ensureDaemonWorker(): Promise<void> {
  const root = getProjectRoot();
  const bin = path.join(root, process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
  const oiDir = path.join(root, '.vodou');
  const daemonSock = path.join(oiDir, 'daemon.sock');
  const workerSock = path.join(oiDir, 'worker.sock');

  // Remove stale sockets so `ensure` can rebind cleanly.
  for (const sock of [daemonSock, workerSock]) {
    if (fs.existsSync(sock) && !(await socketAlive(sock))) {
      try { fs.unlinkSync(sock); } catch { /* */ }
    }
  }

  // If the worker sock is dead, a stale worker process may still hold worker.lock — then
  // `worker ensure` bails on flock and nothing serves BrainLoader (the live intent/memory
  // pipeline). Reap it first (mirrors the gateway's reapStaleWorker), then ensure can start
  // a fresh worker. Without this, `brain` calls time out and the CLI loses the live magic.
  if (!(await socketAlive(workerSock))) {
    if (process.platform !== 'win32') { try { execSync(`pkill -9 -f "vodou-core worker start"`, { stdio: 'ignore', timeout: 3_000, windowsHide: true }); } catch { /* */ } }
    try { fs.unlinkSync(path.join(oiDir, 'worker.pid')); } catch { /* */ }
  }

  // SIGKILL on timeout: macOS UE/uninterruptible-sleep processes ignore SIGTERM and
  // would hang execSync forever (same fix as the gateway's ensure block).
  try {
    execSync(`"${bin}" daemon ensure`, { cwd: root, timeout: 10_000, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true });
  } catch { /* best-effort */ }
  try {
    execSync(`"${bin}" worker ensure`, { cwd: root, timeout: 10_000, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true });
  } catch { /* best-effort */ }

  await Promise.all([waitForSocket(daemonSock), waitForSocket(workerSock)]);
}

/**
 * Bring up the engine for headless (CLI) use. Idempotent enough to call once at startup.
 * `warmPool` kickstarts the Claude-CLI warm pool (only relevant on the CLI-auth path;
 * a no-op when an API key is configured).
 */
export async function bootstrapHeadless(opts?: { warmPool?: boolean; warmBrain?: boolean }): Promise<BootstrapResult> {
  await initAuth();
  setFlushCallback(triggerMemoryFlush);

  await ensureDaemonWorker();

  const health = await checkExecutorHealth().catch(() => ({ vcAvailable: false } as { vcAvailable: boolean }));

  if (opts?.warmPool !== false) {
    try { kickstartWarmCliPool(); } catch { /* */ }
  }

  // Pre-warm the worker's BrainLoader (loads embedding models) in the background so the
  // user's FIRST turn gets live intent routing + memory recall instead of racing a cold
  // worker. Fire-and-forget — never block startup on it.
  if (opts?.warmBrain !== false) {
    callWorkerSocket('brain', { query: '__brainloader_warmup__', clean: true }, 30_000).catch(() => { /* */ });
  }

  return {
    projectRoot: getProjectRoot(),
    configured: isConfigured(),
    executorOk: !!health.vcAvailable,
  };
}
