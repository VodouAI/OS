/**
 * Anthropic Claude Client for Vodou-Console
 *
 * Architecture: BrainLoader-first.
 * 1. User message → vodou-core brain "<query>" (BrainLoader handles routing, params, parallel exec)
 * 2. Vodou results + user message → Claude CLI (conversational formatting)
 *
 * Claude is the conversational layer. Vodou is the intelligence layer.
 *
 * Version: 0.5.46 - BrainLoader-first architecture
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn, spawnSync, execSync } from 'child_process';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import net from 'net';
import path from 'path';
import { VODOU_TOOLS, getOpenAITools, isMenuReply as isMenuReplyCheck } from './tools.js';
import { executeOITool, runBrainRoute, callWorkerSocket, freshEnv } from './executor.js';
import { getConversationManager } from './conversation.js';
import { getProjectRoot, getSetting, getMemoryDb, getDb } from './db.js';
import { saveSkillState, loadSkillState, clearSkillState } from './conversation-store.js';
import { detectWorkflow, handleWorkflowChoice, hasActiveWorkflow, getActiveWorkflow, clearWorkflow, executeInitialSteps } from './workflow-driver.js';
import {
  appendChannelAttachmentHints,
  buildAnthropicUserContent,
  openaiCompatVisionEnabled,
  type ChannelAttachmentMeta,
} from './channelAttachments.js';
import { buildScopeSuffix, resolveScope, type Scope } from './scope.js';
import { normalizeOpenRouterApiKeyCandidate } from './openrouter-key.js';
import * as phase0 from './phase0/emitter.js';

export type { ChannelAttachmentMeta } from './channelAttachments.js';

// Configuration (mutable — reloaded on settings change)
let MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
let CLI_MODEL = process.env.CLI_MODEL || 'sonnet';
let MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '8096', 10);
const MAX_TOOL_ITERATIONS = parseInt(process.env.MAX_TOOL_ITERATIONS || '10', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const VC_PATH = () => process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');

// --- Multi-provider auth ---

type LLMProvider = 'claude-cli' | 'anthropic' | 'kimi-cli' | 'kimi' | 'openai' | 'google' | 'groq' | 'deepseek' | 'xai' | 'mistral' | 'openrouter' | 'ollama' | 'custom' | 'none';

let currentProvider: LLMProvider = 'none';

// Provider-specific config (loaded from DB settings)
let openaiApiKey = '';
let openaiModel = 'gpt-4o';
let ollamaBaseUrl = 'http://localhost:11434';
let ollamaModel = '';
let customBaseUrl = '';
let customModel = '';
let customApiKey = '';

// Preset OpenAI-compatible providers (base URL + key + model)
let googleApiKey = '';
let googleModel = 'gemini-2.5-flash';
let groqApiKey = '';
let groqModel = 'llama-3.3-70b-versatile';
let deepseekApiKey = '';
let deepseekModel = 'deepseek-chat';
let xaiApiKey = '';
let xaiModel = 'grok-3';
let mistralApiKey = '';
let mistralModel = 'mistral-large-latest';
let kimiApiKey = '';
let kimiModel = 'kimi-k2.6';
let kimiCliModel = 'kimi-k2.6';
let openrouterApiKey = '';
let openrouterModel = 'openai/gpt-4o';

// --- Smart Model Routing (#2 from Hermes learnings) ---
// Routes simple queries to a cheaper/faster model. Kill switch: VODOU_SMART_ROUTING=0
let smartRoutingEnabled = process.env.VODOU_SMART_ROUTING !== '0'; // ON by default
let smartRoutingModel = process.env.VODOU_SMART_ROUTING_MODEL || ''; // empty = auto-detect cheap model

/** Technical words that ALWAYS force the primary model, regardless of message length */
const TECHNICAL_KEYWORDS = /\b(code|bug|error|fix|debug|deploy|build|create|write|implement|implementation|refactor|test|schema|database|db|api|server|function|class|module|component|config|install|migrate|auth|security|encrypt|performance|optimize|docker|kubernetes|k8s|script|compile|async|stream|websocket|webhook|endpoint|route|query|sql|css|html|react|node|rust|python|typescript|javascript|golang|java|swift|file|commit|merge|branch|git|npm|pip|cargo|make|run|execute|parse|render|fetch|upload|download|backup|restore|cron|schedule|scheduler|monitor|log|trace|profile|lint|format|scaffold|setup|init|provision|terraform|ansible|redis|mongo|postgres|mysql|graphql|grpc|socket|cors|jwt|token|cert|ssl|tls|proxy|nginx|apache|ci|cd|pipeline|workflow|container|image|volume|network|port|daemon|process|thread|memory|cpu|disk|cache|index|reindex|shard|replica|cluster|helm|yaml|json|xml|csv|regex|pattern|template|middleware|plugin|extension|hook|callback|promise|observable|listener|handler|controller|service|repository|factory|singleton|interface|type|enum|struct|trait|protocol|generic|abstract|virtual|override|decorator|annotation|macro|crate|package|dependency|version|release|patch|hotfix|rollback|revert|cherry.pick|stash|rebase|analyze|investigate|benchmark|diagnose|troubleshoot|inspect|audit|crawl|scrape|data|refine|architect|design|spec|schema|model|train|inference|embed|vector|chunk|tokenize|serialize|deserialize|marshal|unmarshal)\b/i;

/** Conservative simple query detection — whitelist approach.
 *  A query is "simple" ONLY if it's clearly trivial AND contains no technical words.
 *  Everything else goes to the primary model. Safe default. */
function isSimpleQuery(message: string): boolean {
  const trimmed = message.trim();
  const len = trimmed.length;
  const words = trimmed.split(/\s+/).length;

  // Never route long messages to cheap model
  if (len > 120 || words > 20) return false;

  // Never route messages with code, URLs, or multi-line
  if (/```/.test(trimmed)) return false;
  if (/https?:\/\//.test(trimmed)) return false;
  if (trimmed.includes('\n')) return false;

  // ANY technical keyword → primary model, no exceptions
  if (TECHNICAL_KEYWORDS.test(trimmed)) return false;

  // Menu/stopping point replies — always simple (already passed technical check)
  if (/^\d{1,2}[\.\)\s:]/.test(trimmed) || /^\d{1,2}$/.test(trimmed)) return true;
  if (/^(all|yes|no|y|n)\s*[!?.]*$/i.test(trimmed)) return true;

  // Short non-technical messages (greetings, thanks, casual questions)
  // Conservative: only very short messages that passed the technical keyword filter
  if (len <= 50 && words <= 8) return true;

  // Everything else → primary model (safe default)
  return false;
}

/** Get the cheap model for the current provider */
function getSmartRoutingCheapModel(): { model: string; cliModel: string } {
  // User-configured override
  if (smartRoutingModel) {
    return { model: smartRoutingModel, cliModel: smartRoutingModel };
  }
  // Auto-detect based on provider
  switch (currentProvider) {
    case 'claude-cli':
      return { model: 'haiku', cliModel: 'haiku' };
    case 'anthropic':
      return { model: 'claude-haiku-4-5-20251001', cliModel: 'haiku' };
    case 'openai':
      return { model: 'gpt-4o-mini', cliModel: '' };
    case 'google':
      return { model: 'gemini-2.0-flash-lite', cliModel: '' };
    case 'groq':
      return { model: 'llama-3.1-8b-instant', cliModel: '' };
    case 'deepseek':
      return { model: 'deepseek-chat', cliModel: '' }; // DeepSeek is already cheap
    case 'kimi':
      return { model: kimiModel, cliModel: '' };
    case 'openrouter':
      return { model: 'openai/gpt-4o-mini', cliModel: '' };
    default:
      return { model: '', cliModel: '' }; // No cheap alternative known
  }
}

function detectProvider(): LLMProvider {
  // Check DB settings first
  try {
    const dbProvider = getSetting('llm_provider');
    if (dbProvider && dbProvider !== 'none') {
      console.error(`[Auth] Using provider from settings: ${dbProvider}`);
      return dbProvider as LLMProvider;
    }
  } catch {}

  // Check env override
  if (process.env.LLM_PROVIDER) {
    console.error(`[Auth] Using LLM_PROVIDER env: ${process.env.LLM_PROVIDER}`);
    return process.env.LLM_PROVIDER as LLMProvider;
  }

  // Auto-detect
  if (process.env.ANTHROPIC_API_KEY) {
    console.error('[Auth] Using ANTHROPIC_API_KEY (SDK mode)');
    return 'anthropic';
  }

  try {
    execSync('which claude', { stdio: 'pipe', timeout: 3000 });
    console.error('[Auth] Using Claude CLI (Max subscription mode)');
    return 'claude-cli';
  } catch {
    console.error('[Auth] No API key and no Claude CLI found');
    return 'none';
  }
}

function loadProviderConfig(): void {
  try {
    CLI_MODEL = getSetting('cli_model') || process.env.CLI_MODEL || 'sonnet';
    MODEL = getSetting('claude_model') || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
    MAX_TOKENS = parseInt(getSetting('max_tokens') || process.env.MAX_TOKENS || '8096', 10);
    openaiApiKey = getSetting('openai_api_key') || process.env.OPENAI_API_KEY || '';
    openaiModel = getSetting('openai_model') || process.env.OPENAI_MODEL || 'gpt-4o';
    ollamaBaseUrl = (getSetting('ollama_base_url') || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    ollamaModel = getSetting('ollama_model') || process.env.OLLAMA_MODEL || '';
    customBaseUrl = (getSetting('custom_llm_base_url') || process.env.CUSTOM_LLM_BASE_URL || '').replace(/\/$/, '');
    customModel = getSetting('custom_llm_model') || process.env.CUSTOM_LLM_MODEL || '';
    customApiKey = getSetting('custom_llm_api_key') || process.env.CUSTOM_LLM_API_KEY || '';

    // Preset OpenAI-compatible providers
    googleApiKey = getSetting('google_api_key') || process.env.GEMINI_API_KEY || '';
    googleModel = getSetting('google_model') || 'gemini-2.5-flash';
    groqApiKey = getSetting('groq_api_key') || process.env.GROQ_API_KEY || '';
    groqModel = getSetting('groq_model') || 'llama-3.3-70b-versatile';
    deepseekApiKey = getSetting('deepseek_api_key') || process.env.DEEPSEEK_API_KEY || '';
    deepseekModel = getSetting('deepseek_model') || 'deepseek-chat';
    xaiApiKey = getSetting('xai_api_key') || process.env.XAI_API_KEY || '';
    xaiModel = getSetting('xai_model') || 'grok-3';
    mistralApiKey = getSetting('mistral_api_key') || process.env.MISTRAL_API_KEY || '';
    mistralModel = getSetting('mistral_model') || 'mistral-large-latest';
    kimiApiKey = getSetting('kimi_api_key') || process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '';
    kimiModel = getSetting('kimi_model') || process.env.MOONSHOT_MODEL || 'kimi-k2.6';
    kimiCliModel = getSetting('kimi_cli_model') || process.env.KIMI_CLI_MODEL || 'kimi-k2.6';
    openrouterApiKey =
      normalizeOpenRouterApiKeyCandidate(getSetting('openrouter_api_key') || '') ||
      normalizeOpenRouterApiKeyCandidate(process.env.OPENROUTER_API_KEY || '') ||
      '';
    openrouterModel = getSetting('openrouter_model') || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';

    // Manage ANTHROPIC_API_KEY in process.env based on active provider.
    // Claude CLI MUST NOT have this set — it causes CLI to use API key auth
    // instead of Max subscription OAuth → "credit balance too low" error.
    const dbProvider = getSetting('llm_provider');
    if (dbProvider === 'anthropic') {
      const dbAnthropicKey = getSetting('anthropic_api_key');
      if (dbAnthropicKey) process.env.ANTHROPIC_API_KEY = dbAnthropicKey;
    } else {
      // For ALL non-Anthropic providers (including claude-cli), remove the key
      delete process.env.ANTHROPIC_API_KEY;
    }
  } catch {}
}

/** Reload provider + model fields from DB/env and sync `currentProvider` (fixes stale footer / routing). */
function syncProviderFromDb(): void {
  loadProviderConfig();
  currentProvider = detectProvider();
  // Sync smart routing settings from DB (env vars are fallback)
  try {
    const dbSmartRouting = getSetting('smart_routing');
    if (dbSmartRouting !== null) smartRoutingEnabled = dbSmartRouting !== '0' && dbSmartRouting !== 'false';
    const dbSmartModel = getSetting('smart_routing_model');
    if (dbSmartModel) smartRoutingModel = dbSmartModel;
  } catch {}
}

async function initAuth(): Promise<void> {
  syncProviderFromDb();
  // Reset SDK client in case key changed
  client = null;
}

/**
 * Reinitialize auth after settings change — called from settings API
 */
async function reinitAuth(): Promise<void> {
  syncProviderFromDb();
  client = null;
  _cachedSystemPrompts.clear();
  _bootstrappedConversations.clear();
  _workspaceBootstrap = '';
  _bootstrapLoadedAt = 0; // force bootstrap re-read on next message
  console.error(`[Auth] Reinitialized — provider: ${currentProvider}, caches cleared`);
}

// --- System prompt (simplified — Claude no longer picks tools) ---

function buildActiveModelLabel(): string {
  switch (currentProvider) {
    case 'claude-cli': return `Claude CLI (${CLI_MODEL})`;
    case 'anthropic': return `Anthropic API (${MODEL})`;
    case 'kimi-cli': return `Kimi CLI (${kimiCliModel})`;
    case 'kimi': return `Kimi API (${kimiModel})`;
    case 'openrouter': return `OpenRouter (${openrouterModel})`;
    case 'openai': return `OpenAI (${openaiModel})`;
    case 'google': return `Google Gemini (${googleModel})`;
    case 'groq': return `Groq (${groqModel})`;
    case 'deepseek': return `DeepSeek (${deepseekModel})`;
    case 'xai': return `xAI Grok (${xaiModel})`;
    case 'mistral': return `Mistral (${mistralModel})`;
    case 'ollama': return `Ollama (${ollamaModel})`;
    case 'custom': return `Custom (${customModel})`;
    default: return 'None';
  }
}

function getActiveModelLabel(): string {
  syncProviderFromDb();
  return buildActiveModelLabel();
}

const SYSTEM_PROMPT_BASE = `You are Vodou (🔮), the AI assistant for Vodou (Open Intelligence). You run on the user's local machine.

## How This Works

Vodou's BrainLoader automatically runs your query through the intelligence pipeline BEFORE you respond.
The results may be provided as structured context. Your job:
- Interpret and present the data clearly
- Add insights, warnings, or recommendations
- If results are empty or no match, tell the user and suggest alternatives`;

const SYSTEM_PROMPT_TOOLS_BASH_RESTRICTED = `
## Follow-Up Tool Calls

When Vodou results require follow-up actions (multi-step workflows, skills, interactive sessions), use Bash to call vodou-core directly:

\`\`\`bash
# Call any MCP server tool:
${VC_PATH()} call <server> <tool> '<json_args>'
\`\`\`

Common follow-up patterns:
- Deep thinking: \`${VC_PATH()} call Vodou-Enhanced-Thinking start_thinking_session '{"topic":"...","depth":10}'\`
- Add thoughts: \`${VC_PATH()} call Vodou-Enhanced-Thinking add_thought '{"session_id":"ID","thought":"..."}'\`
- Screenshots: \`${VC_PATH()} call chrome-devtools take_screenshot '{}'\`
- Memory search: \`${VC_PATH()} mem search "query"\`

**NEVER run \`./oi\` or \`vodou-core brain\` — the gateway already handles BrainLoader routing before your response. Spawning those commands creates zombie processes. Use \`vodou-core call <server> <tool>\` only.**`;

const SYSTEM_PROMPT_TOOLS_BASH_FULL = `
## Tools Available

You have the FULL Claude Code tool surface — same as a terminal session:

- **Bash** — run any shell command, including \`${VC_PATH()} call <server> <tool> '<args>'\` for MCP tools
- **Read** — read files by path
- **Write** — create or overwrite files
- **Edit** — surgical string replacements in files
- **Grep** — search file contents with regex
- **Glob** — find files by pattern

Use the right tool for the job. For Vodou/MCP follow-ups, use Bash with vodou-core. For codebase investigation, file edits, or debugging — use the dedicated tools directly. You are NOT limited to vodou-core commands.

Common Vodou patterns:
- MCP tool call: \`${VC_PATH()} call <server> <tool> '<json_args>'\`
- Memory search: \`${VC_PATH()} mem search "query"\`

**NEVER run \`./oi\` or \`vodou-core brain\` — the gateway already handles BrainLoader routing before your response. Spawning those commands creates zombie processes. Use \`vodou-core call <server> <tool>\` only.**`;

function getToolsBashPrompt(): string {
  const mode = getGatewayShellMode();
  return mode === 'restricted' ? SYSTEM_PROMPT_TOOLS_BASH_RESTRICTED : SYSTEM_PROMPT_TOOLS_BASH_FULL;
}

const SYSTEM_PROMPT_TOOLS_NATIVE = `
## Follow-Up Tool Calls

You have two tools available for follow-up actions:

1. **vodou_core_call** — Call any MCP server tool directly.
   Parameters: \`server\` (string), \`tool\` (string), \`args\` (object, optional)
   Examples:
   - Deep thinking: \`vodou_core_call(server="Vodou-Enhanced-Thinking", tool="start_thinking_session", args={"topic":"...","depth":10})\`
   - System info: \`vodou_core_call(server="mcp-monitor", tool="get_cpu_info")\`
   - Screenshots: \`vodou_core_call(server="chrome-devtools", tool="take_screenshot")\`

2. **list_available_tools** — Instant catalog from local vodou-core.db (cached tools). Refresh MCP Servers in the gateway if the list is empty or outdated.

Use these tools when skills or workflows require follow-up actions. Chain tool calls: capture outputs from one call and feed them into the next.

**Do not** paste terminal fiction: never write \`<execute_bash>\`, \`<tool_code>\`, or simulated \`vodou-core\` shell lines in your visible reply. The gateway runs tools via the API — only use the tools above.`;

const SYSTEM_PROMPT_RULES = `

## CRITICAL RULES

1. **Skills are Layer 1 — they ALWAYS come first.** When Vodou returns a skill, follow it completely. Never bypass, skip stopping points, or substitute your own answer. The skill IS the answer.

2. **Stopping points are sacred.** When you see numbered menus, display ALL options and STOP. Wait for the user to choose. Never assume their choice.

3. **Actually use the tools.** When a skill says to call an MCP tool (start_thinking_session, etc.), CALL IT. Do NOT fake the output or answer from your own knowledge.

4. **Be concise.** Don't over-explain. Chad knows the platform.

5. **No approval needed.** You are running in the Vodou-Console web chat. All tool calls are pre-approved. Never ask for terminal approval or say you're waiting for permission — there is no terminal. Just execute.

6. **NEVER run \`./oi\` or \`vodou-core brain\`.** The gateway already ran BrainLoader before your response arrived. Running it again spawns a new vodou-core subprocess inside the gateway process, which becomes an unresponsive zombie and can force the user to restart their machine. Use \`vodou-core call <server> <tool>\` for direct MCP tool calls only.

Style: Direct, occasional humor. You know the user from your bootstrap context.`;

// CLI gets Bash instructions (mode-aware); all other providers get native tool calling guidance
const SYSTEM_PROMPT_TOOL_CALLING = SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_TOOLS_NATIVE + SYSTEM_PROMPT_RULES;

function getAppsSystemBlock(): string {
  const base = (process.env.GATEWAY_BASE_URL || `http://localhost:${process.env.WEB_PORT || '8765'}`).replace(/\/$/, '');
  return `
## Apps (remote MCP servers)

Vodou has a curated app hub at **${base}/#/apps**. When a user asks to use an external service that requires authentication:

**ALWAYS do:**
- If the service is in the preset catalog, tell the user: "Go to ${base}/#/apps and click Connect on <provider>. Authorize in the popup. Done."
- For any custom remote MCP URL (not in the preset catalog), direct them to paste it into the "Add Custom App" section on the same page.
- For API-key services: same page, click "Use API Key" and paste the token.

**NEVER do:**
- Suggest users create a developer OAuth app themselves unless the preset is explicitly "Manual OAuth" (rare — only Asana and a few others).
- Recommend pulling Bearer tokens from browser DevTools. That's a security anti-pattern and bypasses the gateway's token storage.
- Provide curl commands for OAuth authorization codes. The gateway's Dynamic Client Registration flow handles that automatically.

**Preset catalog:**
- DCR (1-click): cloudflare, stripe, linear, notion, canva, attio, monday, buildkite, cloudinary, audioscrape
- Manual OAuth (requires env vars + developer console): asana, carbonvoice
- API key: airtable, zapier, dappier, exa

To verify current connection status programmatically: \`GET ${base}/api/oauth/status\` returns per-provider \`{ connected, expired, mcpHealth, toolCount }\`.

If a tool call returns \`AuthenticationRequired\`, \`invalid_token\`, or \`401\` for an app connection, the credential is missing or expired — tell the user to reconnect via the Apps tab.
`.trim();
}

function getSystemPrompt(): string {
  const appsBlock = getAppsSystemBlock();
  // Non-CLI providers with tool calling support get native tool guidance
  if (currentProvider !== 'claude-cli' && currentProvider !== 'kimi-cli') {
    return SYSTEM_PROMPT_TOOL_CALLING + '\n\n' + appsBlock;
  }
  // CLI mode: tool instructions vary by shell mode (restricted vs full)
  return SYSTEM_PROMPT_BASE + getToolsBashPrompt() + SYSTEM_PROMPT_RULES + '\n\n' + appsBlock;
}

/**
 * Detect auth-related failures in a vodou-core tool result and replace them with
 * actionable guidance so the LLM directs the user to the Apps tab instead of
 * hallucinating OAuth setup instructions.
 */
function rewriteAuthError(raw: string, serverName?: string): string {
  if (!raw) return raw;
  const authFailurePattern = /invalid_token|AuthenticationRequired|Missing or invalid access token|HTTP\s*401\b|"code"\s*:\s*401\b|www-authenticate:\s*Bearer/i;
  if (!authFailurePattern.test(raw)) return raw;

  const base = (process.env.GATEWAY_BASE_URL || `http://localhost:${process.env.WEB_PORT || '8765'}`).replace(/\/$/, '');

  // Try to extract server name from the error text if the caller didn't supply one
  let name = serverName;
  if (!name) {
    const fromMsg = raw.match(/(?:Authentication required for|for server|server_name[":\s]*"?)([A-Za-z0-9_.-]+)/i);
    if (fromMsg) name = fromMsg[1];
  }
  const target = name ? `'${name}'` : 'this app';
  const connectPath = name
    ? `${base}/#/apps (find ${name} and click Connect)`
    : `${base}/#/apps (click Connect on the relevant provider)`;

  return `⚠️ The ${target} app isn't connected, or its credential has expired.

Tell the user: "Go to ${connectPath}, authorize in the popup, and then retry." Do NOT suggest creating a developer OAuth app or pasting Bearer tokens from DevTools — the gateway handles credentials automatically via Dynamic Client Registration.

Raw error (for your context, do not show verbatim to the user):
${raw.slice(0, 800)}`;
}

// --- SDK mode ---

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('No ANTHROPIC_API_KEY set');
    client = new Anthropic({ apiKey });
  }
  return client;
}

// --- Workspace bootstrap (loaded once, mtime-checked every 5min) ---

let _workspaceBootstrap = '';
let _bootstrapLoadedAt = 0;
let _bootstrapMtime = 0;
const BOOTSTRAP_REFRESH_MS = 300_000; // 5 minutes (was 60s)

// Track which conversations have received the full bootstrap context
// (so we don't resend 413 lines on every message)
const _bootstrappedConversations = new Set<string>();
const _pendingDisambiguations = new Map<string, { query: string; options: Array<{server: string; tool: string}> }>();
const _lastMemoryUsed = new Map<string, string[]>();
/** Track active skill per conversation — prevents menu replies from being re-routed through BrainLoader */
const _activeSkill = new Map<string, { skillName: string; loadedAt: number; skillContent: string }>();
/** Sticky Vodou context — stores last BrainLoader result per conversation so follow-ups don't lose context */
const _lastOiContext = new Map<string, { oiResults: string; skillName: string | null; timestamp: number }>();
/** Cached system prompt per conversation — stable across turns for prompt caching */
const _cachedSystemPrompts = new Map<string, { prompt: string; builtAt: number }>();

/**
 * Append the scope-specific suffix + per-scope workbench instructions to a
 * fully-built system prompt. No-op for unscoped (`scope == null`).
 * Lives here so every provider helper (SDK, CLI, OpenAI-compat) can apply
 * it uniformly without duplicating the logic. Cost per call: one short
 * string build + one SQLite getSetting() read.
 */
function maybeAppendScopeBlock(prompt: string, scope?: Scope | null): string {
  if (!scope) return prompt;
  // Skill scopes are handled at the top of chat() via chatWithSkill — they
  // never reach this function. Anything that lands here is a non-skill scope
  // (integration, channel, automation, flow): append-only.
  let out = prompt + '\n\n---\n\n' + buildScopeSuffix(scope);
  const pinned = getSetting(`workbench_instructions:${scope.raw}`);
  if (pinned && pinned.trim()) {
    out += '\n\n## Workbench instructions\n' + pinned.trim();
  }
  if (scope.type === 'automation') {
    out += buildAutomationContextBlock(scope.id);
  }
  return out;
}

/**
 * Fetch an automation's config + last 5 runs from vodou-core.db and
 * format them as a system-prompt block. Called only when a scoped
 * conversation has scope.type === 'automation'. Read-only DB open.
 */
function buildAutomationContextBlock(automationId: string): string {
  try {
    const id = Number(automationId);
    if (!Number.isFinite(id)) return '';
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, name, description, trigger_json, actions_json, notify_json,
                enabled, interval_minutes, last_run_at, next_run_at, run_count,
                last_error
           FROM automations WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number; name: string; description: string | null;
          trigger_json: string; actions_json: string; notify_json: string | null;
          enabled: number; interval_minutes: number; last_run_at: string | null;
          next_run_at: string | null; run_count: number; last_error: string | null;
        }
      | undefined;
    if (!row) return '\n\n## Automation\n(not found — may have been deleted)';

    const trigger = safeParse(row.trigger_json);
    const actions = safeParse(row.actions_json);
    const notify = row.notify_json ? safeParse(row.notify_json) : null;

    const runs = db
      .prepare(
        `SELECT started_at, events_matched, success, error
           FROM automation_runs
          WHERE automation_id = ?
       ORDER BY started_at DESC
          LIMIT 5`,
      )
      .all(id) as Array<{
        started_at: string;
        events_matched: number;
        success: number;
        error: string | null;
      }>;

    let block = `\n\n## Automation: ${row.name}\n`;
    if (row.description) block += `${row.description}\n`;
    block += `\n- **Enabled:** ${row.enabled ? 'yes' : 'no'}\n`;
    block += `- **Interval:** every ${row.interval_minutes ?? 15} min\n`;
    block += `- **Run count:** ${row.run_count ?? 0}\n`;
    if (row.last_run_at) block += `- **Last run:** ${row.last_run_at}\n`;
    if (row.next_run_at) block += `- **Next run:** ${row.next_run_at}\n`;
    if (row.last_error) block += `- **Last error:** ${row.last_error}\n`;
    if (trigger && typeof trigger === 'object') {
      const t = trigger as { integration?: string; tool?: string; args?: unknown };
      block += `\n**Trigger:** \`${t.integration || '?'}.${t.tool || '?'}\``;
      if (t.args && typeof t.args === 'object' && Object.keys(t.args).length > 0) {
        block += `\n\`\`\`json\n${JSON.stringify(t.args, null, 2)}\n\`\`\``;
      }
      block += '\n';
    }
    if (Array.isArray(actions) && actions.length > 0) {
      block += `\n**Actions (${actions.length}):**\n`;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i] as { integration?: string; tool?: string };
        block += `${i + 1}. \`${a.integration || '?'}.${a.tool || '?'}\`\n`;
      }
    } else {
      block += `\n**Actions:** none (notify-only)\n`;
    }
    if (notify && typeof notify === 'object') {
      const n = notify as { url?: string };
      if (n.url) block += `\n**Notify:** ${n.url.substring(0, 80)}${n.url.length > 80 ? '…' : ''}\n`;
    }
    if (runs.length > 0) {
      block += `\n**Recent runs:**\n`;
      for (const r of runs) {
        const status = r.success ? '✓' : '✗';
        const errSuffix = r.error ? ` — ${r.error.substring(0, 120)}` : '';
        block += `- ${status} ${r.started_at} · ${r.events_matched || 0} event(s)${errSuffix}\n`;
      }
    } else {
      block += `\n**Recent runs:** none yet\n`;
    }
    return block;
  } catch (err) {
    return `\n\n## Automation\n(failed to load context: ${(err as Error).message})`;
  }
}

function safeParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
const SYSTEM_PROMPT_CACHE_MS = 300_000; // 5 min

/** Track files modified during a conversation (for context injection) */
const _fileChanges = new Map<string, Set<string>>();

function detectFileChanges(toolName: string, toolArgs: any, _toolResult: string): string[] {
  const files: string[] = [];
  const name = (toolName || '').toLowerCase();

  // Direct file operations from tool name
  if (/write|edit|mv|cp|rm|mkdir|touch/i.test(name)) {
    if (toolArgs?.file_path) files.push(toolArgs.file_path);
    if (toolArgs?.path) files.push(toolArgs.path);
  }

  // Bash commands with redirection or file-modifying commands
  if (name === 'bash' && toolArgs?.command) {
    const cmd: string = toolArgs.command;
    // Detect redirections: >, >>
    const redirectMatches = cmd.matchAll(/[^>]>>?\s*["']?([^\s"'|;&]+)/g);
    for (const m of redirectMatches) {
      if (m[1] && !m[1].startsWith('-')) files.push(m[1]);
    }
    // Detect common file-modifying commands (take last non-flag arg)
    if (/\b(sed\s+-i|mv|cp|rm|mkdir|touch|chmod|chown)\b/.test(cmd)) {
      const parts = cmd.split(/\s+/);
      const lastArg = parts[parts.length - 1];
      if (lastArg && !lastArg.startsWith('-') && !lastArg.startsWith('|')) files.push(lastArg);
    }
  }

  return files;
}

function addFileChanges(conversationId: string, files: string[]): void {
  if (!_fileChanges.has(conversationId)) _fileChanges.set(conversationId, new Set());
  const set = _fileChanges.get(conversationId)!;
  for (const f of files) set.add(f);
}

export function getFileChangeSummary(conversationId: string): string {
  const files = _fileChanges.get(conversationId);
  if (!files || files.size === 0) return '';
  return `\n<files_modified_this_session>\n${[...files].join('\n')}\n</files_modified_this_session>\n`;
}

/** Get the memories used in the last response for a conversation */
export function getLastMemoryUsed(conversationId: string): string[] {
  return _lastMemoryUsed.get(conversationId) || [];
}

/** Get total memory count from memory.db via better-sqlite3 (no shell exec) */
let _memoryCountCache: { count: number; expires: number } = { count: 0, expires: 0 };
export function getTotalMemoryCount(): number {
  const now = Date.now();
  if (_memoryCountCache.expires > now) return _memoryCountCache.count;
  try {
    const memDb = getMemoryDb();
    if (!memDb) return 0;
    const row = memDb.prepare('SELECT count(*) as cnt FROM memory_chunks').get() as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    _memoryCountCache = { count, expires: now + 60_000 }; // Cache 60s
    return count;
  } catch {
    return 0;
  }
}

// --- Heartbeat tracking ---
const _heartbeatConversations = new Set<string>();
const _conversationMaxTokens = new Map<string, number>();
const _conversationMaxToolIterations = new Map<string, number>();

export function markHeartbeatConversation(conversationId: string): void {
  _heartbeatConversations.add(conversationId);
  _suppressTranscript = true; // F4: Don't save heartbeat turns to memory transcript
}

// F4: When true, skip transcript saving for current turn (reset after chat completes)
let _suppressTranscript = false;

export function setConversationMaxTokens(conversationId: string, maxTokens: number): void {
  _conversationMaxTokens.set(conversationId, maxTokens);
}

export function setConversationMaxToolIterations(conversationId: string, maxIterations: number): void {
  _conversationMaxToolIterations.set(conversationId, maxIterations);
}

/** Get max tokens for a conversation — uses per-conversation override if set, otherwise global MAX_TOKENS */
function getMaxTokens(conversationId?: string): number {
  if (conversationId) {
    const override = _conversationMaxTokens.get(conversationId);
    if (override) return override;
  }
  return MAX_TOKENS;
}

/** Get max tool iterations for a conversation — uses per-conversation override if set, otherwise global MAX_TOOL_ITERATIONS */
function getMaxToolIterations(conversationId?: string): number {
  if (conversationId) {
    const override = _conversationMaxToolIterations.get(conversationId);
    if (override) return override;
  }
  return MAX_TOOL_ITERATIONS;
}

function getWorkspaceBootstrap(): string {
  const now = Date.now();
  const cachePath = path.join(getProjectRoot(), '.vodou', 'workspace', '.context_cache');

  // Fast path: within refresh window
  if (_workspaceBootstrap && (now - _bootstrapLoadedAt) < BOOTSTRAP_REFRESH_MS) {
    return _workspaceBootstrap;
  }

  try {
    const stat = statSync(cachePath);
    const mtime = stat.mtimeMs;

    // File hasn't changed since last read — just reset the timer
    if (_workspaceBootstrap && mtime === _bootstrapMtime) {
      _bootstrapLoadedAt = now;
      return _workspaceBootstrap;
    }

    // File changed (or first read) — reload
    _workspaceBootstrap = readFileSync(cachePath, 'utf-8');
    _bootstrapLoadedAt = now;
    _bootstrapMtime = mtime;
    console.error(`[Bootstrap] loaded ${_workspaceBootstrap.length} chars from context cache`);
  } catch (err) {
    console.error(`[Bootstrap] context cache not available: ${(err as Error).message}`);
  }
  return _workspaceBootstrap;
}

// --- Gateway periodic memory flush ---
// Flush every N messages so daily logs get written even when Claude Code is active
let _gatewayMsgCount = 0;
const FLUSH_EVERY_N = parseInt(process.env.VODOU_FLUSH_EVERY_N_PROMPTS || '15', 10) || 15;

function maybeFlushMemory(): void {
  _gatewayMsgCount++;
  if (_gatewayMsgCount >= FLUSH_EVERY_N) {
    _gatewayMsgCount = 0;
    triggerMemoryFlush();
  }
}

// --- Memory injection via daemon socket ---

export function getMemoryContext(prompt: string, conversationId?: string): Promise<string> {
  const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');

  // V2-C gateway: include recent conversation turns as context for the daemon's
  // memory search. This is the gateway equivalent of file-context boosting —
  // when the user says "tell me more about that", the daemon sees the last few
  // turns and can boost memories related to the recent topic.
  const messages: Array<{role: string; content: string}> = [];
  if (conversationId) {
    try {
      const raw = getConversationManager().getMessages(conversationId);
      // Grab last 4 messages (2 user + 2 assistant turns), skip the current prompt
      const recent = raw.slice(-5, -1);
      for (const msg of recent) {
        const role = msg.role || '';
        const text = typeof msg.content === 'string'
          ? msg.content.substring(0, 300)
          : '';
        if (text && (role === 'user' || role === 'assistant')) {
          messages.push({ role, content: text });
        }
      }
    } catch { /* conversation manager may not have this convo yet */ }
  }

  const hookJson: any = { prompt };
  if (messages.length > 0) {
    hookJson.messages = messages;
  }

  // Phase B (PLAN-UNIFIED-SCOPED-CONVERSATIONS): forward the active scope to the
  // daemon so memory search can boost in-scope memories. resolveScope returns
  // null for the default 'web' conversation, in which case we omit the field
  // (daemon treats absent === unscoped).
  if (conversationId) {
    try {
      const scope = resolveScope(conversationId);
      if (scope?.raw) hookJson.scope = scope.raw;
    } catch { /* malformed conversationId — fall back to unscoped */ }
  }

  const request = JSON.stringify({
    cmd: 'prompt',
    payload: { hook_json: JSON.stringify(hookJson) }
  }) + '\n';

  return new Promise((resolve) => {
    const client = net.createConnection({ path: sockPath }, () => {
      client.write(request);
      client.end();
    });

    client.setTimeout(3000);

    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });

    client.on('end', () => {
      try {
        const resp = JSON.parse(data.trim());
        // PLAN-MEMORY-VISIBILITY-UI Phase B.2 — stash the structured debug
        // payload alongside the raw additional_context. Indexed by conversationId
        // so the `done` event can forward it to the client.
        const debug = resp?.data?.memory_recall_debug;
        if (debug && conversationId) {
          _lastMemoryDebug.set(conversationId, debug);
        }
        resolve(resp?.data?.additional_context || '');
      } catch {
        resolve('');
      }
    });

    client.on('error', () => resolve(''));
    client.on('timeout', () => {
      console.warn(`[Memory] Search timed out after 3000ms for query: "${prompt.substring(0, 50)}"`);
      client.destroy();
      resolve('');
    });
  });
}

/**
 * PLAN-MEMORY-VISIBILITY-UI Phase B.2 — stash for the structured `memory_recall_debug`
 * payload returned by the daemon's `cmd:'prompt'`. Per-conversation; consumed when
 * the gateway emits the `done` event.
 */
const _lastMemoryDebug = new Map<string, { query: string; active_scope: string | null; results: any[] }>();
export function getLastMemoryDebug(conversationId: string) {
  return _lastMemoryDebug.get(conversationId) || null;
}

/**
 * Parse daemon `additional_context` (lines like `- [path] snippet`) and store for the
 * WebSocket `done.memory` payload / chat footer. Must run for every turn that injects
 * memory — not only the main chat() path (workflows and skill replies also prefetch).
 */
function recordMemoriesInjected(conversationId: string, memoryContext: string): void {
  const memoryLines = memoryContext
    ? memoryContext.split('\n').filter(l => l.trim().startsWith('- ['))
    : [];
  _lastMemoryUsed.set(conversationId, memoryLines);
  if (memoryContext) {
    console.error(`[Memory] injected ${memoryContext.length} chars, ${memoryLines.length} memories`);
  }
}

// --- Memory persistence: gateway transcript file ---
// Write a JSONL transcript (same format as Claude Code transcripts) so the
// daemon's flush_with_transcript path is used — which applies all the
// multi-layer filtering (noise filter, pre-dedup, semantic dedup) that the
// raw .prompt_buffer path skips.

function getTranscriptPath(): string {
  return path.join(getProjectRoot(), '.vodou', 'workspace', '.gateway_transcript.jsonl');
}

/**
 * Append a message to the gateway transcript file in JSONL format
 * compatible with parse_transcript_lines in memory_flush.rs.
 */
function appendToTranscript(role: 'user' | 'assistant', content: string): void {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 20) return;

  const transcriptPath = getTranscriptPath();
  try {
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const entry = JSON.stringify({ type: role, content: trimmed });
    appendFileSync(transcriptPath, entry + '\n');
    console.error(`[Memory] saved ${role} message (${trimmed.length} chars) to gateway transcript`);
  } catch (err) {
    console.error(`[Memory] failed to save ${role} message: ${(err as Error).message}`);
  }
}

/**
 * Save user message to transcript. Called when we receive a user prompt.
 */
function saveUserToTranscript(message: string): void {
  appendToTranscript('user', message);
}

/**
 * Save assistant response to transcript and maybe trigger a flush.
 */
function saveAssistantToBuffer(response: string): void {
  if (_suppressTranscript) {
    _suppressTranscript = false; // Reset for next turn
    return;
  }
  appendToTranscript('assistant', response);
  maybeFlushMemory();
}

/**
 * Trigger a memory flush via vodou-hook-bin sock flush.
 * Passes transcript_path pointing to our gateway transcript file, which routes
 * through flush_with_transcript → flush_inner with all multi-layer filtering
 * (noise filter, pre-dedup against existing memories, semantic dedup).
 * Fire-and-forget. Never spawns vodou-core directly (UE risk).
 */
function triggerMemoryFlush(): void {
  const root = getProjectRoot();
  const hookBin = path.join(root, 'vodou-hook-bin');
  const transcriptPath = getTranscriptPath();

  // Ensure daemon is running before attempting flush
  try {
    spawn(hookBin, ['ensure'], { cwd: root, stdio: 'ignore', detached: true }).unref();
  } catch {}

  // Pass transcript_path so daemon uses flush_with_transcript (full filtering pipeline)
  const hookJson = JSON.stringify({ transcript_path: transcriptPath });

  try {
    const proc = spawn(hookBin, ['sock', 'flush'], {
      cwd: root,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env },
    });

    proc.stdin?.write(hookJson);
    proc.stdin?.end();

    proc.on('close', (code) => {
      if (code === 0) {
        console.error('[Memory] flush triggered via vodou-hook-bin sock flush (transcript mode)');
        // Clear transcript after successful flush — daemon has consumed it
        try { writeFileSync(transcriptPath, '', 'utf-8'); } catch {}
      } else {
        console.error(`[Memory] vodou-hook-bin flush exited with code ${code}`);
      }
    });

    proc.on('error', (err) => {
      console.error(`[Memory] vodou-hook-bin flush error: ${err.message}`);
    });

    proc.unref();
  } catch (err) {
    console.error(`[Memory] flush spawn error: ${(err as Error).message}`);
  }
}

// --- BrainLoader execution ---

/**
 * Run user's query through the BrainLoader.
 * Fast path: worker socket (~1-2ms connect). Fallback: CLI spawn (~50-200ms).
 * Returns the full orchestrated output or empty string if no intent matched.
 */
async function runBrainLoader(query: string): Promise<{ matched: boolean; output: string }> {
  console.error(`[BrainLoader] "${query.substring(0, 80)}..."`);

  // Fast path: worker socket
  const sockResult = await callWorkerSocket('brain', { query, clean: false }, 60_000);
  if (sockResult !== null) {
    if (sockResult.ok) {
      const output = (sockResult.stdout || '').trim();
      if (output) {
        console.error(`[BrainLoader] matched via socket, ${output.length} chars`);
        return { matched: true, output };
      }
      // Socket responded ok but empty stdout — could be a tool that produced no output.
      // Fall through to CLI spawn so we don't silently drop a matched intent.
      console.error(`[BrainLoader] socket ok but empty stdout — falling back to CLI spawn`);
    } else {
      // Socket error (ok=false) — fall through to CLI spawn rather than giving up.
      console.error(`[BrainLoader] socket error (ok=false) — falling back to CLI spawn`);
    }
  }

  // Fallback: CLI spawn (worker socket unavailable)
  console.error(`[BrainLoader] socket unavailable, falling back to CLI spawn`);
  return runBrainLoaderCLI(query);
}

/**
 * CLI spawn fallback for BrainLoader.
 */
