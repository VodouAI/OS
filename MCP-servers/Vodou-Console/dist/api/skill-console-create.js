/**
 * Gateway UI — create Skill Consoles without MCP client.
 * Delegates to vodou-core `vc_skills_create` (same validation as MCP).
 */
import { findConsoleScheduleRow } from '../skill-kind.js';
import { Router } from 'express';
import { runVodouCoreCallTool } from '../executor.js';
import { isConfigured, rawLLMCallStrict } from '../llm.js';
import { resolveSkillCronExpression } from './nl-cron.js';
import { getDb, getGatewayDb } from '../db.js';
import { ensureConversation, setConversationProject } from '../conversation-store.js';
// Generic CRUD/verb tokens that are too noisy to signal which server an idea
// is about — e.g. nearly every server has a `*_list` tool, so the word "list"
// must not make every server look relevant.
const CATALOG_STOP_TOKENS = new Set([
    'list', 'lists', 'create', 'update', 'delete', 'send', 'read', 'info', 'data',
    'tool', 'tools', 'search', 'fetch', 'find', 'show', 'make', 'call', 'batch',
    'modify', 'archive', 'trash', 'with', 'your', 'this', 'that', 'from', 'into',
    'once', 'look', 'want', 'need', 'about', 'when', 'then', 'them', 'they', 'have',
]);
/** Lowercase tokens (len ≥ 4, minus stop-words) of a server or tool name. */
function catalogTokens(s) {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !CATALOG_STOP_TOKENS.has(t));
}
/** One-line, length-capped tool description for the catalog. */
function shortToolDesc(d, max = 72) {
    if (!d)
        return '';
    const one = d.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
export function formatToolCatalog(rows, idea, opts = {}) {
    const fullCap = opts.fullCap ?? 80;
    // Slim servers aren't what the idea is about — a handful of described tools
    // conveys what the server is for without the full list bloating the prompt
    // (and slowing the timed draft call). The drafter expands a server in full
    // the moment the idea actually points at it.
    const slimCap = opts.slimCap ?? 6;
    const maxFullServers = opts.maxFullServers ?? 5;
    if (!rows.length)
        return '';
    const byServer = new Map();
    for (const r of rows) {
        const list = byServer.get(r.server) || [];
        list.push({ tool: r.tool, description: r.description });
        byServer.set(r.server, list);
    }
    const ideaLc = idea.toLowerCase();
    const ideaTokens = new Set(ideaLc.match(/[a-z0-9]{4,}/g) || []);
    // Score each server by how strongly the idea points at it: a literal name
    // mention is the strongest signal, then shared name tokens, then shared
    // tool-name tokens (so "triage my threads" finds gmail via `threads_list`).
    const scored = [...byServer.entries()].map(([server, tools]) => {
        let score = 0;
        if (ideaLc.includes(server.toLowerCase()))
            score += 10;
        for (const tok of catalogTokens(server))
            if (ideaTokens.has(tok))
                score += 5;
        const toolToks = new Set();
        for (const t of tools)
            for (const tok of catalogTokens(t.tool))
                toolToks.add(tok);
        for (const tok of toolToks)
            if (ideaTokens.has(tok))
                score += 1;
        return { server, tools, score };
    });
    const fullSet = new Set(scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.server.localeCompare(b.server))
        .slice(0, maxFullServers)
        .map((s) => s.server));
    // Expanded (relevant) servers first — highest score — then the rest A–Z.
    scored.sort((a, b) => {
        const af = fullSet.has(a.server) ? 1 : 0;
        const bf = fullSet.has(b.server) ? 1 : 0;
        if (af !== bf)
            return bf - af;
        if (af && b.score !== a.score)
            return b.score - a.score;
        return a.server.localeCompare(b.server);
    });
    const blocks = [];
    for (const { server, tools } of scored) {
        if (fullSet.has(server)) {
            // Relevant server — list each tool fully-qualified with a short
            // description so the drafter picks the right one by capability, not by
            // guessing from the name (e.g. message_modify vs message_send).
            const lines = tools.slice(0, fullCap).map((t) => {
                const d = shortToolDesc(t.description);
                return `    ${server}/${t.tool}${d ? ` — ${d}` : ''}`;
            });
            const extra = tools.length - Math.min(tools.length, fullCap);
            blocks.push(`- ${server} (${tools.length} tools):\n${lines.join('\n')}${extra > 0 ? `\n    …(+${extra} more)` : ''}`);
        }
        else {
            // Less-relevant server — names + a terse description so the drafter has
            // some capability context for the long tail without ballooning the
            // prompt. Semicolon-separated because descriptions contain commas.
            const shown = tools.slice(0, slimCap).map((t) => {
                const d = shortToolDesc(t.description, 34);
                return d ? `${t.tool} (${d})` : t.tool;
            });
            const extra = tools.length - Math.min(tools.length, slimCap);
            blocks.push(`- ${server}: ${shown.join('; ')}${extra > 0 ? `; …(+${extra} more)` : ''}`);
        }
    }
    return blocks.join('\n');
}
/**
 * Query installed servers/tools and format them for the idea. Returns '' on any
 * DB error (degrade gracefully — the LLM still drafts, just without the hint).
 */
