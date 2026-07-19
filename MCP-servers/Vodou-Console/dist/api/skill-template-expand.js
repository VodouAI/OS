// PLAN-SKILL-CONSOLE-LOOP §20.1 + §20.2 — template expansion for skill consoles.
// {{param:name}}, {{invoke_skill:child|k=v}}, {{invoke_tool:server::tool|args}}, {{invoke_script:reg_server::script_name|params}},
// {{invoke_recall:q|k=N|scope=conversation|scope=all}} — script/tool/recall are pre-LLM; recall scope defaults to conversation
const MAX_INVOKE_DEPTH = 5;
/** Schema default → saved overrides → one-shot /run overrides. */
export function mergeSkillParams(parametersJson, paramOverridesJson, runOverrides) {
    const base = {};
    if (parametersJson?.trim()) {
        try {
            const j = JSON.parse(parametersJson);
            if (Array.isArray(j)) {
                for (const item of j) {
                    if (item && typeof item === 'object' && 'name' in item) {
                        const n = String(item.name).toLowerCase();
                        const d = item.default;
                        base[n] = d != null ? String(d) : '';
                    }
                }
            }
            else if (j && typeof j === 'object' && !Array.isArray(j)) {
                for (const [k, v] of Object.entries(j)) {
                    const key = k.toLowerCase();
                    if (typeof v === 'string')
                        base[key] = v;
                    else if (v && typeof v === 'object' && v !== null && 'default' in v) {
                        base[key] = String(v.default ?? '');
                    }
                }
            }
        }
        catch {
            /* ignore invalid JSON */
        }
    }
    let over = {};
    if (paramOverridesJson?.trim()) {
        try {
            const o = JSON.parse(paramOverridesJson);
            if (o && typeof o === 'object') {
                for (const [k, v] of Object.entries(o))
                    over[k.toLowerCase()] = String(v);
            }
        }
        catch {
            /* */
        }
    }
    const run = {};
    for (const [k, v] of Object.entries(runOverrides))
        run[k.toLowerCase()] = v;
    return { ...base, ...over, ...run };
}
/** `topic=foo|user_message=bar` from {{invoke_skill:x|...}} */
export function parseInvokePipeArgs(pipe) {
    if (!pipe?.trim())
        return {};
    const out = {};
    for (const part of pipe.split('|')) {
        const idx = part.indexOf('=');
        if (idx <= 0)
            continue;
        const key = part.slice(0, idx).trim().toLowerCase();
        let val = part.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (/^[a-z0-9_]+$/.test(key))
            out[key] = val;
    }
    return out;
}
/**
 * `/run topic=foo "hello"` → overrides + remainder as user_message for the skill.
 */
export function parseRunCommand(message) {
    const t = message.trim();
    if (!/^\/run\b/i.test(t))
        return null;
    let s = t.replace(/^\/run\b/i, '').trimStart();
    const overrides = {};
    const pairRe = /^([a-z0-9_]+)=(?:["']([^"']*)["']|(\S+))(?:\s+|$)/i;
    while (s.length > 0) {
        const m = s.match(pairRe);
        if (!m)
            break;
        const key = m[1].toLowerCase();
        const val = (m[2] ?? m[3] ?? '').trim();
        overrides[key] = val;
        s = s.slice(m[0].length);
    }
    return { overrides, rest: s.trim() };
}
const INVOKE_RE = /\{\{\s*invoke_skill:([a-z0-9-]+)(?:\|([^}]*?))?\s*\}\}/;
const INVOKE_RECALL_RE = /\{\{\s*invoke_recall:([\s\S]*?)\s*\}\}/i;
/** First `}}` at or after `start`, respecting quotes (for non-JSON pipe segments). */
export function scanToTemplateClose(s, start) {
    let i = start;
    let inStr = null;
    while (i < s.length - 1) {
        const c = s[i];
        if (inStr) {
            if (c === '\\') {
                i += 2;
                continue;
            }
            if (c === inStr)
                inStr = null;
            i++;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = c;
            i++;
            continue;
        }
        if (c === '}' && s[i + 1] === '}')
            return i;
        i++;
    }
    return -1;
}
/** Balanced `{...}` starting at `start` (must be `{`); returns exclusive end index. */
export function extractBalancedJsonSegment(s, start) {
    if (start >= s.length || s[start] !== '{')
        return null;
    let depth = 0;
    let inStr = null;
    const j0 = start;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (c === '\\') {
                i++;
                if (i >= s.length)
                    break;
                continue;
            }
            if (c === inStr)
                inStr = null;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = c;
            continue;
        }
        if (c === '{')
            depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0)
                return { end: i + 1, json: s.slice(j0, i + 1) };
        }
    }
    return null;
}
/**
 * Locates the first `{{invoke_tool:server::tool|…}}` with correct closing.
 * JSON pipe args may contain nested `}`; non-JSON pipes end at the first quoted-safe `}}`.
 */
