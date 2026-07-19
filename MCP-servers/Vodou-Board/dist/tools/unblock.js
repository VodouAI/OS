/**
 * board_unblock — orchestrator-only. Move a blocked task back to ready.
 */
import { z } from 'zod';
import { gatewayCall } from '../gateway-client.js';
export const unblockInputSchema = z.object({
    task_id: z.string(),
    note: z.string().max(2048).optional(),
});
export async function handleUnblock(args) {
    const { task_id, note } = unblockInputSchema.parse(args);
    const result = await gatewayCall(`/tasks/${task_id}/unblock`, { method: 'POST', body: { note: note ?? null } });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
