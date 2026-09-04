/**
 * ExecDesk — multi-agent orchestrator endpoint.
 *
 * Plan: PLANS/0.5.38/PLAN-SMB-EXEC-CONSOLE.md §0.11.1 (locked scope contract).
 *
 *   POST /api/exec/team-consult
 *
 * v1 scope (locked, do NOT expand without revising §0.11.1):
 *   ✅ Fan-out: route a single user prompt to N exec skills in parallel (N ≤ 4)
 *   ✅ Stitch: concatenate exec responses with role-attribution headers
 *   ✅ Optional CEO synthesis (final 2-paragraph summary)
 *   ✅ Per-tenant rate limit — 10/hr Starter (mitigation #3 of §0.10.8)
 *   ✅ Audit log row per call (file-based until Phase 4 DB migration lands)
 *
 * v1 explicitly does NOT do (deferred):
 *   ❌ Inter-exec dialogue
 *   ❌ Streaming partial responses (await-all-then-render)
 *   ❌ Confidence scoring / disagreement detection
 *   ❌ Persistence as multi-turn thread
 *   ❌ Tool calls during orchestration (execs may call tools INSIDE their skill;
 *      the orchestrator does NOT chain skills across execs)
 *
 * Hard ship: Phase 2 day 10 per §0.11.1 budget. If unfinished, cut from v1, do not extend.
 */
import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '../db.js';
import { rawLLMCallStrict, isConfigured, getAuthType, getMemoryContext, chatWithSkill } from '../llm.js';
const router = Router();
// ─── Tier configuration (will federate from license server in Phase 4) ─────
const TIER_LIMITS = {
    starter: { perHour: 10, maxExecs: 2 },
    growth: { perHour: 30, maxExecs: 4 },
    scale: { perHour: 120, maxExecs: 7 },
};
const DEFAULT_TIER = 'starter';
const rateWindows = new Map();
function checkRateLimit(tenantId, tier) {
    const limit = (TIER_LIMITS[tier] || TIER_LIMITS[DEFAULT_TIER]).perHour;
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    let entry = rateWindows.get(tenantId);
    if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + HOUR };
        rateWindows.set(tenantId, entry);
    }
    if (entry.count >= limit) {
        return { ok: false, remaining: 0, resetAt: entry.resetAt };
    }
    entry.count++;
    return { ok: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}
