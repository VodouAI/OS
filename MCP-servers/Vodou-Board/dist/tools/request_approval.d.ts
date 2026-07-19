/**
 * board_request_approval — request human approval mid-run (alternative to block).
 *
 * Creates a board_approvals row and moves task → pending_approval. The
 * dispatcher won't reclaim until decision is resolved. Notifier dispatches
 * the request to subscribers.
 */
import { z } from 'zod';
export declare const requestApprovalInputSchema: z.ZodObject<{
    reason: z.ZodString;
    decision_required_by: z.ZodOptional<z.ZodString>;
    task_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    reason: string;
    task_id?: string | undefined;
    decision_required_by?: string | undefined;
}, {
    reason: string;
    task_id?: string | undefined;
    decision_required_by?: string | undefined;
}>;
export declare function handleRequestApproval(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
