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
const _store = new AsyncLocalStorage();
/** Bind the project context to the current turn's async branch (concurrency-safe). */
export function enterProjectContext(ctx) {
    _store.enterWith(ctx);
}
/** Active project root for this turn, or undefined (→ caller falls back to install root). */
export function projectContextRoot() {
    const r = _store.getStore()?.root;
    return r && r.trim() ? r : undefined;
}
/** Active project's system-prompt directive for this turn, or '' (Default → no directive). */
export function projectContextDirective() {
    return _store.getStore()?.directive ?? '';
}
/** Active project id for this turn, or undefined (Default project / non-project caller). */
export function projectContextProjectId() {
    const p = _store.getStore()?.projectId;
    return p && p.trim() ? p : undefined;
}
/** Active project display name for this turn, or undefined. */
export function projectContextProjectName() {
    const n = _store.getStore()?.projectName;
    return n && n.trim() ? n : undefined;
}
/**
 * Who is driving this turn. Defaults to 'owner' when unset — every pre-existing
 * caller (web chat, scheduler, board, skills, Claude Code) keeps full capability
 * without being changed. Only a bridge that explicitly says 'guest' is demoted,
 * so a dropped field can never silently promote a guest.
 */
export function turnPrincipal() {
    return _store.getStore()?.principal === 'guest' ? 'guest' : 'owner';
}
/** True when this turn must not be able to cause tool calls, shell, or writes. */
export function turnIsGuest() {
    return turnPrincipal() === 'guest';
}
/** Vault scoping guest recall this turn ('*' = whole brain), or undefined. */
export function turnGuestVault() {
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
export function toolCallRefusal(server, tool) {
    const ctx = _store.getStore();
    const want = `${server}/${tool}`;
    // Dry run: refuse writes even when the tool IS declared. A skill legitimately
    // declaring `gmail/send` must still not send mail during its own preview.
    // Checked before the allowlist so a declared write is refused rather than
    // waved through.
    if (ctx?.readOnly && looksLikeWriteName(tool)) {
        return (`DRY RUN: ${want} looks like it modifies something, so it is refused during ` +
            `this preview. Produce your answer from reads only, and say what you WOULD ` +
            `have written. The skill will be able to call it on its real schedule.`);
    }
    const allow = ctx?.toolAllowlist;
    if (!allow || allow.length === 0)
        return null;
    if (allow.includes(want))
        return null;
    return (`Tool ${want} is not in this skill's declared required_tools. ` +
        `Declared: ${allow.join(', ')}. ` +
        `Call one of those instead — do not retry ${want}. ` +
        `If this skill genuinely needs ${want}, its required_tools must be updated first.`);
}
/** The tools this turn is bound to, or undefined when unrestricted. */
export function turnToolAllowlist() {
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
function looksLikeWriteName(tool) {
    const tokens = tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return WRITE_VERBS_LOCAL.some((v) => tokens.includes(v) || tokens.some((t) => t === `${v}s`));
}
