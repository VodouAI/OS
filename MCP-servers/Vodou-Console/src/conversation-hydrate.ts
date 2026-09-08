/**
 * Hydrate in-memory ConversationManager from gateway.db so the LLM sees prior
 * turns after gateway restart or cold in-memory state (UI already loads history from DB).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getConversationManager } from './conversation.js';
import { loadMessages, type StoredMessage } from './conversation-store.js';

const MAX_SEED = Math.min(Math.max(parseInt(process.env.VODOU_LLM_SEED_MAX_MESSAGES || '80', 10) || 80, 10), 200);

/**
 * Stands in for the missing user turn ahead of an assistant-first replay: a
 * summary handed over from the memory map, a board worker, a skill console —
 * threads an action started rather than anything typed.
 *
 * Only ever reaches the model on a SHORT conversation, and that is not a
 * limitation, it is the whole population that needed help. `ConversationManager`
 * caps at MAX_HISTORY (40) and trims from the front, so any replay longer than
 * that loses its head — primer included — and the leading assistant turn was
 * going to be trimmed anyway. Measured before assuming otherwise: 52 of the 86
 * conversations with >= 80 turns open their window on a reply, and not one of
 * them is affected by this, because 40 < 80.
 *
 * Which also means MAX_SEED (80) is half wasted: hydrate replays up to 80
 * messages into a manager that will keep 40. Raising
 * VODOU_LLM_SEED_MAX_MESSAGES does nothing above 40. Left alone here — it costs
 * a few array pushes, and changing a context-window knob is not this commit's
 * business — but it is not the tunable it looks like.
 */
const ASSISTANT_FIRST_PRIMER =
  'This conversation opens with your own message below — it came from an action I took, not something I typed. Treat it as yours and continue from it.';

/**
 * When `getMessages(convId)` is empty, load `gateway_messages` and replay into
 * the conversation manager (user/assistant text only).
 *
 * If `pendingUserPlain` is set and the **last** DB row is a user message with the
 * same body, it is skipped — the current `chat()` turn will re-append that user
 * message via the provider path (DB already has the row from the WS handler).
 */
export function hydrateLlmConversationFromDb(
  conversationId: string,
  pendingUserPlain?: string | null,
): number {
  const mgr = getConversationManager();
  if (mgr.getMessages(conversationId).length > 0) {
    return 0;
  }
  let rows: StoredMessage[];
  try {
    rows = loadMessages(conversationId);
  } catch {
    return 0;
  }
  if (!rows.length) {
    return 0;
  }

  const toReplay = [...rows];
  const pending = pendingUserPlain?.trim();
  if (pending && toReplay.length > 0) {
    const last = toReplay[toReplay.length - 1];
    if (last && last.role === 'user' && String(last.content || '').trim() === pending) {
      toReplay.pop();
    }
  }

  const slice = toReplay.length > MAX_SEED ? toReplay.slice(-MAX_SEED) : toReplay;

  // A transcript may not BEGIN with an assistant turn.
  //
  // `ConversationManager.trimHistory` drops a leading assistant message
  // outright — the Messages API rejects one, so that rule is correct and stays.
  // The consequence here was silent and total: a conversation whose stored
  // history starts with the assistant lost that message on every replay, the
  // manager stayed empty, so the NEXT hydrate replayed it and lost it again
  // (the tell is two `rows=1` lines for one conversation). The model then
  // answered as though the thread were empty while the message sat in
  // gateway.db and on screen, one row above the question.
  //
  // Any lane can start this way: a seeded memory summary, a briefing, an
  // outbound-first channel thread. One minimal user turn ahead of it makes the
  // transcript legal and the assistant's words survive.
  const firstReplayable = slice.find((r) => {
    const role = String(r.role || '').toLowerCase();
    return (role === 'user' || role === 'assistant') && String(r.content || '').trim();
  });
  if (firstReplayable && String(firstReplayable.role || '').toLowerCase() === 'assistant') {
    mgr.addUserMessage(conversationId, ASSISTANT_FIRST_PRIMER);
  }

  let n = 0;
  for (const r of slice) {
    const role = String(r.role || '').toLowerCase();
    const text = String(r.content || '').trim();
    if (!text) continue;

    if (role === 'user') {
      mgr.addUserMessage(conversationId, text);
      n++;
    } else if (role === 'assistant') {
      const blocks = [{ type: 'text' as const, text }];
      mgr.addAssistantMessage(conversationId, blocks as Anthropic.Messages.ContentBlock[]);
      n++;
    }
  }

  if (n > 0) {
    console.error(`[Gateway DIAG] hydrated LLM context from gateway.db: convId=${conversationId} rows=${n}`);
  }
  return n;
}