function buildToolCatalog(idea) {
    try {
        const db = getDb();
        const rows = db.prepare(`SELECT s.name AS server, t.name AS tool, t.description AS description
       FROM tools t JOIN mcp_servers s ON t.server_id = s.id
       WHERE s.active = 1 AND COALESCE(t.enabled, 1) = 1
       ORDER BY s.name, t.name`).all();
        return formatToolCatalog(rows, idea);
    }
    catch {
        return '';
    }
}
/** Active MCP server names (lowercased) for required_tools preflight warnings. */
function getInstalledServerNames() {
    try {
        const db = getDb();
        const rows = db.prepare(`SELECT DISTINCT name FROM mcp_servers WHERE active = 1`).all();
        return new Set(rows.map((r) => r.name.toLowerCase()));
    }
    catch {
        return new Set();
    }
}
/**
 * If a drafted skill name already exists in gateway.db, suffix it (-2, -3, …)
 * so the user doesn't fill the whole form only to hit a uniqueness error at
 * Create. Stays within the 41-char `^[a-z][a-z0-9-]{2,40}$` limit. Degrades to
 * the original name if gateway.db / skills_meta isn't reachable.
 */
function dedupeSkillName(name) {
    try {
        const db = getGatewayDb();
        const taken = (n) => !!db.prepare(`SELECT 1 FROM skills_meta WHERE name = ? LIMIT 1`).get(n);
        if (!taken(name))
            return name;
        const base = name.slice(0, 38).replace(/-+$/, ''); // leave room for "-NN"
        for (let i = 2; i <= 99; i++) {
            const cand = `${base}-${i}`;
            if (!taken(cand))
                return cand;
        }
        return name; // give up — Create will surface the collision
    }
    catch {
        return name;
    }
}
export const skillConsoleCreateRouter = Router();
const NAME_RE = /^[a-z][a-z0-9-]{2,40}$/;
/** Exported for tests — slug must match vc_skills_create ^[a-z][a-z0-9-]{2,40}$ */
export function slugifySkillConsoleName(title) {
    let slug = title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
    if (!slug.length)
        return 'my-skill';
    if (!/^[a-z]/.test(slug))
        slug = 'x-' + slug.replace(/^[^a-z0-9]+/, '');
    if (slug.length < 3)
        slug = `${slug}-bot`;
    if (slug.length > 41)
        slug = slug.slice(0, 41).replace(/-+$/g, '');
    if (!NAME_RE.test(slug))
        slug = `skill-${Math.random().toString(36).slice(2, 10)}`;
    return slug.slice(0, 41);
}
/**
 * Extract the JSON object from a possibly-chatty LLM completion. Robust to:
 *   - leading reasoning / `<thinking>…</thinking>` blocks,
 *   - ```json fences,
 *   - trailing prose AFTER the closing brace (the old slice-to-end parser threw
 *     here, surfacing as a 500),
 *   - trailing commas before } or ].
 * Scans from the first `{` to its matching `}` with string/escape awareness so
 * braces inside string values don't end the object early.
 */
