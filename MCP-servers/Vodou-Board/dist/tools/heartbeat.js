/**
 * board_heartbeat — signal liveness during long-running work.
 * Updates tasks.last_heartbeat_at via gateway HTTP. Stale heartbeats trigger
 * reclaim after CLAIM_TTL_SECS (default 900s).
 */
import { z } from 'zod';
import { currentTaskId } from '../gating.js';
import { gatewayCall } from '../gateway-client.js';
export const heartbeatInputSchema = z.object({
    note: z.string().max(512).optional(),
    task_id: z.string().optional(),
});
export async function handleHeartbeat(args) {
    const { note, task_id } = heartbeatInputSchema.parse(args ?? {});
    const id = task_id ?? currentTaskId();
    const result = await gatewayCall(`/tasks/${id}/heartbeat`, { method: 'POST', body: { note: note ?? null } });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
