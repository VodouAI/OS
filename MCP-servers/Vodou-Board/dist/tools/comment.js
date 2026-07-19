/**
 * board_comment — append a comment to a task's thread.
 * Writes via gateway HTTP. Author resolved server-side from the JWT principal_id.
 */
import { z } from 'zod';
import { gatewayCall } from '../gateway-client.js';
export const commentInputSchema = z.object({
    task_id: z.string(),
    body: z.string().min(1).max(8192),
    in_reply_to: z.number().int().positive().optional(),
});
export async function handleComment(args) {
    const { task_id, body, in_reply_to } = commentInputSchema.parse(args);
    const result = await gatewayCall(`/tasks/${task_id}/comments`, { method: 'POST', body: { body, in_reply_to: in_reply_to ?? null } });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
