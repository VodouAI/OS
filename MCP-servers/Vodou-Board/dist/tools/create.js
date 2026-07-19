/**
 * board_create — orchestrator-only. Create a new task.
 * Writes via gateway HTTP. Cycle-detection happens server-side.
 */
import { z } from 'zod';
import { gatewayCall } from '../gateway-client.js';
export const createInputSchema = z.object({
    title: z.string().min(1).max(512),
    body: z.string().max(65536).optional(),
    assignee: z.string().nullable().optional(),
    parents: z.array(z.string()).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    workspace: z.string().optional(),
    skills: z.array(z.string()).optional(),
    max_runtime_seconds: z.number().int().positive().optional(),
    budget_usd_cap: z.number().positive().optional(),
    idempotency_key: z.string().max(128).optional(),
    board_id: z.string().optional(),
    tenant_id: z.string().optional(),
    workflow_template_id: z.string().optional(),
    requires_approval_on: z.array(z.string()).optional(),
});
export async function handleCreate(args) {
    const payload = createInputSchema.parse(args);
    const result = await gatewayCall(`/tasks`, { method: 'POST', body: payload });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
