/**
 * index.ts — the Vodou CLI entrypoint (`bin/vodou-cli` → dist/cli/index.js).
 *
 * Embeds the agentic loop in-process: bootstrap the engine (no HTTP/WS), then either run
 * one prompt (`-p "…"` / positional / piped stdin) or an interactive plain REPL. Phase 1
 * ships the plain renderer; Phase 2 swaps in the Ink TUI as the default for TTYs.
 *
 * cwd model: the bash launcher cd's to the project root and passes the user's ORIGINAL
 * directory via VODOU_CLI_CWD, which becomes the file-tools root so relative paths anchor
 * to where the user launched (absolute/.. paths still reach machine-wide; denylist on).
 */

import './quiet.js'; // FIRST — redirect engine logs before heavy modules load.

import { bootstrapHeadless } from '../bootstrapHeadless.js';
import { shutdownCliPool } from '../llm.js';
import { CliSession } from './session.js';
import { runPlainRepl, runPlainOnce } from './renderers/plain.js';
import { runTui } from './renderers/tui.js';

interface CliArgs { print: string | null; plain: boolean; positional: string[] }

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let print: string | null = null;
  let plain = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--print') print = args[++i] ?? '';
    else if (a === '--plain') plain = true;              // force the streaming-print REPL
    else if (a === '--tui' || a === '--verbose' || a === '--remote') { /* --tui: now the default; --verbose: quiet.ts */ }
    else positional.push(a);
  }
  return { print, plain, positional };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  // Anchor file access to the user's launch directory (see header). Two paths:
  //  - CLI providers (claude-cli/kimi-cli): VODOU_CLI_AGENT_CWD sets the spawn cwd so
  //    their native Read/Write/Edit/Bash operate in the launch dir. MUST be set before
  //    bootstrap (the warm CLI pool spawns during bootstrap).
  //  - API providers (anthropic/openai/…): VODOU_FS_TOOLS_* drive the fs-sandbox tools.
  const launchCwd = process.env.VODOU_CLI_CWD || process.cwd();
  process.env.VODOU_CLI_AGENT_CWD ||= launchCwd;
  // Interactive dev CLI: always use the user's CONFIGURED model — no silent smart-routing
  // downgrade to a cheap model (haiku). Override with VODOU_SMART_ROUTING=1 if you want it.
  process.env.VODOU_SMART_ROUTING ||= '0';
  // Give live BrainLoader (intent routing + memory recall) room to run on a cold worker —
  // its first call loads embedding models and can exceed the gateway's snappy 8s default.
  process.env.VODOU_BRAINLOADER_TIMEOUT_MS ||= '25000';
  process.env.VODOU_FS_TOOLS_ENABLED ||= '1';
  process.env.VODOU_FS_TOOLS_UNSANDBOXED ||= '1';
  process.env.VODOU_FS_TOOLS_ROOT ||= launchCwd;

  if (process.env.VODOU_CLI_DEBUG === '1') {
    process.stderr.write(`[cli-debug] VODOU_CLI_CWD=${process.env.VODOU_CLI_CWD} launchCwd=${launchCwd} AGENT_CWD=${process.env.VODOU_CLI_AGENT_CWD} pcwd=${process.cwd()}\n`);
  }

  const { print, plain, positional } = parseArgs(process.argv);

  const boot = await bootstrapHeadless();
  if (!boot.configured) {
    process.stderr.write('Vodou CLI: no LLM configured. Set ANTHROPIC_API_KEY or install the Claude CLI, then retry.\n');
    process.exit(1);
  }

  const session = new CliSession();
  const cleanup = () => { try { shutdownCliPool(); } catch { /* */ } };
  process.on('exit', cleanup);

  // One-shot: -p "text" | positional words | piped stdin.
  const oneShot = (print && print.length ? print : null)
    ?? (positional.length ? positional.join(' ') : null)
    ?? (await readStdin() || null);

  if (oneShot) {
    await runPlainOnce(session, oneShot);
    process.exit(0);
  }

  if (!process.stdin.isTTY) process.exit(0); // nothing piped, not interactive

  // Default = Ink full-screen TUI (scrollback fixed via incremental Static commit, build
  // 2026-06-20j). --plain forces the streaming-print REPL (pipes/SSH/CI fall back to one-shot).
  if (plain) await runPlainRepl(session);
  else await runTui(session);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`Vodou CLI fatal: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  process.exit(1);
});