function runBrainLoaderCLI(query: string): Promise<{ matched: boolean; output: string }> {
  return new Promise((resolve) => {
    const bt4 = VC_PATH();

    const proc = spawn(bt4, ['brain', query], {
      cwd: getProjectRoot(),
      env: freshEnv(),
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ matched: false, output: '' });
    }, 60_000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Forward child stderr to gateway stderr (→ system.log) so DEBUG=1 output is visible
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      // Strip the agent instruction header (emoji lines at the top)
      const output = stdout.trim()
        .split('\n')
        .filter(line => !line.startsWith('🔥') && !line.startsWith('📎') && !line.startsWith('🤖') &&
                        !line.startsWith('⚡') && !line.startsWith('🎛️') && !line.startsWith('📖'))
        .join('\n')
        .trim();

      if (code === 0) {
        // Exit code 0 = brain command ran successfully (matched or no-intent — isNoIntentFoundOutput handles the distinction).
        // Don't require non-empty output: a matched tool could produce minimal stdout after header stripping.
        console.error(`[BrainLoader] CLI exited 0, ${output.length} chars`);
        resolve({ matched: true, output: output || 'No intent found for query' });
      } else {
        console.error(`[BrainLoader] no match via CLI (code=${code})`);
        resolve({ matched: false, output: '' });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      console.error(`[BrainLoader] CLI error: ${err.message}`);
      resolve({ matched: false, output: '' });
    });
  });
}

/**
 * Check if VODOU_SHOW_RAW_RESULTS=1 in .env (re-reads from disk, no restart needed).
 */
function showRawOIResults(): boolean {
  try {
    const envPath = path.resolve(getProjectRoot(), '.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('VODOU_SHOW_RAW_RESULTS=')) {
        return trimmed.split('=')[1]?.trim() === '1';
      }
    }
  } catch {}
  return false;
}

/**
 * Quick synchronous check: does this message contain (or is contained by) any intent keyword?
 * Used to override isFollowUp so short intent queries like "cpu memory disk" always hit BrainLoader.
 */
function messageMatchesIntent(message: string): boolean {
  try {
    const db = getDb();
    const lower = message.trim().toLowerCase();
    // Same LIKE logic as brain_loader.rs analyze_query_intent
    const rows = db.prepare(
      "SELECT keyword FROM intent_mappings WHERE ? LIKE '%' || keyword || '%' OR keyword LIKE '%' || ? || '%' LIMIT 1"
    ).all(lower, lower) as { keyword: string }[];
    return rows.length > 0;
  } catch {
    return false; // DB unavailable — don't override, let existing logic decide
  }
}

/**
 * Detect if a message is conversational (no tool needed) vs actionable (needs BrainLoader).
 * Simple heuristic — most messages go through BrainLoader, pure chat doesn't.
 */
function isConversationalOnly(message: string): boolean {
  const lower = message.trim().toLowerCase();
  // Pure greetings and small talk
  const chatPatterns = [
    /^(hi|hey|hello|sup|yo|howdy|good morning|good evening|gm|what'?s up)[\s!?.]*$/,
    /^(thanks|thank you|thx|ty|cool|nice|ok|okay|got it|understood|perfect|great)[\s!?.]*$/,
    /^(bye|goodbye|see ya|later|gn|good night)[\s!?.]*$/,
    // Short numeric/menu replies — stopping point selections (1, 2, 3, etc.)
    /^\d{1,2}$/,
    // "all" or "yes"/"no" — common skill replies
    /^(all|yes|no|y|n)[\s!?.]*$/,
  ];
  return chatPatterns.some(p => p.test(lower));
}

function isNoIntentFoundOutput(output: string): boolean {
  const t = (output || '').toLowerCase();
  return (
    t.includes('no intent found') ||
    t.includes('no matching intent') ||
    t.includes('could not find intent')
  );
}

function shouldBypassNoIntentToDirectLLM(): boolean {
  return currentProvider !== 'claude-cli' && currentProvider !== 'kimi-cli';
}

// PLAN-SKILLS-V2 §6 B4-remainder: dynamic ${VODOU_*} substitution.
// The Rust loader (src/skills_executor.rs::preprocess_skill_content) resolves the static
// vars (VODOU_SKILL_DIR, VODOU_PROJECT_ROOT, VODOU_USER) but leaves session-scoped ones for
// the gateway, which has the conversation context. No-op when the input has no placeholders.
function substituteVodouDynamicVars(text: string, conversationId: string, scope: Scope | null): string {
  if (!text.includes('${VODOU_')) return text;
  return text
    .replace(/\$\{VODOU_SESSION_ID\}/g, conversationId)
    .replace(/\$\{VODOU_SCOPE\}/g, scope?.raw ?? 'default');
}

function buildUserPromptWithOIResults(message: string, oiResults: string): string {
  if (!oiResults) return message;

  // Detect if oiResults contains a skill (vs. regular tool output)
  const isSkill = /# SKILL:/i.test(oiResults);

  if (isSkill) {
    // Skills are INSTRUCTIONS — the LLM must follow them, not interpret them
    return `${message}\n\n${oiResults}\n\nIMPORTANT: The content above is a SKILL — follow its instructions exactly. Display the first stopping point menu and STOP. Do not summarize, interpret, or skip ahead. The skill controls the flow.`;
  }

  if (showRawOIResults()) {
    return `${message}\n\n<oi_results>\n${oiResults}\n</oi_results>\n\nInterpret these Vodou results for the user. Be concise and add insights.`;
  }
  return `${message}\n\nOI execution results:\n${oiResults}\n\nInterpret these Vodou results for the user. Be concise and add insights. Never include XML-style wrapper tags in your response.`;
}

// --- Public API ---

export function isConfigured(): boolean {
  return currentProvider !== 'none';
}

export function getAuthType(): string {
  return currentProvider;
}

export interface StreamEvent {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'usage' | 'status';
  content?: string;
  status?: string;
  toolName?: string;
  toolId?: string;
  toolResult?: string;
  toolArgs?: Record<string, unknown>;
  serverName?: string;
  executionTime?: number;
  success?: boolean;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreateTokens?: number; costUsd?: number; durationMs?: number; model?: string; tokenBudget?: number; };
}

export type StreamCallback = (event: StreamEvent) => void;

/**
 * Chat with Claude — BrainLoader-first architecture.
 *
 * 1. Run query through BrainLoader (intent routing, parallel execution)
 * 2. Get memory context from daemon
 * 3. Send everything to Claude for conversational response
 */
export interface ChatOptions {
  channelAttachments?: ChannelAttachmentMeta[];
  /**
   * Scope of the conversation, derived from conversation.source.
   * Present for workbench conversations (integration/skill/flow); null
   * for the global/`web` chat. See src/scope.ts.
   */
  scope?: Scope | null;
}

export async function chat(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  options?: ChatOptions
): Promise<string> {
  // [DIAG] Log every chat() invocation so we can spot duplicate/recursive calls
  console.error(`[Gateway DIAG] chat() ENTRY convId=${conversationId} msg_len=${message.length} preview=${JSON.stringify(message.substring(0, 60))}`);

  // Phase 0 instrumentation — see PLANS/0.5.46/PHASE-0-INSTRUMENTATION-SPEC.md.
  // Pure observation, no behavior change. Disabled via VODOU_PHASE0_DISABLED=1.
  // We track here so all early-return paths still emit.
  const _phase0Start = Date.now();
  const _phase0Begin = (() => {
    try {
      return phase0.beginPrompt({
        conversationId,
        prompt: message,
        scope: options?.scope?.raw ?? null,
      });
    } catch { return null; }
  })();
  const _phase0Counters = phase0.makeCounters();
  const _phase0Stage = {
    daemon_intent_matched: false as boolean,
    daemon_intent_keyword: null as string | null,
    daemon_intent_confidence: null as number | null,
    daemon_auto_routed: false as boolean,
    brainloader_fired: false as boolean,
    brainloader_skill: null as string | null,
  };
  let _phase0Finalized = false;
  const _phase0Finalize = () => {
    if (_phase0Finalized) return;
    _phase0Finalized = true;
    try {
      phase0.finalize({
        begin: _phase0Begin,
        startMs: _phase0Start,
        counters: _phase0Counters,
        ..._phase0Stage,
      });
    } catch { /* never break the chat path */ }
  };
  // Wrap the original onEvent to side-track stream events into counters.
  // Also fires finalize() on `done` and `error` so all return paths are covered.
  const _origOnEvent = onEvent;
  onEvent = phase0.instrumentCallback(_phase0Start, _phase0Counters, (e: StreamEvent) => {
    if (e.type === 'done' || e.type === 'error') _phase0Finalize();
    _origOnEvent(e);
  });

  // Save user message to gateway transcript for memory extraction (skip heartbeat — noisy)
  const isHeartbeatConv = _heartbeatConversations.has(conversationId) || message.startsWith('[Heartbeat');
  if (!isHeartbeatConv) {
    const forTranscript = options?.channelAttachments?.length
      ? appendChannelAttachmentHints(message, options.channelAttachments)
      : message;
    saveUserToTranscript(forTranscript);
  }

  // Persona/skill conversations route through the skill_message WS handler
  // (see index.ts) which uses chatWithSkill directly. They never hit chat().

  // Step 0a: Check if this is a disambiguation follow-up → store routing feedback
  const pending = _pendingDisambiguations.get(conversationId);
  if (pending) {
    const choice = parseInt(message.trim(), 10);
    if (!isNaN(choice) && choice >= 1 && choice <= pending.options.length) {
      const selected = pending.options[choice - 1];
      // Store feedback so next time this query routes directly
      try {
        const { spawn } = await import('child_process');
        const bt4 = VC_PATH();
        spawn(bt4, ['routing-feedback', pending.query, selected.server, selected.tool], {
          cwd: getProjectRoot(),
          stdio: 'ignore',
          detached: true,
        }).unref();
        console.error(`[Feedback] Stored: "${pending.query}" → ${selected.server}::${selected.tool}`);
      } catch {}
    }
    _pendingDisambiguations.delete(conversationId);
  }

  // Step 0d: Heartbeat — skip BrainLoader, inject memory, dispatch directly to LLM
  if (_heartbeatConversations.has(conversationId) || message.startsWith('[Heartbeat')) {
    const memoryContext = await getMemoryContext(message, conversationId);
    recordMemoriesInjected(conversationId, memoryContext);
    console.error(`[Heartbeat] Dispatching heartbeat to provider (skip BrainLoader)`);
    console.error(`[Gateway DIAG] dispatchToProvider site=heartbeat convId=${conversationId}`);
    return dispatchToProvider(conversationId, message, onEvent, memoryContext, '', '', options?.channelAttachments, options?.scope ?? null);
  }

  // Step 0b: Check if this is a workflow follow-up (AGENT_ACTIONS — engine-enforced)
  // This MUST come before the active skill check — workflows have deterministic execution
  // CRITICAL: Engine-handled messages must return BEFORE the LLM sees them
  if (hasActiveWorkflow(conversationId)) {
    const workflowResult = await handleWorkflowChoice(conversationId, message, onEvent);
    if (workflowResult) {
      if (workflowResult.startsWith('__MENU_ONLY__')) {
        // Menu-only: stream directly, don't touch conversation history, don't call LLM
        const menuContent = workflowResult.replace('__MENU_ONLY__', '').trim();
        onEvent({ type: 'text', content: menuContent });
        onEvent({ type: 'done' });
        console.error(`[Workflow] Streaming menu directly (no LLM)`);
        return menuContent;
      }
      if (workflowResult.startsWith('__RESULTS_AND_MENU__')) {
        // Tool results + next menu: format results via LLM, then stream menu directly
        const content = workflowResult.replace('__RESULTS_AND_MENU__', '');
        const menuSplit = content.indexOf('\n\n---\n\n##');
        if (menuSplit >= 0) {
          const toolResults = content.substring(0, menuSplit).trim();
          const menuPart = content.substring(menuSplit + 5).trim(); // skip \n\n---\n
          // Format tool results via LLM
          const cleanResults = toolResults.replace(/<!--[\s\S]*?-->/g, '');
          const memoryContext = await getMemoryContext(message, conversationId);
          recordMemoriesInjected(conversationId, memoryContext);
          console.error(`[Gateway DIAG] dispatchToProvider site=workflow_results_and_menu convId=${conversationId}`);
          const formatted = await dispatchToProvider(conversationId, message, onEvent, memoryContext, cleanResults, '', undefined, options?.scope ?? null);
          // Stream the next menu directly after LLM response
          onEvent({ type: 'text', content: '\n\n' + menuPart });
          return formatted + '\n\n' + menuPart;
        }
        // Fallback: treat as results only
        const cleanResults = content.replace(/<!--[\s\S]*?-->/g, '');
        const memoryContext = await getMemoryContext(message, conversationId);
        recordMemoriesInjected(conversationId, memoryContext);
        console.error(`[Gateway DIAG] dispatchToProvider site=workflow_results_only_fallback convId=${conversationId}`);
        return dispatchToProvider(conversationId, message, onEvent, memoryContext, cleanResults, '', undefined, options?.scope ?? null);
      }
      // Has tool results — give to LLM to format (but strip AGENT_ACTIONS from context)
      const cleanResults = workflowResult.replace(/<!--[\s\S]*?-->/g, '');
      const memoryContext = await getMemoryContext(message, conversationId);
      recordMemoriesInjected(conversationId, memoryContext);
      console.error(`[Gateway DIAG] dispatchToProvider site=workflow_has_results convId=${conversationId}`);
      return dispatchToProvider(conversationId, message, onEvent, memoryContext, cleanResults, '', undefined, options?.scope ?? null);
    }
    // Didn't match an option — fall through to active skill check
  }

  // Step 0c: Restore persisted skill state if in-memory Maps are empty (e.g., after server restart)
  if (!_activeSkill.has(conversationId)) {
    try {
      const stored = loadSkillState(conversationId);
      if (stored) {
        _activeSkill.set(conversationId, { skillName: stored.skill_name, loadedAt: stored.loaded_at, skillContent: stored.oi_context || '' });
        if (stored.oi_context) {
          _lastOiContext.set(conversationId, { oiResults: stored.oi_context, skillName: stored.skill_name, timestamp: stored.loaded_at });
        }
        console.error(`[Skill] Restored persisted skill state: ${stored.skill_name} for ${conversationId}`);
      }
    } catch {}
  }

  // Step 0d: Check if this is a skill stopping point reply — skip BrainLoader
  // For skills WITHOUT AGENT_ACTIONS, number inputs go to the LLM with context
  const activeSkill = _activeSkill.get(conversationId);
  const isSkillReply = isMenuReplyCheck(message.trim());
  if (activeSkill && isSkillReply && !hasActiveWorkflow(conversationId)) {
    if (Date.now() - activeSkill.loadedAt < 1_800_000) {  // 30 min TTL (sliding window)
      console.error(`[Skill] Routing "${message}" to active skill "${activeSkill.skillName}" (skipping BrainLoader)`);
      activeSkill.loadedAt = Date.now();
      try { saveSkillState(conversationId, activeSkill.skillName, activeSkill.skillContent, activeSkill.loadedAt); } catch {}
      const memoryContext = await getMemoryContext(message, conversationId);
      recordMemoriesInjected(conversationId, memoryContext);
      const skillPrompt = activeSkill.skillContent
        ? `You are continuing an active Vodou skill. Follow the skill instructions. Respect all stopping points.\n\n--- SKILL ---\n${activeSkill.skillContent}\n--- END SKILL ---`
        : '';
      console.error(`[Gateway DIAG] dispatchToProvider site=active_skill_reply convId=${conversationId} skill=${activeSkill.skillName}`);
      return dispatchToProvider(conversationId, message, onEvent, memoryContext, '', skillPrompt, undefined, options?.scope ?? null);
    } else {
      _activeSkill.delete(conversationId);
      try { clearSkillState(conversationId); } catch {}
    }
  }

  // Clear active skill + stored context if user sends a non-trivial non-number message (they moved on)
  if (activeSkill && !isMenuReplyCheck(message.trim()) && message.trim().length > 3) {
    _activeSkill.delete(conversationId);
    _lastOiContext.delete(conversationId);
    try { clearSkillState(conversationId); } catch {}
    console.error(`[Skill] Cleared active skill "${activeSkill.skillName}" + stored context — user sent new query`);
  }

  // P19: Detect /skill-name prefix for explicit skill invocation
  const slashSkillMatch = message.match(/\/([a-zA-Z0-9_-]+(?:\s|$))/);
  const explicitSkill = slashSkillMatch ? slashSkillMatch[1].trim() : null;
  let brainQuery = message;
  if (explicitSkill) {
    brainQuery = message.replace(/\/[a-zA-Z0-9_-]+\s*/, '').trim() || explicitSkill;
    console.error(`[P19] Explicit skill invocation: /${explicitSkill}, context: "${brainQuery.substring(0, 80)}"`);
  }

  // P19: Suppress skill routing for long queries without /prefix
  const wordCount = message.trim().split(/\s+/).length;
  const suppressSkills = !explicitSkill && wordCount > 5;
  if (suppressSkills) {
    console.error(`[P19] Long query (${wordCount} words, no /prefix) — skills suppressed`);
  }

  // Step 1+2: Run memory search + BrainLoader IN PARALLEL (saves ~1s)
  // Skip BrainLoader for short follow-up messages in active conversations.
  // Without this, "do it" or "yes" triggers a new BrainLoader query that returns
  // different/no results, making the LLM "forget" what it was working on.
  //
  // Scoped workbench (integration/skill/flow): BrainLoader + daemon memory are
  // redundant with SDK `vodou_core_call` + scope-filtered catalog — skipping
  // cuts multi-second (sometimes 15s+) stalls before the first token. Use
  // `/skill name …` when you explicitly need BrainLoader skill routing.
  const skipPrefetchForWorkbench = Boolean(options?.scope) && !explicitSkill;
  // isFollowUp: skip BrainLoader for short replies like "yes", "do it", "ok" in active conversations.
  // BUT: override if the message matches a known intent keyword — short intent queries like
  // "cpu memory disk" (3 words) must always hit BrainLoader regardless of conversation state.
  const intentMatch = !explicitSkill && _bootstrappedConversations.has(conversationId)
    && message.trim().split(/\s+/).length <= 8
    ? messageMatchesIntent(message)
    : false;
  const isFollowUp = _bootstrappedConversations.has(conversationId)
    && !explicitSkill
    && message.trim().split(/\s+/).length <= 8
    && !message.trim().startsWith('/')
    && !intentMatch;
  if (intentMatch) {
    console.error(`[BrainLoader] Short message matches intent keyword — overriding isFollowUp, will run BrainLoader`);
  }
  const needsBrainLoader =
    !skipPrefetchForWorkbench && !isConversationalOnly(message) && !isFollowUp;
  if (skipPrefetchForWorkbench) {
    console.error('[Workbench] Skipping daemon memory + BrainLoader prefetch (use /skill to force brain)');
  }
  onEvent({
    type: 'status',
    status: skipPrefetchForWorkbench
      ? 'Thinking...'
      : (needsBrainLoader ? 'Loading context...' : 'Searching memory...'),
  });

  const memoryPromise = skipPrefetchForWorkbench
    ? Promise.resolve('')
    : getMemoryContext(message, conversationId);
  const brainPromise = needsBrainLoader
    ? (async () => {
        const startMs = Date.now();
        const result = explicitSkill
          ? await runBrainLoader(`/skill ${explicitSkill} ${brainQuery}`)
          : await runBrainLoader(suppressSkills ? `[NO_SKILLS] ${brainQuery}` : brainQuery);
        return { ...result, execTime: Date.now() - startMs };
      })()
    : Promise.resolve({ matched: false, output: '', execTime: 0 });

  const [memoryContext, brainResult] = await Promise.all([memoryPromise, brainPromise]);
  recordMemoriesInjected(conversationId, memoryContext);

  // Phase 0: stage daemon + brainloader signals from already-resolved state.
  try {
    // memoryContext carries the daemon's `additional_context` block which contains the
    // intent-signal hint when daemon auto-routed. Look for the markers we already emit.
    if (memoryContext && /Vodou tools detected for this query — auto-routing through BrainLoader/i.test(memoryContext)) {
      _phase0Stage.daemon_intent_matched = true;
      _phase0Stage.daemon_auto_routed = true;
      const m = memoryContext.match(/`([^`]+)` → `([^`]+)`\s+\(confidence:\s*(\d+)\)/);
      if (m) {
        _phase0Stage.daemon_intent_keyword = m[1];
        _phase0Stage.daemon_intent_confidence = parseInt(m[3], 10) / 100;
      }
    } else if (memoryContext && /Intent Signal/i.test(memoryContext)) {
      _phase0Stage.daemon_intent_matched = true;
    }
    if (brainResult && brainResult.matched && brainResult.output) {
      _phase0Stage.brainloader_fired = true;
      const skillMatch = brainResult.output.match(/^#\s*SKILL:\s*([^\n]+)/m);
      if (skillMatch) _phase0Stage.brainloader_skill = skillMatch[1].trim();
    }
  } catch { /* phase0 must never break chat */ }

  let oiResults = '';

  if (needsBrainLoader) {
    if (brainResult.matched) {
      const noIntentFound = isNoIntentFoundOutput(brainResult.output);
      if (noIntentFound) {
        // Suppress "No intent found" from being injected as active_context regardless of provider.
        // For non-CLI providers we also bypass to direct LLM; for CLI providers we let it fall through
        // to direct LLM naturally (oiResults stays empty = no context noise injected).
        console.error(`[BrainLoader] no intent found in ${brainResult.execTime}ms — suppressing context injection for provider=${currentProvider}`);
      } else if (/^Tool execution failed:|^Error:/i.test(brainResult.output.trim())) {
        // BrainLoader returned an error (e.g. broken pipe, daemon down) — don't inject
        // error text as context or the LLM will misinterpret it as a channel/tool failure.
        console.error(`[BrainLoader] error result in ${brainResult.execTime}ms, suppressing: ${brainResult.output.trim().substring(0, 80)}`);
      } else {
        oiResults = rewriteAuthError(brainResult.output);
        if (oiResults !== brainResult.output) {
          console.error(`[BrainLoader] auth error detected — rewrote ${brainResult.output.length} chars → integration-hub guidance`);
        }
        // PLAN-SKILLS-V2 §6 B4-remainder: substitute dynamic ${VODOU_*} vars the Rust loader
        // intentionally left unresolved (it lacks session ctx). Done here so stored skill
        // content + downstream prompts all see the resolved values.
        oiResults = substituteVodouDynamicVars(oiResults, conversationId, options?.scope ?? null);
        console.error(`[BrainLoader] matched in ${brainResult.execTime}ms, ${oiResults.length} chars`);
        detectWorkflow(conversationId, oiResults, message);

        if (showRawOIResults()) {
          const debugBlock = `<details><summary>🔍 Raw Vodou Results (${oiResults.length} chars, ${brainResult.execTime}ms)</summary>\n\n\`\`\`\n${oiResults}\n\`\`\`\n</details>\n\n`;
          onEvent({ type: 'text', content: debugBlock });
        }

        const skillMatch = oiResults.match(/# SKILL:\s*(\S+)/i);
        const now = Date.now();
        if (skillMatch) {
          _activeSkill.set(conversationId, { skillName: skillMatch[1], loadedAt: now, skillContent: oiResults });
          console.error(`[Skill] Tracking active skill: ${skillMatch[1]}`);
        }

        // Store Vodou context for follow-up turns (sticky context)
        _lastOiContext.set(conversationId, {
          oiResults,
          skillName: skillMatch ? skillMatch[1] : null,
          timestamp: now,
        });

        // Persist skill + context to DB so browser refresh doesn't lose state
        if (skillMatch) {
          try { saveSkillState(conversationId, skillMatch[1], oiResults, now); } catch {}
        }
      }
    } else {
      // BrainLoader didn't match — check if we have stored context from a previous turn
      const stored = _lastOiContext.get(conversationId);
      if (stored && Date.now() - stored.timestamp < 600_000) {
        oiResults = stored.oiResults;
        stored.timestamp = Date.now(); // refresh TTL on use
        console.error(`[BrainLoader] no match (${brainResult.execTime}ms) — reusing stored context (${oiResults.length} chars, skill: ${stored.skillName || 'none'})`);
      } else {
        console.error(`[BrainLoader] no match (${brainResult.execTime}ms)`);
      }
      if (showRawOIResults()) {
        onEvent({ type: 'text', content: `<details><summary>🔍 BrainLoader: no match (${brainResult.execTime}ms)${oiResults ? ' — using stored context' : ''}</summary></details>\n\n` });
      }
    }
  } else {
    // BrainLoader skipped (conversational message) — still re-inject stored context if available
    const stored = _lastOiContext.get(conversationId);
    if (stored && Date.now() - stored.timestamp < 600_000) {
      oiResults = stored.oiResults;
      stored.timestamp = Date.now();
      console.error(`[BrainLoader] skipped (conversational) — reusing stored context (${oiResults.length} chars)`);
    }
  }

  // Step 2.5a: If workflow was detected (actions.json sidecar OR inline AGENT_ACTIONS),
  // present ONLY the first stopping point. Don't send the full skill content to the LLM —
  // the engine manages the flow.
  //
  // FIX 2026-04-26 (§0.7a): the prior guard `oiResults.includes('AGENT_ACTIONS')` was a
  // fragile string check from the inline-only era. actions.json skills set workflow state
  // via detectWorkflow() but their SKILL.md body rarely contains the literal string
  // "AGENT_ACTIONS", so the guard missed and the message blew through to the LLM
  // (silent broken-menu behavior on `qa-testing` and disabled state on 3 other skills).
  // Workflow state (set by detectWorkflow at workflow-driver.ts:551-595) is the source of
  // truth — the inner `workflow.step === 'menu'` check below already gates correctly.
  if (hasActiveWorkflow(conversationId)) {
    // Import the workflow state to get the first stopping point's options
    const workflow = getActiveWorkflow(conversationId);
    if (workflow && workflow.step === 'menu') {
      let menuText = '';
      if (workflow.stoppingPoints && workflow.stoppingPoints[workflow.currentPhase]) {
        const sp = workflow.stoppingPoints[workflow.currentPhase];
        const vars = workflow.variables || {};
        const resolveVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || `{{${k}}}`);

        if (sp.type === 'text_input') {
          // Text input phase — show prompt, wait for any input
          menuText = resolveVars(sp.title) + '\n\n*(Type your answer)*';
        } else {
          menuText += `## ${resolveVars(sp.title)}\n\n`;
          for (const [key, opt] of Object.entries(sp.options)) {
            menuText += `${key}. ${resolveVars((opt as any).label)}\n`;
          }
        }
      } else {
        const vars = workflow.variables || {};
        const resolveVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || `{{${k}}}`);
        for (const [key, opt] of Object.entries(workflow.options)) {
          menuText += `${key}. ${resolveVars((opt as any).label)}\n`;
        }
      }
      // Execute initial_steps if they exist (auto-fire on skill load)
      let initialResults = '';
      if (workflow.initialSteps && workflow.initialSteps.length > 0 && !workflow.initialStepsRan) {
        console.error(`[Workflow] Executing ${workflow.initialSteps.length} initial steps`);
        initialResults = await executeInitialSteps(workflow, onEvent, conversationId);
        workflow.initialStepsRan = true;
      }

      // Stream results + menu directly — no LLM call, no conversation history pollution
      const fullContent = initialResults ? initialResults + '\n\n' + menuText.trim() : menuText.trim();
      // If there are initial results, send to LLM to format; otherwise stream menu directly
      if (initialResults) {
        const memoryContext = await getMemoryContext(message, conversationId);
        recordMemoriesInjected(conversationId, memoryContext);
        console.error(`[Gateway DIAG] dispatchToProvider site=workflow_initial_steps_format convId=${conversationId} initialResults_len=${initialResults.length}`);
        return dispatchToProvider(conversationId, message, onEvent, memoryContext, fullContent, '', undefined, options?.scope ?? null);
      }
      onEvent({ type: 'text', content: menuText.trim() });
      onEvent({ type: 'done' });
      console.error(`[Workflow] Presenting first stopping point menu (skipping LLM, no history)`);
      return menuText.trim();
    }
  }

  // Step 2.5b: Detect disambiguation menu — render as buttons, don't send to LLM
  const disambigMatch = oiResults.match(/<oi_disambiguation>([\s\S]*?)<\/oi_disambiguation>/);
  if (disambigMatch) {
    const menuText = disambigMatch[1].trim();
    // Parse numbered options: "1. Description (server::tool)"
    const lines = menuText.split('\n').filter(l => /^\d+\.\s/.test(l.trim()));
    const intro = menuText.split('\n').filter(l => !/^\d+\.\s/.test(l.trim()) && l.trim()).join('\n');

    // Save disambiguation state for feedback learning
    const parsedOptions: Array<{server: string; tool: string}> = [];
    for (const line of lines) {
      const m = line.match(/\(([^:]+)::([^)]+)\)/);
      if (m) parsedOptions.push({ server: m[1], tool: m[2] });
    }
    if (parsedOptions.length > 0) {
      _pendingDisambiguations.set(conversationId, { query: message, options: parsedOptions });
    }

    let output = '';
    if (intro) output += intro + '\n\n';
    for (const line of lines) {
      output += line.trim() + '\n';
    }
    // Stream the disambiguation menu directly — no LLM call
    onEvent({ type: 'text', content: output.trim() });
    onEvent({ type: 'done' });
    console.error(`[Disambiguation] presented ${lines.length} options to user`);
    return output.trim();
  }

  // Step 3: Send to LLM for conversational response
  onEvent({ type: 'status', status: 'Thinking...' });
  console.error(`[Gateway DIAG] dispatchToProvider site=conversational_main convId=${conversationId} oiResults_len=${oiResults.length}`);
  return dispatchToProvider(conversationId, message, onEvent, memoryContext, oiResults, '', options?.channelAttachments, options?.scope ?? null);
}

