/**
 * board_complete — close the current task as completed.
 * Writes via gateway HTTP so the dispatcher emits the canonical events +
 * fires the notifier + writes the task_handoff memory chunk (Phase 2).
 */

import { z } from 'zod';
import { currentTaskId } from '../gating.js';
import { gatewayCall } from '../gateway-client.js';

export const completeInputSchema = z.object({
  summary: z.string().min(1).max(8192),
  metadata: z.record(z.unknown()).optional(),
  task_id: z.string().optional(),
});

export async function handleComplete(args: unknown) {
  const { summary, metadata, task_id } = completeInputSchema.parse(args);
  const id = task_id ?? currentTaskId();
  const result = await gatewayCall<{ task_id: string; status: string }>(
    `/tasks/${id}/complete`,
    { method: 'POST', body: { summary, metadata: metadata ?? {} } },
  );
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
