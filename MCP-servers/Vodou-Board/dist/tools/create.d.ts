/**
 * board_create — orchestrator-only. Create a new task.
 * Writes via gateway HTTP. Cycle-detection happens server-side.
 */
import { z } from 'zod';
export declare const createInputSchema: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodOptional<z.ZodString>;
    assignee: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parents: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    priority: z.ZodOptional<z.ZodNumber>;
    workspace: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    max_runtime_seconds: z.ZodOptional<z.ZodNumber>;
    budget_usd_cap: z.ZodOptional<z.ZodNumber>;
    idempotency_key: z.ZodOptional<z.ZodString>;
    board_id: z.ZodOptional<z.ZodString>;
    tenant_id: z.ZodOptional<z.ZodString>;
    workflow_template_id: z.ZodOptional<z.ZodString>;
    requires_approval_on: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    title: string;
    body?: string | undefined;
    assignee?: string | null | undefined;
    priority?: number | undefined;
    workspace?: string | undefined;
    board_id?: string | undefined;
    tenant_id?: string | undefined;
    max_runtime_seconds?: number | undefined;
    idempotency_key?: string | undefined;
    workflow_template_id?: string | undefined;
    requires_approval_on?: string[] | undefined;
    budget_usd_cap?: number | undefined;
    parents?: string[] | undefined;
    skills?: string[] | undefined;
}, {
    title: string;
    body?: string | undefined;
    assignee?: string | null | undefined;
    priority?: number | undefined;
    workspace?: string | undefined;
    board_id?: string | undefined;
    tenant_id?: string | undefined;
    max_runtime_seconds?: number | undefined;
    idempotency_key?: string | undefined;
    workflow_template_id?: string | undefined;
    requires_approval_on?: string[] | undefined;
    budget_usd_cap?: number | undefined;
    parents?: string[] | undefined;
    skills?: string[] | undefined;
}>;
export declare function handleCreate(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
