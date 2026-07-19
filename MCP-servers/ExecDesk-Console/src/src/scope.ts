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


export interface Scope {
  /** 'integration' | 'skill' | 'flow' | other future types */
  type: string;
  /** server name for app/MCP scope, skill id for skills, etc. */
  id: string;
  /** The full scope string, e.g. `workbench:integration:linear` */
  raw: string;
}

/**
 * Parse a conversation `source` string into a Scope.
 * Returns null for unscoped sources (`web`, null, `channel:*`, etc).
 */
export function resolveScope(source: string | null | undefined): Scope | null {
  if (!source || !source.startsWith('workbench:')) return null;
  const parts = source.split(':');
  if (parts.length < 3) return null;
  const type = parts[1];
  const id = parts.slice(2).join(':');
  if (!type || !id) return null;
  return { type, id, raw: source };
}

/**
 * Build the scope-specific system prompt suffix. Appended to the base prompt
 * when a scoped conversation is active. Keep short — large suffixes eat cache.
 */
export function buildScopeSuffix(scope: Scope): string {
  switch (scope.type) {
    case 'integration':
      return (
        `You are currently scoped to the **${scope.id}** MCP server. ` +
        `When the user asks for something, prefer tools on that server: ` +
        `call \`vodou_core_call\` with \`server: "${scope.id}"\`. ` +
        `If the request clearly belongs to a different server, answer briefly and suggest opening that server's workbench.`
      );
    case 'skill':
      // Skill conversations route through the skill_message WS handler →
      // chatWithSkill — they never reach this function. This branch only
      // fires if a skill scope somehow lands in chat() (e.g. legacy code path).
      return (
        `You are currently scoped to the **${scope.id}** skill. ` +
        `Follow the skill's stopping points and tool sequence exactly.`
      );
    case 'flow':
      return (
        `You are currently scoped to the **${scope.id}** flow. ` +
        `Run the flow's steps in order; pause at checkpoints.`
      );
    case 'automation':
      return (
        `You are currently scoped to **automation #${scope.id}**. ` +
        `The user pinned this automation's run feed to the main chat. ` +
        `They may ask questions about its config, review past runs, or ` +
        `ask you to trigger it immediately. To trigger a run, tell the user ` +
        `to type \`/run\` — the client intercepts that slash command and ` +
        `advances the automation's \`next_run_at\` so the engine picks it up ` +
        `on its next tick (≤60s). Specific config and recent run history ` +
        `for this automation are appended below.`
      );
    case 'channel':
      return (
        `You are currently scoped to the **${scope.id}** messaging channel ` +
        `(Telegram / Slack / Discord / WhatsApp / iMessage). The user may ` +
        `ask about channel status, recent conversations, connected senders, ` +
        `or the allowlist. Use \`vodou_core_call\` with \`server: "Vodou-channels"\` ` +
        `for channel operations. If the user wants to change credentials or ` +
        `the setup itself, suggest they click the gear icon on this channel's ` +
        `sidebar nav item to open the settings modal.`
      );
    default:
      return `You are currently scoped to **${scope.raw}**. Stay on topic.`;
  }
}
