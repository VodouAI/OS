/**
 * board_link — orchestrator-only. Add a parent→child dependency.
 * Server-side enforces no-cycles via DFS check before insert.
 */
import { z } from 'zod';
export declare const linkInputSchema: z.ZodEffects<z.ZodObject<{
    parent_id: z.ZodString;
    child_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    parent_id: string;
    child_id: string;
}, {
    parent_id: string;
    child_id: string;
}>, {
    parent_id: string;
    child_id: string;
}, {
    parent_id: string;
    child_id: string;
}>;
export declare function handleLink(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