export function parseDraftJson(raw) {
    let t = (raw || '').trim();
    if (!t) {
        throw new Error('LLM returned empty output — check gateway model / logs');
    }
    t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence)
        t = fence[1].trim();
    const start = t.indexOf('{');
    if (start < 0) {
        throw new Error(`Draft contained no JSON object. Preview: ${t.slice(0, 200)}`);
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (c === '\\')
                esc = true;
            else if (c === '"')
                inStr = false;
        }
        else if (c === '"') {
            inStr = true;
        }
        else if (c === '{') {
            depth++;
        }
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    let json = end >= 0 ? t.slice(start, end + 1) : t.slice(start);
    json = json.replace(/,\s*([}\]])/g, '$1'); // tolerate trailing commas
    try {
        return JSON.parse(json);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Draft was not valid JSON (${msg}). Preview: ${json.slice(0, 200)}`);
    }
}
const DRAFT_LLM_TIMEOUT_MS = 90_000;
async function withTimeout(promise, ms, label) {
    let to;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                to = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
            }),
        ]);
    }
    finally {
        if (to)
            clearTimeout(to);
    }
}
skillConsoleCreateRouter.post('/create', async (req, res) => {
    try {
        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const display_name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
        let prompt_template = typeof body.prompt_template === 'string' ? body.prompt_template : '';
        const scheduleRaw = typeof body.schedule_cron === 'string' ? body.schedule_cron.trim() : '';
        const prefer_model = typeof body.prefer_model === 'string' ? body.prefer_model.trim() : '';
        const delivery_mode = typeof body.delivery_mode === 'string' ? body.delivery_mode.trim() : 'console';
        const delivery_target = typeof body.delivery_target === 'string' ? body.delivery_target.trim() : '';
        const history_window = typeof body.history_window === 'number' ? body.history_window : 0;
        const ephemeral = Boolean(body.ephemeral);
        let stopping_points = body.stopping_points;
        const parameters_json = typeof body.parameters_json === 'string' ? body.parameters_json : '';
        const required_tools = body.required_tools;
        const project_id = typeof body.project_id === 'string' ? body.project_id.trim() : '';
        if (!name || !display_name) {
            res.status(400).json({ error: 'name and display_name are required' });
            return;
        }
        if (!NAME_RE.test(name)) {
            res.status(400).json({ error: 'name must match ^[a-z][a-z0-9-]{2,40}$' });
            return;
        }
        if (prompt_template.length < 20) {
            res.status(400).json({ error: 'prompt_template must be at least 20 characters' });
            return;
        }
        if (!/\{\{\s*user_message\s*\}\}/i.test(prompt_template)) {
            prompt_template = `${prompt_template.trim()}\n\nUser message: {{user_message}}`;
        }
        if (prompt_template.length < 20 || prompt_template.length > 8000) {
            res.status(400).json({ error: `prompt_template must be 20-8000 chars after defaults (got ${prompt_template.length})` });
            return;
        }
        const args = {
            name,
            display_name,
            prompt_template,
            output_format: 'markdown',
            history_window,
            ephemeral,
            delivery_mode,
        };
        if (scheduleRaw) {
            try {
                const { cron } = resolveSkillCronExpression(scheduleRaw);
                args.schedule_cron = cron;
            }
            catch (e) {
                res.status(400).json({ error: e.message });
                return;
            }
        }
        if (prefer_model)
            args.prefer_model = prefer_model;
        if (delivery_mode !== 'console' && delivery_target)
            args.delivery_target = delivery_target;
        if (parameters_json)
            args.parameters_json = parameters_json;
        if (stopping_points !== undefined && stopping_points !== null && stopping_points !== '') {
            args.stopping_points = stopping_points;
        }
        if (required_tools !== undefined && required_tools !== null) {
            if (!Array.isArray(required_tools)) {
                res.status(400).json({ error: 'required_tools must be a JSON array' });
                return;
            }
            args.required_tools = required_tools;
        }
        const out = await runVodouCoreCallTool('vc_skills_create', args);
        const convMatch = /workbench:skill-console:[a-z0-9-]+/.exec(out);
        const idMatch = /\(id=(\d+)\)/.exec(out);
        // Say whether this skill will ever actually run.
        //
        // The schedule is optional on this dialog, and that is fine — a tab you
        // open by hand is a legitimate thing to want. What was NOT fine is that
        // both outcomes looked identical: a skill created with no cron, and one
        // whose cron failed to register, each produced a plain success. The user
        // walked away believing they had automated something. `vodou-channel-finder`
        // sat in exactly that state, invisible in Scheduled, until someone went
        // looking in the database.
        //
        // Ask the DB, not the reply text: a scheduled_tasks row is what makes it
        // fire. The engine's note is only used for the REASON when one is missing.
        // Scope the console to the project it was created from. The engine creates
        // the conversation with no project, so without this a skill built inside
        // VODOU SOCIAL lands under Default and cannot be found by filtering to the
        // project you made it in — which is exactly how one went missing.
        if (project_id && project_id !== 'proj_default' && convMatch) {
            try {
                ensureConversation(convMatch[0], display_name.slice(0, 80), 'skill-console', undefined, project_id);
                setConversationProject(convMatch[0], project_id);
            }
            catch (e) {
                console.error('[skill-console-create] project scoping failed:', e.message);
            }
        }
        let scheduled = false;
        let warning = null;
        if (args.schedule_cron) {
            const slug = slugifySkillConsoleName(String(args.name));
            const row = findConsoleScheduleRow(getDb(), slug);
            scheduled = !!row?.id;
            if (!scheduled) {
                const noteMatch = /cron `[^`]*` recorded but scheduler register failed: ([^\n(]+)/.exec(out);
                warning = noteMatch
                    ? `Created, but the schedule did not register: ${noteMatch[1].trim()}. It will not run until that is fixed.`
                    : 'Created, but the schedule did not register — it will not run on its own.';
                console.error(`[skill-console-create] cron did not register for "${args.name}"`);
            }
        }
        else {
            warning = 'Created with no schedule — it has a tab you can open, but it will never run on its own. Add a schedule under Advanced to automate it.';
        }
        res.json({
            ok: true,
            scheduled,
            warning,
            raw: out,
            conversationId: convMatch ? convMatch[0] : null,
            skillId: idMatch ? parseInt(idMatch[1], 10) : null,
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[skill-console-create]', msg);
        res.status(400).json({ error: msg });
    }
});
skillConsoleCreateRouter.post('/draft', async (req, res) => {
    if (!isConfigured()) {
        res.status(503).json({
            error: 'Gateway LLM not configured — set API keys / provider in Settings → Model (or .env), then restart the gateway',
        });
        return;
    }
    const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : '';
    if (!idea || idea.length < 5) {
        res.status(400).json({ error: 'idea must be a non-empty string (at least 5 chars)' });
        return;
    }
    const catalog = buildToolCatalog(idea);
    const catalogBlock = catalog
        ? `\n\nInstalled Vodou MCP servers and tools (reference these by exact \`server/tool\` name). Servers most relevant to the idea are listed first with their full tool set; \`…(+N more)\` means a less-relevant server has extra tools not shown:\n${catalog}`
        : '';
    const system = `You help fill a Skill Console creation form. Output ONLY valid JSON, no markdown fence, no commentary.
Schema:
{
  "display_name": "short human title, max 60 chars",
  "name": "kebab-case id matching ^[a-z][a-z0-9-]{2,40}$ — lowercase, start with letter",
  "prompt_template": "instructions for the recurring skill; MUST include the literal substring {{user_message}} somewhere; 40-4000 chars; no {{principal_id}} or {{token}}",
  "schedule_cron": optional string — either a 5-field cron, @hourly, @daily, @weekly, OR English like "every weekday at 9am",
  "required_tools": optional JSON array of "server/tool" strings this skill depends on, drawn ONLY from the catalog below,
  "delivery_mode": "console" | "channel" | "broadcast" — where output goes. Default "console" (the Skill Console tab). Use "channel" only if the user names a specific Slack/Telegram/Discord destination; "broadcast" only if they say all channels.,
  "delivery_target": string "platform:id" (e.g. "slack:C0123ABC", "telegram:-1001234567890") — REQUIRED iff delivery_mode is "channel". Omit/empty otherwise. Only set if the user actually gave a destination; never invent an id.,
  "ephemeral": boolean — true ONLY if the user wants a one-shot/run-once/temporary skill that self-deletes. A recurring schedule means false.,
  "history_window": integer 0-50 — prior turns to include. 0 for one-shot digests/reports; 5-10 for ongoing conversational assistants. Default 0.,
  "stopping_points": optional JSON object {checkpoint_key: "question to ask the user"} — ONLY for interactive skills that must pause for confirmation mid-run (e.g. {"before_send":"Send these emails?"}). For fully-automated skills use {} or omit.,
  "prefer_model": optional "opus" | "sonnet" | "haiku" — only if the user expresses a preference ("use a fast/cheap model" → haiku; "best reasoning" → opus). Otherwise omit.,
  "parameters_json": optional JSON object of reusable vars referenced in the template as {{param:NAME}} (e.g. {"topic":"AI news","max_items":5}). Only if the idea has obvious tunable constants. Otherwise omit.
}
Rules:
- name unique-ish (add random suffix only if needed).
- prompt_template must be actionable for automation.
- CRITICAL — tools: Vodou has its OWN MCP servers (see catalog). The skill MUST use those. NEVER reference \`mcp__claude_ai_*\` connectors (e.g. mcp__claude_ai_Gmail__*) — those are not part of Vodou and will fail. For Gmail use the \`gmail\` server, for calendar the \`google-calendar\` server, etc. In prompt_template, say "use the <server> MCP server" and name the actual tools (e.g. "call gmail/messages_list, then gmail/message_modify").
- Populate required_tools with the exact \`server/tool\` names the skill will call, picked from the catalog. If the catalog has no fitting server, use an empty array — do NOT invent tool names.
- Be conservative on the optional advanced fields: only set delivery_mode/target, ephemeral, stopping_points, prefer_model, parameters_json when the user's description clearly implies them. When unsure, omit (the form keeps its safe default). Do NOT fabricate channel ids, models, or parameters.${catalogBlock}`;
    const user = `User idea:\n${idea.slice(0, 4000)}`;
    try {
        const text = await withTimeout(
        // TURNLESS: skill authoring from the wizard, before the console's conversation is bound.
        rawLLMCallStrict(user, system), DRAFT_LLM_TIMEOUT_MS, 'Skill draft LLM call');
        if (!String(text).trim()) {
            res.status(502).json({
                error: 'LLM returned no text (provider may have failed silently — check .vodou/system.log and model settings)',
            });
            return;
        }
        const obj = parseDraftJson(text);
        const display_name = String(obj.display_name || '').trim().slice(0, 80);
        let name = String(obj.name || '').trim().toLowerCase();
        if (!NAME_RE.test(name))
            name = slugifySkillConsoleName(display_name || idea);
        name = dedupeSkillName(name);
        let prompt_template = String(obj.prompt_template || '').trim();
        if (!/\{\{\s*user_message\s*\}\}/i.test(prompt_template)) {
            prompt_template = `${prompt_template}\n\nUser: {{user_message}}`;
        }
        // Non-fatal advisories shown to the user after a draft (the form still
        // populates) — e.g. a schedule we couldn't parse, or a tool whose server
        // isn't installed. Surfacing these beats silently dropping them.
        const warnings = [];
        let schedule_cron;
        const sch = obj.schedule_cron;
        if (typeof sch === 'string' && sch.trim()) {
            try {
                schedule_cron = resolveSkillCronExpression(sch.trim()).cron;
            }
            catch {
                schedule_cron = undefined;
                warnings.push(`Couldn't parse the suggested schedule "${sch.trim()}" — left blank. Set it in Advanced (e.g. \`@daily\`, \`0 9 * * *\`, or "every weekday at 9am").`);
            }
        }
        // required_tools — keep only well-formed "server/tool" strings the LLM
        // returned. Strip any stray mcp__claude_ai_* the model may still emit, so
        // a bad suggestion never lands in the form.
        let required_tools = [];
        if (Array.isArray(obj.required_tools)) {
            required_tools = obj.required_tools
                .filter((t) => typeof t === 'string')
                .map((t) => t.trim())
                .filter((t) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t) && !/^mcp__claude_ai_/i.test(t));
        }
        // Preflight: warn (don't block) when a required tool names a server that
        // isn't installed/active — the skill would otherwise fail only at run time.
        const installedServers = getInstalledServerNames();
        if (installedServers.size) {
            const missing = [...new Set(required_tools
                    .map((t) => t.split('/')[0].toLowerCase())
                    .filter((srv) => !installedServers.has(srv)))];
            for (const srv of missing) {
                warnings.push(`Required tool server \`${srv}\` isn't installed — connect it in Capabilities → MCP Servers, or the skill may fail when it runs.`);
            }
        }
        // The catalog now lists real Vodou tools, but guard against the model still
        // baking a forbidden claude.ai connector name into the prompt body.
        if (/mcp__claude_ai_/i.test(prompt_template)) {
            warnings.push('The drafted prompt references an `mcp__claude_ai_*` connector. Vodou uses its own MCP servers — edit the prompt to name a real server/tool (see the tool list).');
        }
        // ── Advanced fields — validate strictly; fall back to safe defaults so a
        // bad LLM guess never lands a broken value in the form. ──
        // delivery_mode ∈ {console, channel, broadcast}; default console.
        let delivery_mode = 'console';
        const dm = typeof obj.delivery_mode === 'string' ? obj.delivery_mode.trim().toLowerCase() : '';
        if (dm === 'channel' || dm === 'broadcast')
            delivery_mode = dm;
        // delivery_target only meaningful for channel mode; require "platform:id".
        let delivery_target = '';
        if (delivery_mode === 'channel') {
            const dt = typeof obj.delivery_target === 'string' ? obj.delivery_target.trim() : '';
            if (/^[a-z]+:[A-Za-z0-9._-]+$/.test(dt)) {
                delivery_target = dt;
            }
            else {
                // Model claimed channel but gave no usable target — revert to console
                // rather than create an undeliverable skill.
                delivery_mode = 'console';
            }
        }
        const ephemeral = obj.ephemeral === true;
        // history_window — clamp to 0-50 int.
        let history_window = 0;
        const hw = Number(obj.history_window);
        if (Number.isFinite(hw))
            history_window = Math.max(0, Math.min(50, Math.round(hw)));
        // stopping_points — keep only if it parses to a non-empty object/array.
        let stopping_points = '';
        if (obj.stopping_points && typeof obj.stopping_points === 'object') {
            const sp = obj.stopping_points;
            const nonEmpty = Array.isArray(sp) ? sp.length > 0 : Object.keys(sp).length > 0;
            if (nonEmpty) {
                try {
                    stopping_points = JSON.stringify(sp);
                }
                catch {
                    stopping_points = '';
                }
            }
        }
        // prefer_model — allowlist only.
        let prefer_model = '';
        const pm = typeof obj.prefer_model === 'string' ? obj.prefer_model.trim().toLowerCase() : '';
        if (['opus', 'sonnet', 'haiku'].includes(pm))
            prefer_model = pm;
        // parameters_json — keep only if a non-empty plain object.
        let parameters_json = '';
        if (obj.parameters_json && typeof obj.parameters_json === 'object' && !Array.isArray(obj.parameters_json)) {
            if (Object.keys(obj.parameters_json).length > 0) {
                try {
                    parameters_json = JSON.stringify(obj.parameters_json);
                }
                catch {
                    parameters_json = '';
                }
            }
        }
        // Interactive checkpoints can't be answered on an unattended scheduled run
        // (the fire has no user), so they'd stall — they only pause when the user
        // chats in the tab. Flag the combination rather than silently breaking it.
        if (schedule_cron && stopping_points && delivery_mode === 'console') {
            warnings.push('This skill has interactive stopping points AND a schedule. Scheduled runs are unattended — nobody can answer a checkpoint, so a scheduled fire may stall (they only pause when you chat in the tab). For unattended review use channel delivery, or remove the stopping points.');
        }
        res.json({
            display_name: display_name || name.replace(/-/g, ' '),
            name,
            prompt_template,
            schedule_cron: schedule_cron || '',
            required_tools,
            delivery_mode,
            delivery_target,
            ephemeral,
            history_window,
            stopping_points,
            prefer_model,
            parameters_json,
            warnings,
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[skill-console-draft]', msg);
        res.status(500).json({ error: msg });
    }
});