/**
 * Chat with Claude using a skill as the system prompt.
 * Skips BrainLoader — the skill IS the intelligence.
 * The SKILL.md content becomes the system prompt, guiding Claude through
 * stopping points and interactive workflows.
 */
export async function chatWithSkill(
  conversationId: string,
  message: string,
  skillContent: string,
  onEvent: StreamCallback
): Promise<string> {
  saveUserToTranscript(message);
  const memoryContext = await getMemoryContext(message, conversationId);
  recordMemoriesInjected(conversationId, memoryContext);

  const skillSystemPrompt = `You are running an interactive Vodou skill in a floating panel. Follow the skill instructions below step by step.

CRITICAL RULES:
1. Display the skill's overview and the first stopping point. Show ALL numbered options verbatim and STOP. Wait for the user's choice.
2. NEVER tell the user to run /mcp or "connect via Claude Code". You are inside the Vodou gateway, not Claude Code. If a tool needs auth, point them to http://localhost:8765/#/apps.
3. Numbered replies (1, 2, 3, ...) are handled deterministically by the panel — you do NOT need to execute the steps yourself. Just present the menu.
4. Be conversational but stay focused on the skill workflow.

--- SKILL CONTENT ---
${skillContent}
--- END SKILL ---`;

  console.error(`[Gateway DIAG] dispatchToProvider site=chatWithSkill convId=${conversationId} skill_len=${skillContent.length}`);
  return dispatchToProvider(conversationId, message, onEvent, memoryContext, '', skillSystemPrompt);
}

// --- Token-aware context management ---

/** Context window limits by provider (in tokens). */
const CONTEXT_LIMITS: Record<string, number> = {
  'claude-cli': 200_000,
  'anthropic': 200_000,
  'openai': 128_000,
  'google': 1_000_000,
  'groq': 32_000,
  'deepseek': 64_000,
  'xai': 128_000,
  'mistral': 32_000,
  'kimi': 131_072,
  'kimi-cli': 131_072,
  'openrouter': 128_000,
  'ollama': 32_000,
  'custom': 64_000,
};
const CONTEXT_THRESHOLD = 0.80; // compress at 80% usage
const KEEP_RECENT = 10; // always keep last N messages verbatim

/** Rough token estimate: chars / 4. Fast, no dependency. */
function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') chars += block.text.length;
        else if ('content' in block && typeof block.content === 'string') chars += block.content.length;
        else if ((block as any).type === 'image') chars += 8000 * 4; // rough budget for vision tiles
        else if ((block as any).type === 'document') {
          const d = (block as any).source?.data;
          chars += typeof d === 'string' ? Math.min(d.length, 400_000) : 50_000;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Extract plain text from a message for summarization. */
function extractMessageText(msg: any): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((b: any) => b.text || (typeof b.content === 'string' ? b.content : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Summarize older messages into a condensed block. */
function summarizeOlderMessages(messages: any[]): string {
  const userTopics: string[] = [];
  const assistantPoints: string[] = [];
  const toolResults: string[] = [];

  for (const msg of messages) {
    const text = extractMessageText(msg);
    if (!text) continue;

    if (msg.role === 'user') {
      // Check if it's a tool_result
      if (Array.isArray(msg.content) && msg.content.some((b: any) => b.type === 'tool_result')) {
        const preview = text.substring(0, 150).replace(/\n/g, ' ');
        toolResults.push(preview);
      } else {
        const preview = text.substring(0, 100).replace(/\n/g, ' ');
        if (preview.trim()) userTopics.push(preview);
      }
    } else if (msg.role === 'assistant') {
      const preview = text.substring(0, 150).replace(/\n/g, ' ');
      if (preview.trim()) assistantPoints.push(preview);
    }
  }

  let summary = '[Conversation Summary — older messages compacted]\n';
  if (userTopics.length > 0) {
    summary += 'User discussed: ' + userTopics.slice(0, 5).join('; ') + '\n';
  }
  if (assistantPoints.length > 0) {
    summary += 'Key responses: ' + assistantPoints.slice(0, 5).join('; ') + '\n';
  }
  if (toolResults.length > 0) {
    summary += 'Tool results: ' + toolResults.slice(0, 3).join('; ') + '\n';
  }
  return summary;
}

/** Proactive compression threshold — compress at 50% of message-only tokens.
 *  Real usage is higher (system prompt + tools + Vodou results add 20-40K tokens). */
const PROACTIVE_THRESHOLD = 0.50;

/**
 * Phase 1 compression: replace old tool_result content with short placeholders.
 * Returns a NEW array — never mutates the original.
 * Messages in the KEEP_RECENT tail are left untouched.
 */
function pruneOldToolOutputs(messages: any[], keepRecent: number = KEEP_RECENT): any[] {
  if (messages.length <= keepRecent) return messages;

  const boundary = messages.length - keepRecent;
  const result: any[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Recent messages: pass through unchanged
    if (i >= boundary) {
      result[i] = msg;
      continue;
    }

    // Old user messages containing tool_result blocks: prune content
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const blocks = msg.content as any[];
      const hasToolResult = blocks.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        const prunedBlocks = blocks.map((b: any) => {
          if (b.type === 'tool_result') {
            const originalLen = typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content).length;
            return {
              type: 'tool_result',
              tool_use_id: b.tool_use_id,
              content: `[Tool output cleared — ${originalLen} chars]`,
              ...(b.is_error ? { is_error: b.is_error } : {}),
            };
          }
          return b;
        });
        result[i] = { role: 'user', content: prunedBlocks };
        continue;
      }
    }

    // Everything else: pass through
    result[i] = msg;
  }

  return result;
}

/**
 * Remove orphaned tool_use / tool_result blocks that have no matching counterpart.
 * Prevents API 400 errors from trimHistory splitting pairs.
 * Returns a new array.
 */
function sanitizeToolPairs(messages: any[]): any[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content as any[]) {
        if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content as any[]) {
        if (b.type === 'tool_result' && b.tool_use_id) toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // IDs that have both a tool_use and a tool_result
  const pairedIds = new Set<string>();
  for (const id of toolUseIds) {
    if (toolResultIds.has(id)) pairedIds.add(id);
  }

  const result: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const blocks = (msg.content as any[]).filter((b: any) => {
        if (b.type === 'tool_use') return pairedIds.has(b.id);
        return true;
      });
      if (blocks.length > 0) result.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      const blocks = (msg.content as any[]).filter((b: any) => {
        if (b.type === 'tool_result') return pairedIds.has(b.tool_use_id);
        return true;
      });
      if (blocks.length > 0) result.push({ role: 'user', content: blocks });
    } else {
      result.push(msg);
    }
  }

  // Ensure first message is role:user with text content (API requirement).
  // Drop leading assistant messages and orphaned tool_result-only user messages.
  while (result.length > 0) {
    const first = result[0];
    if (first.role === 'assistant') { result.shift(); continue; }
    if (first.role === 'user' && Array.isArray(first.content)) {
      const allTR = (first.content as any[]).every((b: any) => b.type === 'tool_result');
      if (allTR) { result.shift(); continue; }
    }
    break;
  }

  return result;
}

/**
 * Get messages with Phase 1 compression: prune old tool outputs + sanitize pairs.
 * All provider paths should use this instead of conversations.getMessages() directly.
 */
function getCompressedMessages(conversationId: string): any[] {
  const raw = getConversationManager().getMessages(conversationId);
  if (raw.length <= KEEP_RECENT) return raw;
  const pruned = pruneOldToolOutputs(raw, KEEP_RECENT);
  const sanitized = sanitizeToolPairs(pruned);
  if (raw.length > KEEP_RECENT) {
    const rawTokens = estimateTokens(raw);
    const prunedTokens = estimateTokens(sanitized);
    if (rawTokens !== prunedTokens) {
      console.error(`[Compression] ${rawTokens} → ${prunedTokens} est. tokens (saved ${rawTokens - prunedTokens})`);
    }
  }
  return sanitized;
}

/**
 * Proactive compaction: check if conversation is approaching context limits
 * and compact BEFORE sending to the API.
 */
function maybeProactiveCompact(conversationId: string, onEvent?: StreamCallback): boolean {
  const messages = getConversationManager().getMessages(conversationId);
  if (messages.length <= KEEP_RECENT) return false;

  const estimated = estimateTokens(messages);
  const limit = CONTEXT_LIMITS[currentProvider as keyof typeof CONTEXT_LIMITS] || 200_000;
  const threshold = Math.floor(limit * PROACTIVE_THRESHOLD);

  if (estimated < threshold) return false;

  console.error(
    `[Proactive Compaction] ${estimated} est. tokens >= ${PROACTIVE_THRESHOLD * 100}% of ${limit} ` +
    `(threshold ${threshold}) — compacting ${conversationId.substring(0, 8)}`
  );

  if (onEvent) {
    onEvent({ type: 'status', status: 'Optimizing conversation context...' });
  }

  return compactConversation(conversationId);
}

/**
 * Reactive compaction: compress older messages in a conversation when context limit is hit.
 * Keeps last KEEP_RECENT messages verbatim, summarizes the rest.
 * Returns true if compaction actually reduced the message count.
 */
function compactConversation(conversationId: string): boolean {
  const conversations = getConversationManager();
  const messages = conversations.getMessages(conversationId);

  if (messages.length <= KEEP_RECENT) {
    console.error(`[Compaction] Only ${messages.length} messages — nothing to compact`);
    return false;
  }

  const olderMessages = messages.slice(0, -KEEP_RECENT);
  const summary = summarizeOlderMessages(olderMessages);

  // Replace conversation with summary + recent messages
  conversations.clear(conversationId);
  // Re-add summary as a user message
  conversations.addUserMessage(conversationId, summary);
  // Re-add recent messages
  const recentMessages = messages.slice(-KEEP_RECENT);
  for (const msg of recentMessages) {
    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            conversations.addToolResult(conversationId, tr.tool_use_id, tr.content, tr.is_error);
          }
          continue;
        }
        const hasMultimodal = (msg.content as any[]).some(
          (b: any) => b.type === 'image' || b.type === 'document'
        );
        if (hasMultimodal) {
          conversations.addUserMessage(conversationId, msg.content as Anthropic.Messages.ContentBlockParam[]);
          continue;
        }
      }
      const text = extractMessageText(msg);
      if (text) conversations.addUserMessage(conversationId, text);
    } else if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text' as const, text: String(msg.content) }];
      conversations.addAssistantMessage(conversationId, content as any);
    }
  }

  // Ensure pairs are intact after re-adding recent messages
  conversations.trimAfterToolResults(conversationId);

  const newCount = conversations.getMessages(conversationId).length;
  console.error(`[Compaction] Compacted ${messages.length} → ${newCount} messages (removed ${olderMessages.length} older)`);
  return newCount < messages.length;
}

// --- CLI mode implementation ---

function formatConversationForCLI(conversationId: string, newMessage: string): string {
  const conversations = getConversationManager();
  const messages = getCompressedMessages(conversationId);

  if (messages.length === 0) return newMessage;

  // Token-aware trimming: estimate tokens and compress if over threshold
  const limit = CONTEXT_LIMITS[currentProvider] || 200_000;
  const threshold = Math.floor(limit * CONTEXT_THRESHOLD);
  const totalTokens = estimateTokens(messages);

  let messagesToUse: any[];
  let summaryPrefix = '';

  if (totalTokens > threshold && messages.length > KEEP_RECENT) {
    // Split: summarize old, keep recent verbatim
    const olderMessages = messages.slice(0, -KEEP_RECENT);
    const recentMessages = messages.slice(-KEEP_RECENT);
    summaryPrefix = summarizeOlderMessages(olderMessages);
    messagesToUse = recentMessages;
    console.error(`[Context] Token-aware trim: ${totalTokens} tokens > ${threshold} threshold. Compacted ${olderMessages.length} older messages, keeping ${recentMessages.length} recent.`);
  } else {
    messagesToUse = messages.slice(-20);
  }

  let context = '<conversation_history>\n';
  if (summaryPrefix) {
    context += summaryPrefix + '\n';
  }

  for (const msg of messagesToUse) {
    if (msg.role === 'user') {
      let text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
          : '';
      // Strip Vodou context blocks from history — they're re-injected fresh per turn
      text = text
        .replace(/<active_context>[\s\S]*?<\/active_context>\s*/g, '')
        .replace(/<oi_results>[\s\S]*?<\/oi_results>\s*/g, '')
        .replace(/Vodou execution results:[\s\S]*?(?=User's new message:|$)/g, '')
        .replace(/IMPORTANT: The active_context[\s\S]*?\n\n/g, '')
        .replace(/Interpret the active_context[\s\S]*?\n\n/g, '')
        .trim();
      if (text) context += `User: ${text}\n`;
    } else if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      if (text) context += `Assistant: ${text}\n`;
    }
  }

  context += '</conversation_history>\n\n';
  context += `User's new message: ${newMessage}`;
  return context;
}

/**
 * Default: pass each user turn via stdin as NDJSON (`--input-format=stream-json`), same protocol as Claude Code bridge.
 * Set `VODOU_GATEWAY_CLI_LEGACY_ARGV_PROMPT=1` to restore passing user text as the final argv (old behavior).
 */
function useClaudeCliStreamJsonStdin(): boolean {
  const v = process.env.VODOU_GATEWAY_CLI_LEGACY_ARGV_PROMPT;
  return v !== '1' && v !== 'true';
}

function usePersistentClaudeCliPool(): boolean {
  const v = process.env.VODOU_GATEWAY_DISABLE_PERSISTENT_CLI;
  return v !== '1' && v !== 'true';
}

function restartPoolOnSystemPromptChange(): boolean {
  const v = process.env.VODOU_GATEWAY_POOL_RESTART_ON_SYSTEM_PROMPT_CHANGE;
  return v === '1' || v === 'true';
}

/** One NDJSON line for `--input-format=stream-json` (aligned with CC SDK / directConnect shape). */
function streamJsonUserMessageLine(userText: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: userText }],
    },
    parent_tool_use_id: null,
    session_id: '',
  });
}