// ─── Per-exec memory persistence ───────────────────────────────────────────
// Writes the user prompt + each exec's response to `.prompt_buffer` with the
// per-exec scope (`workbench:skill:execdesk-<role>`). The Rust daemon's chunker
// reads scope-tagged buffer lines and prefixes extracted bullets with
// `scope:<raw> |` (memory_flush.rs §append_to_prompt_buffer_with_scope) so
// future BrainLoader retrievals on the same scope return prior turns.
//
// After writing, fires `vodou-hook-bin sock flush` to trigger immediate
// extraction. Fire-and-forget — never blocks the response to the user.
async function persistTurnToExecMemory(execId, prompt, response) {
    if (!response || response.length < 20)
        return; // skip empty/error responses
    const root = getProjectRoot();
    const bufPath = path.join(root, '.vodou', 'workspace', '.prompt_buffer');
    const scope = `workbench:skill:${execId}`;
    const entries = [
        { role: 'user', content: `[team-consult] ${prompt}`, scope },
        { role: 'assistant', content: `[team-consult] ${response}`, scope },
    ];
    try {
        await fs.mkdir(path.dirname(bufPath), { recursive: true });
        for (const e of entries) {
            await fs.appendFile(bufPath, JSON.stringify(e) + '\n');
        }
    }
    catch (err) {
        console.error(`[ExecDesk] persist write failed for ${execId}:`, err);
    }
}
async function triggerFlushOnce() {
    // Synchronous flush — daemon picks up buffered entries and runs full extraction.
    // Awaited so we know it landed before the response returns. Uses the same
    // pattern as llm.ts triggerMemoryFlush: pipe transcript_path JSON to stdin.
    return new Promise((resolve) => {
        try {
            const root = getProjectRoot();
            const hookBin = path.join(root, 'vodou-hook-bin');
            const proc = spawn(hookBin, ['sock', 'flush'], {
                cwd: root,
                stdio: ['pipe', 'ignore', 'pipe'],
                env: { ...process.env },
            });
            let stderr = '';
            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', (code) => {
                if (code !== 0) {
                    console.error(`[ExecDesk] flush exited code=${code} stderr=${stderr.slice(0, 200)}`);
                }
                resolve();
            });
            proc.on('error', (err) => {
                console.error(`[ExecDesk] flush spawn error: ${err.message}`);
                resolve();
            });
            proc.stdin?.end(); // empty stdin triggers buffer-drain mode
        }
        catch (err) {
            console.error('[ExecDesk] flush trigger failed:', err);
            resolve();
        }
    });
}
// ─── Audit log (file-based until Phase 4 DB migration lands) ───────────────
async function appendAuditLog(row) {
    try {
        const dir = path.join(getProjectRoot(), '.vodou', 'execdesk');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, 'team-consult-audit.jsonl');
        await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
    }
    catch (err) {
        console.error('[ExecDesk] audit log write failed:', err);
    }
}
async function resolveExec(skillName) {
    // Validate execdesk-* prefix (mitigation #5)
    if (!skillName.startsWith('execdesk-'))
        return null;
    // Don't allow action-skill calls through the orchestrator — they're called
    // BY personas via AGENT_ACTIONS, not directly.
    if (skillName.startsWith('execdesk-action-'))
        return null;
    const role = skillName.replace(/^execdesk-/, '').replace(/-/g, '_');
    const roleMdPath = path.join(getProjectRoot(), 'skills', 'catalog', skillName, 'role.md');
    try {
        const roleMd = await fs.readFile(roleMdPath, 'utf-8');
        return { id: skillName, role, roleMd };
    }
    catch {
        return null;
    }
}
async function loadCompanyBrief(tenantId) {
    // Phase 4 wires this to memory scope `tenant:<id>:company-brief`. For v1
    // we read the eval fixture as a stub so the endpoint is exercisable end-to-end.
    const fixturePath = path.join(getProjectRoot(), 'evals', 'execdesk', 'fixtures', 'company-brief.md');
    try {
        return await fs.readFile(fixturePath, 'utf-8');
    }
    catch {
        return '# Company Brief\n\n_(no brief found — onboarding not run)_';
    }
}
// ─── Single exec call ──────────────────────────────────────────────────────
// Uses the gateway's configured LLM provider (claude-cli / anthropic / openai / ollama / etc.)
// via the existing `rawLLMCall` abstraction. Inherits gateway's auth — no separate API key needed.
//
// System prompt is constructed to mirror chatWithSkill's anti-Claude-Code framing
// (per memory 2026-04-27/28: claude-cli auto-loads CLAUDE.md from cwd which drowns
// persona prompts unless we explicitly counter-frame). Memory context is injected
// via BrainLoader's getMemoryContext keyed on the per-exec convId.
async function callExec(exec, brief, userPrompt, history = []) {
    const t0 = Date.now();
    // BrainLoader memory injection — keyed on the per-exec workbench convId
    // so the CEO sees prior CEO turns, CMO sees prior CMO turns, etc.
    let memory = '';
    try {
        memory = await getMemoryContext(userPrompt, `workbench:skill:${exec.id}`);
    }
    catch (err) {
        console.error(`[ExecDesk] memory load failed for ${exec.id}:`, err);
    }
    // Conversation history — formatted as a transcript block in the user message so
    // the LLM has continuity across turns. For solo-mode chat with the CoS or a
    // single persona, this is what makes back-and-forth interviews work.
    // Truncate to last 20 turns to stay within reasonable context size.
    const trimmedHistory = history.slice(-20);
    const historyBlock = trimmedHistory.length > 0
        ? '\n\n## Prior conversation\n\n' + trimmedHistory.map((m) => {
            const speaker = m.role === 'user' ? 'FOUNDER' : (m.from || exec.role.toUpperCase());
            return `[${speaker}]: ${m.content}`;
        }).join('\n\n') + '\n\n## Current message from FOUNDER\n\n' + userPrompt
        : userPrompt;
    const system = [
        `You are the ${exec.role.toUpperCase()} on the user's ExecDesk team. You are NOT Claude Code, NOT a software engineering assistant, NOT a generic helper. You are this specific executive, in role, every single response.`,
        '',
        'CRITICAL RULES:',
        `1. Stay in your role (${exec.role.toUpperCase()}) at all times. If the question is outside your domain, say "that's a [other-role] question" and stop.`,
        `2. NEVER mention "Claude Code", "Claude CLI", "the Vodou gateway", "/mcp", or any developer tooling. The founder doesn't care; you're their exec.`,
        `3. NEVER claim you can't help because you "don't have context" — your context IS the Company Brief below. Use it.`,
        `4. Lead with the answer or recommendation in sentence 1. Reasoning second.`,
        '',
        '## Your role definition',
        '',
        exec.roleMd.trim(),
        '',
        '## Active Company Brief',
        '',
        brief.trim(),
        memory ? '\n## Relevant memory from past conversations\n\n' + memory.trim() : '',
    ].filter(Boolean).join('\n');
    try {
        // TURNLESS: ExecDesk composes on behalf of a persona from an HTTP request; there is no conversation turn to attach to.
        const text = (await rawLLMCallStrict(historyBlock, system)).trim();
        return { id: exec.id, role: exec.role, text, ms: Date.now() - t0 };
    }
    catch (err) {
        return { id: exec.id, role: exec.role, text: '', ms: Date.now() - t0, error: err.message || String(err) };
    }
}
// ─── Synthesis call (optional, default off for v1) ─────────────────────────
async function synthesizeWithCEO(brief, userPrompt, execResponses) {
    const ceoRoleMdPath = path.join(getProjectRoot(), 'skills', 'catalog', 'execdesk-ceo', 'role.md');
    let ceoRole = '';
    try {
        ceoRole = await fs.readFile(ceoRoleMdPath, 'utf-8');
    }
    catch { /* fall through */ }
    const stitched = execResponses
        .map((r) => `### ${r.role.toUpperCase()}\n${r.text}`)
        .join('\n\n');
    const system = [
        ceoRole.trim(),
        '',
        '## Active Company Brief',
        '',
        brief.trim(),
        '',
        '## Synthesis task',
        'Your team just weighed in on the user\'s question. Read each exec\'s response below, then write a 2-paragraph executive summary as the CEO. Lead with the recommendation. Cite specific exec inputs by role. Keep it under 150 words.',
    ].join('\n');
    const userMsg = `User asked: "${userPrompt}"\n\n## Team responses\n\n${stitched}\n\n## Your synthesis (2 paragraphs, lead with recommendation)`;
    // TURNLESS: same — persona reply for an ExecDesk request, no turn.
    return (await rawLLMCallStrict(userMsg, system)).trim();
}
// ─── Endpoint ──────────────────────────────────────────────────────────────
router.post('/team-consult', async (req, res) => {
    const t0 = Date.now();
    const { prompt, execs: requestedExecs, tenant_id: tenantId = 'default', tier = DEFAULT_TIER, synthesize = false, history = [], } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required' });
    }
    if (!Array.isArray(requestedExecs) || requestedExecs.length === 0) {
        return res.status(400).json({ error: 'execs must be a non-empty array of skill IDs' });
    }
    // Tier cap on how many execs can be called at once (mitigation #3 + tier shape)
    const tierConfig = TIER_LIMITS[tier] || TIER_LIMITS[DEFAULT_TIER];
    if (requestedExecs.length > tierConfig.maxExecs) {
        return res.status(400).json({
            error: `Tier '${tier}' allows max ${tierConfig.maxExecs} execs per consult; requested ${requestedExecs.length}`,
        });
    }
    // Rate limit
    const rl = checkRateLimit(tenantId, tier);
    if (!rl.ok) {
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt / 1000)));
        return res.status(429).json({
            error: 'Rate limit exceeded',
            tier,
            reset_at: new Date(rl.resetAt).toISOString(),
        });
    }
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt / 1000)));
    // Resolve execs (cheap fs read; do this BEFORE API key check so bad inputs fail fast)
    const resolved = [];
    const unresolved = [];
    for (const id of requestedExecs) {
        const r = await resolveExec(id);
        if (r)
            resolved.push(r);
        else
            unresolved.push(id);
    }
    if (resolved.length === 0) {
        return res.status(400).json({ error: 'No valid execs resolved', unresolved });
    }
    // LLM provider — uses gateway's configured provider (claude-cli / anthropic / etc.)
    if (!isConfigured()) {
        return res.status(500).json({
            error: 'No LLM provider configured on gateway. Configure one in /#/settings.',
            auth_type: getAuthType(),
        });
    }
    // Load brief
    const brief = await loadCompanyBrief(tenantId);
    // Fan-out (parallel) — each exec hits the gateway's configured LLM provider
    const safeHistory = Array.isArray(history) ? history : [];
    const responses = await Promise.all(resolved.map((e) => callExec(e, brief, prompt, safeHistory)));
    // Stitch
    const stitched = responses
        .map((r) => `### ${r.role.toUpperCase()}\n\n${r.error ? `_(error: ${r.error})_` : r.text}`)
        .join('\n\n---\n\n');
    // Optional CEO synthesis
    let synthesis = null;
    if (synthesize && resolved.length > 1) {
        try {
            synthesis = await synthesizeWithCEO(brief, prompt, responses.filter((r) => !r.error).map((r) => ({ role: r.role, text: r.text })));
        }
        catch (err) {
            synthesis = `_(synthesis failed: ${err.message || err})_`;
        }
    }
    // Per-exec memory persistence — write the team-consult turn into each exec's
    // memory scope so future individual chats with that exec see what was discussed.
    // Fire-and-forget (don't block the response).
    await Promise.all(responses
        .filter((r) => !r.error && r.text.length >= 20)
        .map((r) => persistTurnToExecMemory(r.id, prompt, r.text)));
    if (synthesis && synthesis.length >= 20) {
        // Synthesis is the CEO's final output — also persist into CEO scope.
        await persistTurnToExecMemory('execdesk-ceo', `[synthesis of: ${prompt}]`, synthesis);
    }
    await triggerFlushOnce();
    const totalMs = Date.now() - t0;
    // Audit log
    await appendAuditLog({
        tenant_id: tenantId,
        tier,
        prompt: prompt.slice(0, 500),
        execs_requested: requestedExecs,
        execs_resolved: resolved.map((r) => r.id),
        unresolved,
        synthesize,
        auth_type: getAuthType(),
        total_ms: totalMs,
        rate_limit_remaining: rl.remaining,
        response_lengths: responses.map((r) => r.text.length),
        errors: responses.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    });
    return res.json({
        prompt,
        execs: responses,
        stitched,
        synthesis,
        unresolved,
        timing: { total_ms: totalMs, per_exec: responses.map((r) => ({ id: r.id, ms: r.ms })) },
        rate_limit: { remaining: rl.remaining, reset_at: new Date(rl.resetAt).toISOString() },
    });
});
// ─── Save brief — Chief of Staff onboarding output ────────────────────────
// POST /api/exec/save-brief
//
// Writes a Company Brief to memory as ONE scope-tagged buffer entry per schema
// section. This works around the §0.11.4 dry-run finding: long-form documents
// re-chunk under default scope:web because the chunker reads broader transcript
// context. Per-section bullet-style writes preserve scope tagging correctly.
//
// Tenant scope: `tenant:<id>:company-brief`
//
// Body shape:
//   { tenant_id, company_name, sections: { at_a_glance, who_they_serve, ... } }
router.post('/save-brief', async (req, res) => {
    const { tenant_id: tenantId = 'default', company_name: companyName = 'Unknown', sections = {} } = req.body || {};
    if (!sections || typeof sections !== 'object') {
        return res.status(400).json({ error: 'sections object required' });
    }
    const root = getProjectRoot();
    const bufPath = path.join(root, '.vodou', 'workspace', '.prompt_buffer');
    const scope = `tenant:${tenantId}:company-brief`;
    const ts = new Date().toISOString();
    // Per-section writes — each section becomes its own bullet-style buffer entry,
    // chunkable as-is by the daemon's extractor.
    const sectionLabels = {
        at_a_glance: 'At a glance',
        who_they_serve: 'Who they serve',
        this_quarter: 'This quarter',
        what_hurts: 'What hurts most',
        how_they_sound: 'How they sound',
        competitive: 'Competitive context',
        boundaries: 'What we DON\'T do',
        notes_for_team: 'Notes for the team',
    };
    const written = [];
    try {
        await fs.mkdir(path.dirname(bufPath), { recursive: true });
        // Lead with a "header" entry so future BrainLoader retrievals always pull the company name first.
        const headerEntry = {
            role: 'assistant',
            content: `[Company Brief — ${companyName}] Saved ${ts.slice(0, 10)}.`,
            scope,
        };
        await fs.appendFile(bufPath, JSON.stringify(headerEntry) + '\n');
        for (const [key, label] of Object.entries(sectionLabels)) {
            const content = (sections[key] || '').toString().trim();
            if (!content || content.length < 5)
                continue;
            const entry = {
                role: 'assistant',
                content: `[${companyName} — ${label}] ${content}`,
                scope,
            };
            await fs.appendFile(bufPath, JSON.stringify(entry) + '\n');
            written.push(key);
        }
    }
    catch (err) {
        console.error('[ExecDesk] save-brief write failed:', err);
        return res.status(500).json({ error: 'Failed to write brief sections', detail: err.message });
    }
    // Trigger flush so chunks index immediately and are retrievable on the next exec call.
    await triggerFlushOnce();
    // Audit log row
    await appendAuditLog({
        event: 'save-brief',
        tenant_id: tenantId,
        company_name: companyName,
        sections_written: written,
        scope,
    });
    return res.json({
        ok: true,
        tenant_id: tenantId,
        company_name: companyName,
        scope,
        sections_written: written,
        timestamp: ts,
    });
});
// ─── Streaming endpoint — solo-mode chat with full Vodou abilities ───────
// POST /api/exec/stream
//
// Single-exec only (rejects multi-exec). Returns Server-Sent Events.
//
// **Architecture (refactored 2026-05-04):** routes through Vodou's standard
// `chatWithSkill` infrastructure rather than spawning claude-cli directly.
// This gives ExecDesk personas:
//   - MCP tool access (web search, calendar, gmail, slack, stripe, etc.)
//   - BrainLoader intent routing + memory injection
//   - Tool-use loop (skills can call tools mid-conversation)
//   - Conversation persistence via gateway's chat history (per-convId)
//   - Per-conversation model selection
//   - All other Vodou superpowers
//
// Persona fidelity is preserved because `chatWithCLI` (downstream) passes the
// system prompt via `--system-prompt` flag — claude-cli's CLAUDE.md auto-load
// doesn't drown out role.md.
//
// ConvId scheme: `workbench:skill:<exec_id>` — gateway maintains per-exec
// conversation history server-side, so we don't need to pass `history` from
// the frontend.
//
// Body shape:
//   { prompt, exec_id, history, tenant_id, tier }
//
// SSE event shapes:
//   data: {"type":"start","exec":"execdesk-ceo","role":"ceo"}
//   data: {"type":"token","text":"H"}
//   data: {"type":"token","text":"e"}
//   ...
//   data: {"type":"done","ms":2341,"rate_remaining":9}
router.post('/stream', async (req, res) => {
    const { prompt, exec_id: execId, tenant_id: tenantId = 'default', tier = DEFAULT_TIER } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required' });
    }
    if (!execId || typeof execId !== 'string') {
        return res.status(400).json({ error: 'exec_id is required (single exec only for streaming)' });
    }
    // Resolve exec — gives us role.md + role + verifies execdesk-* prefix
    const exec = await resolveExec(execId);
    if (!exec) {
        return res.status(400).json({ error: 'No valid exec resolved', unresolved: [execId] });
    }
    // Rate limit
    const rl = checkRateLimit(tenantId, tier);
    if (!rl.ok) {
        return res.status(429).json({ error: 'Rate limit exceeded', reset_at: new Date(rl.resetAt).toISOString() });
    }
    if (!isConfigured()) {
        return res.status(500).json({ error: 'No LLM provider configured' });
    }
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const sendEvent = (obj) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        res.flush?.();
    };
    // Load brief once + build the skill content (role.md + brief + persona-fidelity guard)
    // chatWithSkill will inject the active memory context automatically — we don't need
    // to call getMemoryContext manually here.
    const brief = await loadCompanyBrief(tenantId);
    const skillContent = [
        `You are the ${exec.role.toUpperCase()} on the user's ExecDesk team. You are NOT Claude Code, NOT a software engineering assistant, NOT a generic helper. You are this specific executive, in role.`,
        '',
        'CRITICAL RULES:',
        `1. Stay in role (${exec.role.toUpperCase()}) at all times.`,
        `2. NEVER mention "Claude Code", "Claude CLI", "/mcp", or any developer tooling.`,
        `3. Use the Company Brief below — it IS your context.`,
        `4. Lead with the answer. Reasoning second.`,
        `5. You have access to MCP tools (web search, calendar, gmail, etc.) — use them when the founder's question would benefit from real data, not your training-data guess.`,
        '',
        '## Your role definition',
        '',
        exec.roleMd.trim(),
        '',
        '## Active Company Brief',
        '',
        brief.trim(),
    ].join('\n');
    // ConvId — gateway maintains conversation history server-side per this id, so
    // multi-turn chat works automatically without us forwarding history.
    const conversationId = `workbench:skill:${exec.id}`;
    const t0 = Date.now();
    sendEvent({ type: 'start', exec: exec.id, role: exec.role, convId: conversationId });
    let fullText = '';
    let clientClosed = false;
    req.on('close', () => { clientClosed = true; });
    // Forward chatWithSkill's StreamEvents as SSE for the frontend.
    // text → token, tool_call_start → tool_start, tool_call_end → tool_end,
    // status → status, error → error, done → done, usage → usage.
    const onEvent = (evt) => {
        if (clientClosed)
            return;
        switch (evt.type) {
            case 'text':
                if (evt.content) {
                    fullText += evt.content;
                    sendEvent({ type: 'token', text: evt.content });
                }
                break;
            case 'tool_call_start':
                sendEvent({
                    type: 'tool_start',
                    tool: evt.toolName,
                    server: evt.serverName,
                    args: evt.toolArgs,
                });
                break;
            case 'tool_call_end':
                sendEvent({
                    type: 'tool_end',
                    tool: evt.toolName,
                    ms: evt.executionTime,
                    success: evt.success,
                });
                break;
            case 'status':
                sendEvent({ type: 'status', status: evt.status, content: evt.content });
                break;
            case 'usage':
                sendEvent({ type: 'usage', usage: evt.usage });
                break;
            case 'error':
                sendEvent({ type: 'error', error: evt.error || 'unknown error' });
                break;
            case 'done':
                // We send our own 'done' below with timing.
                break;
        }
    };
    try {
        await chatWithSkill(conversationId, prompt, skillContent, onEvent);
        const ms = Date.now() - t0;
        // Persist a short-form summary line to per-exec scope (the standard chat path
        // also persists via saveAssistantToBuffer, but that's a global transcript;
        // we want a scoped breadcrumb too).
        if (fullText && fullText.length >= 20) {
            await persistTurnToExecMemory(exec.id, prompt, fullText);
        }
        sendEvent({
            type: 'done',
            ms,
            rate_remaining: rl.remaining,
            length: fullText.length,
        });
        await appendAuditLog({
            event: 'stream',
            tenant_id: tenantId,
            tier,
            prompt: prompt.slice(0, 500),
            exec: exec.id,
            total_ms: ms,
            response_length: fullText.length,
            via: 'chatWithSkill',
        });
    }
    catch (err) {
        console.error('[ExecDesk] stream error:', err);
        sendEvent({ type: 'error', error: err.message || String(err) });
    }
    finally {
        if (!clientClosed)
            res.end();
    }
});
// ─── Activity feed — recent ExecDesk runs (scheduled or manual) ────────────
// GET /api/exec/activity?limit=20
//
// Reads the audit log JSONL and returns recent runs grouped by day. Powers the
// home view's "What your team did this week" feed.
router.get('/activity', async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 100);
    const auditPath = path.join(getProjectRoot(), '.vodou', 'execdesk', 'team-consult-audit.jsonl');
    try {
        const exists = await fs.access(auditPath).then(() => true).catch(() => false);
        if (!exists) {
            return res.json({ runs: [], total: 0 });
        }
        const content = await fs.readFile(auditPath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());
        const recent = lines.slice(-limit * 2).reverse(); // oversample then trim
        const runs = [];
        for (const line of recent) {
            try {
                const row = JSON.parse(line);
                // Only surface team-consult and stream events (skip save-brief etc.)
                if (row.event === 'save-brief')
                    continue;
                // Tag cron runs so the UI can mark them differently
                const isCron = String(row.tenant_id || '').startsWith('cron-');
                runs.push({
                    ts: row.ts,
                    source: isCron ? 'scheduled' : 'manual',
                    execs: row.execs_resolved || (row.exec ? [row.exec] : []),
                    prompt: (row.prompt || '').slice(0, 140),
                    response_lengths: row.response_lengths || (row.response_length ? [row.response_length] : []),
                    total_ms: row.total_ms,
                    tenant: row.tenant_id,
                });
                if (runs.length >= limit)
                    break;
            }
            catch { /* skip malformed lines */ }
        }
        res.json({ runs, total: runs.length });
    }
    catch (err) {
        console.error('[ExecDesk] activity read failed:', err);
        res.status(500).json({ error: 'Failed to read activity log', detail: err.message });
    }
});
// ─── Health/inspect ────────────────────────────────────────────────────────
router.get('/team-consult/status', (req, res) => {
    const tenantId = String(req.query.tenant_id || 'default');
    const tier = String(req.query.tier || DEFAULT_TIER);
    const now = Date.now();
    const entry = rateWindows.get(tenantId);
    const limit = (TIER_LIMITS[tier] || TIER_LIMITS[DEFAULT_TIER]).perHour;
    const remaining = entry && entry.resetAt > now ? limit - entry.count : limit;
    res.json({
        tenant_id: tenantId,
        tier,
        rate_limit: {
            per_hour: limit,
            remaining: Math.max(0, remaining),
            reset_at: entry ? new Date(entry.resetAt).toISOString() : null,
        },
        plan_status: {
            version: 'v1 skeleton 2026-05-04',
            scope_locked_per: 'PLAN §0.11.1',
            synthesis: 'available via synthesize=true',
            streaming: 'NOT IMPLEMENTED (deferred)',
            inter_exec_dialogue: 'NOT IMPLEMENTED (deferred)',
        },
    });
});
export { router as execRouter };
