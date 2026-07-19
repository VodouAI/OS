/**
 * board_list — list task summaries with optional filters.
 * Read-only direct against board.db.
 */

import { z } from 'zod';
import { getReadDb } from '../db.js';

export const listInputSchema = z.object({
  board_id: z.string().optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  assignee: z.string().optional(),
  tenant_id: z.string().optional(),
  archived: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function handleList(args: unknown) {
  const opts = listInputSchema.parse(args ?? {});
  const db = getReadDb();

  const filters: string[] = [];
  const params: (string | number | bigint | null | Uint8Array)[] = [];

  if (opts.board_id) {
    filters.push('board_id = ?');
    params.push(opts.board_id);
  }
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const placeholders = opts.status.map(() => '?').join(', ');
      filters.push(`status IN (${placeholders})`);
      params.push(...opts.status);
    } else {
      filters.push('status = ?');
      params.push(opts.status);
    }
  } else if (!opts.archived) {
    // Default: hide archived
    filters.push('status != ?');
    params.push('archived');
  }
  if (opts.assignee) {
    filters.push('assignee = ?');
    params.push(opts.assignee);
  }
  if (opts.tenant_id) {
    filters.push('tenant_id = ?');
    params.push(opts.tenant_id);
  }
  if (opts.archived === false) {
    filters.push('status != ?');
    params.push('archived');
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;

  const rows = db.prepare(
    `SELECT id, board_id, title, status, assignee, priority, tenant_id,
            workspace, max_runtime_seconds, budget_usd_cap, current_step_key,
            created_at, updated_at
       FROM tasks
       ${where}
   ORDER BY priority DESC, updated_at DESC
      LIMIT ?`,
  ).all(...params, limit) as any[];

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ count: rows.length, tasks: rows }, null, 2),
    }],
  };
}
