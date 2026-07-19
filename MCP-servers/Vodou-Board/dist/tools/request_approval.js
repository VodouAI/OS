/**
 * board_request_approval — request human approval mid-run (alternative to block).
 *
 * Creates a board_approvals row and moves task → pending_approval. The
 * dispatcher won't reclaim until decision is resolved. Notifier dispatches
 * the request to subscribers.
 */
import { z } from 'zod';
import { currentTaskId } from '../gating.js';
import { gatewayCall } from '../gateway-client.js';
export const requestApprovalInputSchema = z.object({
    reason: z.string().min(3).max(4096),
    decision_required_by: z.string().datetime().optional(),
    task_id: z.string().optional(),
});
export async function handleRequestApproval(args) {
    const { reason, decision_required_by, task_id } = requestApprovalInputSchema.parse(args);
    const id = task_id ?? currentTaskId();
    const result = await gatewayCall(`/tasks/${id}/approvals`, { method: 'POST', body: { reason, decision_required_by: decision_required_by ?? null } });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
