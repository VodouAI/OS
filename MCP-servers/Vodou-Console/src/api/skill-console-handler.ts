// PLAN-SKILL-CONSOLE-LOOP §15 spike + §31 Phase 2 — skill console plumbing.
//
// Spike (§15): minimal binding lookup + template render of {{user_message}}.
// Phase 2 (§31): activate the Phase 1 schema slots —
//   - prefer_model: per-skill model override (passed via ChatOptions)
//   - history_window: prepend last N gateway_messages turns
//   - delivery_mode='channel': route assistant turn to a channel id
//   - ephemeral: auto-disable skill after first reply
//
// §20.1 invoke_skill + §20.2 params + §20.4 completion hook — skill-template-expand.ts

import { scheduleNameFor, schedulePayloadTypeFor } from '../skill-kind.js';
import type { DB } from '../db.js';
import { chat } from '../llm.js';
import type { StreamCallback } from '../llm.js';
import { VodouCore } from '../core-client.js';
import { resolveSkillCronExpression } from './nl-cron.js';
import { expandSkillPrompt, expandInvokeToolAndRecall, mergeSkillParams } from './skill-template-expand.js';
import { clearWorkflow, getActiveWorkflowMenuMarkdown, parseWorkflowStoppingPointsJson } from '../workflow-driver.js';

/** Full skill row, including Phase 1 polish columns + §20 fields. */
export interface SkillRow {
    id: number;
    name: string;
    display_name: string;
    prompt_template: string;
    is_active: number;
    prefer_model: string | null;
    delivery_mode: string;       // 'console' | 'channel' | 'broadcast'
    delivery_target: string | null;
    history_window: number;
    ephemeral: number;
    principal_id: string;
    parameters_json: string | null;
    param_overrides_json: string | null;
    on_complete_hook: string | null;
    /** PLAN §27 Layer B — JSON same shape as unified AGENT_ACTIONS */
    stopping_points_json: string | null;
    /**
     * PLAN-ALPHA F3 — declared `server/tool` contract (JSON array, or null for
     * "declares nothing", which stays legal and unrestricted).
     */
    required_tools: string | null;
    current_phase: number;
}

/**
 * Check if a conversation is bound to a skill. Cheap single-row lookup.
 * Returns the skill metadata if a binding exists, null otherwise.
 *
 * NOTE: returns disabled (is_active=0) skills too — the caller must check
 * `is_active` to decide whether to route message turns through the skill's
 * prompt template. We surface disabled bindings so slash commands like
 * `/enable` and `/snapshot` still work in the disabled tab; otherwise once
 * a user `/disable`d a skill, they could never re-enable it from chat.
 *
 * The Phase 1 polish columns (prefer_model, delivery_mode, etc.) are pulled
 * with COALESCE so legacy rows missing the columns still work — though after
 * the migration runs in initGatewaySchema, every row will have them.
 */
export function lookupSkillBinding(db: DB, conversationId: string): SkillRow | null {
    try {
        const row = db.prepare(`
            SELECT
                s.id,
                s.name,
                s.display_name,
                s.prompt_template,
                s.is_active,
                s.prefer_model,
                COALESCE(s.delivery_mode, 'console') AS delivery_mode,
                s.delivery_target,
                COALESCE(s.history_window, 0) AS history_window,
                COALESCE(s.ephemeral, 0) AS ephemeral,
                s.principal_id,
                s.parameters_json,
                s.param_overrides_json,
                s.on_complete_hook,
                s.stopping_points_json,
                -- PLAN-ALPHA F3 — the skill's declared tool contract, read here
                -- so /chat/skill-fire can resolve it BEFORE spending a turn.
                s.required_tools,
                COALESCE(s.current_phase, 0) AS current_phase
            FROM skill_console_bindings b
            JOIN skills_meta s ON s.id = b.skill_id
            WHERE b.conversation_id = ?
            LIMIT 1
        `).get(conversationId) as SkillRow | undefined;
        return row ?? null;
    } catch {
        // Tables may not exist yet on a pre-spike gateway.db — treat as no binding.
        return null;
    }
}

/**
 * Render the skill's prompt_template with user message + optional history.
 * For skills without invoke_skill / param, same as legacy replace-only path.
 */
export function renderTemplate(
    template: string,
    ctx: { userMessage: string; conversationId: string; history?: string },
): string {
    return template
        .replace(/\{\{\s*user_message\s*\}\}/g, ctx.userMessage)
        .replace(/\{\{\s*now\s*\}\}/g, new Date().toISOString())
        .replace(/\{\{\s*conversation_id\s*\}\}/g, ctx.conversationId)
        .replace(/\{\{\s*history\s*\}\}/g, ctx.history ?? '');
}

