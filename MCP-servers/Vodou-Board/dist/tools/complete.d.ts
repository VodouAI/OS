/**
 * board_complete — close the current task as completed.
 * Writes via gateway HTTP so the dispatcher emits the canonical events +
 * fires the notifier + writes the task_handoff memory chunk (Phase 2).
 */
import { z } from 'zod';
export declare const completeInputSchema: z.ZodObject<{
    summary: z.ZodString;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    task_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    summary: string;
    task_id?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    summary: string;
    task_id?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export declare function handleComplete(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
