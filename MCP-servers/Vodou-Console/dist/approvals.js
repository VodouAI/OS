/**
 * approvals.ts — pending tool-approval store for the out-of-band `ask` flow (Bet #2 Phase 2).
 *
 * When a tool's permission category resolves to `ask`, executeOITool does NOT run it —
 * it parks a pending approval here (returning the token to the client via an
 * `approval_requested` event) and the command runs on a NEW turn once the user confirms
 * via POST /chat/approve. This is the out-of-band design from 6-PLAN §6 (the board
 * `pending_approval` machinery does not fit a synchronous chat tool sink).
 *
 * In-memory + transient by design: pendings are short-lived; a gateway restart simply
 * drops them (the approve then 404s cleanly — "expired"). Single-use, TTL'd, capped.
 * The token (crypto.randomUUID) is the capability — only the requesting client gets it.
 */
import { randomUUID } from 'crypto';
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PER_CONV = 20; // bound memory per conversation
const store = new Map(); // key = `${conversationId}\0${token}`
function key(conversationId, token) {
    return `${conversationId}\0${token}`;
}
function gc(now) {
    for (const [k, v] of store) {
        if (now - v.createdAt > TTL_MS)
            store.delete(k);
    }
}
/** Park a pending approval; returns it (with a fresh single-use token). */
export function createApproval(conversationId, toolName, input, category, now = Date.now()) {
    gc(now);
    // Per-conversation cap: evict the oldest if at the limit.
    const mine = [...store.values()].filter((p) => p.conversationId === conversationId);
    if (mine.length >= MAX_PER_CONV) {
        mine.sort((a, b) => a.createdAt - b.createdAt);
        store.delete(key(conversationId, mine[0].token));
    }
    const p = { token: randomUUID(), conversationId, toolName, input, category, createdAt: now };
    store.set(key(conversationId, p.token), p);
    return p;
}
/** Consume a pending approval (single-use). Returns null if absent/expired. */
export function consumeApproval(conversationId, token, now = Date.now()) {
    gc(now);
    if (!conversationId || !token)
        return null;
    const k = key(conversationId, token);
    const p = store.get(k);
    if (!p)
        return null;
    store.delete(k);
    return p;
}
/** Test/diagnostic helper. */
export function pendingCount(conversationId) {
    if (!conversationId)
        return store.size;
    let n = 0;
    for (const v of store.values())
        if (v.conversationId === conversationId)
            n++;
    return n;
}
