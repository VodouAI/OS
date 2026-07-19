/**
 * board_block — escalate the current task for human input.
 * Writes via gateway HTTP.
 */
import { z } from 'zod';
import { currentTaskId } from '../gating.js';
import { gatewayCall } from '../gateway-client.js';
export const blockInputSchema = z.object({
    reason: z.string().min(3).max(4096),
    task_id: z.string().optional(),
});
export async function handleBlock(args) {
    const { reason, task_id } = blockInputSchema.parse(args);
    const id = task_id ?? currentTaskId();
    const result = await gatewayCall(`/tasks/${id}/block`, { method: 'POST', body: { reason } });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
