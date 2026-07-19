import { getConversationManager } from './conversation.js';
import { loadMessages } from './conversation-store.js';
const MAX_SEED = Math.min(Math.max(parseInt(process.env.VODOU_LLM_SEED_MAX_MESSAGES || '80', 10) || 80, 10), 200);
/**
 * When `getMessages(convId)` is empty, load `gateway_messages` and replay into
 * the conversation manager (user/assistant text only).
 *
 * If `pendingUserPlain` is set and the **last** DB row is a user message with the
 * same body, it is skipped — the current `chat()` turn will re-append that user
 * message via the provider path (DB already has the row from the WS handler).
 */
export function hydrateLlmConversationFromDb(conversationId, pendingUserPlain) {
    const mgr = getConversationManager();
    if (mgr.getMessages(conversationId).length > 0) {
        return 0;
    }
    let rows;
    try {
        rows = loadMessages(conversationId);
    }
    catch {
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
    let n = 0;
    for (const r of slice) {
        const role = String(r.role || '').toLowerCase();
        const text = String(r.content || '').trim();
        if (!text)
            continue;
        if (role === 'user') {
            mgr.addUserMessage(conversationId, text);
            n++;
        }
        else if (role === 'assistant') {
            const blocks = [{ type: 'text', text }];
            mgr.addAssistantMessage(conversationId, blocks);
            n++;
        }
    }
    if (n > 0) {
        console.error(`[Gateway DIAG] hydrated LLM context from gateway.db: convId=${conversationId} rows=${n}`);
    }
    return n;
}
