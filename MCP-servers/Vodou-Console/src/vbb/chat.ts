/**
 * vbb/chat.ts — the browser bridge's AGENTIC lane (PLAN-BRAIN-INJECT-LANE).
 *
 * The extension already has a retrieval lane: `context_request` → handleContextRequest
 * → `vodou-core mem context` (pure memory lookup, no LLM). THIS module is the upgrade:
 * it runs a FULL agentic Vodou turn through the same `chat()` pipeline the web UI and
 * the CLI use — memory injection + BrainLoader routing + skills (Layer 1) + MCP tools —
 * and streams the result back over the /api/vbb WebSocket.
 *
 * Two consumers, one shared runner:
 *   • brain_request  — "the Face": the user is about to send `draft` to a third-party
 *     LLM (ChatGPT/Claude/…). We produce a compact CONTEXT PACK the host assistant needs
 *     and hand it back for injection into the composer. Conversation id `brainctx:*`.
 *   • chat_request   — the panel Chat tab: a normal streamed chat turn. Conversation id
 *     `panel:*`.
 *
 * Why not reuse index.ts streamToConversation(): that function is private to the chat
 * WSS and keyed to its own `clients` map (index.ts:746). The extension is a different
 * transport (the vbb socket), so we carry our own tiny seq + ring-buffer + replay here,
 * mirroring the SHAPE of the web path (per-conv monotonic seq, resume after a dropped
 * MV3 service worker) without touching the hot file.
 *
 * Dependency-injected: bridge.ts passes { send, retrieveFallback } so this module never
 * imports bridge.ts (no cycle) and vitest can drive the queue/seq/replay/budget logic
 * with a fake chat function (see _test).
 */

import { randomUUID } from 'crypto';

import {
  chat,
  abortConversationTurn,
  isConfigured,
  getActiveModelLabel,
  getLastMemoryUsed,
  getLastSkillsUsed,
  resetSkillsUsed,
  getTotalMemoryCount,
  messageIntentIsPureRecall,
  type StreamEvent,
} from '../llm.js';
import { ensureConversation, saveMessage, loadRecentMessages } from '../conversation-store.js';
import { hydrateLlmConversationFromDb } from '../conversation-hydrate.js';
import { getConversationManager } from '../conversation.js';
import { executeOITool } from '../executor.js';
import { consumeApproval } from '../approvals.js';
import { loadInjectPolicy, stripLeaks } from '../inject-policy.js';
import { getProjectRoot } from '../db.js';
import { markFunnel } from '../funnel.js';
import { receiptReset, receiptAddTool, buildReceipt } from '../turn-receipt.js';
import { emitTurnEvent, flushTurnEvents } from '../turn-events.js';

// ── Wire event shape (byte-compatible with the web-chat WS mapping, index.ts:3921) ──
export interface ChatWireEvent {
  type: 'chunk' | 'tool_start' | 'tool_end' | 'status' | 'usage' | 'approval' | 'error' | 'done'
    // item 12 — the graph lane. Same names the web chat uses, so one renderer
    // reads both surfaces and the panel cannot drift into its own vocabulary.
    | 'graph_plan' | 'graph_branch' | 'graph_join' | 'graph_check' | 'graph_ask' | 'graph_done';
  content?: string;
  tool?: string;
  toolId?: string;
  server?: string;
  args?: Record<string, unknown>;
  /** Graph-lane payload, passed through untouched — the panel renders what the driver said. */
  graph?: unknown;
  /** `'graph'` when this text repeats something already sent as structure (§4b). */
  echoOf?: string;
  result?: string;
  executionTime?: number;
  success?: boolean;
  status?: string;
  usage?: StreamEvent['usage'];
  token?: string;
  category?: string;
  message?: string;
  activeModel?: string;
  memory?: { used: number; total: number; items: string[] };
  /**
   * PLAN-INJECT-RECEIPT-UI — what this turn actually did, on the terminal `done`
   * frame. `null` when the turn used nothing: the client renders nothing rather
   * than "0 memories". `memory` above is kept for back-compat with clients that
   * already read it.
   */
  receipt?: TurnReceipt | null;
}

/** What bridge.ts injects so this module stays free of a bridge import (no cycle). */
export interface ChatDeps {
  /** Push a frame on the LIVE extension socket (bridge.sendAck). */
  send: (payload: Record<string, unknown>) => void;
  /** The retrieval lane, for the brain-budget degrade path (bridge.handleContextRequest). */
  retrieveFallback: (
    query: string, host: string, allMemory: boolean, vault: string, convId: string, provider: string,
  ) => Promise<any>;
  /** Captured tail of a webcap:<provider>:<conv> thread (bridge.seedFromConversation). */
  seedFromConversation: (provider: string, convId: string) => string;
  /** N most-recent OTHER webcap tails, one line each — cross-chat continuity. */
  recentOtherThreads?: (excludeConvId: string, limit: number) => Array<{ id: string; line: string }>;
}

// Injectable so vitest can run the runner without a real subprocess (see _test).
let _chatFn: typeof chat = chat;
let _now: () => number = () => Date.now();
let _isConfigured: typeof isConfigured = isConfigured;

// ── Per-conversation seq + ring buffer + replay ────────────────────────────────
const RING_CAP = 400;
const RING_TTL_MS = 15 * 60 * 1000; // covers the 15-min CLI turn timeout
interface Ring { seq: number; events: Array<{ seq: number; event: ChatWireEvent }>; touchedAt: number; }
const _rings = new Map<string, Ring>();

function ring(convId: string): Ring {
  let r = _rings.get(convId);
  if (!r) { r = { seq: 0, events: [], touchedAt: _now() }; _rings.set(convId, r); }
  return r;
}

