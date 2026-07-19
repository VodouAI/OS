/**
 * memory-client.ts — Tool-usage memory emission helpers
 *
 * Stage 4 of PLAN-UNIFIED-MEMORY-GRID: auto-extractor for MCP tool calls.
 * Amendment A: tool-usage memories scope to the integration, not the UI tab.
 *
 * When a user calls an MCP tool (e.g. asana/create_tasks) from the main chat
 * tab (`web` scope), the emitted memory is tagged `workbench:integration:asana`
 * — not `web` — so it surfaces correctly whether the user is in main chat or
 * the Asana workbench on the next session.
 */

import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../db.js';
import type { Scope } from '../scope.js';
import { resolveScope } from '../scope.js';

// ---------------------------------------------------------------------------
// deriveToolUsageScope
// ---------------------------------------------------------------------------

/**
 * Determines which memory scope a tool-usage emission should be tagged with.
 *
 * Tool-usage memories describe a specific integration's capability, not the
 * UI surface the user happened to be in. By scoping to the integration, these
 * memories are equally useful whether the user called the tool from main chat
 * or from the dedicated workbench.
 *
 * Decision table:
 * | ctx.scope          | server present? | result                             |
 * |--------------------|-----------------|-------------------------------------|
 * | null (web/unscoped)| yes             | workbench:integration:<server>      |
 * | null (web/unscoped)| no / blank      | 'web'  (internal Vodou calls)          |
 * | Scope (workbench)  | any             | scope.raw  (already isolated)       |
 *
 * Note: `ctx.scope` is null for web conversations because resolveScope('web')
 * returns null. A non-null scope means we're already in a dedicated workbench.
 */
export function deriveToolUsageScope(
  scope: Scope | null | undefined,
  server: string
): string {
  // Already in a dedicated workbench scope — keep it unchanged.
  // Workbench memories stay workbench; no re-tagging needed.
  if (scope) return scope.raw;

  // null/undefined = web/unscoped conversation calling an integration.
  if (!server) {
    // No server = internal Vodou call (e.g. vodou_core_call to brain itself).
    return 'web';
  }

  // web + real server → scope to the integration's canonical workbench scope.
  // This mirrors what resolveScope() produces for workbench:integration:<server>,
  // so the dedup hash coalesces correctly with memories from the workbench itself.
  const integrationScope = `workbench:integration:${server}`;
  // Validate via resolveScope so malformed server names don't pollute scope column.
  const resolved = resolveScope(integrationScope);
  return resolved ? resolved.raw : 'web';
}

// ---------------------------------------------------------------------------
// sanitizeToolArgs
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /token|secret|password|key|api_key|access_token|auth/i;

/**
 * Strip credential-looking keys from tool args before writing to memory.
 * Shallow pass — nested objects are JSON-stringified and written as-is.
 */
function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    result[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// summarizeResult
// ---------------------------------------------------------------------------

/**
 * Truncate and clean a raw tool result string to at most maxLen chars.
 * Exported so executor.ts can use it in the emit call site.
 */
export function summarizeResult(result: string, maxLen: number): string {
  const clean = result.trim().replace(/\s+/g, ' ');
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen) + '…';
}

// ---------------------------------------------------------------------------
// emitToolUsageMemory
// ---------------------------------------------------------------------------

/**
 * In-process dedup set: tracks (scope|server|tool) combos emitted this session.
 * Prevents the same tool from being logged 50× in one conversation.
 * Rust-side dedup hash (src/memory/bullets.rs) is a Stage 4 follow-on.
 */
const _emittedThisSession = new Set<string>();

/**
 * Append a TOOL_USAGE bullet to today's daily memory log.
 *
 * Format:
 *   - [TOOL_USAGE] scope:workbench:integration:asana | asana/create_tasks({"name":"..."}) → Task created
 *
 * The daemon's nightly extraction picks these up naturally via the existing
 * markdown-to-memory_chunks pipeline. No Rust changes needed for Amendment A.
 *
 * Fire-and-forget: callers should `void emitToolUsageMemory(...).catch(...)`.
 */
export async function emitToolUsageMemory(opts: {
  scope: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
  /**
   * PLAN-PROJECT-SCOPED-MEMORY — active project id for the turn (undefined =
   * Default/global). Written as an in-band `project:<id>` token next to
   * `scope:`; the Rust chunker parses it into `memory_chunks.project_id` so
   * the usage memory only surfaces inside that project.
   */
  projectId?: string;
}): Promise<void> {
  // Session-level dedup: same project+scope+server+tool = skip
  const dedupKey = `${opts.projectId ?? ''}|${opts.scope}|${opts.server}|${opts.tool}`;
  if (_emittedThisSession.has(dedupKey)) {
    console.error(`[tool-usage-extractor] dedup skip: ${opts.server}/${opts.tool}`);
    return;
  }
  _emittedThisSession.add(dedupKey);

  const sanitized = sanitizeToolArgs(opts.args);
  const argsStr = Object.keys(sanitized).length > 0
    ? JSON.stringify(sanitized).substring(0, 80)
    : '{}';

  const today = new Date().toISOString().split('T')[0];
  const memDir = path.join(getProjectRoot(), '.vodou', 'workspace', 'memory');
  const memFile = path.join(memDir, `${today}.md`);

  // Format matches existing daily log bullet style; the optional project token
  // sits before the pipe, alongside scope, where extract_project() finds it.
  const projectToken = opts.projectId ? ` project:${opts.projectId}` : '';
  const line = `- [TOOL_USAGE] scope:${opts.scope}${projectToken} | ${opts.server}/${opts.tool}(${argsStr}) → ${opts.resultSummary}\n`;

  try {
    mkdirSync(memDir, { recursive: true });
    appendFileSync(memFile, line, 'utf-8');
    console.error(`[tool-usage-extractor] emitted scope=${opts.scope} ${opts.server}/${opts.tool}`);
  } catch (err) {
    console.error('[tool-usage-extractor] write failed:', err);
  }
}
