/**
 * tool-call-recovery.ts — robustness for OpenAI-compatible providers (PLAN 0.6.4 #8 §1.5 / 6-PLAN §7).
 *
 * Pure, no IO. Two deterministic recoveries wired into chatWithOpenAICompat:
 *
 *  1. recoverToolCallsFromContent() — some providers emit a tool call as TEXT in
 *     `content` with finish_reason="stop" instead of a structured `tool_calls`
 *     array (DeepSeek does this ~11% of the time; self-hosted Qwen/vLLM with a
 *     missing/wrong tool-parser leaks raw `<tool_call>…</tool_call>` XML). We parse
 *     those back into real tool calls so the loop dispatches them.
 *
 *  2. repairToolArgs() — providers sometimes send malformed/stringified JSON
 *     arguments; we parse-with-repair and lightly coerce against the tool schema
 *     instead of silently dropping the args (the old `JSON.parse(...) catch {}`
 *     turned a bad payload into an empty-args call).
 *
 * SAFETY — this runs on the LIVE tool loop for every compat provider (managed
 * kimi-k2p6 included), NOT behind the FS flag. So recovery is engineered to be a
 * NO-OP on well-behaved responses:
 *   - only attempted when there are NO structured tool_calls,
 *   - the recovered call's name MUST be one we actually OFFERED this turn
 *     (`knownToolNames`) — this is the primary false-positive guard, so prose or a
 *     code sample that merely mentions a function name is never mistaken for a call,
 *   - skipped on truncated responses (finish_reason="length").
 */
const KNOWN_ARG_KEYS = ['arguments', 'parameters', 'args', 'input'];
const KNOWN_NAME_KEYS = ['name', 'tool', 'function', 'tool_name'];
/** Master gate (env kill-switch). Recovery is ON by default. */
export function toolCallRecoveryEnabled() {
    return process.env.VODOU_TOOLCALL_RECOVERY !== '0';
}
// P1-8: process-monotonic counter for recovered tool_call ids. Previously each
// call built ids as `recovered_${out.length}` (0,1,2… reset every invocation),
// so a conversation that recovered calls in the main loop AND again in the
// cap-hit final round (llm.ts) produced duplicate tool_call_ids — which breaks
// the provider's tool_use/tool_result pairing. A never-resetting counter makes
// every recovered id unique for the process lifetime.
let _recoveryCounter = 0;
/**
 * Try to recover serialized tool calls from assistant `content`. Returns [] (no-op)
 * unless the content clearly contains structured call(s) naming a KNOWN tool.
 */
