/**
 * Scope — identity of a conversation for scoped workbenches.
 *
 * A conversation's `source` field carries its scope. Strings starting with
 * `workbench:<type>:<id>` are scoped conversations (Apps / MCP servers, Skills,
 * Flows). Everything else (`web`, `channel:*`, null) is unscoped.
 *
 * Scope flows one-way: conversation.source → resolveScope() → Scope → passed
 * into chat() via ChatOptions → read by system prompt builder + executor.
 */
/**
 * Parse a conversation `source` string into a Scope.
 * Returns null for unscoped sources (`web`, null, `channel:*`, etc).
 */
export function resolveScope(source) {
    if (!source || !source.startsWith('workbench:'))
        return null;
    const parts = source.split(':');
    if (parts.length < 3)
        return null;
    const type = parts[1];
    const id = parts.slice(2).join(':');
    if (!type || !id)
        return null;
    return { type, id, raw: source };
}
/** Infra conversations that belong to no project and must never be filtered. */
const ALWAYS_GLOBAL = new Set(['vodou-heartbeat', 'board-chat']);
/**
 * The §2.2 absence table. Two rules, mechanically enforced:
 *   - OWNED + absent  ⇒ Default   (only where a single owner is genuinely known)
 *   - PINNED + absent ⇒ everywhere (never hides — the fail-open that keeps the 44
 *                                   untagged workbench surfaces reachable)
 */
export function scopeVisibility(raw, s) {
    if (!raw)
        return { mode: 'global' }; // fail-open (INV-3)
    if (ALWAYS_GLOBAL.has(raw))
        return { mode: 'global' };
    const scope = resolveScope(raw);
    if (!scope) {
        // Not a workbench string ⇒ a bare conversation id (a chat). OWNED.
        // NULL project_id genuinely means Default: conversation-store.ts
        // setConversationProject() WRITES NULL for proj_default, so this mirrors the
        // writer rather than guessing at it.
        return { mode: 'owned', projectId: s.conversationProject(raw) ?? 'proj_default' };
    }
    switch (scope.type) {
        case 'skill-console':
            return { mode: 'owned', projectId: s.conversationProject(raw) ?? 'proj_default' };
        // NEVER route this through a scheduled-task map. `workbench:automation:<id>`
        // carries an `automations` row id (vodou-core.db, api/automations.ts), while
        // project_tasks maps `scheduled_tasks` ids — two independent AUTOINCREMENT
        // sequences over two tables, and they collide: automation 4 is
        // mcp-ecosystem-watch, scheduled task 4 is vodou-heartbeat. Resolving an
        // automation through project_tasks would file it under a DIFFERENT OBJECT's
        // project: silent, plausible, and completely wrong. An earlier draft of the
        // plan specified exactly that. Automations have no owner, so they pin like any
        // other shared surface. See §1.4 and the id-collision guard test.
        case 'automation':
            return { mode: 'pinned', projectIds: s.scopeProjects(raw) };
        // Skills read project_skills by NAME while everything else pins by full scope
        // string. The asymmetry is deliberate: it keeps the existing skills curation as
        // the single source, so the dock and #/skills cannot diverge (INV-2).
        case 'skill':
            return { mode: 'pinned', projectIds: s.skillProjects(scope.id) };
        case 'channel':
        case 'integration':
        case 'flow':
            return { mode: 'pinned', projectIds: s.scopeProjects(raw) };
        default:
            return { mode: 'global' }; // unknown type ⇒ fail-open
    }
}
/** The single decision function, so no caller re-implements the comparison. */
export function isVisibleIn(v, projectId) {
    switch (v.mode) {
        case 'global':
            return true;
        case 'owned':
            return v.projectId === projectId;
        case 'pinned':
            return v.projectIds.length === 0 || v.projectIds.includes(projectId);
    }
}
/**
 * Build the scope-specific system prompt suffix. Appended to the base prompt
 * when a scoped conversation is active. Keep short — large suffixes eat cache.
 */
export function buildScopeSuffix(scope) {
    switch (scope.type) {
        case 'integration':
            return (`You are currently scoped to the **${scope.id}** MCP server. ` +
                `When the user asks for something, prefer tools on that server: ` +
                `call \`vodou_core_call\` with \`server: "${scope.id}"\`. ` +
                `If the request clearly belongs to a different server, answer briefly and suggest opening that server's workbench.`);
        case 'skill':
            // Skill conversations route through the skill_message WS handler →
            // chatWithSkill — they never reach this function. This branch only
            // fires if a skill scope somehow lands in chat() (e.g. legacy code path).
            return (`You are currently scoped to the **${scope.id}** skill. ` +
                `Follow the skill's stopping points and tool sequence exactly.`);
        case 'flow':
            return (`You are currently scoped to the **${scope.id}** flow. ` +
                `Run the flow's steps in order; pause at checkpoints.`);
        case 'automation':
            return (`You are currently scoped to **automation #${scope.id}**. ` +
                `The user pinned this automation's run feed to the main chat. ` +
                `They may ask questions about its config, review past runs, or ` +
                `ask you to trigger it immediately. To trigger a run, tell the user ` +
                `to type \`/run\` — the client intercepts that slash command and ` +
                `advances the automation's \`next_run_at\` so the engine picks it up ` +
                `on its next tick (≤60s). Specific config and recent run history ` +
                `for this automation are appended below.`);
        case 'channel':
            return (`You are currently scoped to the **${scope.id}** messaging channel ` +
                `(Telegram / Slack / Discord / WhatsApp / iMessage). The user may ` +
                `ask about channel status, recent conversations, connected senders, ` +
                `or the allowlist. Use \`vodou_core_call\` with \`server: "Vodou-channels"\` ` +
                `for channel operations. If the user wants to change credentials or ` +
                `the setup itself, suggest they click the gear icon on this channel's ` +
                `sidebar nav item to open the settings modal.`);
        default:
            return `You are currently scoped to **${scope.raw}**. Stay on topic.`;
    }
}
