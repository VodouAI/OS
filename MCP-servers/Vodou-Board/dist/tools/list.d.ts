/**
 * board_list — list task summaries with optional filters.
 * Read-only direct against board.db.
 */
import { z } from 'zod';
export declare const listInputSchema: z.ZodObject<{
    board_id: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>;
    assignee: z.ZodOptional<z.ZodString>;
    tenant_id: z.ZodOptional<z.ZodString>;
    archived: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    archived?: boolean | undefined;
    assignee?: string | undefined;
    board_id?: string | undefined;
    tenant_id?: string | undefined;
    status?: string | string[] | undefined;
    limit?: number | undefined;
}, {
    archived?: boolean | undefined;
    assignee?: string | undefined;
    board_id?: string | undefined;
    tenant_id?: string | undefined;
    status?: string | string[] | undefined;
    limit?: number | undefined;
}>;
export declare function handleList(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
