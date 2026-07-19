/**
 * project-context.ts — PLAN-GATEWAY-PROJECTS Phase 2.
 *
 * Per-turn project context carried through the async call tree via
 * AsyncLocalStorage. The gateway runs concurrent turns across different
 * projects in ONE process, so the active project's working-directory root and
 * system-prompt directive must NOT live in a process-global (that would bleed
 * across interleaved turns / awaits).
 *
 * chat() sets the context once at the top of a turn (enterProjectContext); it
 * then propagates to everything that turn awaits:
 *   - getSystemPrompt() reads the directive (llm.ts)
 *   - agentCwd() reads the root for the claude-cli spawn cwd (llm.ts)
 *   - unsandboxedBase() reads the root for fs-tool relative paths (fs-sandbox.ts)
 *
 * Shared module (not in llm.ts) precisely because fs-sandbox.ts must read it
 * without importing llm.ts (which would be a cycle).
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface ProjectContext {
  /** Active project's working directory (absolute), or undefined for Default/install root. */
  root?: string;
  /** Pre-built system-prompt directive (name + instructions), or '' for Default. */
  directive?: string;
  /**
   * PLAN-PROJECT-SCOPED-MEMORY — active project id for this turn, or undefined
   * for the Default project (proj_default is normalized to undefined at
   * chat() entry: Default conversations stay global, matching pre-project
   * behavior). Drives memory emit tagging + recall filtering.
   */
  projectId?: string;
  /**
   * PLAN-CONTEXT-GROUND-TRUTH — active project display name. Rides into the
   * daemon prompt hook (project-aware retrieval, Opt 1) and the ground-truth
   * facts block; undefined for Default.
   */
  projectName?: string;
}

const _store = new AsyncLocalStorage<ProjectContext>();

/** Bind the project context to the current turn's async branch (concurrency-safe). */
export function enterProjectContext(ctx: ProjectContext): void {
  _store.enterWith(ctx);
}

/** Active project root for this turn, or undefined (→ caller falls back to install root). */
export function projectContextRoot(): string | undefined {
  const r = _store.getStore()?.root;
  return r && r.trim() ? r : undefined;
}

/** Active project's system-prompt directive for this turn, or '' (Default → no directive). */
export function projectContextDirective(): string {
  return _store.getStore()?.directive ?? '';
}

/** Active project id for this turn, or undefined (Default project / non-project caller). */
export function projectContextProjectId(): string | undefined {
  const p = _store.getStore()?.projectId;
  return p && p.trim() ? p : undefined;
}

/** Active project display name for this turn, or undefined. */
export function projectContextProjectName(): string | undefined {
  const n = _store.getStore()?.projectName;
  return n && n.trim() ? n : undefined;
}
