/**
 * board_heartbeat — signal liveness during long-running work.
 * Updates tasks.last_heartbeat_at via gateway HTTP. Stale heartbeats trigger
 * reclaim after CLAIM_TTL_SECS (default 900s).
 */
import { z } from 'zod';
export declare const heartbeatInputSchema: z.ZodObject<{
    note: z.ZodOptional<z.ZodString>;
    task_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    task_id?: string | undefined;
    note?: string | undefined;
}, {
    task_id?: string | undefined;
    note?: string | undefined;
}>;
export declare function handleHeartbeat(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