/**
 * Phase 2 — load the last N user/assistant turns from gateway_messages for
 * this conversation, formatted as a plain-text transcript suitable for
 * prepending to the rendered prompt. Returns empty string if N=0 or no rows.
 *
 * The current user message is excluded (it lives in {{user_message}}).
 */
export function loadHistoryWindow(db: DB, conversationId: string, n: number): string {
    if (n <= 0) return '';
    try {
        // gateway_messages columns: id, conversation_id, role, content, created_at
        // Pull the most recent 2*N rows (user + assistant pairs), then reverse
        // chronologically when formatting. The N filter is loose — short
        // conversations just emit fewer turns.
        const rows = db.prepare(`
            SELECT role, content
            FROM gateway_messages
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT ?
        `).all(conversationId, n * 2) as Array<{ role: string; content: string }>;
        if (rows.length === 0) return '';
        const lines = rows.reverse().map(r => {
            const tag = r.role === 'assistant' ? 'Assistant' : 'User';
            const truncated = r.content.length > 1000 ? r.content.substring(0, 1000) + '…' : r.content;
            return `${tag}: ${truncated}`;
        });
        return `--- prior turns (${rows.length}) ---\n${lines.join('\n')}\n--- end ---`;
    } catch {
        return '';
    }
}

/**
 * Phase 2 — flip is_active=0 on an ephemeral skill after its first reply.
 * Idempotent: hits at most one row by primary key. Returns true on success.
 */
export function disableEphemeralSkill(db: DB, skillId: number): boolean {
    try {
        const r = db.prepare(`UPDATE skills_meta SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ephemeral = 1`).run(skillId);
        return r.changes > 0;
    } catch {
        return false;
    }
}

/**
 * Parse a delivery_target like "slack:C123" / "telegram:987" / "discord:42" into
 * { source, recipient }. Returns null on malformed input.
 */
export function parseDeliveryTarget(target: string | null): { source: string; recipient: string } | null {
    if (!target) return null;
    const idx = target.indexOf(':');
    if (idx <= 0 || idx === target.length - 1) return null;
    return {
        source: target.substring(0, idx).toLowerCase().trim(),
        recipient: target.substring(idx + 1).trim(),
    };
}

/**
 * Compose the chat() invocation with all Phase 2 overrides applied.
 * This is a thin convenience wrapper around chat() that:
 *   1. Loads history if history_window > 0 and prepends as {{history}}
 *   2. Renders the skill's prompt_template
 *   3. Forwards prefer_model via ChatOptions
 *
 * Channel delivery + ephemeral cleanup happen in the caller's onEvent('done')
 * because they need the assembled assistant text.
 */
