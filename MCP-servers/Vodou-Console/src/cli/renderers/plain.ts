/**
 * plain.ts — the streaming "print" renderer + readline loop (the DEFAULT UX).
 *
 * It prints the transcript as ordinary terminal output, so the terminal owns the
 * scrollback (scroll/copy/paste all work natively) — no managed full-screen region to
 * fight, unlike the Ink TUI (`--tui`). It consumes the same StreamEvent stream as the
 * TUI. Also powers one-shot `-p`/piped mode. Never use console.log here (stdout is the
 * render surface; the engine's console.* is redirected to a log file by quiet.ts).
 */

import readline from 'readline';

import type { StreamEvent } from '../../llm.js';
import { getActiveModelLabel, reinitAuth } from '../../llm.js';
import { getSetting, setSetting } from '../../db.js';
import type { Renderer } from '../session.js';
import { CliSession } from '../session.js';

export const CLI_BUILD = '2026-06-21h';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};
const out = (s: string) => process.stdout.write(s);
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class PlainRenderer implements Renderer {
  private atLineStart = true;
  private started = false;                  // has this turn emitted its assistant bullet yet?
  private openTool: string | null = null;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private spinFrame = 0;
  private lastStatus = '';
  private lineBuf = '';            // markdown is rendered per COMPLETE line (streamed chunks split markers)
  private inCodeFence = false;
  // Cumulative session usage (for /usage).
  usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  usageSummary(): string {
    const u = this.usage;
    return `${u.turns} turn(s) · in ${u.inputTokens} · out ${u.outputTokens} · $${u.costUsd.toFixed(4)}`;
  }

  private freshLine() {
    if (!this.atLineStart) { out('\n'); this.atLineStart = true; }
  }

  /** Transient single-line spinner while waiting — overwritten, never committed to scrollback. */
  private startSpinner() {
    if (!useColor || this.spinTimer) return;
    this.spinTimer = setInterval(() => {
      const label = this.lastStatus || 'thinking…';
      out(`\r${C.dim(SPIN[this.spinFrame = (this.spinFrame + 1) % SPIN.length] + ' ' + label)}\x1b[K`);
    }, 90);
  }
  private stopSpinner() {
    if (this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = null; out('\r\x1b[K'); this.atLineStart = true; }
  }

  turnStart(): void {
    this.started = false; this.openTool = null; this.lastStatus = ''; this.atLineStart = true;
    this.startSpinner();
  }

  private ensureBullet() {
    if (!this.started) { this.stopSpinner(); this.freshLine(); out(C.green('⏺ ')); this.started = true; this.atLineStart = false; }
  }

  /** Lightweight markdown → ANSI for ONE complete line (no cross-line state except code fences). */
  private renderMd(line: string): string {
    if (!useColor) return line;
    if (/^\s*```/.test(line)) { this.inCodeFence = !this.inCodeFence; return C.dim(line); }
    if (this.inCodeFence) return C.dim(line);
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) return C.bold(h[2]);
    let l = line.replace(/^(\s*)[-*]\s+/, '$1• ');
    l = l.replace(/`([^`]+)`/g, (_m, p1) => C.cyan(p1));     // inline code
    l = l.replace(/\*\*([^*]+)\*\*/g, (_m, p1) => C.bold(p1)); // bold
    return l;
  }

  /** Buffer streamed text; emit each COMPLETE line rendered as markdown. */
  private feedText(s: string) {
    this.lineBuf += s;
    let idx: number;
    while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      this.stopSpinner(); this.ensureBullet();
      out(this.renderMd(line) + '\n'); this.atLineStart = true;
    }
  }

  /** Flush any partial buffered line (before a tool/footer/turn-end interrupts the stream). */
  private flushPending() {
    if (this.lineBuf) {
      this.stopSpinner(); this.ensureBullet();
      out(this.renderMd(this.lineBuf)); this.atLineStart = this.lineBuf.endsWith('\n');
      this.lineBuf = '';
    }
  }

  onEvent(e: StreamEvent): void {
    switch (e.type) {
      case 'text':
        // feedText kills the spinner before writing (its periodic erase-line would
        // otherwise wipe streamed output — the "sometimes no output" bug).
        if (e.content) this.feedText(e.content);
        break;
      case 'status':
        if (e.status) { this.lastStatus = e.status; } // shown via the spinner, not committed
        break;
      case 'tool_call_start': {
        const name = `${e.serverName ? e.serverName + '.' : ''}${e.toolName || 'tool'}`;
        if (this.openTool === name) break;
        this.openTool = name;
        this.flushPending();
        this.stopSpinner(); this.freshLine();
        out(C.dim(`⏺ ${name}…`) + '\n'); this.atLineStart = true;
        break;
      }
      case 'tool_call_end': {
        this.flushPending();
        this.stopSpinner(); this.freshLine();
        // Prefer the name captured at tool_call_start — the claude-cli end-event
        // sometimes hardcodes 'Bash' for non-Bash tools.
        const name = this.openTool || e.toolName || 'tool';
        this.openTool = null;
        const mark = e.success === false ? C.red('✗') : C.green('✓');
        const ms = e.executionTime ? C.dim(` (${e.executionTime}ms)`) : '';
        const err = e.success === false && e.error ? C.red(` ${e.error.slice(0, 200)}`) : '';
        out(C.dim('  ⎿ ') + `${mark}${C.dim(' ' + name)}${ms}${err}\n`); this.atLineStart = true;
        this.startSpinner(); // back to waiting for the model's continuation
        break;
      }
      case 'error':
        this.flushPending();
        this.stopSpinner(); this.freshLine();
        out(C.red(`✗ ${e.error || 'error'}`) + '\n'); this.atLineStart = true;
        break;
      case 'done': {
        this.flushPending();
        if (e.usage) {
          const u = e.usage;
          this.usage.turns += 1;
          this.usage.inputTokens += u.inputTokens || 0;
          this.usage.outputTokens += u.outputTokens || 0;
          this.usage.costUsd += u.costUsd || 0;
          const parts = [u.model,
            u.inputTokens != null ? `in ${u.inputTokens}` : null,
            u.outputTokens != null ? `out ${u.outputTokens}` : null,
            u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : null].filter(Boolean);
          if (parts.length) { this.stopSpinner(); this.freshLine(); out(C.dim(`  ${parts.join(' · ')}`) + '\n'); this.atLineStart = true; }
        }
        break;
      }
      default: break;
    }
  }

  confirmApproval(e: StreamEvent): Promise<boolean> {
    this.stopSpinner(); this.freshLine();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<boolean>((resolve) => {
      rl.question(C.bold(`Approve ${e.toolName} (${e.category || 'sensitive'})? [y/N] `), (ans) => {
        rl.close(); resolve(/^y(es)?$/i.test(ans.trim()));
      });
    });
  }

  turnEnd(): void { this.flushPending(); this.stopSpinner(); this.freshLine(); this.inCodeFence = false; }
}

// VODOU wordmark (ANSI Shadow). Equal-width rows so the letters line up.
const VODOU_ART = [
  '██╗   ██╗ ██████╗ ██████╗  ██████╗ ██╗   ██╗',
  '██║   ██║██╔═══██╗██╔══██╗██╔═══██╗██║   ██║',
  '██║   ██║██║   ██║██║  ██║██║   ██║██║   ██║',
  '╚██╗ ██╔╝██║   ██║██║  ██║██║   ██║██║   ██║',
  ' ╚████╔╝ ╚██████╔╝██████╔╝╚██████╔╝╚██████╔╝',
  '  ╚═══╝   ╚═════╝ ╚═════╝  ╚═════╝  ╚═════╝ ',
];

/**
 * Startup banner — the VODOU wordmark + tagline + build/cwd. Shared by BOTH renderers
 * (TUI + plain); printed once on interactive startup, never in one-shot mode.
 */
export function vodouBanner(): string {
  const cwd = process.env.VODOU_CLI_AGENT_CWD || process.cwd();
  if (!useColor) {
    return `\n${VODOU_ART.map((l) => '  ' + l).join('\n')}\n\n  the personalization OS · build ${CLI_BUILD}\n  cwd: ${cwd}\n  /help for commands · /exit to quit\n\n`;
  }
  const MAG = '\x1b[95m', BOLD = '\x1b[1m', DIM = '\x1b[2m', RST = '\x1b[0m';
  const art = VODOU_ART.map((l) => `  ${BOLD}${MAG}${l}${RST}`).join('\n');
  return `\n${art}\n\n  ${DIM}the personalization OS · build ${CLI_BUILD}${RST}\n  ${DIM}cwd: ${cwd}${RST}\n  ${DIM}/help for commands · /exit to quit · Ctrl-C abort${RST}\n\n`;
}

function intro(_session: CliSession): void {
  out(vodouBanner());
}

/** One-shot: run a single prompt and exit (powers `vodou -p "…"` and piped stdin). */
export async function runPlainOnce(session: CliSession, text: string): Promise<void> {
  await session.runTurn(text, new PlainRenderer());
}

/** Interactive streaming REPL — the default. Native terminal scrollback, no managed region. */
export async function runPlainRepl(session: CliSession): Promise<void> {
  const renderer = new PlainRenderer();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan('› ') });

  intro(session);
  let turnActive = false;
  rl.prompt();

  rl.on('SIGINT', () => {
    if (turnActive) { session.abort(); out(C.dim('\n^C aborted\n')); }
    else { out('\n'); rl.close(); }
  });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === '/exit' || text === '/quit') { rl.close(); return; }
    if (text === '/new') { session.reset(); out(C.dim('— new conversation —\n\n')); rl.prompt(); return; }
    if (text === '/help' || text === '/?') {
      out(C.dim('  /model [name] · /usage · /clear · /new · /exit  ·  Ctrl-C abort turn\n\n'));
      rl.prompt(); return;
    }
    if (text === '/usage') { out(C.dim('  ' + renderer.usageSummary()) + '\n\n'); rl.prompt(); return; }
    if (text === '/clear') { out('\x1b[2J\x1b[3J\x1b[H'); rl.prompt(); return; }
    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.slice('/model'.length).trim();
      if (!arg) {
        out(C.dim(`  current: ${getActiveModelLabel()}  (configured cli_model=${getSetting('cli_model') || 'sonnet'})\n`));
        out(C.dim('  switch with: /model <sonnet|opus|haiku|...>\n\n'));
      } else {
        try { setSetting('cli_model', arg); await reinitAuth(); out(C.green(`  ✓ model → ${arg}`) + C.dim(' (applies next turn)\n\n')); }
        catch (e) { out(C.red(`  ✗ ${e instanceof Error ? e.message : String(e)}\n\n`)); }
      }
      rl.prompt(); return;
    }

    turnActive = true;
    rl.pause();
    try { await session.runTurn(text, renderer); }
    catch (e) { out(C.red(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`)); }
    turnActive = false;
    rl.resume();
    out('\n');
    rl.prompt();
  });

  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
}
