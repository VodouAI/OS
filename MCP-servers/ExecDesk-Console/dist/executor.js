/**
 * Tool Executor for Vodou-Console - Simplified Direct vodou-core Integration
 *
 * Executes ANY vodou-core tool directly via CLI.
 * One generic tool instead of many specialized ones.
 *
 * Version: 0.5.33.6 - Direct vodou-core Integration
 */
import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import net from 'net';
import path from 'path';
import { getDb, getProjectRoot } from './db.js';
import { deriveToolUsageScope, emitToolUsageMemory, summarizeResult } from './api/memory-client.js';
const VC_PATH = () => process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');
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
                ? `There are ${serverCount} server row(s) registered — run **Capabilities → MCP Servers → Refresh status**, or \`./vodou-core all-tools\` / \`./vodou-core tools <server>\` once to populate the local tools table.`
                : 'Add a server from the gateway, then refresh status or run `./vodou-core connect …`.',
            '',
            'After the DB has tools, this list is instant (no remote MCP round-trips).',
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
 * Once we detect the worker socket is dead (zombie, ENOENT, ECONNREFUSED), we
 * remember that for a short window so subsequent calls skip straight to CLI
 * fallback without re-paying the first-byte timeout. Cleared on any successful
 * response (which implies a healthy worker is back).
 */
let _deadSocketUntil = 0;
const DEAD_SOCKET_COOLDOWN_MS = parseInt(process.env.VODOU_WORKER_SOCK_DEAD_COOLDOWN_MS || '10000', 10);
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
        const sock = net.createConnection(sockPath);
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
    try {
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
                break;
            default:
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
            }).catch((err) => console.error('[tool-usage-extractor] emit failed:', err));
        }
        return {
            success: true,
            output: result,
            executionTime: Date.now() - startTime
        };
    }
    catch (error) {
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
    // Large results: save to disk, return smart preview
    const resultDir = path.join(getProjectRoot(), '.vodou', 'tool-results');
    try {
        mkdirSync(resultDir, { recursive: true });
    }
    catch { }
    const filename = `${toolId || Date.now()}.txt`;
    const filepath = path.join(resultDir, filename);
    try {
        writeFileSync(filepath, cleaned);
    }
    catch { }
    const preview = generatePreview(cleaned, toolName);
    const sizeKB = (cleaned.length / 1024).toFixed(1);
    return `${preview}\n\n[Full output saved: .vodou/tool-results/${filename} (${sizeKB}KB) — read the file if you need the complete result]`;
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
export async function runVodouCore(server, tool, args) {
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
                execSync(`"${VC_PATH()}" reconnect ${server}`, {
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
 * Run a vodou-core command (like 'servers' or 'tools').
 * Explicit timeout + kill so child is always reaped.
 */
async function runVodouCoreCommand(command) {
    return new Promise((resolve, reject) => {
        console.error(`[Executor] vodou-core ${command}`);
        const proc = spawn(VC_PATH(), [command], {
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
    const checkFile = (filePath) => {
        return new Promise((resolve) => {
            const proc = spawn('test', ['-x', filePath]);
            proc.on('close', (code) => resolve(code === 0));
        });
    };
    const vcAvailable = await checkFile(VC_PATH());
    return {
        vcAvailable,
        vcPath: VC_PATH()
    };
}
