/**
 * tui.tsx — the Ink (React-for-terminal) renderer. Primary UX for TTYs.
 *
 * Consumes the SAME StreamEvent stream as the plain renderer (the contract lives in
 * session.ts), so the agentic loop is untouched — this is purely presentation. Finalized
 * turns render via Ink's <Static> (printed once, never re-diffed); only the live tail
 * (streaming text / running tool / input) re-renders each frame.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, Static, useApp, useInput, render } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

import type { StreamEvent } from '../../llm.js';
import { getActiveModelLabel, reinitAuth } from '../../llm.js';
import { getSetting, setSetting } from '../../db.js';
import type { Renderer } from '../session.js';
import { CliSession } from '../session.js';
import { vodouBanner } from './plain.js'; // shared startup banner (build marker lives in plain.ts)
import { classifyLine, MdView, type MdLine } from './markdown.js';
import { listSkillsText, listServersText, listToolsText, searchText, CLI_HELP, isServerSideCommand, modelHint, bareModelName } from '../commands.js';

type BlockBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; md: MdLine }   // md = line pre-classified at commit (fence state captured then)
  | { kind: 'tool'; name: string; ok: boolean; ms?: number; error?: string }
  | { kind: 'info'; text: string }      // dim slash-command output (/help, /usage, /model…)
  | { kind: 'error'; text: string };
// `id` is a STABLE per-block key. Ink's <Static> commits each child once and never
// re-renders it; a churning key (e.g. a fresh counter every render) makes it drop the
// block entirely — the "answer flashes then disappears" bug.
type Block = BlockBody & { id: number };

function fmtUsage(u: NonNullable<StreamEvent['usage']>): string {
  return [
    u.model,
    u.inputTokens != null ? `in ${u.inputTokens}` : null,
    u.outputTokens != null ? `out ${u.outputTokens}` : null,
    u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Bridges chat() events → React. Implements Renderer; the <App> subscribes to its
 * single listener and force-renders. `history` is append-only (Static); `streaming`,
 * `liveTool`, `status`, and `busy` are the live tail.
 */