type PendingCliTurn = {
  onEvent: StreamCallback;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  fullText: string;
  lastAllText: string;
  finalUsage?: StreamEvent['usage'];
  seenToolIds: Set<string>;
  /** Per-tool start timestamps so we can compute executionTime when the matching tool_result arrives. */
  toolStartTimes: Map<string, number>;
  startMs: number;
  /** Undefined when VODOU_GATEWAY_CLI_TURN_TIMEOUT_MS=0 */
  timeout?: NodeJS.Timeout;
};

type QueuedCliTurn = {
  prompt: string;
  onEvent: StreamCallback;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  attempt?: number;
};

type ClaudeCliSession = {
  conversationId: string;
  systemPrompt: string;
  cliModel: string;
  proc: ReturnType<typeof spawn>;
  stdin: NonNullable<ReturnType<typeof spawn>['stdin']>;
  stdout: NonNullable<ReturnType<typeof spawn>['stdout']>;
  stderr: NonNullable<ReturnType<typeof spawn>['stderr']>;
  buffer: string;
  queue: QueuedCliTurn[];
  pending: PendingCliTurn | null;
  stderrBuffer: string;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
  /** Set before killCliSession from pool logic so proc.on('close') does not count as crash */
  poolKillReason?: 'idle' | 'timeout' | 'stdin' | 'restart';
  /** Completed turn count for this session (for pool recycling). */
  turnCount: number;
  /** Last cache_read_input_tokens reported by the CLI (for pool recycling). */
  lastCacheReadTokens: number;
};

const _cliSessions = new Map<string, ClaudeCliSession>();
const CLI_SESSION_IDLE_MS = parseInt(process.env.VODOU_GATEWAY_CLI_POOL_IDLE_MS || '600000', 10); // 10 min
/** Per-turn wall clock; 0 = disabled. Default 15m — multi-tool turns can exceed 3m easily. */
const CLI_TURN_TIMEOUT_MS = parseInt(process.env.VODOU_GATEWAY_CLI_TURN_TIMEOUT_MS || '900000', 10);
/** Recycle pool session when cumulative cache_read tokens exceed this. Default 500k.
 *  Prevents unbounded prefix growth in persistent CLI sessions (tool results accumulate
 *  inside the subprocess and are re-sent every turn). Set to 0 to disable. */
const CLI_POOL_TOKEN_BUDGET = parseInt(process.env.VODOU_GATEWAY_POOL_TOKEN_BUDGET || '500000', 10);

// Pool diagnostics
const _cliPoolStats = {
  pool_spawned: 0,
  pool_reused: 0,
  pool_restarts: 0,
  pool_timeout_kills: 0,
  pool_idle_kills: 0,
  pool_crash_kills: 0,
};
function logPoolStats(): void {
  const { pool_spawned, pool_reused, pool_restarts, pool_timeout_kills, pool_idle_kills, pool_crash_kills } = _cliPoolStats;
  console.error(`[CLI pool stats] spawned=${pool_spawned} reused=${pool_reused} restarts=${pool_restarts} timeout_kills=${pool_timeout_kills} idle_kills=${pool_idle_kills} crash_kills=${pool_crash_kills} active=${_cliSessions.size}`);
}
/** Check if any CLI session is alive (process running). Used by ensure endpoint to skip blocking live test. */
export function hasActiveCliSession(): boolean {
  for (const s of _cliSessions.values()) {
    if (!s.proc.killed && s.proc.exitCode === null) return true;
  }
  return false;
}

/** Expose pool stats for health endpoint */
export function getCliPoolStats() {
  let pendingSessions = 0;
  let queuedTurns = 0;
  let oldestActivityMs = 0;
  let maxCacheReadTokens = 0;
  let totalTurns = 0;
  const now = Date.now();
  for (const s of _cliSessions.values()) {
    if (s.pending) pendingSessions++;
    queuedTurns += s.queue.length;
    oldestActivityMs = Math.max(oldestActivityMs, now - s.lastActivityAt);
    maxCacheReadTokens = Math.max(maxCacheReadTokens, s.lastCacheReadTokens);
    totalTurns += s.turnCount;
  }
  return {
    ..._cliPoolStats,
    activeSessions: _cliSessions.size,
    pendingSessions,
    queuedTurns,
    oldestActivityMs,
    maxCacheReadTokens,
    totalTurns,
    tokenBudget: CLI_POOL_TOKEN_BUDGET,
  };
}

// Gateway shell mode controls how much of Claude's tool surface is exposed to the
// gateway-spawned Claude CLI. Set via VODOU_GATEWAY_SHELL_MODE env var.
//   restricted — Bash only + vodou-core-only text guard (legacy behavior, safest for multi-user)
//   verify     — Bash + read-only investigation tools (Read/Grep/Glob), no vodou-core guard
//   full       — Full Claude Code parity (Bash/Read/Write/Edit/Grep/Glob), no guard, higher max-turns
// Default is `full` — single-user dev parity with terminal Claude Code. See PLAN-GATEWAY-SHELL-MODES.md.
type GatewayShellMode = 'restricted' | 'verify' | 'full';

function getGatewayShellMode(): GatewayShellMode {
  const raw = (process.env.VODOU_GATEWAY_SHELL_MODE || 'full').toLowerCase().trim();
  if (raw === 'restricted' || raw === 'verify' || raw === 'full') return raw;
  return 'full';
}

function shellModeAllowedTools(mode: GatewayShellMode): string {
  switch (mode) {
    case 'restricted': return 'Bash';
    case 'verify':     return 'Bash,Read,Grep,Glob';
    case 'full':       return 'Bash,Read,Write,Edit,Grep,Glob';
  }
}

function shellModeMaxTurns(mode: GatewayShellMode, isMenuReply: boolean): string {
  if (isMenuReply) return '1';
  switch (mode) {
    case 'restricted': return '15';
    case 'verify':     return '25';
    case 'full':       return '50';
  }
}

function shellModeInjectsVodouCoreGuard(mode: GatewayShellMode): boolean {
  return mode === 'restricted';
}

function buildPersistentCliArgs(systemPrompt: string): string[] {
  const mode = getGatewayShellMode();
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--settings', '{"hooks":{}}',
    '--model', CLI_MODEL,
    '--max-turns', shellModeMaxTurns(mode, false),
    '--dangerously-skip-permissions',
    '--allowedTools', shellModeAllowedTools(mode),
    '--system-prompt', systemPrompt,
  ];
}

function killCliSession(session: ClaudeCliSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try { session.stdin.destroy(); } catch {}
  try { session.stdout.destroy(); } catch {}
  try { session.stderr.destroy(); } catch {}
  try { session.proc.kill('SIGTERM'); } catch {}
}

function armIdleTimer(session: ClaudeCliSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (!session.pending && session.queue.length === 0) {
      console.error(`[CLI pool] Idle timeout — closing ${session.conversationId.substring(0, 8)}`);
      _cliPoolStats.pool_idle_kills++;
      logPoolStats();
      _cliSessions.delete(session.conversationId);
      session.poolKillReason = 'idle';
      killCliSession(session);
    } else {
      armIdleTimer(session);
    }
  }, CLI_SESSION_IDLE_MS);
}