export function parseFirstInvokeToolTag(text, searchFrom = 0) {
    const needle = /\{\{\s*invoke_tool:/gi;
    needle.lastIndex = searchFrom;
    const open = needle.exec(text);
    if (!open)
        return null;
    const tagStart = open.index;
    let pos = open.index + open[0].length;
    const rest = text.slice(pos);
    const srvM = /^([a-z0-9_-]+)::/i.exec(rest);
    if (!srvM)
        return null;
    const server = srvM[1];
    pos += srvM[0].length;
    const rest2 = text.slice(pos);
    const toolM = /^([a-z0-9_-]+)/i.exec(rest2);
    if (!toolM)
        return null;
    const tool = toolM[1];
    pos += toolM[0].length;
    while (pos < text.length && /\s/.test(text[pos]))
        pos++;
    if (pos + 1 < text.length && text[pos] === '}' && text[pos + 1] === '}') {
        return { index: tagStart, full: text.slice(tagStart, pos + 2), server, tool };
    }
    if (pos >= text.length || text[pos] !== '|')
        return null;
    pos++;
    while (pos < text.length && /\s/.test(text[pos]))
        pos++;
    if (pos + 1 < text.length && text[pos] === '}' && text[pos + 1] === '}') {
        return { index: tagStart, full: text.slice(tagStart, pos + 2), server, tool, pipe: '' };
    }
    const argsStart = pos;
    if (pos < text.length && text[pos] === '{') {
        const bal = extractBalancedJsonSegment(text, pos);
        if (bal) {
            pos = bal.end;
            while (pos < text.length && /\s/.test(text[pos]))
                pos++;
            if (pos + 1 >= text.length || text[pos] !== '}' || text[pos + 1] !== '}')
                return null;
            return {
                index: tagStart,
                full: text.slice(tagStart, pos + 2),
                server,
                tool,
                pipe: bal.json,
            };
        }
    }
    const closeIdx = scanToTemplateClose(text, argsStart);
    if (closeIdx < 0)
        return null;
    const pipe = text.slice(argsStart, closeIdx).trim();
    return {
        index: tagStart,
        full: text.slice(tagStart, closeIdx + 2),
        server,
        tool,
        pipe,
    };
}
/**
 * `{{invoke_script:server_name::script_name|…}}` — runs `Vodou-script-executor::execute_script`
 * with optional JSON or key=value params (same pipe rules as invoke_tool).
 */
export function parseFirstInvokeScriptTag(text, searchFrom = 0) {
    const needle = /\{\{\s*invoke_script:/gi;
    needle.lastIndex = searchFrom;
    const open = needle.exec(text);
    if (!open)
        return null;
    const tagStart = open.index;
    let pos = open.index + open[0].length;
    const rest = text.slice(pos);
    const srvM = /^([a-z0-9_-]+)::/i.exec(rest);
    if (!srvM)
        return null;
    const server = srvM[1];
    pos += srvM[0].length;
    const rest2 = text.slice(pos);
    const scriptM = /^([a-z0-9_-]+)/i.exec(rest2);
    if (!scriptM)
        return null;
    const script = scriptM[1];
    pos += scriptM[0].length;
    while (pos < text.length && /\s/.test(text[pos]))
        pos++;
    if (pos + 1 < text.length && text[pos] === '}' && text[pos + 1] === '}') {
        return { index: tagStart, full: text.slice(tagStart, pos + 2), server, script };
    }
    if (pos >= text.length || text[pos] !== '|')
        return null;
    pos++;
    while (pos < text.length && /\s/.test(text[pos]))
        pos++;
    if (pos + 1 < text.length && text[pos] === '}' && text[pos + 1] === '}') {
        return { index: tagStart, full: text.slice(tagStart, pos + 2), server, script, pipe: '' };
    }
    const argsStart = pos;
    if (pos < text.length && text[pos] === '{') {
        const bal = extractBalancedJsonSegment(text, pos);
        if (bal) {
            pos = bal.end;
            while (pos < text.length && /\s/.test(text[pos]))
                pos++;
            if (pos + 1 >= text.length || text[pos] !== '}' || text[pos + 1] !== '}')
                return null;
            return {
                index: tagStart,
                full: text.slice(tagStart, pos + 2),
                server,
                script,
                pipe: bal.json,
            };
        }
    }
    const closeIdx = scanToTemplateClose(text, argsStart);
    if (closeIdx < 0)
        return null;
    const pipe = text.slice(argsStart, closeIdx).trim();
    return {
        index: tagStart,
        full: text.slice(tagStart, closeIdx + 2),
        server,
        script,
        pipe,
    };
}
const SCRIPT_EXECUTOR_MCP = 'Vodou-script-executor';
const MAX_TOOL_TAGS = 8;
const MAX_RECALL_TAGS = 8;
const MAX_SCRIPT_TAGS = 8;
const MAX_INJECT_CHARS = 24000;
/** Split `a=1,b="x,y"` on commas not inside quotes. */
export function splitCommaRespectQuotes(s) {
    const out = [];
    let cur = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            cur += c;
            if (c === q && s[i - 1] !== '\\')
                q = null;
            continue;
        }
        if (c === '"' || c === "'") {
            q = c;
            cur += c;
            continue;
        }
        if (c === ',') {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    if (cur.trim())
        out.push(cur.trim());
    return out;
}
/**
 * Pipe after invoke_tool — JSON object, or comma-separated key=value (values may be quoted).
 */
export function parseToolPipeArgs(pipe) {
    if (!pipe?.trim())
        return {};
    const p = pipe.trim();
    if (p.startsWith('{')) {
        try {
            const j = JSON.parse(p);
            return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
        }
        catch {
            return {};
        }
    }
    const out = {};
    for (const part of splitCommaRespectQuotes(p)) {
        const idx = part.indexOf('=');
        if (idx <= 0)
            continue;
        const key = part.slice(0, idx).trim();
        let val = part.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!/^[a-zA-Z0-9_]+$/.test(key))
            continue;
        if (/^-?\d+$/.test(val))
            out[key] = parseInt(val, 10);
        else if (val === 'true')
            out[key] = true;
        else if (val === 'false')
            out[key] = false;
        else
            out[key] = val;
    }
    return out;
}
export function parseRecallTagBody(inner) {
    let q = inner.trim();
    let k = 5;
    let scope = 'conversation';
    for (let p = 0; p < 8; p++) {
        const km = /\|\s*k\s*=\s*(\d+)\s*$/i.exec(q);
        const sm = /\|\s*scope\s*=\s*(all|conversation)\s*$/i.exec(q);
        if (km && km.index !== undefined) {
            k = Math.min(20, Math.max(1, parseInt(km[1], 10)));
            q = q.slice(0, km.index).trim();
            continue;
        }
        if (sm && sm.index !== undefined) {
            scope = sm[1].toLowerCase() === 'all' ? 'all' : 'conversation';
            q = q.slice(0, sm.index).trim();
            continue;
        }
        break;
    }
    return { query: q, k, scope };
}
function stringifyInject(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    try {
        const s = JSON.stringify(v, null, 2);
        return s.length > MAX_INJECT_CHARS ? s.slice(0, MAX_INJECT_CHARS) + '\n…' : s;
    }
    catch {
        return String(v).slice(0, MAX_INJECT_CHARS);
    }
}
function formatRecallItems(resp) {
    if (!resp.items?.length)
        return '(no matching memories)';
    const lines = [];
    for (let i = 0; i < resp.items.length; i++) {
        const it = resp.items[i];
        const prov = it.provenance_scope || it.source || '';
        const body = (it.content || '').trim();
        lines.push(`[${i + 1}]${prov ? ' ' + prov : ''}\n${body}`);
    }
    const s = lines.join('\n\n');
    return s.length > MAX_INJECT_CHARS ? s.slice(0, MAX_INJECT_CHARS) + '\n…' : s;
}
function findNextToolRecallOrScript(text) {
    INVOKE_RECALL_RE.lastIndex = 0;
    const tm = parseFirstInvokeToolTag(text, 0);
    const sm = parseFirstInvokeScriptTag(text, 0);
    const rm = INVOKE_RECALL_RE.exec(text);
    const cands = [];
    if (tm) {
        cands.push({
            idx: tm.index,
            m: {
                kind: 'tool',
                index: tm.index,
                full: tm.full,
                server: tm.server,
                tool: tm.tool,
                pipe: tm.pipe,
            },
        });
    }
    if (sm) {
        cands.push({
            idx: sm.index,
            m: {
                kind: 'script',
                index: sm.index,
                full: sm.full,
                server: sm.server,
                script: sm.script,
                pipe: sm.pipe,
            },
        });
    }
    if (rm) {
        cands.push({
            idx: rm.index,
            m: { kind: 'recall', index: rm.index, full: rm[0], inner: rm[1] },
        });
    }
    if (cands.length === 0)
        return null;
    cands.sort((a, b) => a.idx - b.idx);
    return cands[0].m;
}
/**
 * Replace {{invoke_tool:…}}, {{invoke_script:…}}, and {{invoke_recall:…}} after sync invoke_skill expansion.
 * Invokes vodou-core via callbacks (typically VodouCore.callTool / memoryRecall).
 */
export async function expandInvokeToolAndRecall(text, ctx, io) {
    let t = text;
    let nTool = 0;
    let nScript = 0;
    let nRecall = 0;
    while (true) {
        const next = findNextToolRecallOrScript(t);
        if (!next)
            break;
        let replacement;
        if (next.kind === 'tool') {
            if (nTool >= MAX_TOOL_TAGS) {
                replacement = '[invoke_tool error: too many invocations in one template]';
            }
            else {
                nTool++;
                try {
                    const args = parseToolPipeArgs(next.pipe);
                    const raw = await io.callTool(next.server, next.tool, args);
                    replacement = stringifyInject(raw);
                }
                catch (e) {
                    replacement = `[invoke_tool error: ${e.message}]`;
                }
            }
        }
        else if (next.kind === 'script') {
            if (nScript >= MAX_SCRIPT_TAGS) {
                replacement = '[invoke_script error: too many invocations in one template]';
            }
            else {
                nScript++;
                try {
                    const params = parseToolPipeArgs(next.pipe);
                    const raw = await io.callTool(SCRIPT_EXECUTOR_MCP, 'execute_script', {
                        server_name: next.server,
                        script_name: next.script,
                        params,
                    });
                    replacement = stringifyInject(raw);
                }
                catch (e) {
                    replacement = `[invoke_script error: ${e.message}]`;
                }
            }
        }
        else {
            if (nRecall >= MAX_RECALL_TAGS) {
                replacement = '[invoke_recall error: too many invocations in one template]';
            }
            else {
                nRecall++;
                const { query, k, scope } = parseRecallTagBody(next.inner);
                if (!query) {
                    replacement = '[invoke_recall error: empty query]';
                }
                else {
                    try {
                        const scope_filter = scope === 'conversation'
                            ? { conversation_id: ctx.conversationId }
                            : 'all';
                        const resp = await io.recall({
                            principal_id: ctx.principalId,
                            query,
                            k,
                            scope_filter,
                            provenance: true,
                        });
                        replacement = formatRecallItems(resp);
                    }
                    catch (e) {
                        replacement = `[invoke_recall error: ${e.message}]`;
                    }
                }
            }
        }
        t = t.slice(0, next.index) + replacement + t.slice(next.index + next.full.length);
    }
    return t;
}
export function expandSkillPrompt(db, opts) {
    const maxDepth = opts.maxDepth ?? MAX_INVOKE_DEPTH;
    const ctx = {
        conversationId: opts.conversationId,
        userMessage: opts.userMessage,
        history: opts.history,
        principalId: opts.principalId,
        parametersJson: opts.parametersJson,
        paramOverridesJson: opts.paramOverridesJson,
        runParamOverrides: opts.runParamOverrides,
    };
    return expandPromptRecursive(db, opts.template, 0, [opts.skillId], ctx, maxDepth);
}
function expandPromptRecursive(db, template, depth, chainIds, ctx, maxDepth) {
    if (depth > maxDepth) {
        return template.replace(/\{\{\s*invoke_skill:[^}]+\}\}/g, '[invoke error: max depth]');
    }
    let t = template
        .replace(/\{\{\s*user_message\s*\}\}/g, ctx.userMessage)
        .replace(/\{\{\s*now\s*\}\}/g, new Date().toISOString())
        .replace(/\{\{\s*conversation_id\s*\}\}/g, ctx.conversationId)
        .replace(/\{\{\s*history\s*\}\}/g, ctx.history);
    const merged = mergeSkillParams(ctx.parametersJson, ctx.paramOverridesJson, ctx.runParamOverrides);
    t = t.replace(/\{\{\s*param:([a-z0-9_]+)\s*\}\}/gi, (_, name) => {
        const key = name.toLowerCase();
        return merged[key] !== undefined && merged[key] !== ''
            ? merged[key]
            : `[missing param: ${key}]`;
    });
    while (true) {
        const match = t.match(INVOKE_RE);
        if (!match)
            break;
        const full = match[0];
        const childName = match[1];
        const pipe = match[2];
        const childRow = db
            .prepare(`
      SELECT id, name, prompt_template, parameters_json, param_overrides_json, is_active, principal_id
      FROM skills_meta WHERE name = ? AND principal_id = ? LIMIT 1
    `)
            .get(childName, ctx.principalId);
        let replacement;
        if (!childRow) {
            replacement = `[invoke error: no skill \`${childName}\`]`;
        }
        else if (childRow.principal_id !== ctx.principalId) {
            replacement = `[invoke error: principal mismatch]`;
        }
        else if (!childRow.is_active) {
            replacement = `[invoke error: skill \`${childName}\` is disabled]`;
        }
        else if (chainIds.includes(childRow.id)) {
            replacement = `[invoke error: circular reference (\`${childName}\`)]`;
        }
        else {
            const pipeArgs = parseInvokePipeArgs(pipe);
            const nestedUser = pipeArgs.user_message ?? ctx.userMessage;
            const useParentHistory = pipeArgs.history === '1' || pipeArgs.history === 'true' || pipeArgs.history === 'yes';
            const nestedHistory = useParentHistory ? ctx.history : '';
            const pipeRun = { ...pipeArgs };
            delete pipeRun.user_message;
            delete pipeRun.history;
            const nestedCtx = {
                conversationId: ctx.conversationId,
                userMessage: nestedUser,
                history: nestedHistory,
                principalId: ctx.principalId,
                parametersJson: childRow.parameters_json,
                paramOverridesJson: childRow.param_overrides_json,
                runParamOverrides: pipeRun,
            };
            replacement = expandPromptRecursive(db, childRow.prompt_template, depth + 1, [...chainIds, childRow.id], nestedCtx, maxDepth);
        }
        t = t.replace(full, replacement);
    }
    return t;
}
