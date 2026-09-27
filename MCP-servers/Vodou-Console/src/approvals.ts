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

export interface PendingApproval {
  token: string;
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  category: string;
  createdAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PER_CONV = 20; // bound memory per conversation

const store = new Map<string, PendingApproval>(); // key = `${conversationId}\0${token}`

function key(conversationId: string, token: string): string {
  return `${conversationId}\0${token}`;
}

function gc(now: number): void {
  for (const [k, v] of store) {
    if (now - v.createdAt > TTL_MS) store.delete(k);
  }
}

/** Park a pending approval; returns it (with a fresh single-use token). */
export function createApproval(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>,
  category: string,
  now: number = Date.now(),
): PendingApproval {
  gc(now);
  // Per-conversation cap: evict the oldest if at the limit.
  const mine = [...store.values()].filter((p) => p.conversationId === conversationId);
  if (mine.length >= MAX_PER_CONV) {
    mine.sort((a, b) => a.createdAt - b.createdAt);
    store.delete(key(conversationId, mine[0].token));
  }
  const p: PendingApproval = { token: randomUUID(), conversationId, toolName, input, category, createdAt: now };
  store.set(key(conversationId, p.token), p);
  return p;
}

/** Consume a pending approval (single-use). Returns null if absent/expired. */
export function consumeApproval(conversationId: string, token: string, now: number = Date.now()): PendingApproval | null {
  gc(now);
  if (!conversationId || !token) return null;
  const k = key(conversationId, token);
  const p = store.get(k);
  if (!p) return null;
  store.delete(k);
  return p;
}

/**
 * The newest pending approval for a conversation, NOT consumed — or null.
 * M2b: lets a plain-text "yes"/"no" resolve an approval on surfaces that have
 * no approve/deny card (the /simple page, phone/channel replies). "Latest"
 * because that is the one the person was just asked about; anything older is
 * still reachable through its own token via POST /chat/approve.
 */
export function latestPending(conversationId: string, now: number = Date.now()): PendingApproval | null {
  gc(now);
  let best: PendingApproval | null = null;
  for (const v of store.values()) {
    if (v.conversationId === conversationId && (!best || v.createdAt > best.createdAt)) best = v;
  }
  return best;
}

/**
 * Parse one inbound message as an approval reply. Same contract as
 * `parseLoopControl` (commitment-controls.ts): ONLY a bare control word counts —
 * "yes" is a decision, "yes but change the subject line" is a sentence — and a
 * word only counts when an approval is actually pending (the caller checks
 * `latestPending` first). Returns 'approve' | 'deny' | null.
 */
const APPROVE_WORDS = ['yes', 'y', 'yes please', 'yep', 'yeah', 'approve', 'approved', 'ok', 'okay', 'go ahead', 'do it', 'sure', '👍'];
const DENY_WORDS = ['no', 'n', 'nope', 'deny', 'denied', 'no thanks', 'don\'t', 'do not', 'stop', 'skip it', 'skip', '👎'];

export function parseApprovalReply(raw: string): 'approve' | 'deny' | null {
  const text = String(raw ?? '').trim().replace(/^\/+/, '').trim();
  if (!text || text.length > 20) return null;
  const lower = text.toLowerCase().replace(/[.!]+$/, '').trim();
  if (APPROVE_WORDS.includes(lower)) return 'approve';
  if (DENY_WORDS.includes(lower)) return 'deny';
  return null;
}

/** Test/diagnostic helper. */
export function pendingCount(conversationId?: string): number {
  if (!conversationId) return store.size;
  let n = 0;
  for (const v of store.values()) if (v.conversationId === conversationId) n++;
  return n;
}