class TuiController implements Renderer {
  history: Block[] = [];
  streaming = '';                                   // assistant text accumulating this segment
  liveTool: string | null = null;                   // a tool currently running
  status = '';                                      // transient status line
  busy = false;
  footer = '';                                      // last-turn usage
  usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };  // cumulative, for /usage
  pendingApproval: { ev: StreamEvent; resolve: (b: boolean) => void } | null = null;
  private listener: (() => void) | null = null;
  private key = 0;

  subscribe(fn: () => void) { this.listener = fn; }
  private emit() { this.listener?.(); }

  /**
   * Append a history block. TWO things are required for Ink <Static> to actually commit:
   *  (1) a NEW array reference each time — Static is memoized and skips re-render when the
   *      items prop is the same reference (mutating in place = the block never prints), and
   *  (2) a STABLE per-block id as the key (a churning key makes Static drop the block).
   */
  private add(b: BlockBody) { this.history = [...this.history, { ...b, id: this.key++ } as Block]; }

  pushUser(text: string) { this.add({ kind: 'user', text }); this.emit(); }
  note(text: string) { this.add({ kind: 'error', text }); this.emit(); }
  info(text: string) { this.add({ kind: 'info', text }); this.emit(); }

  usageSummary(): string {
    const u = this.usage;
    return `${u.turns} turn(s) · in ${u.inputTokens} · out ${u.outputTokens} · $${u.costUsd.toFixed(4)}`;
  }

  /** Commit any remaining streamed text (whole lines + the trailing partial) into history. */
  private flushStreaming() {
    this.commitCompleteLines();                        // drain complete lines first
    if (this.streaming.length) this.addAssistantLine(this.streaming.replace(/\s+$/, ''));
    this.streaming = '';
  }

  private inCodeFence = false;                          // markdown code-fence state across lines

  /** Classify a completed line as markdown (threading fence state) and commit it to Static. */
  private addAssistantLine(text: string) {
    const { md, nextFence } = classifyLine(text, this.inCodeFence);
    this.inCodeFence = nextFence;
    this.history = [...this.history, { kind: 'assistant', text, md, id: this.key++ }];
  }

  /**
   * Move every COMPLETE line (everything up to the last newline) out of the live tail
   * and into <Static> history, leaving only the trailing partial line streaming. This
   * is the load-bearing fix for native scrollback: it keeps the live region a few lines
   * tall, so Ink never has to erase a region TALLER than the viewport (which corrupts
   * output, pins the view to the bottom, and eats committed lines). Finished lines flow
   * straight into the terminal's native scrollback — the same property that makes the
   * plain renderer scroll/copy/paste correctly.
   */
  private commitCompleteLines() {
    const nl = this.streaming.lastIndexOf('\n');
    if (nl < 0) return;                                // no complete line yet
    const complete = this.streaming.slice(0, nl);      // one or more whole lines
    this.streaming = this.streaming.slice(nl + 1);     // keep the trailing partial
    for (const line of complete.split('\n')) this.addAssistantLine(line);
  }

  onEvent(e: StreamEvent): void {
    switch (e.type) {
      case 'text':
        if (e.content) { this.streaming += e.content; this.status = ''; this.commitCompleteLines(); }
        break;
      case 'status':
        if (e.status) this.status = e.status;
        break;
      case 'tool_call_start': {
        const name = `${e.serverName ? e.serverName + '.' : ''}${e.toolName || 'tool'}`;
        if (this.liveTool === name) break;          // dedupe partial+full
        this.flushStreaming();                       // text before the tool becomes its own block
        this.liveTool = name;
        break;
      }
      case 'tool_call_end': {
        // Prefer the start-event name (claude-cli end-event can hardcode 'Bash').
        const name = this.liveTool || e.toolName || 'tool';
        this.liveTool = null;
        this.add({ kind: 'tool', name, ok: e.success !== false, ms: e.executionTime, error: e.success === false ? e.error : undefined });
        break;
      }
      case 'error':
        this.flushStreaming();
        this.add({ kind: 'error', text: e.error || 'error' });
        break;
      case 'done':
        if (e.usage) {
          this.footer = fmtUsage(e.usage);
          this.usage.turns += 1;
          this.usage.inputTokens += e.usage.inputTokens || 0;
          this.usage.outputTokens += e.usage.outputTokens || 0;
          this.usage.costUsd += e.usage.costUsd || 0;
        }
        break;
      default:
        break;
    }
    this.emit();
  }

  /** Start of a turn — reset markdown code-fence state so a new answer parses cleanly. */
  turnStart(): void { this.inCodeFence = false; this.emit(); }

  /** End of a turn — flush remaining streamed text, then a blank line for separation. */
  turnEnd(): void {
    const had = this.streaming.length > 0 || (this.history.length > 0 && this.history[this.history.length - 1].kind === 'assistant');
    this.flushStreaming();
    if (had) this.addAssistantLine('');                   // restores the old post-answer blank line
    this.status = ''; this.liveTool = null; this.emit();
  }

  confirmApproval(e: StreamEvent): Promise<boolean> {
    return new Promise<boolean>((resolve) => { this.pendingApproval = { ev: e, resolve }; this.emit(); });
  }
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'user':
      return <Text><Text color="cyan" bold>› </Text>{b.text}</Text>;
    case 'assistant':
      // One block = one line now (committed incrementally for native scrollback), rendered
      // as markdown (headers/bold/italic/inline-code/bullets/code-blocks/links). MdView keeps
      // blank lines at full height. Pre-classified at commit time so fence state is correct.
      return <MdView md={b.md} />;
    case 'tool': {
      const mark = b.ok ? <Text color="green">✓</Text> : <Text color="red">✗</Text>;
      return (
        <Text>
          {'  '}{mark}<Text color="gray"> {b.name}{b.ms != null ? ` (${b.ms}ms)` : ''}</Text>
          {b.error ? <Text color="red"> {b.error.slice(0, 200)}</Text> : null}
        </Text>
      );
    }
    case 'info':
      return <Text color="gray">{b.text}</Text>;
    case 'error':
      return <Text color="red">✗ {b.text}</Text>;
  }
}

