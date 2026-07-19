/**
 * permissions.ts — category-based, fail-closed permission engine (PLAN 0.6.4 #8 Bet #2).
 *
 * Separates "WHAT may be touched" from "WHEN to ask". A small set of sensitive action
 * CATEGORIES each carry a mode — `auto` (run), `ask` (require approval), or `deny`
 * (reject) — resolvable per-scope, with named PROFILES as a one-word autonomy dial.
 *
 * Phase 1 (this file): the engine + `auto`/`deny` enforcement at the executeOITool sink.
 * DEFAULT is all-`auto` (profile "full") → ZERO behavior change until an operator opts
 * into a stricter profile / override. Resolution is **fail-closed**: an explicitly-set
 * but invalid value resolves to `deny`, never silently to `auto`.
 *
 * `ask` requires the OUT-OF-BAND approval flow (provider-loop interception + a pending
 * tool result + a resume turn — see 6-PLAN §6; the board `pending_approval` machinery
 * does NOT fit a synchronous chat sink). That flow is Phase 2; until it lands, `ask`
 * resolves to `deny` here (fail-closed) so a configured `ask` is never silently auto-run.
 *
 * Pure + dependency-injected: the settings reader is a param (default: gateway_settings
 * via getSetting), so tests never touch the live gateway DB.
 */
import { getSetting } from './db.js';
/**
 * Named profiles = a one-word autonomy dial per scope. A profile only sets the
 * categories it names; unnamed categories fall through to the default (`auto`).
 * "full" / "danger-full-access" = everything auto (the default — no behavior change).
 */
const PROFILES = {
    full: {},
    'danger-full-access': {},
    // The workspace stays writable; everything outward-facing / executing asks.
    workspace: {
        bash: 'ask',
        messaging_send: 'ask',
        calendar_write: 'ask',
        schedule_create: 'ask',
        mcp_mutation: 'ask',
    },
    // Look, don't touch.
    'read-only': {
        file_write: 'deny',
        bash: 'deny',
        mcp_mutation: 'deny',
        messaging_send: 'deny',
        calendar_write: 'deny',
        schedule_create: 'deny',
    },
};
/**
 * Gateway-tool → category. Only tools that are unambiguously classifiable at this layer
 * are mapped; reads (read_file/list_dir/list_available_tools/board_show) and worker-state
 * tools (board_complete/block/heartbeat) are UNGATED (null). `vodou_core_call` is left
 * ungated in Phase 1 — most calls are reads, and mutation-classification needs per-call
 * semantics (a Phase-2 refinement of the mcp_mutation category).
 */
const TOOL_CATEGORY = {
    write_file: 'file_write',
    edit_file: 'file_write',
    multi_edit: 'file_write',
    bash: 'bash',
};
/** Verbs that read state — never gated (a "read-only" profile must still read). */
const READ_VERB = /(^|_)(get|list|search|read|fetch|status|show|find|query|view|describe|count|check|health|inspect|resolve|preview|export|download|history|recent)(_|$)/;
/** Verbs that mutate state. */
const WRITE_VERB = /(^|_)(send|broadcast|reply|post|create|update|delete|remove|insert|patch|put|write|add|move|archive|upload|set|modify|edit|enable|disable|cancel|schedule|invite|assign|complete|approve|reject|publish|share|revoke|rotate)(_|$)/;
const MESSAGING_SERVER = /(channel|slack|telegram|discord|whatsapp|signal|imessage|teams|googlechat|gmail|mail|messag)/;
const MESSAGING_SEND = /(send|broadcast|reply|post|message|email)/;
/**
 * Classify a `vodou_core_call` by its server/tool args (P1-3). The category
 * engine was previously dead for everything routed through vodou_core_call —
 * messaging_send/calendar_write/schedule_create/mcp_mutation were defined but
 * NO tool ever resolved to them, so a "read-only" or "workspace" profile
 * silently still let the model send messages and mutate calendars. Heuristic,
 * conservative on the read side: unknown/read verbs stay ungated (null) so a
 * strict profile never blocks harmless reads. Only bites when an operator
 * selects a non-default profile (default "full" = all auto = no change).
 */
function classifyCoreCall(server, tool) {
    const s = String(server ?? '').toLowerCase();
    const t = String(tool ?? '').toLowerCase();
    if (!t)
        return null;
    if (READ_VERB.test(t) && !WRITE_VERB.test(t))
        return null;
    if (MESSAGING_SERVER.test(s + t) && MESSAGING_SEND.test(t) && WRITE_VERB.test(t))
        return 'messaging_send';
    if (/calendar/.test(s + t) && WRITE_VERB.test(t))
        return 'calendar_write';
    if (/(schedul|automat|cron|routine|reminder)/.test(s + t) && WRITE_VERB.test(t))
        return 'schedule_create';
    if (WRITE_VERB.test(t))
        return 'mcp_mutation';
    return null;
}
/**
 * Category for a tool. For `vodou_core_call`, pass its input `{server, tool}` so
 * the call can be classified by target (P1-3) — without it, vodou_core_call is
 * ungated (Phase-1 behavior, preserved for callers that don't have the args).
 */
export function toolCategory(toolName, input) {
    if (toolName === 'vodou_core_call') {
        return input ? classifyCoreCall(input.server, input.tool) : null;
    }
    return TOOL_CATEGORY[toolName] ?? null;
}
function normalizeMode(v) {
    return v === 'auto' || v === 'ask' || v === 'deny' ? v : null;
}
function activeProfile(read) {
    const name = (read('perm_profile') || 'full').trim();
    return PROFILES[name] ?? PROFILES.full;
}
/**
 * Resolve a category's mode. Precedence (most specific first):
 *   per-scope override `perm.<scope.raw>.<category>` → global override `perm_<category>`
 *   → active profile → default `auto`. An explicitly-set INVALID value → `deny` (fail-closed).
 */
export function resolvePermissionMode(category, scope, read = getSetting) {
    if (scope?.raw) {
        const s = read(`perm.${scope.raw}.${category}`);
        if (s != null)
            return normalizeMode(s) ?? 'deny';
    }
    const g = read(`perm_${category}`);
    if (g != null)
        return normalizeMode(g) ?? 'deny';
    const p = activeProfile(read)[category];
    return p ?? 'auto';
}
/**
 * Decide whether a tool may execute under the current policy. Ungated tools are always
 * allowed. Phase 1: auto → allow, deny → block, ask → block (fail-closed; approval flow
 * is Phase 2).
 */
export function checkToolPermission(toolName, scope, read = getSetting, input) {
    const category = toolCategory(toolName, input);
    if (!category)
        return { allowed: true, mode: 'auto', category: null };
    const mode = resolvePermissionMode(category, scope, read);
    if (mode === 'auto')
        return { allowed: true, mode, category };
    if (mode === 'deny') {
        return { allowed: false, mode, category, reason: `'${toolName}' is denied by the '${category}' permission policy.` };
    }
    // 'ask' — out-of-band approval is not implemented yet (Phase 2); fail closed.
    return {
        allowed: false,
        mode,
        category,
        reason: `'${toolName}' requires approval ('${category}' = ask). The executor parks it for out-of-band approval when a chat channel is present; in contexts without one it is refused.`,
    };
}
/** Profile names known to the engine (for settings UI / validation). */
export function knownProfiles() {
    return Object.keys(PROFILES);
}