function processNextQueuedTurn(session: ClaudeCliSession): void {
  if (session.pending || session.queue.length === 0) return;
  const next = session.queue.shift()!;
  let turnTimeout: NodeJS.Timeout | undefined;
  if (CLI_TURN_TIMEOUT_MS > 0) {
    turnTimeout = setTimeout(() => {
      if (session.pending) {
        const err = new Error(
          `claude CLI turn timed out after ${Math.round(CLI_TURN_TIMEOUT_MS / 1000)}s ` +
            `(set VODOU_GATEWAY_CLI_TURN_TIMEOUT_MS=0 to disable, or increase the limit)`,
        );
        _cliPoolStats.pool_timeout_kills++;
        logPoolStats();
        next.onEvent({ type: 'error', error: err.message });
        next.reject(err);
        session.pending = null;
        _cliSessions.delete(session.conversationId);
        session.poolKillReason = 'timeout';
        killCliSession(session);
      }
    }, CLI_TURN_TIMEOUT_MS);
  }

  session.pending = {
    onEvent: next.onEvent,
    resolve: next.resolve,
    reject: next.reject,
    fullText: '',
    lastAllText: '',
    seenToolIds: new Set<string>(),
    toolStartTimes: new Map<string, number>(),
    startMs: Date.now(),
    timeout: turnTimeout,
  };
  session.lastActivityAt = Date.now();

  const line = streamJsonUserMessageLine(next.prompt) + '\n';
  const pendingRef = session.pending;
  const attempt = next.attempt || 0;
  const retryTurnOnce = (): boolean => {
    if (attempt >= 1) return false;
    try {
      _cliSessions.delete(session.conversationId);
      session.poolKillReason = 'stdin';
      killCliSession(session);
      const revived = getOrCreateCliSession(session.conversationId, session.systemPrompt);
      revived.queue.unshift({ ...next, attempt: attempt + 1 });
      processNextQueuedTurn(revived);
      return true;
    } catch (e) {
      console.error(`[CLI pool] failed to auto-recover dead stdin: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
  const failTurn = (message: string, kill: boolean) => {
    if (turnTimeout) clearTimeout(turnTimeout);
    if (session.pending !== pendingRef) return;
    session.pending = null;
    const err = new Error(message);
    next.onEvent({ type: 'error', error: err.message });
    next.reject(err);
    if (kill) {
      _cliSessions.delete(session.conversationId);
      session.poolKillReason = 'stdin';
      killCliSession(session);
    }
  };

  try {
    session.stdin.write(line, (err) => {
      if (!err) return;
      const code = (err as NodeJS.ErrnoException).code;
      const isPipe =
        code === 'EPIPE' ||
        code === 'ERR_STREAM_DESTROYED' ||
        /EPIPE|destroyed/i.test(err.message);
      const msg = isPipe
        ? 'Claude CLI closed stdin (process exited or crashed). The next message will start a new session.'
        : err.message;
      console.error(`[CLI pool] stdin write error: ${msg}`);
      if (isPipe && retryTurnOnce()) return;
      failTurn(msg, true);
    });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const isPipe = /EPIPE|destroyed/i.test(raw);
    if (isPipe && retryTurnOnce()) return;
    failTurn(
      isPipe
        ? 'Claude CLI closed stdin (process exited or crashed). The next message will start a new session.'
        : raw,
      true,
    );
  }
}

function wireCliSessionStreams(session: ClaudeCliSession): void {
  session.stdout.on('data', (data: Buffer) => {
    const pending = session.pending;
    session.buffer += data.toString();
    if (pending) session.lastActivityAt = Date.now();
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() || '';
    if (!pending) return;
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }

      // Debug: log event types to trace tool events and stop reasons
      if (event.type === 'result') {
        console.error(`[CLI pool] RESULT: stop=${event.stop_reason || event.subtype} turns=${event.num_turns} duration=${event.duration_ms}ms cost=$${event.total_cost_usd?.toFixed(4) || '?'}`);
      } else if (event.type !== 'stream_event' && event.type !== 'assistant' && event.type !== 'rate_limit_event') {
        console.error(`[CLI pool event] type=${event.type} tool=${event.tool || ''}`);
      } else if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
        console.error(`[CLI pool stream] content_block_start block_type=${event.event.content_block?.type} name=${event.event.content_block?.name || ''}`);
      }

      if (event.type === 'stream_event' && event.event) {
        const se = event.event;
        if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
          pending.onEvent({ type: 'text', content: se.delta.text });
          pending.fullText += se.delta.text;
          pending.lastAllText += se.delta.text;
        }
        // Tool use — create chip immediately for UI feedback
        if (se.type === 'content_block_start' && se.content_block?.type === 'tool_use') {
          const toolId = se.content_block.id || se.content_block.name + '_' + Date.now();
          if (!pending.seenToolIds.has(toolId)) {
            pending.seenToolIds.add(toolId);
            pending.toolStartTimes.set(toolId, Date.now());
            pending.onEvent({
              type: 'tool_call_start',
              toolName: se.content_block.name,
              toolId,
              toolArgs: {},
            });
          }
        }
        if (se.type === 'message_delta' && se.usage) {
          pending.onEvent({
            type: 'usage',
            usage: { outputTokens: se.usage.output_tokens, durationMs: Date.now() - pending.startMs },
          });
        }
        continue;
      }

      if (event.type === 'assistant' && event.message?.content) {
        const allText = event.message.content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('\n');
        if (allText !== pending.lastAllText) {
          if (allText.startsWith(pending.lastAllText)) {
            const delta = allText.substring(pending.lastAllText.length);
            if (delta) pending.onEvent({ type: 'text', content: delta });
          } else {
            pending.onEvent({ type: 'text', content: '\n\n' + allText });
          }
          pending.lastAllText = allText;
        }
        pending.fullText = allText;
        if (event.message.usage) {
          const u = event.message.usage;
          pending.onEvent({
            type: 'usage',
            usage: {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheReadTokens: u.cache_read_input_tokens,
              cacheCreateTokens: u.cache_creation_input_tokens,
              durationMs: Date.now() - pending.startMs,
              model: event.message.model,
            },
          });
        }
        // Tool use blocks — update args on existing chips or create new ones
        for (const block of event.message.content) {
          if (block.type === 'tool_use' && block.name) {
            const toolId = block.id || block.name + '_' + Date.now();
            if (!pending.seenToolIds.has(toolId)) {
              pending.seenToolIds.add(toolId);
              if (!pending.toolStartTimes.has(toolId)) pending.toolStartTimes.set(toolId, Date.now());
              pending.onEvent({
                type: 'tool_call_start',
                toolName: block.name,
                toolId,
                toolArgs: block.input as Record<string, unknown>,
              });
            } else if (block.input && Object.keys(block.input as any).length > 0) {
              pending.onEvent({
                type: 'tool_call_start',
                toolName: block.name,
                toolId,
                toolArgs: block.input as Record<string, unknown>,
              });
            }
          }
          if (block.type === 'tool_result') {
            const content = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text || '').join('')
              : typeof block.content === 'string' ? block.content : '';
            pending.onEvent({
              type: 'tool_call_end',
              toolName: 'Bash',
              toolId: block.tool_use_id,
              toolResult: content,
              success: !block.is_error,
            });
          }
        }
      }

      // Standalone tool events from CLI
      if (event.type === 'tool_use') {
        const toolId = event.tool_use_id || (event.tool || 'tool') + '_' + Date.now();
        if (!pending.seenToolIds.has(toolId)) {
          pending.seenToolIds.add(toolId);
          pending.toolStartTimes.set(toolId, Date.now());
          pending.onEvent({
            type: 'tool_call_start',
            toolName: event.tool || 'tool',
            toolId,
            toolArgs: event.input as Record<string, unknown>,
          });
        }
      }
      if (event.type === 'tool_result') {
        const tid = event.tool_use_id;
        const startedAt = tid ? pending.toolStartTimes.get(tid) : undefined;
        const executionTime = startedAt ? Date.now() - startedAt : undefined;
        if (tid) pending.toolStartTimes.delete(tid);
        pending.onEvent({
          type: 'tool_call_end',
          toolName: event.tool || 'tool',
          toolId: tid,
          toolResult: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
          success: !event.is_error,
          executionTime,
        });
      }

      // Claude CLI emits tool_result blocks inside synthetic `user` messages.
      // This is the path that actually fires for Bash/MCP tools — without it the
      // frontend per-pill timer never receives a tool_end and runs until the turn finishes.
      if (event.type === 'user' && event.message?.content && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block.type !== 'tool_result') continue;
          const tid = block.tool_use_id;
          const startedAt = tid ? pending.toolStartTimes.get(tid) : undefined;
          const executionTime = startedAt ? Date.now() - startedAt : undefined;
          if (tid) pending.toolStartTimes.delete(tid);
          const content = Array.isArray(block.content)
            ? block.content.map((c: any) => c.text || '').join('')
            : typeof block.content === 'string' ? block.content : '';
          pending.onEvent({
            type: 'tool_call_end',
            toolName: 'tool',
            toolId: tid,
            toolResult: content,
            success: !block.is_error,
            executionTime,
          });
        }
      }

      if (event.type === 'result') {
        if (event.result && typeof event.result === 'string') {
          if (event.result.startsWith(pending.lastAllText)) {
            const delta = event.result.substring(pending.lastAllText.length);
            if (delta) pending.onEvent({ type: 'text', content: delta });
          } else if (event.result.length > pending.lastAllText.length) {
            pending.onEvent({ type: 'text', content: '\n\n' + event.result });
          }
          pending.fullText = event.result;
        }
        const u = event.usage || {};
        const mu = event.modelUsage ? Object.values(event.modelUsage)[0] as any : null;
        pending.finalUsage = {
          inputTokens: mu?.inputTokens || u.input_tokens,
          outputTokens: mu?.outputTokens || u.output_tokens,
          cacheReadTokens: mu?.cacheReadInputTokens || u.cache_read_input_tokens,
          cacheCreateTokens: mu?.cacheCreationInputTokens || u.cache_creation_input_tokens,
          costUsd: event.total_cost_usd,
          durationMs: event.duration_ms,
          model: mu ? Object.keys(event.modelUsage)[0] : undefined,
          tokenBudget: CLI_POOL_TOKEN_BUDGET > 0 ? CLI_POOL_TOKEN_BUDGET : undefined,
        };
        pending.onEvent({ type: 'usage', usage: pending.finalUsage });
        pending.onEvent({ type: 'done', usage: pending.finalUsage });
        if (pending.timeout) clearTimeout(pending.timeout);
        const text = pending.fullText;
        pending.resolve(text);
        session.pending = null;
        session.lastActivityAt = Date.now();
        session.turnCount++;

        // Track cache read tokens and recycle pool if over budget
        const cacheRead = pending.finalUsage?.cacheReadTokens || 0;
        if (cacheRead > 0) session.lastCacheReadTokens = cacheRead;
        if (CLI_POOL_TOKEN_BUDGET > 0 && cacheRead > CLI_POOL_TOKEN_BUDGET) {
          console.error(
            `[CLI pool recycle] Cache read ${cacheRead} > budget ${CLI_POOL_TOKEN_BUDGET} ` +
            `after ${session.turnCount} turns — recycling ${session.conversationId.substring(0, 8)}`
          );
          // Flush conversation memory before killing the session so nothing is lost
          triggerMemoryFlush();
          _cliPoolStats.pool_restarts++;
          session.poolKillReason = 'restart';
          _cliSessions.delete(session.conversationId);
          killCliSession(session);
          // Next turn will spawn a fresh subprocess via getOrCreateCliSession
          return;
        }

        armIdleTimer(session);
        processNextQueuedTurn(session);
      }
    }
  });

  session.stderr.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (!msg) return;
    session.stderrBuffer += msg + '\n';
    console.error(`[CLI pool stderr] ${msg}`);

    // Reactive compaction: detect context length errors from CLI stderr
    const isContextError = /prompt.too.long|context.length|token.*limit|request too large|maximum context/i.test(msg);
    if (isContextError && session.pending && !(session as any)._compactionAttempted) {
      (session as any)._compactionAttempted = true;
      const convId = session.conversationId;
      console.error(`[Compaction] CLI context error detected — compacting ${convId}`);
      const didCompact = compactConversation(convId);
      if (didCompact) {
        session.pending.onEvent({ type: 'status', status: 'Compacting conversation history...' });
      }
    }
  });

  session.proc.on('close', (code) => {
    console.error(`[CLI pool] Process exited (${session.conversationId.substring(0, 8)}) code ${code}`);
    _cliSessions.delete(session.conversationId);
    if (!session.poolKillReason) {
      _cliPoolStats.pool_crash_kills++;
      logPoolStats();
    }
    if (session.pending) {
      if (session.pending.timeout) clearTimeout(session.pending.timeout);
      const err = new Error(`claude CLI exited with code ${code}`);
      session.pending.onEvent({ type: 'error', error: err.message });
      session.pending.reject(err);
      session.pending = null;
    }
    while (session.queue.length > 0) {
      const q = session.queue.shift()!;
      q.reject(new Error(`claude CLI unavailable (exit code ${code})`));
    }
    killCliSession(session);
  });
}

function getOrCreateCliSession(conversationId: string, systemPrompt: string): ClaudeCliSession {
  const existing = _cliSessions.get(conversationId);
  if (existing) {
    if (existing.cliModel !== CLI_MODEL) {
      console.error(
        `[CLI pool] Model changed (${existing.cliModel} -> ${CLI_MODEL}); restarting session ${conversationId.substring(0, 8)}`,
      );
      _cliSessions.delete(conversationId);
      _cliPoolStats.pool_restarts++;
      existing.poolKillReason = 'restart';
      killCliSession(existing);
    } else
    // Default to reusing the same warm process to avoid cold starts on every turn.
    // Some context fields (bootstrap/memory) naturally vary by message.
    if (existing.systemPrompt !== systemPrompt) {
      if (restartPoolOnSystemPromptChange()) {
        console.error(`[CLI pool] System prompt changed; restarting session ${conversationId.substring(0, 8)}`);
        _cliSessions.delete(conversationId);
        _cliPoolStats.pool_restarts++;
        existing.poolKillReason = 'restart';
        killCliSession(existing);
      } else {
        console.error(`[CLI pool] Reusing session ${conversationId.substring(0, 8)} pid=${existing.proc.pid}`);
        _cliPoolStats.pool_reused++;
        return existing;
      }
    } else {
      console.error(`[CLI pool] Reusing session ${conversationId.substring(0, 8)} pid=${existing.proc.pid}`);
      _cliPoolStats.pool_reused++;
      return existing;
    }
  }

  const env = freshEnv();
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY; // force Max OAuth path
  const args = buildPersistentCliArgs(systemPrompt);
  const proc = spawn(CLAUDE_BIN, args, {
    env,
    cwd: getProjectRoot(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Catch spawn errors (e.g. ENOENT if claude binary not in PATH) so they don't crash the process
  proc.on('error', (err) => {
    console.error(`[CLI pool] Spawn error for ${conversationId.substring(0, 8)}: ${err.message}`);
    _cliSessions.delete(conversationId);
  });

  const stdin = proc.stdin;
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (!stdin || !stdout || !stderr) {
    throw new Error('claude pool spawn: missing stdio pipes');
  }

  const session: ClaudeCliSession = {
    conversationId,
    systemPrompt,
    cliModel: CLI_MODEL,
    proc,
    stdin,
    stdout,
    stderr,
    buffer: '',
    queue: [],
    pending: null,
    stderrBuffer: '',
    lastActivityAt: Date.now(),
    idleTimer: null,
    turnCount: 0,
    lastCacheReadTokens: 0,
  };
  wireCliSessionStreams(session);
  armIdleTimer(session);
  _cliSessions.set(conversationId, session);
  _cliPoolStats.pool_spawned++;
  console.error(`[CLI pool] Spawned session for ${conversationId.substring(0, 8)} pid=${proc.pid}`);
  return session;
}

async function chatWithCLIPooled(
  conversationId: string,
  prompt: string,
  onEvent: StreamCallback,
  systemPrompt: string,
): Promise<string> {
  const session = getOrCreateCliSession(conversationId, systemPrompt);
  return new Promise<string>((resolve, reject) => {
    session.queue.push({ prompt, onEvent, resolve, reject });
    processNextQueuedTurn(session);
  });
}

/**
 * Chat using Claude CLI — BrainLoader results are included in the prompt.
 * Claude's job is purely conversational — interpret results, answer questions.
 */
async function chatWithCLI(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  // Check if Claude CLI is actually installed
  try {
    execSync(`which ${CLAUDE_BIN}`, { stdio: 'pipe', timeout: 3000 });
  } catch {
    const installMsg = `**Claude CLI not found.**\n\nYour LLM provider is set to "Claude CLI" but the \`claude\` command isn't installed.\n\n` +
      `**To install:**\n\`\`\`\ncurl -fsSL https://claude.ai/install.sh | bash\n\`\`\`\n\n` +
      `Then add to PATH:\n\`\`\`\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc\n\`\`\`\n\n` +
      `Then run \`claude\` in a terminal once to authenticate with your Anthropic account.\n\n` +
      `**Or switch providers** in Settings (sidebar) — you can use Anthropic API, OpenAI, Ollama (free/local), or others.`;
    onEvent({ type: 'text', content: installMsg });
    onEvent({ type: 'done' });
    return installMsg;
  }

  const conversations = getConversationManager();
  const cliMessage =
    channelAttachments?.length && channelAttachments.length > 0
      ? appendChannelAttachmentHints(message, channelAttachments)
      : message;
  conversations.addUserMessage(conversationId, cliMessage);

  // Proactive compaction before building prompt
  maybeProactiveCompact(conversationId, onEvent);

  const fullPrompt = formatConversationForCLI(conversationId, cliMessage);

  // Build system prompt — cached per conversation for stability + Anthropic prompt caching.
  // Skill mode always builds fresh (skill content is the system prompt).
  let systemPrompt: string;
  if (skillSystemPromptOverride) {
    const contextParts = [memoryContext].filter(Boolean).join('\n\n');
    systemPrompt = contextParts
      ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
      : skillSystemPromptOverride;
    if (!_bootstrappedConversations.has(conversationId)) {
      _bootstrappedConversations.add(conversationId);
    }
    console.error(`[SkillRunner] Using skill system prompt for ${conversationId.substring(0, 8)} (${skillSystemPromptOverride.length} chars)`);
  } else {
    // Check cached system prompt — stable across turns
    const cached = _cachedSystemPrompts.get(conversationId);
    if (cached && Date.now() - cached.builtAt < SYSTEM_PROMPT_CACHE_MS) {
      systemPrompt = cached.prompt;
      if (!_bootstrappedConversations.has(conversationId)) {
        _bootstrappedConversations.add(conversationId);
      }
      console.error(`[Context] Using cached system prompt for ${conversationId.substring(0, 8)} (${systemPrompt.length} chars, ${Math.round((Date.now() - cached.builtAt) / 1000)}s old)`);
    } else {
      // Build fresh system prompt (first message or cache expired)
      // Order: base_prompt + bootstrap (static, cacheable prefix) + memory (dynamic suffix)
      // Anthropic caches the longest matching prefix — static content first maximizes cache hits
      const isFirstMessage = !_bootstrappedConversations.has(conversationId);
      const bootstrap = isFirstMessage ? getWorkspaceBootstrap() : '';
      if (isFirstMessage) {
        _bootstrappedConversations.add(conversationId);
        console.error(`[Context] First message in ${conversationId.substring(0, 8)} — sending full bootstrap (${getWorkspaceBootstrap().length} chars)`);
      } else {
        console.error(`[Context] Rebuilding system prompt for ${conversationId.substring(0, 8)} (cache expired)`);
      }
      const staticParts = [getSystemPrompt(), bootstrap].filter(Boolean).join('\n\n---\n\n');
      systemPrompt = memoryContext
        ? staticParts + '\n\n---\n\n' + memoryContext
        : staticParts;
      // Cache it
      _cachedSystemPrompts.set(conversationId, { prompt: systemPrompt, builtAt: Date.now() });
    }
  }

  // Scope-aware suffix — appended AFTER the cached prompt body so scope changes
  // (or per-scope instruction edits) take effect immediately without cache bust.
  systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);

  // Build user prompt: Vodou results injected as a separate context block (not embedded in user text).
  // This keeps conversation history clean — the LLM sees structured context + clean user message.
  let userPrompt = fullPrompt;
  const hasBrainResults = !!oiResults;
  if (oiResults) {
    const isSkill = /# SKILL:/i.test(oiResults);
    const contextLabel = isSkill
      ? 'IMPORTANT: The active_context below is a SKILL. Follow its instructions exactly. Display the first stopping point menu and STOP.'
      : 'Interpret the active_context results for the user. Be concise and add insights.';
    userPrompt = `<active_context>\n${oiResults}\n</active_context>\n\n${contextLabel}\n\n${fullPrompt}`;
  }

  // Detect menu/stopping-point replies — don't give Claude tools for these
  const isMenuReply = isMenuReplyCheck(message);
  if (isMenuReply) {
    userPrompt += '\n\n<instruction>The user selected a numbered menu option from the previous response. Continue the skill/workflow based on their selection. Do NOT start new tool calls, thinking sessions, or independent research. Simply follow the conversation flow and present the next step.</instruction>';
  }

  // Gateway shell mode gates the vodou-core-only injection.
  //   restricted — inject the legacy guard (Bash only, vodou-core calls only, no exploration)
  //   verify/full — no injection; the LLM can use whatever tools `--allowedTools` permits
  // Mode is read from VODOU_GATEWAY_SHELL_MODE; default `full`. See PLAN-GATEWAY-SHELL-MODES.md.
  const _shellMode = getGatewayShellMode();
  if (hasBrainResults && !isMenuReply && shellModeInjectsVodouCoreGuard(_shellMode)) {
    userPrompt += '\n\n<instruction>Vodou already executed tools and returned results above. If you need additional data, you may ONLY use Bash to run vodou-core commands (e.g. `./vodou-core call <server> <tool> \'{"arg":"value"}\'`). Do NOT run general shell commands, file reads, grep, find, or codebase exploration. Focus on interpreting the Vodou results for the user.</instruction>';
  }

  if (usePersistentClaudeCliPool()) {
    try {
      const pooledText = await chatWithCLIPooled(conversationId, userPrompt, onEvent, systemPrompt);
      if (pooledText) {
        conversations.addAssistantMessage(conversationId, [{ type: 'text', text: pooledText } as any]);
        saveAssistantToBuffer(pooledText);
      }
      return pooledText;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[CLI pool] falling back to single-shot path: ${msg}`);
    }
  }

  return new Promise((resolve, reject) => {
    // Tool exposure is governed by VODOU_GATEWAY_SHELL_MODE (restricted/verify/full).
    // Menu replies still get zero tools — we only want the model to format the next step.
    const _mode = getGatewayShellMode();
    const useStdinUser = useClaudeCliStreamJsonStdin();
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--settings', '{"hooks":{}}',
      '--model', CLI_MODEL,
      '--max-turns', shellModeMaxTurns(_mode, isMenuReply),
      '--dangerously-skip-permissions',
      ...(isMenuReply ? [] : ['--allowedTools', shellModeAllowedTools(_mode)]),
      '--system-prompt', systemPrompt,
      ...(useStdinUser ? ['--input-format', 'stream-json'] : []),
      ...(useStdinUser ? [] : [userPrompt]),
    ];

    console.error(
      `[CLI] Spawning claude -p (${useStdinUser ? 'stdin stream-json user message' : 'argv user prompt'}) for ${conversationId.substring(0, 8)}...`
    );

    const env = freshEnv();
    delete env.CLAUDECODE;
    // Ensure CLI uses Max subscription OAuth, not API key auth
    delete env.ANTHROPIC_API_KEY;

    const proc = spawn(CLAUDE_BIN, args, {
      env,
      cwd: getProjectRoot(),
      stdio: [useStdinUser ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (!stdout || !stderr) {
      onEvent({ type: 'error', error: 'claude spawn: missing stdio pipes' });
      reject(new Error('claude spawn: missing stdio pipes'));
      return;
    }

    let fullText = '';
    let lastAllText = '';      // last concatenated text from assistant events
    let buffer = '';
    let stderrBuffer = '';
    const seenToolIds = new Set<string>();
    const toolStartTimes = new Map<string, number>();
    const cliStartTime = Date.now();
    let finalUsage: StreamEvent['usage'] = undefined;

    stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          // Token-level streaming from --include-partial-messages
          if (event.type === 'stream_event' && event.event) {
            const se = event.event;
            if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
              onEvent({ type: 'text', content: se.delta.text });
              fullText += se.delta.text;
              lastAllText += se.delta.text;
            }
            // Tool use streaming — create the chip immediately for UI feedback.
            // Args are empty here; they'll be updated via tool_args_update when the assistant event arrives.
            if (se.type === 'content_block_start' && se.content_block?.type === 'tool_use') {
              const toolId = se.content_block.id || se.content_block.name + '_' + Date.now();
              if (!seenToolIds.has(toolId)) {
                seenToolIds.add(toolId);
                toolStartTimes.set(toolId, Date.now());
                onEvent({
                  type: 'tool_call_start',
                  toolName: se.content_block.name,
                  toolId,
                  toolArgs: {},
                });
              }
            }
            // Input JSON delta for tool calls — accumulate args
            if (se.type === 'content_block_delta' && se.delta?.type === 'input_json_delta') {
              // Tool args stream as partial JSON — we'll get full args from the assistant event
            }
            // Usage from message_delta
            if (se.type === 'message_delta' && se.usage) {
              onEvent({
                type: 'usage',
                usage: {
                  outputTokens: se.usage.output_tokens,
                  durationMs: Date.now() - cliStartTime,
                },
              });
            }
            continue; // Don't double-process — assistant event has final state
          }

          if (event.type === 'assistant' && event.message?.content) {
            // Concatenate all text blocks from this event
            const allText = event.message.content
              .filter((b: any) => b.type === 'text' && b.text)
              .map((b: any) => b.text)
              .join('\n');

            if (allText !== lastAllText) {
              if (allText.startsWith(lastAllText)) {
                // Text grew — emit just the new part
                const delta = allText.substring(lastAllText.length);
                onEvent({ type: 'text', content: delta });
              } else {
                // Text changed completely (new turn after tool use)
                // Always start on a new line
                onEvent({ type: 'text', content: '\n\n' + allText });
              }
              lastAllText = allText;
            }

            fullText = allText;

            // Stream live token usage from assistant events
            if (event.message.usage) {
              const u = event.message.usage;
              onEvent({
                type: 'usage',
                usage: {
                  inputTokens: u.input_tokens,
                  outputTokens: u.output_tokens,
                  cacheReadTokens: u.cache_read_input_tokens,
                  cacheCreateTokens: u.cache_creation_input_tokens,
                  durationMs: Date.now() - cliStartTime,
                  model: event.message.model,
                },
              });
            }

            for (const block of event.message.content) {
              // Follow-up tool calls (Bash for MCP interactions)
              if (block.type === 'tool_use' && block.name) {
                const toolId = block.id || block.name + '_' + Date.now();
                if (!seenToolIds.has(toolId)) {
                  seenToolIds.add(toolId);
                  if (!toolStartTimes.has(toolId)) toolStartTimes.set(toolId, Date.now());
                  onEvent({
                    type: 'tool_call_start',
                    toolName: block.name,
                    toolId,
                    toolArgs: block.input as Record<string, unknown>,
                  });
                } else if (block.input && Object.keys(block.input as any).length > 0) {
                  // Chip already exists (from content_block_start) — update its args
                  onEvent({
                    type: 'tool_call_start',
                    toolName: block.name,
                    toolId,
                    toolArgs: block.input as Record<string, unknown>,
                  });
                }
              }
              if (block.type === 'tool_result') {
                const tid = block.tool_use_id;
                const startedAt = tid ? toolStartTimes.get(tid) : undefined;
                const executionTime = startedAt ? Date.now() - startedAt : undefined;
                if (tid) toolStartTimes.delete(tid);
                const content = Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || '').join('')
                  : typeof block.content === 'string' ? block.content : '';
                onEvent({
                  type: 'tool_call_end',
                  toolName: 'Bash',
                  toolId: tid,
                  toolResult: content,
                  success: !block.is_error,
                  executionTime,
                });
              }
            }
          }

          // Standalone tool events from CLI
          if (event.type === 'tool_use') {
            const toolId = event.tool_use_id || (event.tool || 'tool') + '_' + Date.now();
            if (!seenToolIds.has(toolId)) {
              seenToolIds.add(toolId);
              toolStartTimes.set(toolId, Date.now());
              onEvent({
                type: 'tool_call_start',
                toolName: event.tool || 'tool',
                toolId,
                toolArgs: event.input as Record<string, unknown>,
              });
            }
          }
          if (event.type === 'tool_result') {
            const tid = event.tool_use_id;
            const startedAt = tid ? toolStartTimes.get(tid) : undefined;
            const executionTime = startedAt ? Date.now() - startedAt : undefined;
            if (tid) toolStartTimes.delete(tid);
            onEvent({
              type: 'tool_call_end',
              toolName: event.tool || 'tool',
              toolId: tid,
              toolResult: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
              success: !event.is_error,
              executionTime,
            });
          }

          // Claude CLI emits tool_result blocks inside synthetic `user` messages.
          // Without this branch the per-pill timer in the gateway chat UI never receives
          // a tool_end and runs until the entire turn finishes.
          if (event.type === 'user' && event.message?.content && Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block.type !== 'tool_result') continue;
              const tid = block.tool_use_id;
              const startedAt = tid ? toolStartTimes.get(tid) : undefined;
              const executionTime = startedAt ? Date.now() - startedAt : undefined;
              if (tid) toolStartTimes.delete(tid);
              const content = Array.isArray(block.content)
                ? block.content.map((c: any) => c.text || '').join('')
                : typeof block.content === 'string' ? block.content : '';
              onEvent({
                type: 'tool_call_end',
                toolName: 'tool',
                toolId: tid,
                toolResult: content,
                success: !block.is_error,
                executionTime,
              });
            }
          }

          if (event.type === 'result') {
            if (event.result && typeof event.result === 'string') {
              if (event.result.startsWith(lastAllText)) {
                const delta = event.result.substring(lastAllText.length);
                if (delta) onEvent({ type: 'text', content: delta });
              } else if (event.result.length > lastAllText.length) {
                // Result doesn't match our tracking — emit what's new
                onEvent({ type: 'text', content: '\n\n' + event.result });
              }
              fullText = event.result;
            }
            // Capture final usage stats from result event
            const u = event.usage || {};
            const mu = event.modelUsage ? Object.values(event.modelUsage)[0] as any : null;
            finalUsage = {
              inputTokens: mu?.inputTokens || u.input_tokens,
              outputTokens: mu?.outputTokens || u.output_tokens,
              cacheReadTokens: mu?.cacheReadInputTokens || u.cache_read_input_tokens,
              cacheCreateTokens: mu?.cacheCreationInputTokens || u.cache_creation_input_tokens,
              costUsd: event.total_cost_usd,
              durationMs: event.duration_ms,
              model: mu ? Object.keys(event.modelUsage)[0] : undefined,
            };
            onEvent({ type: 'usage', usage: finalUsage });
          }
        } catch {
          // Ignore partial JSON
        }
      }
    });

    stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        stderrBuffer += msg + '\n';
        console.error(`[CLI stderr] ${msg}`);
      }
    });

    proc.on('close', (code) => {
      console.error(`[CLI] Process exited with code ${code}`);

      // Detect auth failures and surface helpful instructions
      if (code !== 0 && !fullText && (stderrBuffer.includes('401') || stderrBuffer.includes('authentication_error') || stderrBuffer.includes('Invalid authentication') || stderrBuffer.includes('Failed to authenticate'))) {
        const authMsg = `**Claude CLI Authentication Failed**\n\n` +
          `Your Claude CLI session has expired or is not authenticated.\n\n` +
          `**To fix this:**\n` +
          `1. Open a terminal\n` +
          `2. Run \`claude\` to start Claude Code, then type \`/login\` if needed\n` +
          `3. Follow the prompts to authenticate with your Anthropic account\n` +
          `4. Once logged in, come back here and try again\n\n` +
          `**If you have an Anthropic Max subscription**, Claude CLI authenticates via your browser (OAuth).\n\n` +
          `**Or switch providers** in Settings (sidebar) if you prefer to use an API key instead.`;
        onEvent({ type: 'text', content: authMsg });
        onEvent({ type: 'done' });
        resolve(authMsg);
        return;
      }

      if (fullText) {
        conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText } as any]);
        saveAssistantToBuffer(fullText);
      }
      onEvent({ type: 'done', usage: finalUsage });
      resolve(fullText);
    });

    proc.on('error', (err) => {
      console.error(`[CLI] Process error: ${err.message}`);
      onEvent({ type: 'error', error: err.message });
      reject(err);
    });

    if (useStdinUser && proc.stdin) {
      try {
        proc.stdin.write(streamJsonUserMessageLine(userPrompt) + '\n');
        proc.stdin.end();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[CLI] stdin write failed: ${msg}`);
        onEvent({ type: 'error', error: msg });
        reject(new Error(msg));
      }
    }
  });
}

/**
 * Kimi Code CLI (Moonshot) — print mode, one shot per message.
 * Uses the same conversation + system-prompt shaping as Claude CLI, but
 * invokes `kimi --print … --yolo` (non-interactive). See:
 * https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html
 */
async function chatWithKimiCLI(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  try {
    execSync(`which ${KIMI_BIN}`, { stdio: 'pipe', timeout: 3000 });
  } catch {
    const installMsg =
      `**Kimi CLI not found.**\n\n` +
      `**Install:** \`curl -LsSf https://code.kimi.com/install.sh | bash\`\n\n` +
      `Then run \`kimi login\` once (browser OAuth or API key).\n\n` +
      `**Or** use **Kimi (Moonshot API)** in Settings with a key from https://platform.moonshot.ai/console/api-keys\n\n` +
      `Docs: https://moonshotai.github.io/kimi-cli/en/`;
    onEvent({ type: 'text', content: installMsg });
    onEvent({ type: 'done' });
    return installMsg;
  }

  const conversations = getConversationManager();
  const cliMessage =
    channelAttachments?.length && channelAttachments.length > 0
      ? appendChannelAttachmentHints(message, channelAttachments)
      : message;
  conversations.addUserMessage(conversationId, cliMessage);
  maybeProactiveCompact(conversationId, onEvent);
  const fullPrompt = formatConversationForCLI(conversationId, cliMessage);

  let systemPrompt: string;
  if (skillSystemPromptOverride) {
    const contextParts = [memoryContext].filter(Boolean).join('\n\n');
    systemPrompt = contextParts
      ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
      : skillSystemPromptOverride;
    if (!_bootstrappedConversations.has(conversationId)) {
      _bootstrappedConversations.add(conversationId);
    }
    console.error(`[KimiCLI] skill system prompt for ${conversationId.substring(0, 8)}`);
  } else {
    const cached = _cachedSystemPrompts.get(conversationId);
    if (cached && Date.now() - cached.builtAt < SYSTEM_PROMPT_CACHE_MS) {
      systemPrompt = cached.prompt;
      if (!_bootstrappedConversations.has(conversationId)) {
        _bootstrappedConversations.add(conversationId);
      }
    } else {
      const isFirstMessage = !_bootstrappedConversations.has(conversationId);
      const bootstrap = isFirstMessage ? getWorkspaceBootstrap() : '';
      if (isFirstMessage) {
        _bootstrappedConversations.add(conversationId);
      }
      const staticParts = [getSystemPrompt(), bootstrap].filter(Boolean).join('\n\n---\n\n');
      systemPrompt = memoryContext ? staticParts + '\n\n---\n\n' + memoryContext : staticParts;
      _cachedSystemPrompts.set(conversationId, { prompt: systemPrompt, builtAt: Date.now() });
    }
  }
  systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);

  let userPrompt = fullPrompt;
  const hasBrainResults = !!oiResults;
  if (oiResults) {
    const isSkill = /# SKILL:/i.test(oiResults);
    const contextLabel = isSkill
      ? 'IMPORTANT: The active_context below is a SKILL. Follow its instructions exactly. Display the first stopping point menu and STOP.'
      : 'Interpret the active_context results for the user. Be concise and add insights.';
    userPrompt = `<active_context>\n${oiResults}\n</active_context>\n\n${contextLabel}\n\n${fullPrompt}`;
  }
  const isMenuReply = isMenuReplyCheck(message);
  if (isMenuReply) {
    userPrompt +=
      '\n\n<instruction>The user selected a numbered menu option from the previous response. Continue the skill/workflow based on their selection. Do NOT start new tool calls, thinking sessions, or independent research. Simply follow the conversation flow and present the next step.</instruction>';
  }
  const _shellMode = getGatewayShellMode();
  if (hasBrainResults && !isMenuReply && shellModeInjectsVodouCoreGuard(_shellMode)) {
    userPrompt +=
      '\n\n<instruction>Vodou already executed tools and returned results above. If you need additional data, you may ONLY use Bash to run vodou-core commands (e.g. `./vodou-core call <server> <tool> \'{"arg":"value"}\'`). Do NOT run general shell commands, file reads, grep, find, or codebase exploration. Focus on interpreting the Vodou results for the user.</instruction>';
  }

  const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const timeoutMs = parseInt(process.env.VODOU_GATEWAY_KIMI_CLI_TIMEOUT_MS || '120000', 10);

  return new Promise<string>((resolve, reject) => {
    const args = [
      '--print',
      '--output-format',
      'text',
      '--final-message-only',
      '--yolo',
      '--model',
      kimiCliModel,
      '-p',
      combined,
    ];
    const env = { ...freshEnv(), ...freshEnvVars() };
    const proc = spawn(KIMI_BIN, args, {
      env,
      cwd: getProjectRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errBuf = '';
    let to: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      to = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {}
      }, timeoutMs);
    }
    proc.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      out += chunk;
      onEvent({ type: 'text', content: chunk });
    });
    proc.stderr?.on('data', (d: Buffer) => {
      errBuf += d.toString();
    });
    proc.on('close', (code) => {
      if (to) clearTimeout(to);
      const trimmed = out.trim();
      if (code !== 0 && !trimmed) {
        const fail =
          `**Kimi CLI failed** (exit ${code})\n\n` +
          (errBuf.trim().slice(0, 1200) || 'No output. Run `kimi login` or switch to **Kimi (Moonshot API)** in Settings.');
        onEvent({ type: 'text', content: fail });
        onEvent({ type: 'done' });
        resolve(fail);
        return;
      }
      if (trimmed) {
        conversations.addAssistantMessage(conversationId, [{ type: 'text', text: trimmed } as any]);
        saveAssistantToBuffer(trimmed);
      }
      onEvent({ type: 'done' });
      resolve(trimmed);
    });
    proc.on('error', (err) => {
      if (to) clearTimeout(to);
      onEvent({ type: 'error', error: err.message });
      reject(err);
    });
  });
}

