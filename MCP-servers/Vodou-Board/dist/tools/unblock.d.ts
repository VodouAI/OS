/**
 * board_unblock — orchestrator-only. Move a blocked task back to ready.
 */
import { z } from 'zod';
export declare const unblockInputSchema: z.ZodObject<{
    task_id: z.ZodString;
    note: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    task_id: string;
    note?: string | undefined;
}, {
    task_id: string;
    note?: string | undefined;
}>;
export declare function handleUnblock(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
