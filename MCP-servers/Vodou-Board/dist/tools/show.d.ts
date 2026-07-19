/**
 * board_show — read the current task's full worker_context blob.
 *
 * Defaults to env's VODOU_BOARD_TASK if no task_id is passed (the typical
 * worker-spawned case). Returns the §6.3 shape from the main plan: task,
 * prior_attempts, parent_handoffs, role_history, comments, memory, budget,
 * workspace_path, model, guidance.
 *
 * Memory section is Phase 2 (always empty in Phase 1). The other sections
 * are populated from board.db / core.principals / core.skills_registry.
 */
import { z } from 'zod';
export declare const showInputSchema: z.ZodObject<{
    task_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    task_id?: string | undefined;
}, {
    task_id?: string | undefined;
}>;
export declare function handleShow(args: unknown): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
