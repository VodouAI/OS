/**
 * board_unblock — orchestrator-only. Move a blocked task back to ready.
 */

import { z } from 'zod';
import { gatewayCall } from '../gateway-client.js';

export const unblockInputSchema = z.object({
  task_id: z.string(),
  note: z.string().max(2048).optional(),
});

export async function handleUnblock(args: unknown) {
  const { task_id, note } = unblockInputSchema.parse(args);
  const result = await gatewayCall<{ task_id: string; status: string }>(
    `/tasks/${task_id}/unblock`,
    { method: 'POST', body: { note: note ?? null } },
  );
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