/** Stamp, buffer, and push one event for a conversation. Returns the assigned seq. */
function emit(deps: ChatDeps, convId: string, reqId: string | undefined, event: ChatWireEvent): number {
  const r = ring(convId);
  const seq = ++r.seq;
  r.events.push({ seq, event });
  if (r.events.length > RING_CAP) r.events.splice(0, r.events.length - RING_CAP);
  r.touchedAt = _now();
  deps.send({ cmd: 'chat_event', conversationId: convId, reqId, seq, event });
  return seq;
}

// ── The panel lane, reachable from OUTSIDE this module ──────────────────────
//
// `/api/graph/run` (index.ts) streams a run's events with `streamToConversation`,
// which only knows the WEB WS clients. A panel conversation lives on the
// extension socket, so a plan run from the panel opened its run, parked on the
// ask, announced it — and every frame died with "no WS client matched
// convId=panel:main:…". The gateway did everything right and delivered it to
// the wrong door. Found by pressing [Run it] and reading the log.
//
// One registered emitter, set by the bridge when a socket attaches, cleared
// when it detaches. `streamToConversation` calls `emitToPanel` after its own
// loop; it returns false when the conv is not a panel conv or no panel is
// live, so nothing else changes.
let _panelDeps: ChatDeps | null = null;
export function registerPanelEmitter(deps: ChatDeps | null): void { _panelDeps = deps; }

/** Is this a conversation the side panel owns? */
export function isPanelConv(convId: string): boolean { return convId.startsWith('panel:'); }

/**
 * Deliver a gateway stream event to the live panel, in the panel's own wire
 * shape. Returns whether it was sent. Goes through `emit` so the event lands
 * in the ring and a reconnecting panel replays it like any other.
 */
export function emitToPanel(convId: string, payload: Record<string, unknown>): boolean {
  if (!isPanelConv(convId) || !_panelDeps) return false;
  const t = String(payload.type || '');
  let event: ChatWireEvent | null = null;
  if (t.startsWith('graph_')) event = { type: t as ChatWireEvent['type'], graph: payload.graph };
  else if (t === 'chunk' && typeof payload.content === 'string') event = { type: 'chunk', content: payload.content, echoOf: payload.echoOf as string | undefined };
  else if (t === 'done') event = { type: 'done' };
  else if (t === 'error') event = { type: 'error', message: String(payload.message || 'error') };
  if (!event) return false;
  emit(_panelDeps, convId, undefined, event);
  return true;
}

/** Replay buffered events with seq > lastSeq (reconnect / SW restart). */
export function handleChatResume(deps: ChatDeps, msg: any): void {
  const convId = String(msg?.conversationId || '');
  const lastSeq = Number(msg?.lastSeq) || 0;
  const r = _rings.get(convId);
  if (!r) return;
  for (const e of r.events) {
    if (e.seq > lastSeq) deps.send({ cmd: 'chat_event', conversationId: convId, seq: e.seq, event: e.event });
  }
}

// Periodic prune so idle conversations don't retain buffers forever.
const _janitor = setInterval(() => {
  const cutoff = _now() - RING_TTL_MS;
  for (const [k, r] of _rings) if (r.touchedAt < cutoff) _rings.delete(k);
}, 60_000);
(_janitor as any)?.unref?.();

// ── Per-conversation queue/dedup (mirrors index.ts _chatQueue :3670) ───────────
interface QEntry { promise: Promise<void> | null; lastContent: string; lastTime: number; }
const _queue = new Map<string, QEntry>();
function pruneQueue(): void {
  if (_queue.size < 256) return;
  const cutoff = _now() - 60 * 60 * 1000;
  for (const [k, v] of _queue) if (!v.promise && v.lastTime < cutoff) _queue.delete(k);
}

/**
 * Serialize turns on the same conversation, drop 500ms duplicate sends, run
 * cross-conversation turns in parallel. `run` is the actual turn body.
 */
function enqueue(convId: string, content: string, run: () => Promise<void>): 'dropped' | 'queued' {
  pruneQueue();
  let entry = _queue.get(convId);
  if (!entry) { entry = { promise: null, lastContent: '', lastTime: 0 }; _queue.set(convId, entry); }
  const now = _now();
  if (content === entry.lastContent && (now - entry.lastTime) < 500) return 'dropped';
  entry.lastContent = content;
  entry.lastTime = now;
  const prev = entry.promise;
  entry.promise = (async () => {
    if (prev) await prev.catch(() => {});
    await run();
  })();
  return 'queued';
}

// ── Capability / tool policy ───────────────────────────────────────────────────
/** Source tag for these conversations. 'panel' excludes SDK FS tools (tools.ts:338). */
export function panelSource(): string { return 'panel'; }

// ── Turn receipt ───────────────────────────────────────────────────────────────
// Extracted to ../turn-receipt.js so the CONSOLE lane renders the identical
// receipt (PLAN-CONSOLE-SHOWS-ITS-WORK §4.3). The semantics here were earned —
// the `?::Bash` guard and silence-by-design both came from real defects — and two
// copies would drift. Re-exported so this module's existing callers are unchanged.
export type { TurnReceipt } from '../turn-receipt.js';
import type { TurnReceipt } from '../turn-receipt.js';

// ── Shared turn runner ─────────────────────────────────────────────────────────
/**
 * Run one agentic turn to completion, streaming ChatWireEvents. Mirrors
 * CliSession.runTurn (cli/session.ts:93): ensure → save(user) → hydrate → chat →
 * save(assistant), plus approval resume. Returns the assistant's final text.
 */
