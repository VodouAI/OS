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
  /**
   * PLAN-MASTER-EXECUTION-ORDER item 2 (S-PRINCIPAL) — who is driving this turn.
   * 'guest' means the sender matched only a listened ROOM (e.g. a workspace
   * member posting in #ask-vodou), not the owner's sender allowlist. Guests may
   * ask; they get NO tools. Undefined/absent = owner, so every existing caller
   * (web chat, scheduler, board, skills) is unchanged.
   *
   * Lives in this store rather than a second AsyncLocalStorage on purpose: one
   * `enterWith` at turn entry means principal and project can never drift apart.
   * A separate store could be set in one place and forgotten in another, and the
   * failure mode there is a guest silently running with owner capability.
   */
  principal?: 'owner' | 'guest';
  /**
   * Vault scoping what a GUEST may know this turn — a vault name, or '*' for the
   * whole brain. Never consulted for owners.
   */
  guestVault?: string;
  /**
   * PLAN-ALPHA F3 — the ONLY MCP tools this turn may call, as `server/tool`.
   *
   * Set when a scheduled skill declares `required_tools`. Absent (the common
   * case: web chat, channels, skills that declare nothing) means unrestricted —
   * so every existing caller is unchanged and a skill cannot be punished for
   * not declaring.
   *
   * In THIS store rather than a second AsyncLocalStorage, for the reason given
   * on `principal` above: one `enterWith` at turn entry means these can never
   * drift apart. A separate store could be set in one place and forgotten in
   * another, and the failure mode there is a turn silently running with more
   * capability than it declared.
   *
   * This is the "reads broad, writes narrow" mitigation: a prompt injected into
   * a fetched page cannot reach a tool the skill's author never declared,
   * because the bound is set from the DB before the model sees any content.
   */
  toolAllowlist?: string[];
  /**
   * PLAN-ALPHA F5 — this turn is a DRY RUN: reads are fine, anything that looks
   * like a write is refused. Set when a newly created skill is test-fired before
   * its schedule is armed, so the author sees what it produces without it
   * sending mail, posting messages, or deleting anything on their behalf.
   */
  readOnly?: boolean;
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

/**
 * Who is driving this turn. Defaults to 'owner' when unset — every pre-existing
 * caller (web chat, scheduler, board, skills, Claude Code) keeps full capability
 * without being changed. Only a bridge that explicitly says 'guest' is demoted,
 * so a dropped field can never silently promote a guest.
 */
export function turnPrincipal(): 'owner' | 'guest' {
  return _store.getStore()?.principal === 'guest' ? 'guest' : 'owner';
}

/** True when this turn must not be able to cause tool calls, shell, or writes. */
export function turnIsGuest(): boolean {
  return turnPrincipal() === 'guest';
}

/** Vault scoping guest recall this turn ('*' = whole brain), or undefined. */
export function turnGuestVault(): string | undefined {
  const v = _store.getStore()?.guestVault;
  return v && v.trim() ? v : undefined;
}

/**
 * May this turn call `server/tool`?
 *
 * Returns an explanation when refused, `null` when allowed — the caller needs
 * the declared set in the refusal message, otherwise the model retries blindly
 * and burns the turn.
 *
 * Fails OPEN when no allowlist is bound, which is deliberate: the vast majority
 * of turns (web chat, channels, undeclared skills) have none, and defaulting to
 * "deny" would break every one of them. The bound is opt-in per turn.
 */
export function toolCallRefusal(server: string, tool: string): string | null {
  const ctx = _store.getStore();
  const want = `${server}/${tool}`;

  // Dry run: refuse writes even when the tool IS declared. A skill legitimately
  // declaring `gmail/send` must still not send mail during its own preview.
  // Checked before the allowlist so a declared write is refused rather than
  // waved through.
  if (ctx?.readOnly && looksLikeWriteName(tool)) {
    return (
      `DRY RUN: ${want} looks like it modifies something, so it is refused during ` +
      `this preview. Produce your answer from reads only, and say what you WOULD ` +
      `have written. The skill will be able to call it on its real schedule.`
    );
  }

  const allow = ctx?.toolAllowlist;
  if (!allow || allow.length === 0) return null;
  if (allow.includes(want)) return null;
  return (
    `Tool ${want} is not in this skill's declared required_tools. ` +
    `Declared: ${allow.join(', ')}. ` +
    `Call one of those instead — do not retry ${want}. ` +
    `If this skill genuinely needs ${want}, its required_tools must be updated first.`
  );
}

/** The tools this turn is bound to, or undefined when unrestricted. */
export function turnToolAllowlist(): string[] | undefined {
  const a = _store.getStore()?.toolAllowlist;
  return a && a.length ? a : undefined;
}

/**
 * Local copy of the write heuristic.
 *
 * Duplicated from required-tools.ts on purpose: fs-sandbox and executor import
 * this module, and importing required-tools.ts here would pull node:sqlite types
 * into a module that must stay dependency-free (the same reason this file lives
 * outside llm.ts). The list is short and the two are pinned together by a test.
 */
const WRITE_VERBS_LOCAL = [
  'send', 'create', 'update', 'delete', 'post', 'write', 'insert', 'remove',
  'archive', 'move', 'add', 'set', 'put', 'patch', 'upload', 'reply',
  'schedule', 'cancel', 'execute', 'run', 'exec', 'kill', 'store', 'save',
];

function looksLikeWriteName(tool: string): boolean {
  const tokens = tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return WRITE_VERBS_LOCAL.some((v) => tokens.includes(v) || tokens.some((t) => t === `${v}s`));
}