function App({ controller, session }: { controller: TuiController; session: CliSession }) {
  const [, force] = useState(0);
  const [input, setInput] = useState('');
  const { exit } = useApp();

  useEffect(() => { controller.subscribe(() => force((x) => x + 1)); }, [controller]);

  useInput((inp, key) => {
    if (key.ctrl && inp === 'c') {
      if (controller.busy) { session.abort(); }    // abort turn
      else { exit(); }                              // quit at idle
    }
  });

  const onSubmit = async (value: string) => {
    const text = value.trim();
    setInput('');

    // Approval prompt takes priority.
    if (controller.pendingApproval) {
      const { resolve } = controller.pendingApproval;
      controller.pendingApproval = null;
      resolve(/^y(es)?$/i.test(text));
      force((x) => x + 1);
      return;
    }
    if (!text || controller.busy) return;

    // multi-line info output → one dim block per line; turn-runner shared by chat + skill-load
    const emitInfo = (s: string) => { for (const l of s.split('\n')) controller.info(l); };
    const runText = async (t: string) => {
      controller.busy = true; force((x) => x + 1);
      try { await session.runTurn(t, controller); }
      catch (e) { controller.note(e instanceof Error ? e.message : String(e)); }
      controller.busy = false; force((x) => x + 1);
    };

    if (text === '/exit' || text === '/quit') { exit(); return; }
    if (text === '/new') { session.reset(); controller.info('— new conversation —'); return; }
    if (text === '/help' || text === '/?') {
      emitInfo(CLI_HELP);   // shared with --plain; see commands.ts
      return;
    }
    if (text === '/usage') { controller.info('  ' + controller.usageSummary()); return; }
    if (text === '/clear') { controller.history = []; process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); force((x) => x + 1); return; }
    if (text === '/server' || text === '/servers') { emitInfo(listServersText()); return; }
    if (text.startsWith('/server ') || text.startsWith('/servers ')) {
      const rest = text.slice(text.indexOf(' ') + 1).trim();
      const sp = rest.indexOf(' ');
      const name = sp < 0 ? rest : rest.slice(0, sp);
      const instruction = sp < 0 ? '' : rest.slice(sp + 1).trim();
      if (!instruction) { emitInfo(listToolsText(name)); return; }   // `/server gmail` → its tools
      controller.pushUser(text);                                      // `/server gmail <do X>` → act via that server
      await runText(`Use the "${name}" MCP server to: ${instruction}`);
      return;
    }
    if (text === '/tools' || text.startsWith('/tools ')) { emitInfo(listToolsText(text.slice('/tools'.length).trim() || undefined)); return; }
    if (text === '/search' || text.startsWith('/search ')) { emitInfo(searchText(session.conversationId, text.slice('/search'.length).trim())); return; }
    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.slice('/model'.length).trim();
      if (!arg) {
        controller.info(`current: ${getActiveModelLabel()}  (configured cli_model=${getSetting('cli_model') || 'sonnet'})`);
        controller.info(modelHint());
      } else {
        try { setSetting('cli_model', arg); await reinitAuth(); controller.info(`✓ model → ${arg} (applies next turn)`); }
        catch (e) { controller.note(e instanceof Error ? e.message : String(e)); }
      }
      return;
    }
    if (text === '/skills' || text.startsWith('/skills ')) {
      const arg = text.slice('/skills'.length).trim();
      if (!arg) { emitInfo(listSkillsText()); return; }
      controller.pushUser(text);
      await runText(`Load and run the Vodou skill named "${arg}". If it presents a numbered menu or a stopping point, show it verbatim and stop for my choice.`);
      return;
    }
    if (text === '/compress') {
      controller.pushUser(text);
      controller.busy = true; force((x) => x + 1);
      try { await session.compress(controller); controller.info('— context compressed; continuing in a fresh window —'); }
      catch (e) { controller.note(e instanceof Error ? e.message : String(e)); }
      controller.busy = false; force((x) => x + 1);
      return;
    }

    // A bare model name is almost always a half-typed /model — see bareModelName().
    {
      const alias = bareModelName(text);
      if (alias) {
        controller.info(`did you mean \`/model ${alias}\`? — type that to switch, or rephrase to ask about it`);
        return;
      }
    }

    // Any other /slash is a typo or a stale-build command — don't ship it to the LLM as a
    // prompt (and don't let it fall through to the engine's "Unknown command"). Tell the user.
    //
    // EXCEPT the ones the GATEWAY implements: `/workflow` / `/wf` and every
    // `/<skill-name>`. This guard has been eating those since it was written —
    // `/workflow` works in the console chat and never once worked here.
    if (text.startsWith('/') && !isServerSideCommand(text)) {
      controller.info(`unknown command: ${text.split(/\s/)[0]} — type /help for the list`);
      return;
    }

    controller.pushUser(text);
    await runText(text);
  };

  const showInput = !controller.busy || !!controller.pendingApproval;
  const promptLabel = controller.pendingApproval
    ? `approve ${controller.pendingApproval.ev.toolName} (${controller.pendingApproval.ev.category || 'sensitive'})? [y/N] `
    : 'vodou › ';

  return (
    <Box flexDirection="column">
      <Static items={controller.history}>
        {(b) => <BlockView key={b.id} b={b} />}
      </Static>

      {/* live tail */}
      {controller.streaming ? <Text>{controller.streaming}</Text> : null}
      {controller.liveTool ? <Text color="gray"><Spinner type="dots" /> {controller.liveTool}…</Text> : null}
      {controller.status && !controller.streaming && !controller.liveTool
        ? <Text color="gray"><Spinner type="dots" /> {controller.status}</Text> : null}
      {controller.busy && !controller.liveTool && !controller.streaming && !controller.status
        ? <Text color="gray"><Spinner type="dots" /> working…</Text> : null}
      {controller.footer ? <Text color="gray">— {controller.footer}</Text> : null}

      {showInput ? (
        <Box>
          <Text color="cyan">{promptLabel}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
        </Box>
      ) : null}
    </Box>
  );
}

/** Render the Ink TUI for an interactive session. Resolves when the user exits. */
export async function runTui(session: CliSession): Promise<void> {
  const controller = new TuiController();
  // Banner prints above the app via Static-less direct write (shared with the plain renderer).
  process.stdout.write(vodouBanner());
  // patchConsole:false — Ink otherwise re-hooks console.* to print above the app, which
  // clobbers quiet.ts's file redirect and lets the engine's chatty logs corrupt the TUI.
  const app = render(<App controller={controller} session={session} />, { exitOnCtrlC: false, patchConsole: false });
  await app.waitUntilExit();
}