async function runTurn(
  deps: ChatDeps,
  convId: string,
  reqId: string | undefined,
  title: string,
  userText: string,
  framedPrompt: string,
  /**
   * Optional custom emitter. The Tasks lane passes a per-JOB emitter so two tasks on
   * the same page (same brainctx convId) don't interleave into one conversation ring —
   * see the job registry below. Defaults to the per-conversation ring (panel Chat lane).
   */
  emitFn?: (e: ChatWireEvent) => void,
  /** "Just answer it" — suppress the heuristic plan offer for THIS turn only. */
  skipGraphOffer = false,
  /**
   * The turn's identity. Minted here when a caller does not supply one, which is
   * what every caller used to get — `randomUUID()` INLINE in the chat() options,
   * anonymous and unreachable afterwards. A caller that wants the id on its
   * receipt (so "show me the bytes" works on the LIVE turn and not only after a
   * reload) has to be able to name the turn it just ran.
   *
   * Passed IN rather than looked up, because `turnIdFor(convId)` is not an
   * option: that map is keyed by conversation and returns whatever turn is
   * CURRENT at completion. Two interleaved turns on one conversation closed
   * under one id once already (P0b).
   */
  turnId: string = randomUUID(),
): Promise<string> {
  const push = emitFn || ((e: ChatWireEvent) => { emit(deps, convId, reqId, e); });
  receiptReset(convId);   // PLAN-INJECT-RECEIPT-UI — a receipt describes THIS turn only
  try { ensureConversation(convId, title, panelSource()); } catch { /* best-effort */ }
  try { saveMessage(convId, 'user', userText.slice(0, 10000)); } catch { /* */ }

  let fullText = '';
  let returnedText = '';
  const approvals: StreamEvent[] = [];

  try {
    hydrateLlmConversationFromDb(convId, userText.trim());
    returnedText = await _chatFn(convId, framedPrompt, (event: StreamEvent) => {
      switch (event.type) {
        case 'text':
          if (event.content) {
            fullText += event.content;
            // `echoOf` rides ALONGSIDE the text, never instead of it (§4b): the
            // echo still reaches `fullText`, which is the only record of the
            // turn for the transcript and memory extraction. Dropping the flag
            // here is why the panel drew every plan twice — it had no way to
            // know the text repeated structure it had already rendered.
            push({ type: 'chunk', content: event.content, echoOf: (event as { echoOf?: string }).echoOf });
          }
          break;
        case 'tool_call_start':
          receiptAddTool(convId, event.serverName, event.toolName);   // PLAN-INJECT-RECEIPT-UI
          push({ type: 'tool_start', tool: event.toolName, toolId: event.toolId, server: event.serverName, args: event.toolArgs });
          break;
        case 'tool_call_end':
          push({ type: 'tool_end', tool: event.toolName, toolId: event.toolId, result: event.toolResult, executionTime: event.executionTime, success: event.success });
          break;
        case 'status':
          push({ type: 'status', status: event.status });
          break;
        case 'usage':
          push({ type: 'usage', usage: event.usage });
          break;
        case 'approval_requested':
          approvals.push(event);
          push({ type: 'approval', tool: event.toolName, token: event.approvalToken, category: event.category });
          break;
        case 'error':
          push({ type: 'error', message: event.error });
          break;

        // item 12 — the graph lane, forwarded verbatim.
        //
        // This switch had no `default`, so every `graph_*` event died here and
        // the side panel could never draw a plan, a branch, a check or an
        // approval — the same defect the MAIN chat had (index.ts:4810) and the
        // same one the plan calls out as this repo's signature: built, and
        // unreachable from where a person actually types.
        //
        // `graph_ask` matters most. A run that parks for permission is useless
        // if the only surface that can answer is a browser tab; the panel is
        // where someone stands while using another vendor's AI.
        case 'graph_plan':
        case 'graph_branch':
        case 'graph_join':
        case 'graph_check':
        case 'graph_ask':
        case 'graph_done':
          push({ type: event.type, graph: event.graph });
          break;
        // 'done' is emitted by the caller after save, with memory/usage rollup.
      }
    }, { turnId, lensesEnabled: false, principal: 'owner', ...(skipGraphOffer ? { skipGraphOffer: true } : {}) });
  } catch (e) {
    push({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }

  // Prefer the streamed text, but fall back to chat()'s RETURN value. Some paths
  // produce a final answer without streaming it as text events (a provider that only
  // returns, or a workflow/headless skill whose result arrives whole) — building the
  // result from stream events alone would report those as "produced no output" and
  // throw away real work.
  const finalText = fullText.trim() ? fullText : (returnedText || '');
  if (finalText) { try { saveMessage(convId, 'assistant', finalText); } catch { /* */ } }

  // Approval resume — rare under the default all-auto profile. Mirrors /chat/approve
  // (index.ts:1583) so a parked `ask`-category tool runs on the user's confirmation.
  // The panel/extension confirms via a `chat_approve` frame; here we only park them.
  void approvals; // parked; resolved by handleChatApprove when the user answers.

  return finalText;
}

// ── Entry A: brain_request (the Face) ──────────────────────────────────────────
/**
 * The user is about to send `draft` to a third-party LLM. Produce a compact context
 * pack (memory + tools + skills) for injection, or — if the draft is pure recall —
 * answer it directly so no frontier turn is spent.
 *
 * brain_result { reqId, ok, mode:'inject'|'answer', pack?, text?, degraded? }
 */
export async function handleBrainRequest(deps: ChatDeps, msg: any): Promise<void> {
  const reqId = String(msg?.reqId || '');
  const draft = String(msg?.draft || '').trim();
  const page = msg?.page || {};
  const provider = String(page.provider || 'web');
  const pageConv = String(page.convId || 'session');
  const host = String(page.host || '');
  // Clamp raised to 90s: a headless skill run (e.g. a 5-thought deep-thinking session)
  // takes 35-40s of real local work, far past a quick-answer budget. The client sends a
  // long budget for manual turns; the abort timer below only degrades when NOTHING was
  // produced (a completed synthesis is used even if it lands past budget — see below).
  const budgetMs = Math.max(2000, Math.min(90000, Number(msg?.budget_ms) || 10000));

  if (!_isConfigured()) {
    deps.send({ cmd: 'brain_result', reqId, ok: false, error: 'Vodou is not configured — add credentials at /settings.' });
    return;
  }
  if (!draft) {
    deps.send({ cmd: 'brain_result', reqId, ok: false, error: 'empty draft' });
    return;
  }

  const convId = `brainctx:${sanitize(provider)}:${sanitize(pageConv)}`;

  // Intent decides what the brain produces:
  //   'answer' — manual trigger (Ctrl+B, the panel button, the FAB). ANSWER the draft
  //     fully, using memory + tools + skills, exactly like the panel Chat tab, and drop
  //     that answer in the composer. This is what the user means by "do the whole Vodou
  //     thing here," not a passive lookup.
  //   'pack'   — unattended auto-send. Produce a compact CONTEXT PACK to append to the
  //     user's outgoing message so the HOST llm answers better.
  const intent = String(msg?.intent || 'pack') === 'answer' ? 'answer' : 'pack';

  // Direct-answer short-circuit: pure recall never needs the host LLM. Manual 'answer'
  // intent is treated the same way — the result is an answer, injected as the composer text.
  let pureRecall = false;
  try { pureRecall = messageIntentIsPureRecall(draft); } catch { pureRecall = false; }
  const answerMode = intent === 'answer' || pureRecall;

  // Cross-chat continuity: this thread's tail + a hint of other recent threads.
  const ownTail = safe(() => deps.seedFromConversation(provider, pageConv), '');
  const others = safe(() => deps.recentOtherThreads?.(convId, 5) ?? [], [] as Array<{ id: string; line: string }>);
  const continuity = others.length
    ? `\n\nOther recent threads you may be asked to continue:\n${others.map((o) => `- ${o.line}`).join('\n')}`
    : '';

  // Tool policy for this turn. Default 'all' (Chad's call): every Vodou tool, including
  // mutating. 'read' is the cautious opt-in — enforced here as a prompt guard now; a
  // hard executor-side denylist is the documented follow-on (PLAN §5b D-level).
  const readOnly = String(msg?.tools || 'all') === 'read';
  const toolGuard = readOnly
    ? ' Use ONLY read-only tools (search, list, get) — do NOT send, post, create, delete, or modify anything.'
    : '';

  const framed = answerMode
    // CLEAN draft only. Do NOT prepend framing/instructions here: when the draft
    // triggers a SKILL, the message becomes the skill's {{TOPIC}} — and appended
    // "answer using your tools, be fast…" text poisoned the deep-thinking topic, so
    // the model reasoned about the instructions instead of the question and produced
    // garbage. Behavioral guidance for answer turns lives in the system prompt, not
    // the user message. (Non-skill answers still work: the Face answers questions by
    // nature, and the turn cap bounds tangents.)
    ? draft
    : [
        `The user is about to send this to ${provider}: «${draft}».`,
        ownTail ? `\nContext from this thread so far:\n${ownTail}` : '',
        continuity,
        `\n\nUsing memory, tools, and skills, produce the compact context pack the assistant will need to answer well — facts, live data, decisions, links.${toolGuard} Output ONLY the pack text: no preamble, no meta-commentary, no fenced markers.`,
      ].join('');

  // Race the agentic turn against the budget; degrade to retrieval on overrun so the
  // send never loses its context entirely.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { abortConversationTurn(convId); } catch { /* */ } }, budgetMs);

  let text = '';
  try {
    // Same cleanup as the task lane: this text is injected into a third-party
    // composer, so the web-UI debug block must never ride along.
    text = cleanForDelivery(await runTurn(deps, convId, reqId, `Brain · ${provider}`, draft, framed));
  } finally {
    clearTimeout(timer);
  }

  // One id for this turn, minted BEFORE the degraded branch so both exits name
  // the same turn. It used to sit after that branch, which left the degraded
  // path — the one a person is most likely to ask about — logging nothing.
  const injectTurnId = `capture:${sanitize(provider)}:${randomUUID()}`;
  const memoriesUsed = safe(() => getLastMemoryUsed(convId), [] as string[]);

  if (!text.trim()) {
    // Degrade ONLY when nothing was produced. A headless skill (deep-thinking) can
    // finish AFTER the budget timer fired — its synthesis is in `text`, so use it
    // rather than throwing away 35s of real work and injecting a retrieval pack.
    const fallback = await safeAsync(
      () => deps.retrieveFallback(draft, host, true, '', pageConv, provider),
      null,
    );
    const packText = (fallback && (fallback.context || (Array.isArray(fallback.items) ? fallback.items.map((i: any) => i.text).join('; ') : ''))) || '';
    // A degraded inject still put BYTES in front of a third-party model, and it
    // is the case a person is most likely to ask about afterwards. `outcome`
    // records which exit it took; `partial` is unchanged, because this side never
    // sees the request ChatGPT assembles around the pack.
    try {
      emitTurnEvent({ turnId: injectTurnId, conversationId: convId, kind: 'turn/start', chars: 0, provider, source: 'capture' });
      if (draft) {
        emitTurnEvent({ turnId: injectTurnId, conversationId: convId, kind: 'user/message', chars: draft.length, payload: draft, provider, source: 'capture' });
      }
      if (packText) {
        emitTurnEvent({
          turnId: injectTurnId, conversationId: convId, kind: 'inject', lane: 'memory',
          chars: packText.length, payload: packText, provider, source: 'capture',
          meta: { slot: 'none', from: 'composer inject (retrieval fallback)', host },
        });
      }
      emitTurnEvent({
        turnId: injectTurnId, conversationId: convId, kind: 'turn/end', chars: 0, provider, source: 'capture',
        meta: { outcome: 'degraded', partial: true, derive: 'partial' },
      });
      void flushTurnEvents(injectTurnId);
    } catch (e) {
      console.error('[brain] degraded inject turn log failed (the inject still went out):', e);
    }
    deps.send({
      cmd: 'brain_result', reqId, ok: !!packText, degraded: true, mode: 'inject',
      pack: { text: packText, items: fallback?.items || [], tools_run: [], elapsed_ms: budgetMs, degraded: true },
      error: packText ? undefined : 'brain turn timed out and retrieval fallback was empty',
    });
    deps.send({ cmd: 'chat_event', conversationId: convId, reqId, seq: ring(convId).seq + 1, event: { type: 'done', activeModel: getActiveModelLabel(), memory: { used: memoriesUsed.length, total: safe(getTotalMemoryCount, 0), items: memoriesUsed.slice(0, 5) }, receipt: buildReceipt(convId, memoriesUsed, { turnId: injectTurnId }) } });
    return;
  }

  // PLAN-INJECT-RECEIPT-UI — the receipt rides brain_result too, not just the `done`
  // chat_event. The in-page FAB toast is the ONLY receipt surface a user sees while
  // working inside ChatGPT/Claude with the panel closed — and it is the frame the
  // launch film is built around. Built once, before the send, so both the pack's
  // `tools_run` and the toast report the same run rather than two counts that can
  // disagree.
  // ── PLAN-SEAMS P6b(A) — the cross-vendor inject leaves a record ────────────
  //
  // This is the one major lane the turn log could not see. `handleBrainRequest`
  // has always had the pack, the memories and a receipt, and sent all three to
  // the extension — where the receipt is a toast that vanishes. The composer
  // inject is deliberately UNFENCED (a fence trips provider injection
  // resistance), so the extension strips those same bytes back out of the
  // capture via a client-side registry. Measured 2026-08-30: the bytes Vodou
  // puts into ChatGPT existed NOWHERE durable, and `turn_events` had exactly
  // two sources, `gateway` and `hook`.
  //
  // Not a new shape. This is the daemon's orphan-hook record (`daemon.rs`, "one
  // lane on someone else's turn") applied to the surface that needed it: its own
  // turn id, what Vodou contributed, and `partial` as the truthful verdict —
  // there can be no `request` event because this side never sees the request
  // ChatGPT assembles around the pack.
  //
  // Wrapped whole: a log write must never change the shape of the handler it
  // observes. If any of this throws, the inject still goes out.
  try {
    const src = 'capture';
    emitTurnEvent({ turnId: injectTurnId, conversationId: convId, kind: 'turn/start', chars: 0, provider, source: src });
    if (draft) {
      emitTurnEvent({
        turnId: injectTurnId, conversationId: convId, kind: 'user/message',
        chars: draft.length, payload: draft, provider, source: src,
      });
    }
    emitTurnEvent({
      turnId: injectTurnId, conversationId: convId, kind: 'inject', lane: 'memory',
      chars: text.length, payload: text, provider, source: src,
      // `slot: none` for the same reason the hook row carries it: this is a
      // CONTRIBUTION to a request assembled elsewhere, not a placement in one
      // Vodou built, so it must never be fed to the derive as if it were.
      meta: { slot: 'none', from: 'composer inject', host, items: memoriesUsed.length },
    });
    emitTurnEvent({
      turnId: injectTurnId, conversationId: convId, kind: 'turn/end', chars: 0, provider, source: src,
      meta: { outcome: 'ok', partial: true, derive: 'partial' },
    });
    void flushTurnEvents(injectTurnId);
  } catch (e) {
    console.error('[brain] inject turn log failed (the inject still went out):', e);
  }
  // The receipt carries the turn id, so it stops being a toast: the panel can ask
  // the log what each lane actually said, exactly as a gateway turn's receipt can.
  const brainReceipt = buildReceipt(convId, memoriesUsed, { turnId: injectTurnId });
  // PLAN-EXECUTION-SHELF-FUNNEL §5 — ACTIVATION. The single moment the product is
  // about: the user's own context reaching a different AI. Marked here, where the
  // pack is handed to the composer, not where a request arrived.
  if (text && text.trim()) markFunnel('first_inject');
  deps.send({
    cmd: 'brain_result', reqId, ok: true, degraded: false,
    mode: answerMode ? 'answer' : 'inject',
    text: answerMode ? text : undefined,
    receipt: brainReceipt,
    pack: answerMode ? undefined : {
      text, items: memoriesUsed,
      tools_run: brainReceipt ? brainReceipt.tools : [],   // was stubbed [] since the lane shipped
      elapsed_ms: 0, degraded: false,
    },
  });
  emit(deps, convId, reqId, { type: 'done', activeModel: getActiveModelLabel(), memory: { used: memoriesUsed.length, total: safe(getTotalMemoryCount, 0), items: memoriesUsed.slice(0, 5) }, receipt: buildReceipt(convId, memoriesUsed, { turnId: injectTurnId }) });
}

// ── PLAN-VODOU-TASKS-CHANNEL — the async job spine ─────────────────────────────
/**
 * The extension is a CHANNEL: you dispatch a task, the agent runs it to completion
 * LOCALLY (memory + tools + skills, agent-authored/headless), and the finished result
 * is delivered to the composer and/or the panel's Tasks view. Nothing holds the send,
 * so a 40s deep-thinking session and a 2s CPU lookup use the identical lane.
 *
 * Per-JOB event streams (not the per-conversation ring): brainctx:<provider>:<conv> is
 * per PAGE, so two tasks on one ChatGPT thread would otherwise interleave into a single
 * ring and corrupt each other's cards.
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

interface Job {
  jobId: string;
  convId: string;
  title: string;
  status: JobStatus;
  tabId: number | null;
  deliver: 'compose' | 'panel' | 'both';
  /** The composer text at dispatch — delivery injects ONLY if the draft still matches. */
  draftAtDispatch: string;
  draft: string;
  tools: string;
  provider: string;
  pageConv: string;
  host: string;
  startedAt: number;
  endedAt?: number;
  seq: number;
  events: Array<{ seq: number; event: ChatWireEvent }>;
  result?: { text: string; kind: string; tools_run: string[]; elapsed_ms: number };
  error?: string;
  /** True once a skill/tool fired — the extension promotes the pill to a Tasks card. */
  heavy: boolean;
  toolsRun: string[];
}

const JOB_EVENT_CAP = 400;
const JOB_TTL_MS = 30 * 60 * 1000;
const JOB_REGISTRY_CAP = 50;
const _jobs = new Map<string, Job>();
const _pendingJobs: Job[] = [];
let _runningJobs = 0;
const maxConcurrentJobs = () => Math.max(1, Number(process.env.VODOU_TASK_MAX_CONCURRENT) || 3);

function emitJob(deps: ChatDeps, job: Job, event: ChatWireEvent): void {
  // Heavy hint: the first tool/skill activity promotes the in-page pill to a Tasks card.
  if (!job.heavy && (event.type === 'tool_start' || event.type === 'status')) job.heavy = true;
  if (event.type === 'tool_start' && event.tool) job.toolsRun.push(event.tool);
  const seq = ++job.seq;
  job.events.push({ seq, event });
  if (job.events.length > JOB_EVENT_CAP) job.events.splice(0, job.events.length - JOB_EVENT_CAP);
  deps.send({ cmd: 'task_event', jobId: job.jobId, seq, heavy: job.heavy, event });
}

function jobSummary(j: Job) {
  return {
    jobId: j.jobId, title: j.title, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    tabId: j.tabId, deliver: j.deliver, heavy: j.heavy,
    // The FULL result, not a preview. The panel rebuilds its cards from this list on
    // every reconnect, so a 240-char slice meant a reopened panel showed a stub cut
    // mid-word with no way to reach the rest. Capped only to keep one pathological
    // result from bloating the list; this rides a localhost socket.
    result: j.result ? { ...j.result, text: j.result.text.slice(0, 20000) } : undefined,
    error: j.error,
  };
}

function pruneJobs(): void {
  const cutoff = _now() - JOB_TTL_MS;
  for (const [id, j] of _jobs) {
    if (j.status !== 'running' && j.status !== 'queued' && (j.endedAt || 0) < cutoff) _jobs.delete(id);
  }
  if (_jobs.size > JOB_REGISTRY_CAP) {
    const done = [..._jobs.values()]
      .filter((j) => j.status !== 'running' && j.status !== 'queued')
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    for (const j of done.slice(0, _jobs.size - JOB_REGISTRY_CAP)) _jobs.delete(j.jobId);
  }
}

/**
 * Start any queued jobs that can run now. Two limits, both deliberate:
 *  • global concurrency cap — async fire-and-forget makes it trivial to stack
 *    expensive agentic runs.
 *  • per-conversation serialization — two tasks on the SAME page run one at a time so
 *    they share the warm subprocess (a per-job convId would forfeit that reuse).
 */
function pumpJobs(deps: ChatDeps): void {
  while (_runningJobs < maxConcurrentJobs()) {
    const idx = _pendingJobs.findIndex(
      (p) => ![..._jobs.values()].some((j) => j.status === 'running' && j.convId === p.convId),
    );
    if (idx < 0) return;
    const job = _pendingJobs.splice(idx, 1)[0];
    if (job.status === 'cancelled') continue;
    _runningJobs++;
    void runJob(deps, job).finally(() => { _runningJobs--; pumpJobs(deps); });
  }
}

async function runJob(deps: ChatDeps, job: Job): Promise<void> {
  job.status = 'running';
  emitJob(deps, job, { type: 'status', status: 'running locally…' });

  // Cross-chat continuity, same as the brain lane.
  const ownTail = safe(() => deps.seedFromConversation(job.provider, job.pageConv), '');
  const readOnly = job.tools === 'read';
  const guard = readOnly
    ? ' Use ONLY read-only tools (search, list, get) — do NOT send, post, create, delete, or modify anything.'
    : '';
  // CLEAN draft first (a skill reads this as its {{TOPIC}} — framing here poisoned it
  // before). Context and tool policy ride AFTER, clearly separated.
  const framed = ownTail || guard
    ? `${job.draft}\n\n---\n${ownTail ? `Context from this thread so far:\n${ownTail}\n` : ''}${guard}`
    : job.draft;

  try {
    const raw = await runTurn(
      deps, job.convId, undefined, `Task · ${job.provider}`, job.draft, framed,
      (e) => emitJob(deps, job, e),
    );
    // A task result is destined for a composer / the Tasks card — strip the web-UI
    // debug scaffolding (raw MCP JSON) that would otherwise ride along.
    const text = cleanForDelivery(raw);
    // Cast: TS narrows status to 'running' from the assignment above, but
    // handleTaskCancel can flip it to 'cancelled' WHILE we were awaiting the turn.
    if ((job.status as JobStatus) === 'cancelled') { deps.send({ cmd: 'task_done', jobId: job.jobId, ok: false, cancelled: true }); return; }
    const elapsed = _now() - job.startedAt;
    if (!text.trim()) {
      job.status = 'failed';
      job.error = 'the task produced no output';
      job.endedAt = _now();
      deps.send({ cmd: 'task_done', jobId: job.jobId, ok: false, error: job.error, elapsed_ms: elapsed });
      return;
    }
    job.status = 'done';
    job.endedAt = _now();
    job.result = { text, kind: job.heavy ? 'synthesis' : 'answer', tools_run: job.toolsRun, elapsed_ms: elapsed };
    // Narration guard: the agent did the work but reported on it instead of delivering
    // it. Never push that into the user's composer — surface it on the card instead.
    const narration = looksLikeNarration(text, job.heavy);
    if (narration) console.warn(`[vbb-task] ${job.jobId} looks like NARRATION, not a result — withholding from the composer: ${JSON.stringify(text.slice(0, 80))}`);
    const memoriesUsed = safe(() => getLastMemoryUsed(job.convId), [] as string[]);
    deps.send({
      cmd: 'task_done', jobId: job.jobId, ok: true, heavy: job.heavy, narration,
      // draftAtDispatch travels back so the extension can verify the composer still
      // holds it before injecting — never clobber a draft the user has moved on from.
      draftAtDispatch: job.draftAtDispatch, deliver: job.deliver, tabId: job.tabId,
      result: job.result,
      memory: { used: memoriesUsed.length, items: memoriesUsed.slice(0, 5) },
      activeModel: getActiveModelLabel(),
    });
  } catch (e) {
    job.status = 'failed';
    job.error = e instanceof Error ? e.message : String(e);
    job.endedAt = _now();
    deps.send({ cmd: 'task_done', jobId: job.jobId, ok: false, error: job.error });
  } finally {
    pruneJobs();
  }
}

/** task_dispatch — ack IMMEDIATELY, then run in the background. Never blocks. */
export function handleTaskDispatch(deps: ChatDeps, msg: any): void {
  const reqId = String(msg?.reqId || '');
  const draft = String(msg?.draft || '').trim();
  const page = msg?.page || {};
  const jobId = String(msg?.jobId || '') || `job_${_now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  if (!_isConfigured()) {
    deps.send({ cmd: 'task_ack', reqId, jobId, accepted: false, error: 'Vodou is not configured — add credentials at /settings.' });
    return;
  }
  if (!draft) {
    deps.send({ cmd: 'task_ack', reqId, jobId, accepted: false, error: 'empty task' });
    return;
  }

  const provider = sanitize(page.provider || 'web');
  const pageConv = sanitize(page.convId || 'session');
  const job: Job = {
    jobId,
    convId: `brainctx:${provider}:${pageConv}`,
    title: draft.slice(0, 120),
    status: 'queued',
    tabId: Number.isFinite(page.tabId) ? Number(page.tabId) : null,
    deliver: msg?.deliver === 'compose' || msg?.deliver === 'panel' ? msg.deliver : 'both',
    draftAtDispatch: String(msg?.draft || ''),
    draft,
    tools: String(msg?.tools || 'all') === 'read' ? 'read' : 'all',
    provider, pageConv,
    host: String(page.host || ''),
    startedAt: _now(),
    seq: 0, events: [], heavy: false, toolsRun: [],
  };
  _jobs.set(jobId, job);
  _pendingJobs.push(job);

  // Ack BEFORE any work — this is what makes the lane async.
  deps.send({ cmd: 'task_ack', reqId, jobId, accepted: true, status: job.status });
  pumpJobs(deps);
}

export function handleTaskCancel(deps: ChatDeps, msg: any): void {
  const job = _jobs.get(String(msg?.jobId || ''));
  if (!job) return;
  job.status = 'cancelled';
  job.endedAt = _now();
  const qi = _pendingJobs.indexOf(job);
  if (qi >= 0) _pendingJobs.splice(qi, 1);
  try { abortConversationTurn(job.convId); } catch { /* */ }
  deps.send({ cmd: 'task_done', jobId: job.jobId, ok: false, cancelled: true });
}

/** task_status — one job + replay of everything past lastSeq (panel reconnect). */
export function handleTaskStatus(deps: ChatDeps, msg: any): void {
  const reqId = String(msg?.reqId || '');
  const job = _jobs.get(String(msg?.jobId || ''));
  if (!job) { deps.send({ cmd: 'task_status_result', reqId, jobId: msg?.jobId, found: false }); return; }
  const lastSeq = Number(msg?.lastSeq) || 0;
  deps.send({ cmd: 'task_status_result', reqId, found: true, job: jobSummary(job), result: job.result });
  for (const e of job.events) {
    if (e.seq > lastSeq) deps.send({ cmd: 'task_event', jobId: job.jobId, seq: e.seq, heavy: job.heavy, event: e.event });
  }
}

/** task_list — hydrate the Tasks view on panel open (running + recent). */
export function handleTaskList(deps: ChatDeps, msg: any): void {
  pruneJobs();
  const jobs = [..._jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 25).map(jobSummary);
  deps.send({ cmd: 'task_list_result', reqId: String(msg?.reqId || ''), jobs });
}

// ── Entry B: chat_request (the panel Chat tab) ─────────────────────────────────
export function handleChatRequest(deps: ChatDeps, msg: any): void {
  const reqId = String(msg?.reqId || '');
  const convId = String(msg?.conversationId || 'panel:main');
  const text = String(msg?.text || '').trim();

  if (!_isConfigured()) {
    deps.send({ cmd: 'chat_ack', reqId, conversationId: convId, accepted: false, error: 'Vodou is not configured.' });
    return;
  }
  if (!text) {
    deps.send({ cmd: 'chat_ack', reqId, conversationId: convId, accepted: false, error: 'empty message' });
    return;
  }

  const skipGraphOffer = msg?.skipGraphOffer === true;
  const outcome = enqueue(convId, text, async () => {
    // The panel turn's own id, so its receipt can carry it. Every other receipt
    // in the gateway already does; this one could not, because runTurn minted the
    // id inline and threw the reference away.
    const panelTurnId = randomUUID();
    const finalText = await runTurn(deps, convId, reqId, 'Vodou Panel', text, text, undefined, skipGraphOffer, panelTurnId);
    const memoriesUsed = safe(() => getLastMemoryUsed(convId), [] as string[]);
    emit(deps, convId, reqId, {
      type: 'done', activeModel: getActiveModelLabel(),
      memory: { used: memoriesUsed.length, total: safe(getTotalMemoryCount, 0), items: memoriesUsed.slice(0, 5) },
      receipt: buildReceipt(convId, memoriesUsed, { turnId: panelTurnId }),   // PLAN-INJECT-RECEIPT-UI
    });
  });

  deps.send({ cmd: 'chat_ack', reqId, conversationId: convId, accepted: outcome === 'queued', queued: outcome === 'queued' });
}

export function handleChatStop(_deps: ChatDeps, msg: any): void {
  const convId = String(msg?.conversationId || '');
  if (convId) { try { abortConversationTurn(convId); } catch { /* */ } }
}

export function handleChatHistory(deps: ChatDeps, msg: any): void {
  const reqId = String(msg?.reqId || '');
  const convId = String(msg?.conversationId || '');
  const limit = Math.max(1, Math.min(200, Number(msg?.limit) || 40));
  let messages: Array<{ role: string; text: string; ts?: string }> = [];
  try {
    messages = loadRecentMessages(convId, limit).map((m) => ({ role: m.role, text: m.content, ts: m.created_at }));
  } catch { /* */ }
  deps.send({ cmd: 'chat_history_result', reqId, conversationId: convId, messages });
}

/** Mirror POST /chat/approve (index.ts:1583): consume token → run parked tool → note. */
export async function handleChatApprove(deps: ChatDeps, msg: any): Promise<void> {
  const convId = String(msg?.conversationId || '');
  const token = String(msg?.token || '');
  const decision = String(msg?.decision || '');
  if (!convId || !token) return;
  const pending = consumeApproval(convId, token);
  if (!pending) return;
  if (decision === 'deny') {
    const note = `[The user DENIED running ${pending.toolName}.]`;
    try { getConversationManager().addAssistantMessage(convId, [{ type: 'text', text: note } as any]); } catch { /* */ }
    try { saveMessage(convId, 'assistant', note); } catch { /* */ }
    return;
  }
  try {
    const result = await executeOITool(pending.toolName, pending.input, { conversationId: convId, approved: true });
    const note = result.success
      ? `[Approved by the user — ran ${pending.toolName}: ${(result.output || 'done').slice(0, 500)}]`
      : `[Approved, but ${pending.toolName} failed: ${result.error}]`;
    try { getConversationManager().addAssistantMessage(convId, [{ type: 'text', text: note } as any]); } catch { /* */ }
    try { saveMessage(convId, 'assistant', note); } catch { /* */ }
    emit(deps, convId, undefined, { type: 'tool_end', tool: pending.toolName, success: result.success, result: result.output });
  } catch (e) {
    emit(deps, convId, undefined, { type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
/**
 * Strip gateway-UI debug scaffolding from text that will be INJECTED into a
 * third-party composer or shown as a task result.
 *
 * The `🔍 Raw Vodou Results` block is emitted as a `text` event when the
 * showRawOIResults debug setting is on (llm.ts). It renders as a tidy collapsible in
 * the web console — but injected into ChatGPT it is a wall of raw MCP JSON, and it
 * lands in the user's message. Also drops any `<vodou_*>` fences that leak through.
 */
export function cleanForDelivery(text: string): string {
  const cleaned = String(text || '')
    .replace(/<details>\s*<summary>[^<]*Raw Vodou Results[\s\S]*?<\/details>\s*/gi, '')
    .replace(/<\/?vodou_[a-z_]+>\s*/gi, '')
    .trim();
  // PLAN-FACE-OWNS-SKILLS F2 — last line of defence before this text leaves for a
  // third-party model. Memory is filtered at recall (llm.ts), but an answer can also
  // surface extractor deliberation the model itself echoed, so the leak guard runs on
  // the outgoing text too.
  //
  // STATIC import, not require(): this package is "type": "module", so `require` is
  // undefined at runtime and a require-based guard inside a try/catch fails OPEN —
  // silently doing nothing on the one path that sends text to another model.
  try {
    return stripLeaks(cleaned, loadInjectPolicy(getProjectRoot()));
  } catch { return cleaned; }
}

/**
 * P4 — `looksLikeNarration` now lives in `reply-shape.ts` alongside
 * `promisesFollowup`: "the agent reported ON the work instead of delivering it"
 * and "the reply defers the result to a turn that will never come" are two
 * halves of one question, and they were being answered in two files. Re-exported
 * here because this lane's tests and callers name it at this path.
 */
import { looksLikeNarration } from '../reply-shape.js';
export { looksLikeNarration };

function sanitize(s: unknown): string {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return t || 'x';
}
function safe<T>(fn: () => T, dflt: T): T { try { return fn(); } catch { return dflt; } }
async function safeAsync<T>(fn: () => Promise<T>, dflt: T): Promise<T> { try { return await fn(); } catch { return dflt; } }

/** Test seam — override the chat fn and clock so vitest never spawns a subprocess. */
export const _test = {
  setChatFn(fn: typeof chat) { _chatFn = fn; },
  setNow(fn: () => number) { _now = fn; },
  setConfigured(fn: typeof isConfigured) { _isConfigured = fn; },
  reset() {
    _chatFn = chat; _now = () => Date.now(); _isConfigured = (() => true) as any;
    _rings.clear(); _queue.clear();
    _jobs.clear(); _pendingJobs.length = 0; _runningJobs = 0;
  },
  rings: _rings,
  jobs: _jobs,
};
