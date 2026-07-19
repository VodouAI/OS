/**
 * board_search — FTS5 search across tasks on this board.
 * Read-only direct against board.db::tasks_fts.
 * Phase 3 will add cosine reranking against tasks.intent_embedding; Phase 1
 * is pure FTS5.
 */

import { z } from 'zod';
import { getReadDb } from '../db.js';

export const searchInputSchema = z.object({
  query: z.string().min(1),
  board_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function handleSearch(args: unknown) {
  const { query, board_id, limit } = searchInputSchema.parse(args);
  const db = getReadDb();

  // Sanitize FTS5 query — strip control chars; let FTS5 syntax through
  const cleanQuery = query.replace(/[\x00-\x1f]/g, ' ').trim();
  if (!cleanQuery) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ matches: [] }) }],
    };
  }

  const params: (string | number | bigint | null | Uint8Array)[] = [cleanQuery];
  let boardClause = '';
  if (board_id) {
    boardClause = 'AND t.board_id = ?';
    params.push(board_id);
  }
  params.push(limit ?? 20);

  const rows = db.prepare(
    `SELECT t.id, t.title, t.status, t.assignee, t.priority,
            snippet(tasks_fts, 1, '<b>', '</b>', '…', 12) AS title_snippet,
            snippet(tasks_fts, 2, '<b>', '</b>', '…', 16) AS body_snippet,
            bm25(tasks_fts) AS score
       FROM tasks_fts
       JOIN tasks t ON t.id = tasks_fts.task_id
      WHERE tasks_fts MATCH ?
         ${boardClause}
   ORDER BY score
      LIMIT ?`,
  ).all(...params) as any[];

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ query, matches: rows }, null, 2),
    }],
  };
}
