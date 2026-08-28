// PLAN-DYNAMIC-MEMORY-MD W15 — per-project MEMORY.md for the gateway bootstrap.
//
// The workspace bootstrap the gateway sends on a conversation's first turn is
// read from `.vodou/workspace/.context_cache`, whose `### MEMORY.md` section
// is the daemon's GLOBAL rendering (refreshed every 60s). A conversation that
// belongs to a project should get that project's rendering instead — pinned
// facts, then the project's memories, then global fill — exactly what a Claude
// Code session in that project's folder receives from the SessionStart hook.
//
// Same seam, same verb (`memory_render`), same splice rule as the hook
// (vodou-hook/src/main.rs splice_memory_section): the renderer never emits a
// `### ` line, so the section runs from `### MEMORY.md\n` to the next `\n### `.
// Daemon down or slow → the global snapshot stands; a bootstrap is never
// blocked on this (2s cap, one attempt, no retry).

import net from 'net';
import path from 'path';
import { getProjectRoot } from './db.js';
import { sockConnectTarget } from './cli-portability.js';

const RENDER_TIMEOUT_MS = 2000;
const RENDER_CACHE_MS = 60_000;

interface CachedRender { markdown: string; at: number }
const _renderCache = new Map<string, CachedRender>();

/** Replace the body of the `### MEMORY.md` section with `rendered`. */
export function spliceMemorySection(context: string, rendered: string): string {
  const HEAD = '### MEMORY.md\n';
  const body = rendered.trimEnd() + '\n\n';
  const start = context.indexOf(HEAD);
  if (start >= 0) {
    const afterHead = start + HEAD.length;
    const rel = context.indexOf('\n### ', afterHead);
    const end = rel >= 0 ? rel + 1 : context.length;
    return context.slice(0, afterHead) + body + context.slice(end);
  }
  const ctxHead = '## Context\n\n';
  const i = context.indexOf(ctxHead);
  if (i >= 0) {
    const at = i + ctxHead.length;
    return context.slice(0, at) + HEAD + body + context.slice(at);
  }
  return HEAD + body + context;
}

/**
 * Ask the daemon for the rendered MEMORY.md of one project. Resolves '' on any
 * failure (socket missing, timeout, verb error) — callers keep the global copy.
 */
export function fetchProjectMemoryRender(projectId: string, projectName?: string): Promise<string> {
  const now = Date.now();
  const hit = _renderCache.get(projectId);
  if (hit && now - hit.at < RENDER_CACHE_MS) return Promise.resolve(hit.markdown);

  const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
  const request = JSON.stringify({
    cmd: 'memory_render',
    payload: { project_id: projectId, project_name: projectName ?? null },
  }) + '\n';

  return new Promise<string>((resolve) => {
    let settled = false;
    const done = (md: string) => {
      if (settled) return;
      settled = true;
      if (md) _renderCache.set(projectId, { markdown: md, at: Date.now() });
      resolve(md);
    };
    let client: net.Socket;
    try {
      client = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
        client.write(request);
        client.end();
      });
    } catch {
      done('');
      return;
    }
    client.setTimeout(RENDER_TIMEOUT_MS);
    let data = '';
    client.on('data', (c) => { data += c.toString(); });
    client.on('end', () => {
      try {
        const resp = JSON.parse(data.trim());
        const md = resp?.ok ? String(resp?.data?.markdown || '') : '';
        if (!md) console.error(`[memory-render] verb returned no markdown for ${projectId}: ${resp?.error || 'empty'}`);
        done(md);
      } catch {
        done('');
      }
    });
    client.on('error', (err) => {
      console.warn(`[memory-render] daemon socket error for ${projectId}: ${(err as NodeJS.ErrnoException).code || err.message}`);
      done('');
    });
    client.on('timeout', () => {
      console.warn(`[memory-render] timed out after ${RENDER_TIMEOUT_MS}ms for ${projectId}`);
      client.destroy();
      done('');
    });
  });
}

/**
 * The bootstrap for THIS turn: the global bootstrap with its `### MEMORY.md`
 * section swapped for the turn's project rendering when the turn belongs to a
 * real (non-Default) project. Otherwise the global bootstrap unchanged.
 */
export async function bootstrapForProject(
  globalBootstrap: string,
  projectId: string | undefined,
  projectName?: string,
): Promise<string> {
  if (!globalBootstrap || !projectId || projectId === 'proj_default') return globalBootstrap;
  const md = await fetchProjectMemoryRender(projectId, projectName);
  if (!md) return globalBootstrap;
  console.error(`[memory-render] bootstrap MEMORY.md swapped for project ${projectId} (${md.length} chars)`);
  return spliceMemorySection(globalBootstrap, md);
}

/** Test hook. */
export function _resetRenderCache(): void { _renderCache.clear(); }
