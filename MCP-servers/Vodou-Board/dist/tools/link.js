/**
 * board_link — orchestrator-only. Add a parent→child dependency.
 * Server-side enforces no-cycles via DFS check before insert.
 */
import { z } from 'zod';
import { gatewayCall } from '../gateway-client.js';
export const linkInputSchema = z.object({
    parent_id: z.string(),
    child_id: z.string(),
}).refine((d) => d.parent_id !== d.child_id, {
    message: 'parent_id and child_id must differ (no self-link)',
});
export async function handleLink(args) {
    const payload = linkInputSchema.parse(args);
    const result = await gatewayCall(`/links`, { method: 'POST', body: payload });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
