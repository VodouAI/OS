/**
 * session.ts — the headless CLI driver around the shared `chat()` agentic loop.
 *
 * This is renderer-agnostic: it forwards every `StreamEvent` to a `Renderer`, so the
 * same driver powers both the `--plain` renderer and (Phase 2) the Ink TUI. It mirrors
 * the openai-compat path (ensureConversation → hydrate → chat → saveMessage) but keeps
 * the FULL event stream (tool/status events included) and routes approvals the way the
 * gateway's /chat/approve endpoint does.
 */

import { createHash, randomUUID } from 'crypto';

import { chat, abortConversationTurn, clearConversation, type StreamEvent } from '../llm.js';
import { getConversationManager } from '../conversation.js';
import { ensureConversation, saveMessage } from '../conversation-store.js';
import { hydrateLlmConversationFromDb } from '../conversation-hydrate.js';
import { executeOITool } from '../executor.js';
import { consumeApproval } from '../approvals.js';

/** Pluggable presentation layer. Both `--plain` and the TUI implement this. */
export interface Renderer {
  /** Every chat() StreamEvent, in order. */
  onEvent(e: StreamEvent): void;
  /** Prompt the user to approve a parked `ask`-category tool. Resolve true to run it. */
  confirmApproval(e: StreamEvent): Promise<boolean>;
  /** Lifecycle hooks (optional). */
  turnStart?(): void;
  turnEnd?(finalText: string): void;
}

/**
 * A STABLE per-directory conversation id (no pid) so relaunching `vodou` from the same
 * directory RESUMES the same conversation — history is hydrated from the DB each turn.
 * `cli:` prefix keeps it OUT of the `workbench:*` namespace, so the FS-tools gate
 * (tools.ts isInteractiveWebConvId) treats it as the main interactive chat. `/new`
 * (CliSession.reset) starts a fresh one when the user wants a clean slate.
 */
export function makeConversationId(): string {
  const dir = process.env.VODOU_CLI_AGENT_CWD || process.cwd();
  const hash = createHash('sha1').update(dir).digest('hex').slice(0, 10);
  return `cli:${hash}`;
}

export class CliSession {
  conversationId: string;
  private aborting = false;

  constructor(conversationId?: string) {
    this.conversationId = conversationId || makeConversationId();
    // Source defaults to 'web' (conversation-store.ts), which — together with the cli:
    // id and VODOU_FS_TOOLS_ENABLED — makes FS tools eligible for this conversation.
    try { ensureConversation(this.conversationId, 'Vodou CLI'); } catch { /* */ }
  }

  /** Abort the in-flight turn (Ctrl-C / Esc). Safe to call when idle. */
  abort(): void {
    this.aborting = true;
    try { abortConversationTurn(this.conversationId); } catch { /* */ }
  }

  /** `/new` — drop the current conversation's history and start a fresh one. */
  reset(): void {
    try { clearConversation(this.conversationId); } catch { /* */ }
    this.conversationId = `${makeConversationId()}:${Date.now().toString(36)}`;
    try { ensureConversation(this.conversationId, 'Vodou CLI'); } catch { /* */ }
  }

  /**
   * `/compress` — summarize the conversation so far, then start a fresh conversation
   * SEEDED with that summary. Frees the context window on a long session without losing
   * the thread (unlike `/new`, which wipes everything). The summarize turn streams through
   * the renderer like any answer; the summary is then reseeded so the next turn hydrates it.
   */
  async compress(renderer: Renderer): Promise<string> {
    const summary = await this.runTurn(
      'Summarize our conversation so far into a compact brief: key facts, decisions made, ' +
      'open threads, and any files/paths/commands in play. Be concise but complete — this ' +
      'summary REPLACES the prior history so I can keep working in a fresh context.',
      renderer,
    );
    if (summary && summary.trim()) {
      this.reset();
      try { saveMessage(this.conversationId, 'assistant', '[Compressed summary of earlier conversation]\n' + summary); } catch { /* */ }
    }
    return summary;
  }

  /**
   * Run one user turn end-to-end: stream the assistant response, persist it, and handle
   * any parked tool approvals (consume token → run → record note), mirroring the
   * gateway's /chat/approve. Returns the assistant's final text.
   */
  async runTurn(userText: string, renderer: Renderer): Promise<string> {
    this.aborting = false;
    const convId = this.conversationId;
    const turnId = randomUUID();

    // Send the RAW user query — no per-message framing. The earlier cwd directive
    // polluted BrainLoader's intent routing (it parsed the bracketed prefix instead of
    // the real query) and broke skill menu-reply detection. cwd steering now lives in the
    // session SYSTEM PROMPT (llm.ts cliCwdDirective, gated on VODOU_CLI_AGENT_CWD), and the
    // claude-cli's native working dir is already correct (spawn cwd + PWD).
    const framed = userText;

    try { saveMessage(convId, 'user', userText.slice(0, 10000)); } catch { /* */ }
    renderer.turnStart?.();

    let fullText = '';
    const approvals: StreamEvent[] = [];

    try {
      hydrateLlmConversationFromDb(convId, userText.trim());
      await chat(convId, framed, (event) => {
        if (event.type === 'text' && event.content) fullText += event.content;
        if (event.type === 'approval_requested') approvals.push(event);
        renderer.onEvent(event);
      }, { turnId });
    } catch (e) {
      renderer.onEvent({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    }

    if (fullText) { try { saveMessage(convId, 'assistant', fullText); } catch { /* */ } }
    renderer.turnEnd?.(fullText);

    // Approval resume (rare under the default all-auto profile). Mirrors /chat/approve:
    // consume the single-use token, run the parked tool, and record a durable note so
    // the model sees the outcome on the user's next turn.
    for (const ev of approvals) {
      if (this.aborting || !ev.approvalToken) continue;
      const approved = await renderer.confirmApproval(ev);
      const pending = consumeApproval(convId, ev.approvalToken);
      if (!pending) continue;
      if (!approved) {
        const note = `[The user DENIED running ${pending.toolName}.]`;
        try { getConversationManager().addAssistantMessage(convId, [{ type: 'text', text: note } as any]); } catch { /* */ }
        try { saveMessage(convId, 'assistant', note); } catch { /* */ }
        continue;
      }
      try {
        const result = await executeOITool(pending.toolName, pending.input, { conversationId: convId, approved: true });
        const note = result.success
          ? `[Approved by the user — ran ${pending.toolName}: ${(result.output || 'done').slice(0, 500)}]`
          : `[Approved, but ${pending.toolName} failed: ${result.error}]`;
        try { getConversationManager().addAssistantMessage(convId, [{ type: 'text', text: note } as any]); } catch { /* */ }
        try { saveMessage(convId, 'assistant', note); } catch { /* */ }
        renderer.onEvent({ type: 'tool_call_end', toolName: pending.toolName, success: result.success, toolResult: result.output, error: result.error });
      } catch (e) {
        renderer.onEvent({ type: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }

    return fullText;
  }
}
