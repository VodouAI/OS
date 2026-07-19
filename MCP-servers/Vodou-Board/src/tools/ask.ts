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
import { gatewayCall } from '../gateway-client.js';

export const askInputSchema = z.object({
  question: z.string().min(3).max(2048),
  board_id: z.string().optional(),
  budget_usd_cap: z.number().positive().max(1).optional(),
});

interface AskResult {
  answer: string;
  cited_task_ids: string[];
  confidence: number;
  cost_usd: number;
}

export async function handleAsk(args: unknown) {
  const payload = askInputSchema.parse(args);
  const result = await gatewayCall<AskResult>(
    `/ask`,
    { method: 'POST', body: payload, timeoutMs: 20_000 },
  );
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