// --- SDK mode implementation ---

async function chatWithSDK(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  const conversations = getConversationManager();

  const baseText = buildUserPromptWithOIResults(message, oiResults);
  const userContent =
    channelAttachments?.length && channelAttachments.length > 0
      ? buildAnthropicUserContent(baseText, channelAttachments)
      : baseText;

  conversations.addUserMessage(conversationId, userContent);

  // Proactive compaction before API call
  maybeProactiveCompact(conversationId, onEvent);

  // Build system prompt — skill mode uses skill content directly
  let systemPrompt: string;
  if (skillSystemPromptOverride) {
    const contextParts = [memoryContext].filter(Boolean).join('\n\n');
    systemPrompt = contextParts
      ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
      : skillSystemPromptOverride;
    if (!_bootstrappedConversations.has(conversationId)) _bootstrappedConversations.add(conversationId);
    console.error(`[SkillRunner] SDK mode — skill system prompt for ${conversationId.substring(0, 8)}`);
  } else {
    const isFirstMsg = !_bootstrappedConversations.has(conversationId);
    const bootstrap = isFirstMsg ? getWorkspaceBootstrap() : '';
    if (isFirstMsg) _bootstrappedConversations.add(conversationId);
    const staticParts = [getSystemPrompt(), bootstrap].filter(Boolean).join('\n\n---\n\n');
    systemPrompt = memoryContext
      ? staticParts + '\n\n---\n\n' + memoryContext
      : staticParts;
  }
  systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);

  const messages = conversations.getMessages(conversationId);
  const skipTools = isMenuReplyCheck(message);

  try {
    const anthropic = getClient();
    const maxToolIter = getMaxToolIterations(conversationId);
    let iterations = 0;
    let allText = '';

    // Initial stream — include tools unless it's a menu reply
    const effectiveMaxTokens = getMaxTokens(conversationId);
    const streamParams: any = {
      model: MODEL,
      max_tokens: effectiveMaxTokens,
      system: systemPrompt,
      messages: getCompressedMessages(conversationId),
    };
    if (!skipTools) streamParams.tools = VODOU_TOOLS;

    const sdkStartTime = Date.now();
    let stream = anthropic.messages.stream(streamParams);
    let response = await collectStreamResponse(stream, onEvent, sdkStartTime);

    // Tool calling loop — handle tool_use blocks
    while (iterations < maxToolIter) {
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
      );
      if (toolBlocks.length === 0) break;

      // Add assistant message with tool_use blocks to conversation
      conversations.addAssistantMessage(conversationId, response.content);

      // Execute each tool and collect results
      const toolResultContent: any[] = [];
      for (const tb of toolBlocks) {
        onEvent({ type: 'tool_call_start', toolName: tb.name, toolId: tb.id, toolArgs: tb.input as Record<string, unknown> });
        const result = await executeOITool(tb.name, tb.input as Record<string, unknown>, { scope });
        onEvent({
          type: 'tool_call_end', toolName: tb.name, toolId: tb.id,
          toolResult: result.output, success: result.success, executionTime: result.executionTime,
        });
        // Track file changes from tool execution
        if (result.success) {
          const changedFiles = detectFileChanges(tb.name, tb.input, result.output);
          if (changedFiles.length > 0) addFileChanges(conversationId, changedFiles);
        }
        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: result.success ? result.output : `Error: ${result.error}`,
        });
      }

      // Add tool results as user messages and re-stream
      for (const tr of toolResultContent) {
        conversations.addToolResult(conversationId, tr.tool_use_id, tr.content, false);
      }
      conversations.trimAfterToolResults(conversationId);
      const nextStream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: effectiveMaxTokens,
        system: systemPrompt,
        messages: getCompressedMessages(conversationId),
        tools: VODOU_TOOLS,
      });
      response = await collectStreamResponse(nextStream, onEvent, sdkStartTime);
      iterations++;
    }

    conversations.addAssistantMessage(conversationId, response.content);

    allText = response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    if (allText) {
      saveAssistantToBuffer(allText);
    }

    onEvent({ type: 'done', usage: {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      cacheReadTokens: (response.usage as any)?.cache_read_input_tokens,
      cacheCreateTokens: (response.usage as any)?.cache_creation_input_tokens,
      durationMs: Date.now() - sdkStartTime,
      model: response.model,
    }});
    return allText;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Detect auth failures and surface helpful instructions
    if (errorMsg.includes('401') || errorMsg.includes('authentication_error') || errorMsg.includes('Invalid authentication')) {
      const authMsg = `**Anthropic API Authentication Failed**\n\n` +
        `Your API key is invalid or expired.\n\n` +
        `**To fix this:**\n` +
        `1. Go to [console.anthropic.com](https://console.anthropic.com/) and create or copy your API key\n` +
        `2. Open **Settings** (sidebar) and paste it in the Anthropic API Key field\n` +
        `3. Click **Save** and try again\n\n` +
        `**Or switch to Claude CLI** in Settings if you have an Anthropic Max subscription (no API key needed).`;
      onEvent({ type: 'text', content: authMsg });
      onEvent({ type: 'done' });
      return authMsg;
    }

    // Reactive compaction: detect context length errors, compact, and retry once
    const isContextError = /prompt.too.long|context.length|token.*limit|request too large|maximum context/i.test(errorMsg);
    if (isContextError) {
      console.error(`[Compaction] Context length error detected — attempting reactive compaction for ${conversationId}`);
      const didCompact = compactConversation(conversationId);
      if (didCompact) {
        onEvent({ type: 'status', status: 'Compacting conversation history...' });
        try {
          // Retry with compacted messages (recursive call, but compaction won't trigger again because messages are shorter)
          return await chatWithSDK(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope);
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          console.error(`[Compaction] Retry also failed: ${retryMsg}`);
          const helpMsg = 'This conversation has grown too long even after compaction. Please start a new conversation — memory will carry context forward.';
          onEvent({ type: 'text', content: helpMsg });
          onEvent({ type: 'done' });
          return helpMsg;
        }
      }
    }

    onEvent({ type: 'error', error: errorMsg });
    throw error;
  }
}

/**
 * Collect streaming response (SDK path)
 */
async function collectStreamResponse(
  stream: ReturnType<typeof Anthropic.prototype.messages.stream>,
  onEvent: StreamCallback,
  startTime?: number
): Promise<Anthropic.Messages.Message> {
  stream.on('text', (text) => {
    onEvent({ type: 'text', content: text });
  });
  const msg = await stream.finalMessage();
  // Emit usage from final message
  if (msg.usage) {
    onEvent({
      type: 'usage',
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: (msg.usage as any).cache_read_input_tokens,
        cacheCreateTokens: (msg.usage as any).cache_creation_input_tokens,
        durationMs: startTime ? Date.now() - startTime : undefined,
        model: msg.model,
      },
    });
  }
  return msg;
}

// --- Provider dispatch ---

/**
 * Route to the appropriate LLM provider based on current settings.
 * Smart routing: simple queries use a cheaper model when VODOU_SMART_ROUTING is enabled.
 */
function dispatchToProvider(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  // Smart Model Routing: swap to cheap model for simple queries
  let modelSwapped = false;
  let savedModel = MODEL;
  let savedCliModel = CLI_MODEL;
  let savedGoogleModel = googleModel;
  let savedGroqModel = groqModel;
  let savedOpenaiModel = openaiModel;
  let savedOllamaModel = ollamaModel;
  let savedKimiModel = kimiModel;
  let savedOpenrouterModel = openrouterModel;

  if (
    smartRoutingEnabled &&
    !oiResults &&
    !skillSystemPromptOverride &&
    !channelAttachments?.length &&
    isSimpleQuery(message)
  ) {
    const cheap = getSmartRoutingCheapModel();
    if (cheap.model) {
      modelSwapped = true;
      MODEL = cheap.model;
      CLI_MODEL = cheap.cliModel || cheap.model;
      // Also swap provider-specific models
      if (currentProvider === 'google') googleModel = cheap.model;
      if (currentProvider === 'groq') groqModel = cheap.model;
      if (currentProvider === 'openai') openaiModel = cheap.model;
      if (currentProvider === 'ollama') ollamaModel = cheap.model;
      if (currentProvider === 'kimi') kimiModel = cheap.model;
      if (currentProvider === 'openrouter') openrouterModel = cheap.model;
      console.error(`[SmartRouting] Simple query → ${cheap.model} (was ${savedModel})`);
    }
  }

  // Capture the provider call (model vars are read synchronously at function entry)
  let result: Promise<string>;
  switch (currentProvider) {
    case 'claude-cli':
      result = chatWithCLI(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'kimi-cli':
      result = chatWithKimiCLI(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'anthropic':
      result = chatWithSDK(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'openai':
      result = chatWithOpenAI(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'google':
      result = chatWithOpenAICompat('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', googleApiKey, googleModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'groq':
      result = chatWithOpenAICompat('https://api.groq.com/openai/v1/chat/completions', groqApiKey, groqModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'deepseek':
      result = chatWithOpenAICompat('https://api.deepseek.com/v1/chat/completions', deepseekApiKey, deepseekModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'xai':
      result = chatWithOpenAICompat('https://api.x.ai/v1/chat/completions', xaiApiKey, xaiModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'mistral':
      result = chatWithOpenAICompat('https://api.mistral.ai/v1/chat/completions', mistralApiKey, mistralModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'kimi':
      result = chatWithOpenAICompat('https://api.moonshot.ai/v1/chat/completions', kimiApiKey, kimiModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'openrouter':
      result = chatWithOpenAICompat('https://openrouter.ai/api/v1/chat/completions', openrouterApiKey, openrouterModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'ollama':
      result = chatWithOllama(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    case 'custom':
      result = chatWithCustom(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope); break;
    default: {
      const setupMsg = `**No LLM provider configured.**\n\nGo to **Settings** (sidebar) to connect an AI model. Options:\n\n` +
        `1. **Claude CLI** (recommended with Anthropic Max subscription):\n` +
        `   \`curl -fsSL https://claude.ai/install.sh | bash\`\n` +
        `   Then: \`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc\`\n` +
        `   Then run \`claude\` in a terminal once to authenticate.\n\n` +
        `2. **Anthropic API** — paste your API key in Settings\n` +
        `3. **OpenAI API** — paste your API key in Settings\n` +
        `4. **Ollama** (free, local) — install from ollama.com, then select in Settings\n` +
        `5. **Google Gemini / Groq / DeepSeek / xAI / Mistral / Kimi / OpenRouter** — API key in Settings\n` +
        `6. **Kimi Code CLI** — Moonshot terminal agent (\`kimi\`) with \`kimi login\` — like Claude CLI vs Anthropic API`;
      onEvent({ type: 'text', content: setupMsg });
      onEvent({ type: 'done' });
      result = Promise.resolve(setupMsg);
    }
  }

  // Restore original models after provider function captured them
  if (modelSwapped) {
    MODEL = savedModel;
    CLI_MODEL = savedCliModel;
    googleModel = savedGoogleModel;
    groqModel = savedGroqModel;
    openaiModel = savedOpenaiModel;
    ollamaModel = savedOllamaModel;
    kimiModel = savedKimiModel;
    openrouterModel = savedOpenrouterModel;
  }

  return result;
}

/** Convert stored Anthropic-shaped user blocks to OpenAI message content. */
function anthropicUserBlocksToOpenAIUserContent(blocks: any[], visionCompat: boolean): string | any[] {
  if (!visionCompat) {
    let t = '';
    for (const b of blocks) {
      if (b.type === 'text' && b.text) t += b.text + '\n';
      else if (b.type === 'image') t += '\n[Image attachment — enable vision endpoint (OpenAI / Gemini) or use Anthropic API]\n';
      else if (b.type === 'document') t += '\n[PDF/text document — use Anthropic API for full document in context]\n';
    }
    return t.trim();
  }
  const parts: any[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64' && b.source?.media_type && b.source?.data) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      });
    } else if (b.type === 'document') {
      parts.push({
        type: 'text',
        text:
          '[Attached PDF or text document is not forwarded to this provider as binary — use Anthropic API for native documents.]',
      });
    }
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/**
 * Build OpenAI-format messages from Anthropic-format conversation history.
 * Preserves tool_use and tool_result blocks by converting to OpenAI equivalents.
 */
function buildOpenAIMessages(history: any[], systemPrompt: string, visionCompat: boolean = false): any[] {
  const messages: any[] = [{ role: 'system', content: systemPrompt }];

  // Token-aware trimming
  const limit = CONTEXT_LIMITS[currentProvider] || 64_000;
  const threshold = Math.floor(limit * CONTEXT_THRESHOLD);
  const totalTokens = estimateTokens(history);
  let historyToUse: any[];

  if (totalTokens > threshold && history.length > KEEP_RECENT) {
    const olderMessages = history.slice(0, -KEEP_RECENT);
    historyToUse = history.slice(-KEEP_RECENT);
    const summary = summarizeOlderMessages(olderMessages);
    messages.push({ role: 'system', content: summary });
    console.error(`[Context] OpenAI token-aware trim: ${totalTokens} tokens > ${threshold}. Compacted ${olderMessages.length} older messages.`);
  } else {
    historyToUse = history.slice(-20);
  }

  for (const msg of historyToUse) {
    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        // Check for tool_result blocks (stored by addToolResult)
        const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            messages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            });
          }
          continue;
        }
        const nonTool = msg.content as any[];
        const hasVisiony = nonTool.some((b: any) => b.type === 'image' || b.type === 'document');
        if (hasVisiony) {
          const converted = anthropicUserBlocksToOpenAIUserContent(nonTool, visionCompat);
          if (typeof converted === 'string') {
            if (converted) messages.push({ role: 'user', content: converted });
          } else if (Array.isArray(converted) && converted.length > 0) {
            messages.push({ role: 'user', content: converted });
          }
          continue;
        }
        const text = nonTool.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (text) messages.push({ role: 'user', content: text });
      } else {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) messages.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolUseBlocks = (blocks as any[]).filter((b: any) => b.type === 'tool_use');
      const text = (blocks as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      if (toolUseBlocks.length > 0) {
        // Convert Anthropic tool_use to OpenAI tool_calls format
        messages.push({
          role: 'assistant',
          content: text || '',
          tool_calls: toolUseBlocks.map((b: any) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          })),
        });
      } else if (text) {
        messages.push({ role: 'assistant', content: text });
      }
    }
  }
  return messages;
}

// --- OpenAI-compatible chat (used by openai + custom providers) ---

async function chatWithOpenAICompat(
  endpoint: string,
  apiKey: string,
  model: string,
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  const conversations = getConversationManager();

  const bodyText = buildUserPromptWithOIResults(message, oiResults);
  const userTurn =
    channelAttachments?.length && channelAttachments.length > 0
      ? buildAnthropicUserContent(bodyText, channelAttachments)
      : bodyText;

  conversations.addUserMessage(conversationId, userTurn);

  // Proactive compaction before API call
  maybeProactiveCompact(conversationId, onEvent);

  // Build system prompt
  let systemPrompt: string;
  if (skillSystemPromptOverride) {
    const contextParts = [memoryContext].filter(Boolean).join('\n\n');
    systemPrompt = contextParts
      ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
      : skillSystemPromptOverride;
    if (!_bootstrappedConversations.has(conversationId)) _bootstrappedConversations.add(conversationId);
  } else {
    const isFirstMsg = !_bootstrappedConversations.has(conversationId);
    const bootstrap = isFirstMsg ? getWorkspaceBootstrap() : '';
    if (isFirstMsg) _bootstrappedConversations.add(conversationId);
    const staticParts = [getSystemPrompt(), bootstrap].filter(Boolean).join('\n\n---\n\n');
    systemPrompt = memoryContext
      ? staticParts + '\n\n---\n\n' + memoryContext
      : staticParts;
  }
  systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);

  const visionCompat = openaiCompatVisionEnabled(endpoint);
  // Build messages array from conversation history (preserves tool interactions)
  const history = getCompressedMessages(conversationId);
  const openaiMessages = buildOpenAIMessages(history, systemPrompt, visionCompat);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  if (endpoint.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER || (process.env.GATEWAY_BASE_URL || 'http://localhost:8765').replace(/\/$/, '');
    headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Vodou-Console';
  }
  const skipTools = isMenuReplyCheck(message);
  const MAX_TOOL_ITERATIONS = 10;

  try {
    // Tool-calling loop: non-streaming rounds for tool detection, streaming for final text
    let currentMessages: any[] = [...openaiMessages];
    let iterations = 0;
    const oaiStartTime = Date.now();

    while (iterations < MAX_TOOL_ITERATIONS) {
      // Non-streaming request with tools to detect tool_calls
      const toolResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          stream: false,
          messages: currentMessages,
          ...(!skipTools ? { tools: getOpenAITools() } : {}),
        }),
      });

      if (!toolResp.ok) {
        const errText = await toolResp.text();
        // Reactive compaction: detect context length errors and retry once
        const isContextError = /context.length|token.*limit|request too large|maximum context|too many tokens/i.test(errText);
        if (isContextError && iterations === 0) {
          console.error(`[Compaction] OpenAI context error — compacting ${conversationId}`);
          const didCompact = compactConversation(conversationId);
          if (didCompact) {
            onEvent({ type: 'status', status: 'Compacting conversation history...' });
            // Rebuild messages from compacted conversation and retry
            const newHistory = getCompressedMessages(conversationId);
            currentMessages = buildOpenAIMessages(newHistory, systemPrompt, visionCompat);
            iterations++; // prevent infinite loop
            continue;
          }
        }
        onEvent({ type: 'error', error: `LLM API error (${toolResp.status}): ${errText}` });
        onEvent({ type: 'done' });
        return '';
      }

      const toolJson = await toolResp.json() as any;
      const choice = toolJson.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls — break and do streaming final response
        // If we got text in this non-streaming response, use it directly
        const directText = choice?.message?.content || '';
        if (directText && iterations === 0) {
          // First round, no tools used — stream the response instead for better UX
          break;
        }
        // After tool rounds, use the text we got
        if (directText) {
          onEvent({ type: 'text', content: directText });
          conversations.addAssistantMessage(conversationId, [{ type: 'text', text: directText } as any]);
          saveAssistantToBuffer(directText);
          onEvent({ type: 'done' });
          return directText;
        }
        break;
      }

      // Execute tool calls
      const assistantMsg: any = { role: 'assistant', content: choice.message.content || '', tool_calls: toolCalls };
      currentMessages.push(assistantMsg);

      for (const tc of toolCalls) {
        const fnName = tc.function?.name || '';
        let fnArgs: Record<string, unknown> = {};
        try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        onEvent({ type: 'tool_call_start', toolName: fnName, toolId: tc.id, toolArgs: fnArgs });
        const result = await executeOITool(fnName, fnArgs, { scope });
        onEvent({
          type: 'tool_call_end', toolName: fnName, toolId: tc.id,
          toolResult: result.output, success: result.success, executionTime: result.executionTime,
        });
        if (result.success) {
          const changedFiles = detectFileChanges(fnName, fnArgs, result.output);
          if (changedFiles.length > 0) addFileChanges(conversationId, changedFiles);
        }
        currentMessages.push({
          role: 'tool', tool_call_id: tc.id,
          content: result.success ? result.output : `Error: ${result.error}`,
        });
      }
      iterations++;
    }

    // Final streaming response (no tools — just text)
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
        messages: currentMessages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      onEvent({ type: 'error', error: `LLM API error (${resp.status}): ${errText}` });
      onEvent({ type: 'done' });
      return '';
    }

    // Parse SSE stream
    let fullText = '';
    let oaiUsage: any = null;
    const reader = resp.body?.getReader();
    if (!reader) {
      onEvent({ type: 'error', error: 'No response stream' });
      onEvent({ type: 'done' });
      return '';
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.substring(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onEvent({ type: 'text', content: delta });
          }
          // Capture usage from final chunk (OpenAI includes it when stream_options.include_usage is set, or in the last chunk)
          if (json.usage) oaiUsage = json.usage;
        } catch {}
      }
    }

    if (fullText) {
      conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText } as any]);
      saveAssistantToBuffer(fullText);
    }
    const oaiDone: any = { type: 'done', usage: {
      inputTokens: oaiUsage?.prompt_tokens,
      outputTokens: oaiUsage?.completion_tokens,
      durationMs: Date.now() - oaiStartTime,
      model,
    }};
    onEvent(oaiDone);
    return fullText;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', error: errMsg });
    onEvent({ type: 'done' });
    return '';
  }
}

