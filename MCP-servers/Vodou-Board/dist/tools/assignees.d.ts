/**
 * board_assignees — Step-0 orchestrator discovery.
 *
 * Returns the active subagent skills + per-assignee in-flight task counts.
 * Cross-DB JOIN: board.db::tasks ⨝ core.skills_registry.
 *
 * The orchestrator skill calls this first, before any board_create, to avoid
 * the Hermes-class silent-fail-on-unknown-assignee bug.
 */
import { z } from 'zod';
export declare const assigneesInputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare function handleAssignees(_args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
