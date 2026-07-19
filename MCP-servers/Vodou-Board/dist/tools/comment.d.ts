/**
 * board_comment — append a comment to a task's thread.
 * Writes via gateway HTTP. Author resolved server-side from the JWT principal_id.
 */
import { z } from 'zod';
export declare const commentInputSchema: z.ZodObject<{
    task_id: z.ZodString;
    body: z.ZodString;
    in_reply_to: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    body: string;
    task_id: string;
    in_reply_to?: number | undefined;
}, {
    body: string;
    task_id: string;
    in_reply_to?: number | undefined;
}>;
export declare function handleComment(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