async function chatWithOpenAI(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  console.error(`[OpenAI] Sending to ${openaiModel}...`);
  return chatWithOpenAICompat(
    'https://api.openai.com/v1/chat/completions',
    openaiApiKey, openaiModel,
    conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope
  );
}

async function chatWithCustom(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  console.error(`[Custom] Sending to ${customModel} at ${customBaseUrl}...`);
  return chatWithOpenAICompat(
    customBaseUrl + '/v1/chat/completions',
    customApiKey, customModel,
    conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope
  );
}

// --- Ollama chat (NDJSON stream) ---

async function chatWithOllama(
  conversationId: string,
  message: string,
  onEvent: StreamCallback,
  memoryContext: string = '',
  oiResults: string = '',
  skillSystemPromptOverride: string = '',
  channelAttachments?: ChannelAttachmentMeta[],
  scope: Scope | null = null
): Promise<string> {
  const conversations = getConversationManager();
  console.error(`[Ollama] Sending to ${ollamaModel} at ${ollamaBaseUrl}...`);

  const bodyText = buildUserPromptWithOIResults(message, oiResults);
  const userTurn =
    channelAttachments?.length && channelAttachments.length > 0
      ? buildAnthropicUserContent(bodyText, channelAttachments)
      : bodyText;

  conversations.addUserMessage(conversationId, userTurn);

  // Proactive compaction before API call
  maybeProactiveCompact(conversationId, onEvent);

  // Build system prompt
  let systemPrompt: string;
  if (skillSystemPromptOverride) {
    const contextParts = [memoryContext].filter(Boolean).join('\n\n');
    systemPrompt = contextParts
      ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
      : skillSystemPromptOverride;
    if (!_bootstrappedConversations.has(conversationId)) _bootstrappedConversations.add(conversationId);
  } else {
    const isFirstMsg = !_bootstrappedConversations.has(conversationId);
    const bootstrap = isFirstMsg ? getWorkspaceBootstrap() : '';
    if (isFirstMsg) _bootstrappedConversations.add(conversationId);
    const staticParts = [getSystemPrompt(), bootstrap].filter(Boolean).join('\n\n---\n\n');
    systemPrompt = memoryContext
      ? staticParts + '\n\n---\n\n' + memoryContext
      : staticParts;
  }
  systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);

  const ollamaVision = process.env.CHANNEL_OLLAMA_VISION === '1' || process.env.CHANNEL_OLLAMA_VISION === 'true';
  // Build messages (preserves tool interactions from history)
  const history = getCompressedMessages(conversationId);
  const ollamaMessages = buildOpenAIMessages(history, systemPrompt, ollamaVision);

  const skipTools = isMenuReplyCheck(message);
  const MAX_TOOL_ITERATIONS = 10;

  try {
    // Tool-calling loop: non-streaming for tool detection, streaming for final
    let currentMessages: any[] = [...ollamaMessages];
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS && !skipTools) {
      const toolResp = await fetch(ollamaBaseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          messages: currentMessages,
          tools: getOpenAITools(),
          options: { num_predict: MAX_TOKENS },
        }),
      });

      if (!toolResp.ok) break;
      const toolJson = await toolResp.json() as any;
      const toolCalls = toolJson.message?.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tools — use text if we had tool rounds, else fall through to streaming
        const directText = toolJson.message?.content || '';
        if (directText && iterations > 0) {
          onEvent({ type: 'text', content: directText });
          conversations.addAssistantMessage(conversationId, [{ type: 'text', text: directText } as any]);
          saveAssistantToBuffer(directText);
          onEvent({ type: 'done' });
          return directText;
        }
        break;
      }

      currentMessages.push({ role: 'assistant', content: toolJson.message?.content || '', tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const fnName = tc.function?.name || '';
        const tcId = tc.id || `ollama-${Date.now()}`;
        let fnArgs: Record<string, unknown> = {};
        try { fnArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); } catch {}
        onEvent({ type: 'tool_call_start', toolName: fnName, toolId: tcId, toolArgs: fnArgs });
        const result = await executeOITool(fnName, fnArgs, { scope });
        onEvent({ type: 'tool_call_end', toolName: fnName, toolId: tcId, toolResult: result.output, success: result.success, executionTime: result.executionTime });
        if (result.success) {
          const changedFiles = detectFileChanges(fnName, fnArgs, result.output);
          if (changedFiles.length > 0) addFileChanges(conversationId, changedFiles);
        }
        currentMessages.push({ role: 'tool', tool_call_id: tcId, content: result.success ? result.output : `Error: ${result.error}` });
      }
      iterations++;
    }

    // Final streaming response (include tools so Ollama can still make tool calls)
    const ollamaStartTime = Date.now();
    const resp = await fetch(ollamaBaseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        stream: true,
        messages: currentMessages,
        tools: getOpenAITools(),
        options: { num_predict: MAX_TOKENS },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      onEvent({ type: 'error', error: `Ollama error (${resp.status}): ${errText}` });
      onEvent({ type: 'done' });
      return '';
    }

    // Parse NDJSON stream
    let fullText = '';
    let ollamaUsage: any = null;
    const reader = resp.body?.getReader();
    if (!reader) {
      onEvent({ type: 'error', error: 'No response stream' });
      onEvent({ type: 'done' });
      return '';
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const content = json.message?.content;
          if (content) {
            fullText += content;
            onEvent({ type: 'text', content });
          }
          // Ollama's final chunk (done: true) has eval_count / prompt_eval_count
          if (json.done) {
            ollamaUsage = {
              inputTokens: json.prompt_eval_count,
              outputTokens: json.eval_count,
              durationMs: Date.now() - ollamaStartTime,
              model: ollamaModel,
            };
            onEvent({ type: 'usage', usage: ollamaUsage });
          }
        } catch {}
      }
    }

    if (fullText) {
      conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText } as any]);
      saveAssistantToBuffer(fullText);
    }
    onEvent({ type: 'done', usage: ollamaUsage });
    return fullText;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', error: errMsg });
    onEvent({ type: 'done' });
    return '';
  }
}

/**
 * Simple non-streaming chat (for MCP tool use)
 */
/**
 * Lightweight LLM call — skips BrainLoader, memory, and workflow detection.
 * Uses whatever provider/model is currently active in gateway settings.
 * Designed for mid-pipeline generation (e.g., {{LLM:}} templates in workflows).
 */
/**
 * Strict variant of rawLLMCall — passes the system prompt with full provider
 * control, suppressing claude-cli's baked-in Claude Code identity.
 *
 * For claude-cli: uses `--system-prompt` (full replace, NOT --append) plus
 * `--bare` to skip CLAUDE.md auto-discovery, hooks, LSP, attribution, and
 * auto-memory — exactly what we need for persona-driven calls (ExecDesk
 * personas, future skill subagents) where Claude Code's default identity
 * masks the supplied role.
 *
 * For all other providers: identical to rawLLMCall.
 *
 * Use rawLLMCallStrict from API endpoints that need persona fidelity.
 * Keep using rawLLMCall for general-purpose one-shot completions where
 * the default Claude Code framing is fine.
 */
export async function rawLLMCallStrict(prompt: string, systemPrompt: string): Promise<string> {
  if (currentProvider === 'claude-cli') {
    const startMs = Date.now();
    try {
      const { execSync } = await import('child_process');
      const os = await import('os');
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const escapedSys = systemPrompt.replace(/'/g, "'\\''");
      const cliEnv = { ...process.env, ...freshEnvVars() };
      delete cliEnv.ANTHROPIC_API_KEY;
      delete cliEnv.CLAUDECODE;
      delete cliEnv.VODOU_PROJECT_PATH;
      // --system-prompt fully replaces Claude Code's default identity with ours.
      // (--bare would suppress CLAUDE.md/hooks/LSP too but requires ANTHROPIC_API_KEY env;
      //  we use OAuth/Max subscription, so skip --bare. cwd:os.tmpdir() handles the rest.)
      const text = execSync(
        `echo '${escapedPrompt}' | ${CLAUDE_BIN} -p --model ${CLI_MODEL} --output-format text --system-prompt '${escapedSys}'`,
        { cwd: os.tmpdir(), timeout: 90_000, encoding: 'utf-8', env: cliEnv, maxBuffer: 8 * 1024 * 1024 }
      ).toString().trim();
      console.error(`[Gateway] rawLLMCallStrict claude-cli ${Date.now() - startMs}ms (${text.length} chars)`);
      return text;
    } catch (err: any) {
      console.error(`[Gateway] rawLLMCallStrict claude-cli failed: ${err.message}`);
      throw err;
    }
  }
  // Non-cli providers respect system prompt natively — defer to rawLLMCall.
  return rawLLMCall(prompt, systemPrompt);
}

export async function rawLLMCall(prompt: string, systemPrompt?: string): Promise<string> {
  const startMs = Date.now();
  const sys = systemPrompt || 'You are a helpful assistant. Be concise.';
  try {
    let text = '';

    if (currentProvider === 'anthropic') {
      // Direct Anthropic SDK — non-streaming, no conversation
      const anthropic = getClient();
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: sys,
        messages: [{ role: 'user', content: prompt }],
      });
      text = resp.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map(b => b.text).join('');

    } else if (currentProvider === 'ollama') {
      // Direct Ollama — non-streaming
      const resp = await fetch(ollamaBaseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
          options: { num_predict: 1024 },
        }),
      });
      if (resp.ok) {
        const json = await resp.json() as any;
        text = json.message?.content || '';
      }

    } else if (currentProvider === 'claude-cli') {
      // Claude CLI — spawn with minimal args, force subscription OAuth (strip API key).
      //
      // PERF FIX (deep-think token burn): use a neutral cwd (os.tmpdir()) so the
      // CLI does NOT auto-load this project's CLAUDE.md / MEMORY.md / hooks on
      // every cold spawn. rawLLMCall is one-shot prompt completion, not a chat
      // session — workspace bootstrap costs ~28KB of context tokens per call
      // and burns daily Max quota fast when the workflow driver loops 15× for
      // a deep-think session. Timeout bumped 30s → 90s so cold spawns don't
      // fall through to template-text fallback (caught by dedup guard).
      const { execSync } = await import('child_process');
      const os = await import('os');
      const escaped = prompt.replace(/'/g, "'\\''");
      const cliEnv = { ...process.env, ...freshEnvVars() };
      delete cliEnv.ANTHROPIC_API_KEY; // force Max subscription OAuth, not API key auth
      delete cliEnv.CLAUDECODE;
      delete cliEnv.VODOU_PROJECT_PATH; // belt-and-suspenders: prevent project root inheritance
      text = execSync(
        `echo '${escaped}' | ${CLAUDE_BIN} -p --model ${CLI_MODEL} --output-format text`,
        { cwd: os.tmpdir(), timeout: 90_000, encoding: 'utf-8', env: cliEnv }
      ).trim();

    } else if (currentProvider === 'kimi-cli') {
      const full = `${sys}\n\n${prompt}`;
      const r = spawnSync(
        KIMI_BIN,
        ['--quiet', '--yolo', '--model', kimiCliModel, '-p', full],
        { cwd: getProjectRoot(), encoding: 'utf-8', timeout: 60_000, env: { ...process.env, ...freshEnvVars() } }
      );
      text = (r.stdout || '').trim();
      if (!text && r.stderr) text = String(r.stderr).trim();

    } else {
      // OpenAI-compatible (Google, Groq, DeepSeek, xAI, Mistral, OpenAI, Custom, Kimi API)
      const { endpoint, apiKey, model } = getOpenAICompatConfig();
      if (!endpoint) throw new Error('No OpenAI-compatible endpoint configured');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          stream: false,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
        }),
      });
      if (resp.ok) {
        const json = await resp.json() as any;
        text = json.choices?.[0]?.message?.content || '';
      }
    }

    console.error(`[rawLLMCall] ${currentProvider} responded in ${Date.now() - startMs}ms (${text.length} chars)`);
    return text.trim();
  } catch (err) {
    console.error(`[rawLLMCall] error (${Date.now() - startMs}ms): ${err}`);
    return '';
  }
}

/**
 * Pool-aware variant of rawLLMCall.
 *
 * Used by the workflow driver for `{{LLM:...}}` template resolution. The
 * key win: when the active provider is claude-cli AND the conversation
 * already has a warm pooled subprocess (the same one used by chat), this
 * routes the prompt onto that pool's queue instead of spawning a fresh
 * cold claude-cli process. That avoids:
 *   - workspace bootstrap re-load (~28KB context tokens per call)
 *   - daily Max-subscription quota burn
 *   - 30s+ cold-spawn latency
 *
 * For non-claude-cli providers (anthropic, openai, ollama, kimi, etc.)
 * pooling is unnecessary — those calls are already fast. We delegate to
 * `rawLLMCall` which handles them correctly.
 *
 * Falls back to `rawLLMCall` whenever:
 *   - provider isn't claude-cli
 *   - conversationId is empty
 *   - no warm pool session exists (we don't spawn a fresh one just for this)
 *   - pool dispatch errors (defensive)
 */
export async function rawLLMCallPooled(
  conversationId: string,
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  // Non-claude-cli providers: API calls are already fast, no pool concept needed.
  if (currentProvider !== 'claude-cli') {
    return rawLLMCall(prompt, systemPrompt);
  }
  // No conversationId? Fall back — we have nowhere to look up a pool session.
  if (!conversationId) {
    return rawLLMCall(prompt, systemPrompt);
  }
  const session = _cliSessions.get(conversationId);
  // No warm session yet → don't spawn a fresh one just for this one-shot
  // (cold spawn here would defeat the point; let the cold-spawn path in
  // `rawLLMCall` use the neutral-cwd optimization instead).
  if (!session) {
    return rawLLMCall(prompt, systemPrompt);
  }
  const startMs = Date.now();
  try {
    // Push onto the existing warm session's queue. Use a no-op onEvent
    // since we just want the final text, not streaming chunks.
    const result = await new Promise<string>((resolve, reject) => {
      const noopEvent: StreamCallback = () => { /* drop streaming events */ };
      session.queue.push({
        prompt,
        onEvent: noopEvent,
        resolve,
        reject,
      });
      processNextQueuedTurn(session);
    });
    console.error(`[rawLLMCallPooled] reused session ${conversationId.substring(0, 8)} in ${Date.now() - startMs}ms (${result.length} chars)`);
    return result.trim();
  } catch (err) {
    console.error(`[rawLLMCallPooled] pool dispatch failed (${Date.now() - startMs}ms), falling back to cold rawLLMCall: ${err}`);
    return rawLLMCall(prompt, systemPrompt);
  }
}

/** Get OpenAI-compatible endpoint/key/model for current provider */
function getOpenAICompatConfig(): { endpoint: string; apiKey: string; model: string } {
  switch (currentProvider) {
    case 'openai': return { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: openaiApiKey, model: openaiModel };
    case 'google': return { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: googleApiKey, model: googleModel };
    case 'groq': return { endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: groqApiKey, model: groqModel };
    case 'deepseek': return { endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: deepseekApiKey, model: deepseekModel };
    case 'xai': return { endpoint: 'https://api.x.ai/v1/chat/completions', apiKey: xaiApiKey, model: xaiModel };
    case 'mistral': return { endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: mistralApiKey, model: mistralModel };
    case 'kimi': return { endpoint: 'https://api.moonshot.ai/v1/chat/completions', apiKey: kimiApiKey, model: kimiModel };
    case 'openrouter': return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: openrouterApiKey, model: openrouterModel };
    case 'custom': return { endpoint: customBaseUrl, apiKey: customApiKey, model: customModel };
    default: return { endpoint: '', apiKey: '', model: '' };
  }
}

/** Get fresh env vars (re-read .env) for subprocess spawning */
function freshEnvVars(): Record<string, string> {
  try {
    const envPath = path.join(getProjectRoot(), '.env');
    const content = readFileSync(envPath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) vars[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
    return vars;
  } catch { return {}; }
}

/**
 * Simple non-streaming chat (for MCP tool use)
 */
export async function simpleChat(
  conversationId: string,
  message: string
): Promise<string> {
  let result = '';
  await chat(conversationId, message, (event) => {
    if (event.type === 'text' && event.content) {
      result += event.content;
    }
  });
  return result;
}

export function clearConversation(conversationId: string): void {
  const conversations = getConversationManager();
  conversations.clear(conversationId);
  clearWorkflow(conversationId);
  _bootstrappedConversations.delete(conversationId); // resend bootstrap on next message
  _activeSkill.delete(conversationId);
  _lastOiContext.delete(conversationId);
  _cachedSystemPrompts.delete(conversationId);
  _fileChanges.delete(conversationId);
  try { clearSkillState(conversationId); } catch {}
}

export function getStats(): {
  configured: boolean;
  authType: string;
  model: string;
  activeModelLabel: string;
  maxTokens: number;
  conversationStats: ReturnType<typeof getConversationManager.prototype.getStats>;
} {
  syncProviderFromDb();
  let model = MODEL;
  switch (currentProvider) {
    case 'claude-cli': model = CLI_MODEL; break;
    case 'anthropic': model = MODEL; break;
    case 'kimi-cli': model = kimiCliModel; break;
    case 'kimi': model = kimiModel; break;
    case 'openai': model = openaiModel; break;
    case 'google': model = googleModel; break;
    case 'groq': model = groqModel; break;
    case 'deepseek': model = deepseekModel; break;
    case 'xai': model = xaiModel; break;
    case 'mistral': model = mistralModel; break;
    case 'openrouter': model = openrouterModel; break;
    case 'ollama': model = ollamaModel; break;
    case 'custom': model = customModel; break;
  }
  return {
    configured: isConfigured(),
    authType: getAuthType(),
    model,
    activeModelLabel: buildActiveModelLabel(),
    maxTokens: MAX_TOKENS,
    conversationStats: getConversationManager().getStats()
  };
}

/**
 * Pre-warm a CLI session for a conversation so the first message has no cold start.
 * Called on WebSocket switch_conversation when provider is claude-cli.
 * No-op if pool is disabled, provider isn't claude-cli, or session already exists.
 */
export function warmupCliSession(conversationId: string): void {
  if (currentProvider !== 'claude-cli') return;
  if (!usePersistentClaudeCliPool()) return;
  if (_cliSessions.has(conversationId)) return;
  // Skip warmup for skill / persona conversations. Warmup builds the prompt
  // from the workspace bootstrap, which would lock that prompt onto the
  // pooled session — when the real skill_message arrives later, the session
  // gets reused with the wrong prompt and SKILL.md never reaches the LLM.
  // Let the first skill_message spawn the session with the correct prompt.
  if (conversationId.startsWith('workbench:skill:') || conversationId.startsWith('skill-')) {
    return;
  }

  // Check if Claude CLI is authenticated before spawning
  try {
    const authCheck = execSync('claude auth status 2>&1 || true', { stdio: 'pipe', timeout: 5000 }).toString();
    const notAuthed = authCheck.toLowerCase().includes('not authenticated') || authCheck.toLowerCase().includes('not logged');
    if (notAuthed) {
      console.error('[CLI warmup] Claude CLI not authenticated — opening Terminal for login');
      try {
        spawn('osascript', [
          '-e', 'tell application "Terminal" to do script "echo \'Claude CLI needs authentication. Running: claude auth login\' && claude auth login"',
          '-e', 'tell application "Terminal" to activate',
        ], { detached: true, stdio: 'ignore' }).unref();
      } catch (termErr) {
        console.error(`[CLI warmup] Could not open Terminal: ${(termErr as Error).message}`);
      }
      return;
    }
  } catch {
    // auth subcommand may not exist — proceed with spawn
  }

  // Build system prompt same way as chatWithCLI first-message path
  const bootstrap = getWorkspaceBootstrap();
  const systemPrompt = bootstrap
    ? bootstrap + '\n\n---\n\n' + getSystemPrompt()
    : getSystemPrompt();

  // Cache it so the first real message reuses it
  _cachedSystemPrompts.set(conversationId, { prompt: systemPrompt, builtAt: Date.now() });
  _bootstrappedConversations.add(conversationId);

  try {
    getOrCreateCliSession(conversationId, systemPrompt);
    console.error(`[CLI warmup] Pre-spawned session for ${conversationId.substring(0, 8)}`);
  } catch (err) {
    console.error(`[CLI warmup] Failed: ${(err as Error).message}`);
  }
}

export { initAuth, reinitAuth, triggerMemoryFlush, getActiveModelLabel };
