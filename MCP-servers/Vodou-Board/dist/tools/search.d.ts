/**
 * board_search — FTS5 search across tasks on this board.
 * Read-only direct against board.db::tasks_fts.
 * Phase 3 will add cosine reranking against tasks.intent_embedding; Phase 1
 * is pure FTS5.
 */
import { z } from 'zod';
export declare const searchInputSchema: z.ZodObject<{
    query: z.ZodString;
    board_id: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    query: string;
    board_id?: string | undefined;
    limit?: number | undefined;
}, {
    query: string;
    board_id?: string | undefined;
    limit?: number | undefined;
}>;
export declare function handleSearch(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
