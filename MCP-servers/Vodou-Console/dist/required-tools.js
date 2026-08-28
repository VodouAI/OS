/**
 * required-tools.ts — PLAN-ALPHA F3: make `skills_meta.required_tools` a contract.
 *
 * It was advisory metadata the UI displayed and nothing read at run time. A
 * scheduled skill could declare six tools, call none of them, and report `ok` —
 * which is how `daily-competitor-intel` produced 0 bytes on 2026-08-19 while the
 * old free-text log said `ok (skill_id=7, 0 chars)`.
 *
 * Two independent wins from the same declaration:
 *
 *   1. FAIL BEFORE SPENDING. A skill naming a tool that no longer resolves (a
 *      deregistered server, a renamed tool, a revoked integration) is a broken
 *      skill. Discovering that after a multi-minute LLM turn wastes the turn and
 *      buries the cause in prose. Resolve first, refuse to fire, say which tool.
 *
 *   2. BOUND THE TURN. Passing the resolved set as the turn's allowlist takes
 *      tool selection from 1-of-942 to 1-of-6 — and, because the bound is read
 *      from the DB before the model sees any content, an instruction injected
 *      into a fetched page cannot reach a tool the author never declared.
 *      ("Reads broad, writes narrow" — PLAN-WHAT-IS-THE-PRODUCT §6A.4b.)
 *
 * NOT declaring anything stays legal and unrestricted. Two of the four live
 * agents declare nothing, and a skill must never be punished for that — the
 * contract binds what it promises, it does not invent promises.
 */
/**
 * Parse `required_tools` leniently.
 *
 * Accepts a JSON array (how the UI writes it) or a comma/whitespace separated
 * string (how humans write it), because a skill refusing to run over a
 * formatting difference would be the contract working against its own purpose.
 * Anything unparseable is treated as "declared nothing" rather than an error:
 * a malformed field must not take a working agent offline.
 */
export function parseRequiredTools(raw) {
    if (raw === null || raw === undefined)
        return [];
    if (Array.isArray(raw))
        return raw.map((x) => String(x).trim()).filter(Boolean);
    const text = String(raw).trim();
    if (!text)
        return [];
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed))
                return parsed.map((x) => String(x).trim()).filter(Boolean);
        }
        catch { /* fall through to the separated form */ }
    }
    return text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
/**
 * Resolve each declared `server/tool` against the live registry.
 *
 * `mcp_servers.active = 1` matters as much as the tool existing: a server that
 * is registered but deactivated cannot answer, and letting the skill fire
 * against it would reproduce the exact failure this gate exists to prevent.
 *
 * An entry without a `/` cannot be resolved to a server and is reported missing
 * rather than silently skipped — a typo that disables the bound is worse than a
 * typo that stops the run, because the first is invisible.
 */
export function resolveRequiredTools(coreDb, raw) {
    const declared = parseRequiredTools(raw);
    if (declared.length === 0) {
        return { declared: [], missing: [], unrestricted: true };
    }
    const stmt = coreDb.prepare(`SELECT COUNT(*) AS n
       FROM tools t
       JOIN mcp_servers s ON s.id = t.server_id
      WHERE s.name = ? AND t.name = ? AND s.active = 1`);
    const missing = [];
    for (const entry of declared) {
        const slash = entry.indexOf('/');
        if (slash <= 0 || slash === entry.length - 1) {
            missing.push(entry);
            continue;
        }
        const server = entry.slice(0, slash);
        const tool = entry.slice(slash + 1);
        let n = 0;
        try {
            const row = stmt.get(server, tool);
            n = Number(row?.n ?? 0);
        }
        catch {
            // A registry read failure is not evidence the tool is missing. Treating it
            // as missing would take every declaring skill offline the moment the DB
            // hiccups, so an unreadable registry leaves the entry resolved.
            n = 1;
        }
        if (n < 1)
            missing.push(entry);
    }
    return { declared, missing, unrestricted: false };
}
/**
 * Which declared tools did the turn actually call?
 *
 * `toolCalls` arrive in assorted shapes across providers, so accept a
 * `server/tool` string or an object carrying server+tool.
 */
export function summariseToolUsage(declared, toolCalls) {
    const called = [];
    for (const c of toolCalls ?? []) {
        let label = '';
        if (typeof c === 'string')
            label = c;
        else if (c && typeof c === 'object') {
            const o = c;
            const server = o.server ?? o.serverName;
            const tool = o.tool ?? o.toolName ?? o.name;
            if (server && tool)
                label = `${String(server)}/${String(tool)}`;
            else if (tool)
                label = String(tool);
        }
        label = label.trim();
        if (label && !called.includes(label))
            called.push(label);
    }
    const declaredSet = new Set(declared);
    return {
        called,
        declaredCalled: called.filter((c) => declaredSet.has(c)),
        undeclaredCalled: called.filter((c) => !declaredSet.has(c)),
    };
}
/**
 * Does this tool name suggest it CHANGES something?
 *
 * Used only to make a dry run read-only. Deliberately a name heuristic and
 * deliberately over-eager: the cost of wrongly refusing a read during a dry run
 * is a slightly thinner preview, while the cost of wrongly allowing a write is
 * a real email sent, a real row deleted, or a real message posted by a skill the
 * author has not approved yet. Those are not comparable, so this errs toward
 * refusing.
 *
 * It is NOT a security boundary — a determined tool named `fetch_and_email`
 * slips through. The security boundary is the F3 allowlist, which is a closed
 * set read from the DB. This is a second, narrower filter applied on top of it
 * during dry runs only.
 */
const WRITE_VERBS = [
    'send', 'create', 'update', 'delete', 'post', 'write', 'insert', 'remove',
    'archive', 'move', 'add', 'set', 'put', 'patch', 'upload', 'reply',
    'schedule', 'cancel', 'execute', 'run', 'exec', 'kill', 'store', 'save',
];
export function looksLikeWrite(tool) {
    const name = tool.toLowerCase();
    // Match on token boundaries so `update_event` and `event.update` both hit
    // while `posting_frequency` and `created_at` (nouns) do not.
    const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
    return WRITE_VERBS.some((v) => tokens.includes(v) || tokens.some((t) => t === `${v}s`));
}
