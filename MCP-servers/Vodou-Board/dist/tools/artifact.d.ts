/**
 * board_artifact — attach a file path, screenshot, URL, or other artifact
 * reference to the current run's metadata.
 */
import { z } from 'zod';
export declare const artifactInputSchema: z.ZodObject<{
    kind: z.ZodEnum<["file", "screenshot", "pr_url", "deploy_url", "other"]>;
    value: z.ZodString;
    task_id: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    value: string;
    kind: "file" | "screenshot" | "pr_url" | "deploy_url" | "other";
    task_id?: string | undefined;
    label?: string | undefined;
}, {
    value: string;
    kind: "file" | "screenshot" | "pr_url" | "deploy_url" | "other";
    task_id?: string | undefined;
    label?: string | undefined;
}>;
export declare function handleArtifact(args: unknown): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