export function recoverToolCallsFromContent(content, finishReason, knownToolNames) {
    if (!content || !knownToolNames.length)
        return [];
    // Truncated generation → not a complete/trustworthy call.
    if (finishReason === 'length')
        return [];
    const known = new Set(knownToolNames);
    const text = content.trim();
    if (!text)
        return [];
    const blobs = [];
    // (a) <tool_call>…</tool_call> / <function_call>…</function_call> (+ plural) tag leaks
    for (const m of text.matchAll(/<(?:tool_call|function_call|function_calls|tool▁call)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call|function_calls|tool▁call)>/gi)) {
        if (m[1])
            blobs.push(m[1].trim());
    }
    // (b) fenced ```json / ```tool_call code blocks
    if (!blobs.length) {
        for (const m of text.matchAll(/```(?:json|tool_call|tool)?\s*([\s\S]*?)```/gi)) {
            if (m[1] && /["']?(?:name|tool|function)["']?\s*:/.test(m[1]))
                blobs.push(m[1].trim());
        }
    }
    // (c) the whole content is a single JSON object that looks like a call
    if (!blobs.length && (text.startsWith('{') || text.startsWith('['))) {
        blobs.push(text);
    }
    if (!blobs.length)
        return [];
    const out = [];
    for (const blob of blobs) {
        for (const obj of parseJsonObjects(blob)) {
            const call = normalizeCallObject(obj, known);
            if (call)
                out.push({ id: `recovered_${_recoveryCounter++}`, type: 'function', function: call });
        }
    }
    return out;
}
/** Pull one or more JSON objects out of a blob (handles a top-level array of calls). */
function parseJsonObjects(blob) {
    const parsed = tryParseJson(blob);
    if (parsed === undefined)
        return [];
    if (Array.isArray(parsed))
        return parsed.filter((x) => x && typeof x === 'object');
    if (parsed && typeof parsed === 'object')
        return [parsed];
    return [];
}
/** Map a loose call object → {name, arguments:string} iff it names a KNOWN tool. */
function normalizeCallObject(obj, known) {
    if (!obj || typeof obj !== 'object')
        return null;
    // OpenAI-ish shape: { function: { name, arguments } }
    const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
    let name = fn?.name;
    if (typeof name !== 'string') {
        for (const k of KNOWN_NAME_KEYS) {
            if (typeof obj[k] === 'string') {
                name = obj[k];
                break;
            }
        }
    }
    if (typeof name !== 'string' || !known.has(name))
        return null; // ← the false-positive guard
    let args = fn?.arguments;
    if (args === undefined) {
        for (const k of KNOWN_ARG_KEYS) {
            if (obj[k] !== undefined) {
                args = obj[k];
                break;
            }
        }
    }
    let argStr;
    if (typeof args === 'string')
        argStr = args;
    else if (args && typeof args === 'object')
        argStr = JSON.stringify(args);
    else
        argStr = '{}';
    return { name, arguments: argStr };
}
/**
 * Parse + repair tool-call arguments to a clean object. Never throws — returns {}
 * on irrecoverable input (matching the old silent behavior, but after trying).
 * Light schema coercion: stringified arrays/objects → parsed; empty optionals dropped.
 */
export function repairToolArgs(raw, schema) {
    let obj;
    if (raw && typeof raw === 'object')
        obj = raw;
    else if (typeof raw === 'string') {
        obj = tryParseJson(raw);
        if (obj === undefined)
            obj = tryParseJson(repairJsonString(raw));
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        return {};
    const props = schema && typeof schema === 'object' ? schema.properties : undefined;
    const required = Array.isArray(schema?.required) ? schema.required : [];
    if (!props || typeof props !== 'object')
        return obj;
    for (const [key, val] of Object.entries(obj)) {
        const pType = props[key]?.type;
        // coerce a stringified array/object back to a real one
        if (typeof val === 'string' && (pType === 'array' || pType === 'object')) {
            const trimmed = val.trim();
            if ((pType === 'array' && trimmed.startsWith('[')) || (pType === 'object' && trimmed.startsWith('{'))) {
                const p = tryParseJson(trimmed);
                if (p !== undefined)
                    obj[key] = p;
            }
        }
        // drop empty OPTIONAL fields (null / "" / {} / []) so they read as omitted
        if (!required.includes(key) && isEmptyValue(obj[key]))
            delete obj[key];
    }
    return obj;
}
function isEmptyValue(v) {
    if (v === null || v === undefined || v === '')
        return true;
    if (Array.isArray(v) && v.length === 0)
        return true;
    if (v && typeof v === 'object' && Object.keys(v).length === 0)
        return true;
    return false;
}
function tryParseJson(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return undefined;
    }
}
/** Best-effort fixes for common LLM JSON glitches: strip md fences, trailing commas,
 *  and extract the first balanced {...} / [...] region. */
function repairJsonString(s) {
    let t = s.trim();
    // strip a leading ```json / ``` fence and trailing fence
    t = t.replace(/^```[a-zA-Z_]*\s*/, '').replace(/\s*```$/, '').trim();
    // extract first balanced object/array
    const startObj = t.indexOf('{');
    const startArr = t.indexOf('[');
    const start = startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startObj, startArr);
    if (start > 0)
        t = t.slice(start);
    const balanced = extractBalanced(t);
    if (balanced)
        t = balanced;
    // remove trailing commas before } or ]
    t = t.replace(/,\s*([}\]])/g, '$1');
    return t;
}
function extractBalanced(s) {
    const open = s[0];
    if (open !== '{' && open !== '[')
        return null;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (c === '\\')
                esc = true;
            else if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"')
            inStr = true;
        else if (c === open)
            depth++;
        else if (c === close) {
            depth--;
            if (depth === 0)
                return s.slice(0, i + 1);
        }
    }
    return null;
}
