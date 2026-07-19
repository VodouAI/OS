/**
 * board_ask — natural-language Q&A over board state.
 *
 * Routes through gateway HTTP → src/board/ask.rs (Day 11) which runs hybrid
 * FTS5+cosine search over the board corpus and falls back to LLM-router for
 * synthesis when confidence is low. Returns answer + cited task IDs + confidence.
 *
 * Cost-budgeted: dispatcher enforces per-call ceiling (default $0.02) so spam
 * doesn't burn the quota.
 */
import { z } from 'zod';
export declare const askInputSchema: z.ZodObject<{
    question: z.ZodString;
    board_id: z.ZodOptional<z.ZodString>;
    budget_usd_cap: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    question: string;
    board_id?: string | undefined;
    budget_usd_cap?: number | undefined;
}, {
    question: string;
    board_id?: string | undefined;
    budget_usd_cap?: number | undefined;
}>;
export declare function handleAsk(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