export async function buildSkillChatArgs(
    db: DB,
    conversationId: string,
    userMessage: string,
    skill: SkillRow,
    runParamOverrides: Record<string, string> = {},
): Promise<{ renderedPrompt: string; preferModel: string | null }> {
    const history = loadHistoryWindow(db, conversationId, skill.history_window);
    const hasAdvanced =
        /\{\{\s*invoke_skill:/i.test(skill.prompt_template) ||
        /\{\{\s*param:/i.test(skill.prompt_template);
    let renderedPrompt = hasAdvanced
        ? expandSkillPrompt(db, {
              template: skill.prompt_template,
              conversationId,
              userMessage,
              history,
              principalId: skill.principal_id,
              parametersJson: skill.parameters_json,
              paramOverridesJson: skill.param_overrides_json,
              runParamOverrides,
              skillId: skill.id,
          })
        : renderTemplate(skill.prompt_template, { userMessage, conversationId, history });

    if (
        /\{\{\s*invoke_tool:/i.test(renderedPrompt) ||
        /\{\{\s*invoke_script:/i.test(renderedPrompt) ||
        /\{\{\s*invoke_recall:/i.test(renderedPrompt)
    ) {
        renderedPrompt = await expandInvokeToolAndRecall(
            renderedPrompt,
            { principalId: skill.principal_id, conversationId },
            {
                callTool: async (server, tool, args) => {
                    const r = await VodouCore.callTool(server, tool, args);
                    return r.result;
                },
                recall: (req) => VodouCore.memoryRecall(req),
            },
        );
    }

    return {
        renderedPrompt,
        preferModel: skill.prefer_model,
    };
}

// Backwards-compat shim used by the §15 spike harness; safe to leave in place.
export async function handleSkillConsoleMessage(args: {
    res: import('express').Response;
    conversationId: string;
    skill: SkillRow;
    userMessage: string;
    onEvent: any;
}): Promise<string> {
    const { conversationId, skill, userMessage, onEvent } = args;
    const renderedPrompt = renderTemplate(skill.prompt_template, {
        userMessage,
        conversationId,
    });
    return await chat(conversationId, renderedPrompt, onEvent);
}

// ─── Slash commands (PLAN-SKILL-CONSOLE-LOOP §32 → Phase 2 Tier 2) ──────────────
//
// Slash commands give the user direct control over their skill from inside the
// skill's own chat tab. They're parsed BEFORE the message reaches the LLM, so
// they're zero-cost (no API tokens) and instant.
//
// Supported commands:
//   /help              — show this list + the skill's current settings
//   /snapshot          — show current prompt_template + all metadata
//   /disable           — flip is_active=0 (skill stops responding; tab still visible)
//   /enable            — flip is_active=1 (re-arms a disabled or ephemeral skill)
//   /refine <new>      — replace prompt_template (saves old to prompt_history)
//   /cron <expr|off>   — set or clear schedule_cron (Phase 3 wires firing)
//   /history <N>       — set history_window (0..50)
//   /model <name|off>  — set or clear prefer_model

export interface SlashCommandResult {
    response: string;        // assistant-side reply, saved + returned to client
    skillRefreshed: boolean; // true if skill state changed (UI may re-fetch sidebar)
}

/**
 * If `message` starts with '/', parse + execute as a slash command.
 * Returns null if the message is not a slash command (caller should fall through
 * to normal LLM chat). Returns a SlashCommandResult on handled commands —
 * including unknown-command error replies, so the LLM is never called.
 */
export async function handleSlashCommand(
    db: DB,
    skill: SkillRow,
    conversationId: string,
    message: string,
): Promise<SlashCommandResult | null> {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;

    const firstSpace = trimmed.indexOf(' ');
    const cmd = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase();
    const arg = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

    switch (cmd) {
        case 'help':
            return { response: slashHelpText(skill), skillRefreshed: false };
        case 'snapshot':
        case 'show':
        case 'info':
            return { response: slashSnapshotText(skill), skillRefreshed: false };
        case 'disable':
        case 'off':
            return slashDisable(db, skill);
        case 'enable':
        case 'on':
            return slashEnable(db, skill);
        case 'refine':
        case 'edit':
            return slashRefine(db, skill, arg);
        case 'cron':
        case 'schedule':
            return await slashCron(db, skill, conversationId, arg);
        case 'history':
        case 'window':
            return slashHistory(db, skill, arg);
        case 'model':
            return slashModel(db, skill, arg);
        case 'clone':
        case 'dup':
            return slashClone(db, skill, arg);
        case 'set-param':
        case 'setparam':
            return slashSetParam(db, skill, arg);
        case 'show-params':
        case 'params':
            return slashShowParams(skill);
        case 'hook':
        case 'complete-hook':
            return slashHook(db, skill, arg);
        case 'menu':
            return slashLayerBMenu(skill, conversationId);
        case 'phase':
            return slashLayerBPhase(db, skill, conversationId, arg);
        default:
            // Not a skill-console command. Return null so the caller lets the
            // message fall through to normal LLM/server routing. This handler
            // only owns the skill-console verbs above — global slash commands
            // like `/server` and `/skill` must NOT be intercepted here just
            // because the conversation happens to have a skill bound. (Was
            // returning an "Unknown command" error, which swallowed `/server`
            // in any skill-bound tab.)
            return null;
    }
}

function slashHelpText(skill: SkillRow): string {
    return [
        `**Skill Console — \`${skill.name}\`** (${skill.is_active ? 'active' : 'disabled'})`,
        ``,
        `Slash commands:`,
        `  \`/help\` — this list`,
        `  \`/snapshot\` — full settings (prompt template, model, history, cron, etc.)`,
        `  \`/disable\` — turn this skill off (stops responding; tab stays)`,
        `  \`/enable\` — turn it back on`,
        `  \`/refine <new prompt template>\` — replace the prompt template`,
        `  \`/cron <expression>\` or \`/cron off\` — cron (\`0 9 * * *\`), @hourly, or English (\`every weekday at 9am\`)`,
        `  \`/clone <new-name> [display name]\` — duplicate this skill into a new console`,
        `  \`/history <0..50>\` — how many prior turns to inject as context`,
        `  \`/model <name>\` or \`/model off\` — override LLM model for this skill`,
        `  \`/run key=value ...\` prefix on a message — one-shot param overrides (see §20.2)`,
        `  \`/set-param name=value\` — persist default param for future runs`,
        `  \`/show-params\` — effective \`{{param:…}}\` values`,
        `  \`/hook invoke_skill:child-name\` or \`/hook off\` — §20.4 follow-up skill after each reply`,
        `  \`/menu\` — show the guided-step menu again (when this skill uses numbered options)`,
        `  \`/phase\` — show phase; \`/phase reset\` — restart menus; \`/phase skip\` — advance without choosing`,
        ``,
        `Template tags (pre-LLM):`,
        `  \`{{invoke_tool:server::tool|args}}\` — MCP tool via vodou-core (args: JSON object, incl. nested, or comma key=value)`,
        `  \`{{invoke_script:reg_server::script_name|params}}\` — registered script via Vodou-script-executor (same pipe format as tool; params → execute_script)`,
        `  \`{{invoke_recall:query|k=5|scope=conversation}}\` — memory recall (k optional; scope=conversation default, or scope=all)`,
        ``,
        `Anything not starting with \`/\` is sent to the skill's prompt as \`{{user_message}}\`.`,
    ].join('\n');
}

function slashSnapshotText(skill: SkillRow): string {
    const merged = mergeSkillParams(
        skill.parameters_json,
        skill.param_overrides_json,
        {},
    );
    const paramLines =
        Object.keys(merged).length > 0
            ? Object.entries(merged)
                  .map(([k, v]) => `  - \`${k}\`: ${v}`)
                  .join('\n')
            : '  _(none — set \`parameters_json\` on create or /set-param)_';
    const lines = [
        `**${skill.display_name}** (\`${skill.name}\`, id=${skill.id})`,
        `Status: ${skill.is_active ? '🟢 active' : '⚪ disabled'}${skill.ephemeral ? ' · ephemeral' : ''}`,
        `Delivery: \`${skill.delivery_mode}\`${skill.delivery_target ? ` → ${skill.delivery_target}` : ''}`,
        `Model: ${skill.prefer_model ? `\`${skill.prefer_model}\`` : '(smart routing default)'}`,
        `History window: ${skill.history_window} turn${skill.history_window === 1 ? '' : 's'}`,
        `Completion hook: ${skill.on_complete_hook ? `\`${skill.on_complete_hook}\`` : '(none)'}`,
        `Guided steps: phase ${skill.current_phase ?? 0} · menu config: ${skill.stopping_points_json ? 'yes (`…`)' : 'no'}`,
        `parameters_json: ${skill.parameters_json ? '`…`' : '(null)'}`,
        `param_overrides_json: ${skill.param_overrides_json ? '`…`' : '(null)'}`,
        ``,
        `**Effective {{param:}} values:**`,
        paramLines,
        ``,
        `**Prompt template:**`,
        '```',
        skill.prompt_template,
        '```',
    ];
    return lines.join('\n');
}

function slashDisable(db: DB, skill: SkillRow): SlashCommandResult {
    if (!skill.is_active) {
        return { response: `Skill \`${skill.name}\` is already disabled.`, skillRefreshed: false };
    }
    db.prepare(`UPDATE skills_meta SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.id);
    return {
        response: `🛑 Disabled \`${skill.name}\`. New messages in this tab will fall through to generic chat. Type \`/enable\` to re-arm.`,
        skillRefreshed: true,
    };
}

function slashEnable(db: DB, skill: SkillRow): SlashCommandResult {
    if (skill.is_active) {
        return { response: `Skill \`${skill.name}\` is already active.`, skillRefreshed: false };
    }
    db.prepare(`UPDATE skills_meta SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.id);
    return {
        response: `🟢 Re-enabled \`${skill.name}\`. Messages route through the skill prompt again.`,
        skillRefreshed: true,
    };
}

function slashRefine(db: DB, skill: SkillRow, newTemplate: string): SlashCommandResult {
    if (!newTemplate) {
        return {
            response: `Usage: \`/refine <new prompt template>\` — must include \`{{user_message}}\` somewhere.`,
            skillRefreshed: false,
        };
    }
    // Match /create (skill-console-create.ts): if the template omits
    // {{user_message}}, auto-append it rather than silently saving a template
    // that drops user input and renders the skill inert.
    let finalTemplate = newTemplate;
    if (!/\{\{\s*user_message\s*\}\}/i.test(finalTemplate)) {
        finalTemplate = `${finalTemplate.trim()}\n\nUser message: {{user_message}}`;
    }
    if (finalTemplate.length < 20 || finalTemplate.length > 8000) {
        return {
            response: `Refusing: prompt template must be 20–8000 chars (got ${finalTemplate.length}).`,
            skillRefreshed: false,
        };
    }
    if (finalTemplate.includes('{{principal_id}}') || finalTemplate.includes('{{token}}')) {
        return {
            response: `Refusing: prompt template may not reference \`{{principal_id}}\` or \`{{token}}\` (security gate).`,
            skillRefreshed: false,
        };
    }
    // Append previous template to prompt_history (newline-delimited) for /undo + audit.
    db.prepare(`
        UPDATE skills_meta
        SET prompt_template = ?,
            prompt_history = COALESCE(prompt_history, '') || ? ,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(finalTemplate, `\n--- ${new Date().toISOString()} ---\n${skill.prompt_template}`, skill.id);
    return {
        response: `✏️ Updated \`${skill.name}\`'s prompt template (${finalTemplate.length} chars). Previous version saved to prompt_history.`,
        skillRefreshed: true,
    };
}

// PLAN-SKILL-CONSOLE-LOOP §32 Phase 3 — /cron write-through.
// The cron arg is mirrored into skills_meta.schedule_cron AND registered as a
// real scheduled_tasks row in vodou-core.db (payload_type='skill_run', payload
// JSON {skill_id, conversation_id}). The Rust scheduler's skill_run branch
// renders the prompt and POSTs to /chat/skill-fire.
//
// Task naming convention: "skill:<skill.name>" — guarantees 1:1 with the skill
// and lets us delete-then-add for cron updates (no PATCH endpoint exists).
async function slashCron(db: DB, skill: SkillRow, conversationId: string, arg: string): Promise<SlashCommandResult> {
    const taskName = scheduleNameFor({ kind: 'console', name: skill.name, id: skill.id, active: true });
    const isOff = !arg || ['off', 'none', 'clear'].includes(arg.toLowerCase());

    // Always tear down any existing skill:<name> task before re-registering.
    let deleted = false;
    try {
        const tasks = await VodouCore.listSchedule();
        const existing = tasks.tasks.find(t => t.name === taskName);
        if (existing) {
            await VodouCore.removeScheduleTask(existing.id);
            deleted = true;
        }
    } catch (e) {
        return {
            response: `Couldn't reach vodou-core scheduler: ${(e as Error).message}. Cron not changed.`,
            skillRefreshed: false,
        };
    }

    if (isOff) {
        db.prepare(`UPDATE skills_meta SET schedule_cron = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.id);
        return {
            response: deleted
                ? `🚫 Cleared cron for \`${skill.name}\` and removed scheduled task.`
                : `🚫 Cleared cron for \`${skill.name}\` (no scheduled task was registered).`,
            skillRefreshed: true,
        };
    }

    let cronExpr: string;
    let nlNote = '';
    try {
        const r = resolveSkillCronExpression(arg);
        cronExpr = r.cron;
        if (r.nlSource) nlNote = ` — parsed from \`${r.nlSource}\``;
    } catch (e) {
        return {
            response: `❌ ${(e as Error).message}`,
            skillRefreshed: false,
        };
    }

    const payload = JSON.stringify({ skill_id: skill.id, conversation_id: conversationId });
    try {
        await VodouCore.addScheduleTask({
            name: taskName,
            schedule: cronExpr,
            schedule_type: 'cron',
            payload_type: schedulePayloadTypeFor({ kind: 'console', name: skill.name, id: skill.id, active: true }),
            payload,
        });
    } catch (e) {
        return {
            response: `Schedule validated but vodou-core rejected the task: ${(e as Error).message}.`,
            skillRefreshed: false,
        };
    }

    db.prepare(`UPDATE skills_meta SET schedule_cron = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(cronExpr, skill.id);
    return {
        response: `⏰ Set cron for \`${skill.name}\` to \`${cronExpr}\`${nlNote}. Scheduler will fire it into this tab.`,
        skillRefreshed: true,
    };
}

function slashHistory(db: DB, skill: SkillRow, arg: string): SlashCommandResult {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 0 || n > 50) {
        return {
            response: `Usage: \`/history <0..50>\` — how many prior turns to inject as \`{{history}}\` context. Got: \`${arg}\``,
            skillRefreshed: false,
        };
    }
    db.prepare(`UPDATE skills_meta SET history_window = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(n, skill.id);
    return {
        response: n === 0
            ? `📭 Disabled history injection for \`${skill.name}\` (stateless turns).`
            : `📜 Set history_window for \`${skill.name}\` to ${n} turn${n === 1 ? '' : 's'}. Prior conversation gets prepended via \`{{history}}\`.`,
        skillRefreshed: true,
    };
}

// PLAN-SKILL-CONSOLE-LOOP §32 Phase 3 — /clone duplicates a skill.
// Atomic 3-row insert mirroring vc_skills_create (skills_meta + gateway_conversations
// + skill_console_bindings). The new skill inherits the source's prompt template,
// model, history window, delivery mode/target, output format, and parameters.
// schedule_cron is NOT copied — clones start unscheduled (use /cron to set a new one).
// Ephemeral flag is also dropped so clones don't auto-disable on first reply.
// Layer B: stopping_points_json copied; current_phase starts at 0.
function formatLayerBMenuStatic(
    parsed: NonNullable<ReturnType<typeof parseWorkflowStoppingPointsJson>>,
    phaseIndex: number,
): string {
    const n = parsed.stoppingPoints.length;
    const ph = Math.min(Math.max(0, phaseIndex), Math.max(0, n - 1));
    const sp = parsed.stoppingPoints[ph];
    if (sp.type === 'text_input') {
        return `${sp.title}\n\n*(Type your answer)*`;
    }
    let m = `## ${sp.title}\n\n`;
    for (const [k, opt] of Object.entries(sp.options)) {
        m += `${k}. ${opt.label}\n`;
    }
    return m.trim();
}

function slashLayerBMenu(skill: SkillRow, conversationId: string): SlashCommandResult {
    const live = getActiveWorkflowMenuMarkdown(conversationId);
    if (live) {
        return { response: live, skillRefreshed: false };
    }
    const p = parseWorkflowStoppingPointsJson(skill.stopping_points_json);
    if (!p?.stoppingPoints.length) {
        return {
            response: 'No `stopping_points_json` on this skill — Layer B engine menus are not configured.',
            skillRefreshed: false,
        };
    }
    return {
        response: formatLayerBMenuStatic(p, skill.current_phase ?? 0),
        skillRefreshed: false,
    };
}

function slashLayerBPhase(db: DB, skill: SkillRow, conversationId: string, arg: string): SlashCommandResult {
    const p = parseWorkflowStoppingPointsJson(skill.stopping_points_json);
    const n = p?.stoppingPoints.length ?? 0;
    const a = arg.trim().toLowerCase();
    if (n === 0) {
        return {
            response: 'No stopping points (Layer B). Set `stopping_points` when creating the skill or leave unset.',
            skillRefreshed: false,
        };
    }
    if (!a) {
        return {
            response: `**Layer B phase:** \`${skill.current_phase ?? 0}\` (${n} menu phase(s)). Use \`/phase reset\`, \`/phase skip\`, \`/menu\`.`,
            skillRefreshed: false,
        };
    }
    if (a === 'reset') {
        db.prepare(`UPDATE skills_meta SET current_phase = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.id);
        clearWorkflow(conversationId);
        return { response: '🔄 Phase reset to 0. In-memory workflow cleared.', skillRefreshed: true };
    }
    if (a === 'skip') {
        const cur = skill.current_phase ?? 0;
        const nextPh = Math.min(cur + 1, n);
        db.prepare(`UPDATE skills_meta SET current_phase = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextPh, skill.id);
        clearWorkflow(conversationId);
        return {
            response:
                nextPh >= n
                    ? `⏭ Phase set to ${nextPh} (past last menu). Next message uses the normal LLM skill prompt.`
                    : `⏭ Phase advanced to \`${nextPh}\`. Send a message to continue.`,
            skillRefreshed: true,
        };
    }
    return { response: 'Usage: `/phase`, `/phase reset`, `/phase skip`.', skillRefreshed: false };
}

function slashClone(db: DB, skill: SkillRow, arg: string): SlashCommandResult {
    const parts = arg.split(/\s+/);
    const newName = parts[0]?.trim();
    const newDisplay = parts.slice(1).join(' ').trim() || `${skill.display_name} (clone)`;

    if (!newName) {
        return {
            response: `Usage: \`/clone <new-name> [display name]\` — e.g. \`/clone daily-recap-v2 "Daily Recap (revised)"\``,
            skillRefreshed: false,
        };
    }
    if (!/^[a-z][a-z0-9-]{2,40}$/.test(newName)) {
        return {
            response: `Refusing: name must match \`^[a-z][a-z0-9-]{2,40}$\` (lowercase, dash-separated, 3–41 chars). Got \`${newName}\`.`,
            skillRefreshed: false,
        };
    }

    // Pull the full source row — SkillRow alone doesn't carry every column.
    const src = db.prepare(`
        SELECT prompt_template, output_format, principal_id, prefer_model, delivery_mode,
               delivery_target, required_tools, parameters_json, param_overrides_json, history_window,
               stopping_points_json
        FROM skills_meta WHERE id = ?
    `).get(skill.id) as {
        prompt_template: string;
        output_format: string;
        principal_id: string;
        prefer_model: string | null;
        delivery_mode: string;
        delivery_target: string | null;
        required_tools: string | null;
        parameters_json: string | null;
        param_overrides_json: string | null;
        history_window: number;
        stopping_points_json: string | null;
    } | undefined;
    if (!src) {
        return { response: `Source skill row vanished (id=${skill.id}).`, skillRefreshed: false };
    }

    const taken = db.prepare(`SELECT 1 FROM skills_meta WHERE name = ?`).get(newName);
    if (taken) {
        return { response: `Refusing: skill name \`${newName}\` already exists.`, skillRefreshed: false };
    }

    const newConvId = `workbench:skill-console:${newName}`;
    try {
        db.exec('BEGIN');
        const insert = db.prepare(`
            INSERT INTO skills_meta (
                name, display_name, prompt_template, output_format, principal_id,
                prefer_model, delivery_mode, delivery_target, required_tools,
                parameters_json, param_overrides_json, history_window,
                stopping_points_json, current_phase
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
            newName, newDisplay, src.prompt_template, src.output_format, src.principal_id,
            src.prefer_model, src.delivery_mode, src.delivery_target, src.required_tools,
            src.parameters_json, src.param_overrides_json, src.history_window,
            src.stopping_points_json,
        );
        const newSkillId = Number(insert.lastInsertRowid);

        db.prepare(`
            INSERT OR IGNORE INTO gateway_conversations
                (id, title, source, sender_name, conversation_type, principal_id)
            VALUES (?, ?, 'skill-console', ?, 'skill_console', ?)
        `).run(newConvId, newDisplay, newDisplay, src.principal_id);

        db.prepare(`
            INSERT INTO skill_console_bindings (conversation_id, skill_id) VALUES (?, ?)
        `).run(newConvId, newSkillId);

        db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        return { response: `Clone failed: ${(e as Error).message}`, skillRefreshed: false };
    }

    return {
        response: `🧬 Cloned \`${skill.name}\` → \`${newName}\`. New tab \`${newConvId}\` is live; type \`/cron\` there to schedule it.`,
        skillRefreshed: true,
    };
}

function slashModel(db: DB, skill: SkillRow, arg: string): SlashCommandResult {
    if (!arg || arg.toLowerCase() === 'off' || arg.toLowerCase() === 'none' || arg.toLowerCase() === 'clear') {
        db.prepare(`UPDATE skills_meta SET prefer_model = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.id);
        return { response: `🧠 Cleared model override for \`${skill.name}\`. Smart routing decides per turn.`, skillRefreshed: true };
    }
    db.prepare(`UPDATE skills_meta SET prefer_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(arg, skill.id);
    return {
        response: `🧠 Set model override for \`${skill.name}\` to \`${arg}\`. Smart routing skipped for this skill.`,
        skillRefreshed: true,
    };
}

function parseParamOverridesJson(raw: string | null): Record<string, string> {
    if (!raw?.trim()) return {};
    try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = String(v);
        return out;
    } catch {
        return {};
    }
}

function slashSetParam(db: DB, skill: SkillRow, arg: string): SlashCommandResult {
    const m = /^([a-z0-9_]+)\s*=\s*(.+)$/i.exec(arg.trim());
    if (!m) {
        return {
            response: `Usage: \`/set-param topic=Acme\` — persists a default for \`{{param:topic}}\`.`,
            skillRefreshed: false,
        };
    }
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
    ) {
        val = val.slice(1, -1);
    }
    const cur = parseParamOverridesJson(skill.param_overrides_json);
    cur[key] = val;
    const json = JSON.stringify(cur);
    db.prepare(
        `UPDATE skills_meta SET param_overrides_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(json, skill.id);
    return {
        response: `📌 Saved default \`{{param:${key}}}\` = \`${val}\` for future runs (still overridable with \`/run ${key}=…\`).`,
        skillRefreshed: true,
    };
}

function slashShowParams(skill: SkillRow): SlashCommandResult {
    const merged = mergeSkillParams(skill.parameters_json, skill.param_overrides_json, {});
    if (Object.keys(merged).length === 0) {
        return {
            response:
                'No parameters declared. Set `parameters_json` when creating the skill (or use `/set-param name=value` to seed overrides).',
            skillRefreshed: false,
        };
    }
    const lines = Object.entries(merged).map(([k, v]) => `- \`{{param:${k}}}\` → ${v}`);
    return { response: `**Effective parameters**\n${lines.join('\n')}`, skillRefreshed: false };
}

function slashHook(db: DB, skill: SkillRow, arg: string): SlashCommandResult {
    const a = arg.trim();
    if (!a || ['off', 'none', 'clear'].includes(a.toLowerCase())) {
        db.prepare(`UPDATE skills_meta SET on_complete_hook = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.id);
        return { response: `🔕 Cleared completion hook on \`${skill.name}\`.`, skillRefreshed: true };
    }
    const inv = /^invoke_skill:\s*([a-z][a-z0-9-]{2,40})\s*$/i.exec(a);
    const bare = /^([a-z][a-z0-9-]{2,40})$/.exec(a);
    const target = inv ? inv[1] : bare ? bare[1] : '';
    if (!target) {
        return {
            response: `Usage: \`/hook invoke_skill:child-skill\` or \`/hook child-skill\` or \`/hook off\`.`,
            skillRefreshed: false,
        };
    }
    const stored = `invoke_skill:${target}`;
    db.prepare(`UPDATE skills_meta SET on_complete_hook = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        stored,
        skill.id,
    );
    return {
        response: `🔗 After each reply from \`${skill.name}\`, the gateway will run \`${stored}\` once (same tab; hook target has no chained hook).`,
        skillRefreshed: true,
    };
}

/**
 * §20.4 — run a follow-up skill after the parent assistant turn completes.
 * Caller supplies chat StreamCallback (e.g. WS broadcast + persistence) and optional beforeChat.
 */
export async function runSkillConsoleCompletionHook(
    db: DB,
    conversationId: string,
    parentSkill: SkillRow,
    priorAssistantText: string,
    onEvent: StreamCallback,
    opts?: { beforeChat?: (childName: string) => void },
): Promise<void> {
    const hook = parentSkill.on_complete_hook?.trim();
    if (!hook || !priorAssistantText.trim()) return;

    let childName = hook;
    const im = /^invoke_skill:\s*([a-z][a-z0-9-]{2,40})\s*$/i.exec(hook);
    if (im) childName = im[1];
    else if (!/^[a-z][a-z0-9-]{2,40}$/.test(hook)) return;

    if (childName === parentSkill.name) {
        console.error('[SkillConsole] completion hook skipped (self-reference)');
        return;
    }

    const row = db
        .prepare(
            `
      SELECT
        s.id, s.name, s.display_name, s.prompt_template, s.is_active, s.prefer_model,
        COALESCE(s.delivery_mode, 'console') AS delivery_mode,
        s.delivery_target,
        COALESCE(s.history_window, 0) AS history_window,
        COALESCE(s.ephemeral, 0) AS ephemeral,
        s.principal_id, s.parameters_json, s.param_overrides_json,
        s.on_complete_hook
      FROM skills_meta s
      WHERE s.name = ? AND s.principal_id = ? LIMIT 1
    `,
        )
        .get(childName, parentSkill.principal_id) as SkillRow | undefined;

    if (!row || !row.is_active) {
        console.error(`[SkillConsole] completion hook: missing or inactive skill '${childName}'`);
        return;
    }

    const childSkill: SkillRow = { ...row, on_complete_hook: null };
    const userMsg = `Follow-up after \`${parentSkill.name}\`:\n\n${priorAssistantText.slice(0, 20000)}`;
    const built = await buildSkillChatArgs(db, conversationId, userMsg, childSkill, {});
    opts?.beforeChat?.(childName);
    await chat(conversationId, built.renderedPrompt, onEvent, {
        ...(built.preferModel ? { preferModel: built.preferModel } : {}),
    });
}
