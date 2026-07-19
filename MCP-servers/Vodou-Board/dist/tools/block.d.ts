/**
 * board_block — escalate the current task for human input.
 * Writes via gateway HTTP.
 */
import { z } from 'zod';
export declare const blockInputSchema: z.ZodObject<{
    reason: z.ZodString;
    task_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    reason: string;
    task_id?: string | undefined;
}, {
    reason: string;
    task_id?: string | undefined;
}>;
export declare function handleBlock(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
