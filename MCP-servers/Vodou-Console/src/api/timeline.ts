/**
 * Cross-surface timeline — everything you did with AI today, in order.
 *
 * PLAN-CONSOLE-SHOWS-ITS-WORK §3.3 / §4.5:
 *
 *   "brainctx:chatgpt, brainctx:claude, capture:*, channel conversations, web
 *    chats, IDE captures — one database, all timestamped. The console renders
 *    this as TABS, a filing metaphor. It should be a TIMELINE … No competitor can
 *    build that view; nobody else has the data."
 *
 * The filing metaphor is the problem: a tab strip answers "what surfaces exist",
 * which is a question nobody asks. "What did I do today, across everything" is
 * the question, and the data has always been there.
 *
 * §6 called conversation identity a blocker — every brainctx row is titled
 * "Brain · chatgpt", so a timeline of them is a list of identical names. It is
 * solved HERE, at read time, rather than by migrating titles: the first user
 * message is the topic, it needs no LLM, it cannot be wrong about history, and it
 * fixes future rows for free. The stored title is left alone for the dock.
 */

import { Router, Request, Response } from 'express';
import { getGatewayDb } from '../db.js';

export const timelineRouter = Router();

/** Titles that identify a LANE, not a conversation — the §6 problem. */
const GENERIC_TITLE = /^(brain|task)\s*·\s*\w+$|^new chat$|^chat \d+$|^imported chat$/i;

/** Which surface a conversation came from, for grouping and filtering. */
function surfaceOf(id: string, source: string | null): string {
  const s = source || '';
  if (id.startsWith('brainctx:')) return 'brain-inject';
  if (s.startsWith('capture:ide')) return 'ide';
  if (s.startsWith('capture:web')) return 'web-capture';
  if (s.startsWith('capture:manual')) return 'clipped';
  if (s.startsWith('import:')) return 'import';
  if (s.startsWith('channel:') || ['slack', 'telegram', 'discord', 'whatsapp', 'imessage'].includes(s)) return 'channel';
  if (id.startsWith('workbench:skill-console:')) return 'skill-console';
  if (id === 'vodou-heartbeat' || s === 'heartbeat') return 'heartbeat';
  if (id === 'board-chat' || s === 'board') return 'board';
  if (id.startsWith('workbench:')) return 'workbench';
  return 'chat';
}

/** A readable one-liner for a conversation whose stored title says nothing. */
function deriveTitle(stored: string | null, firstUserMessage: string | null): string {
  const t = (stored || '').trim();
  if (t && !GENERIC_TITLE.test(t)) return t;
  const body = (firstUserMessage || '').trim();
  if (!body) return t || 'Untitled';
  // Strip the machine wrappers the gateway folds into a stored user turn, or the
  // "title" becomes "<active_context>" for every row.
  const cleaned = body
    .replace(/<active_context>[\s\S]*?<\/active_context>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return t || 'Untitled';
  return cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
}

// ── GET /api/timeline?days=1&limit=100 ───────────────────────────────────────
timelineRouter.get('/', (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '1'), 10) || 1, 1), 30);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
  try {
    const db = getGatewayDb();
    // One row per conversation that saw traffic in the window, with its own
    // first/last message and count — the timeline is about SESSIONS, not
    // individual messages, or a busy chat drowns everything else.
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.source, c.project_id,
                COUNT(m.id)      AS msgs,
                MIN(m.created_at) AS first_at,
                MAX(m.created_at) AS last_at
           FROM gateway_conversations c
           JOIN gateway_messages m ON m.conversation_id = c.id
          WHERE c.deleted_at IS NULL
            AND m.created_at >= datetime('now', ?)
          GROUP BY c.id
          ORDER BY last_at DESC
          LIMIT ?`,
      )
      .all(`-${days} days`, limit) as Array<{
        id: string; title: string | null; source: string | null; project_id: string | null;
        msgs: number; first_at: string; last_at: string;
      }>;

    const firstUser = db.prepare(
      `SELECT content FROM gateway_messages
        WHERE conversation_id = ? AND role = 'user' AND TRIM(content) != ''
        ORDER BY id ASC LIMIT 1`,
    );

    const items = rows.map((r) => {
      const fu = firstUser.get(r.id) as { content: string } | undefined;
      return {
        id: r.id,
        title: deriveTitle(r.title, fu?.content ?? null),
        storedTitle: r.title,
        surface: surfaceOf(r.id, r.source),
        projectId: r.project_id,
        messages: r.msgs,
        firstAt: r.first_at,
        lastAt: r.last_at,
      };
    });

    const bySurface: Record<string, number> = {};
    for (const i of items) bySurface[i.surface] = (bySurface[i.surface] || 0) + 1;

    res.json({ days, count: items.length, bySurface, items });
  } catch (e) {
    console.warn('[timeline] failed:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});
