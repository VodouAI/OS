/**
 * board_artifact — attach a file path, screenshot, URL, or other artifact
 * reference to the current run's metadata.
 */

import { z } from 'zod';
import { currentTaskId } from '../gating.js';
import { gatewayCall } from '../gateway-client.js';

export const artifactInputSchema = z.object({
  kind: z.enum(['file', 'screenshot', 'pr_url', 'deploy_url', 'other']),
  value: z.string().min(1).max(4096),
  task_id: z.string().optional(),
  label: z.string().max(256).optional(),
});

export async function handleArtifact(args: unknown) {
  const { kind, value, task_id, label } = artifactInputSchema.parse(args);
  const id = task_id ?? currentTaskId();
  const result = await gatewayCall<{ task_id: string; metadata_key: string }>(
    `/tasks/${id}/artifacts`,
    { method: 'POST', body: { kind, value, label: label ?? null } },
  );
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
