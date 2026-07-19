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
import { resolveBinPath, systemPromptFileArgs, sockConnectTarget, claudeInstallInstructionsMd } from './cli-portability.js';
import { enterProjectContext, projectContextRoot, projectContextDirective, projectContextProjectId, projectContextProjectName } from './project-context.js';
import { consumeGroundTruth, prewarmGroundTruth, setGroundTruthBlock, groundTruthFor } from './ground-truth.js';
import { spawn, spawnSync, exec } from 'child_process';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { getOpenAITools, getAnthropicTools, getActiveTools, getTool, fsToolsActive, isMenuReply as isMenuReplyCheck } from './tools.js';
import { recoverToolCallsFromContent, repairToolArgs, toolCallRecoveryEnabled } from './tool-call-recovery.js';
import { modelCapabilities } from './model-capabilities.js';
import { executeOITool, callWorkerSocket, freshEnv } from './executor.js';
import { getConversationManager } from './conversation.js';
// PLAN-LENSES-MVP — esm import (require() not available in ESM modules)
import { getRegistry as getLensesRegistry } from './lenses/registry.js';
import { getProjectRoot, getSetting, getMemoryDb, getDb } from './db.js';
import { flushTrajectory, recordTrajectoryStep, normalizeCliToolSteps } from './trajectory-capture.js';
import { saveSkillState, loadSkillState, clearSkillState, getConversation } from './conversation-store.js';
import { lensesAllowedForConversation } from './lenses-policy.js';
import { detectWorkflow, handleWorkflowChoice, hasActiveWorkflow, getActiveWorkflow, clearWorkflow, executeInitialSteps } from './workflow-driver.js';
import { appendChannelAttachmentHints, buildAnthropicUserContent, openaiCompatVisionEnabled, } from './channelAttachments.js';
import { buildScopeSuffix, resolveScope } from './scope.js';
import { deriveCostProfile, setCostProfile, getCostProfile, governorEnabled } from './cost-profile.js';
import { makeIterationBudget, roundIsRefundable, agentModeFor, agentModeMaxIters } from './agent-loop.js';
import { normalizeOpenRouterApiKeyCandidate } from './openrouter-key.js';
import { computeCogs, recordTokenUsage, checkQuota, invalidateQuotaCache } from './usage-tracking.js';
import * as phase0 from './phase0/emitter.js';
// Configuration (mutable — reloaded on settings change)
let MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
let CLI_MODEL = process.env.CLI_MODEL || 'sonnet';
let MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '8096', 10);
const MAX_TOOL_ITERATIONS = parseInt(process.env.MAX_TOOL_ITERATIONS || '10', 10);
/**
 * Resolve `claude` to an absolute path at startup. If we leave it as the
 * bare command `claude`, every spawn re-resolves it against the current
 * PATH — and if some path-mutating subprocess (rare but happens) clears
 * or shrinks PATH, the resolve fails with ENOENT and crashes the gateway
 * (2026-05-15 incident: mid-chat crash with `spawn claude ENOENT`).
 * Resolve once via resolveBinPath (pure fs PATH+PATHEXT scan — NO `which`
 * shell-out; on Windows a `which.cmd` shim would spawn a nested cmd.exe that
 * windowsHide can't suppress) and cache. CLAUDE_BIN env override still wins.
 */
function resolveClaudeBin() {
    if (process.env.CLAUDE_BIN)
        return process.env.CLAUDE_BIN;
    // Cross-platform PATH search (C3/C4): returns an ABSOLUTE path incl. extension
    // so spawn() works without a shell on Windows (no `which`, no PATHEXT gap).
    const resolved = resolveBinPath('claude');
    if (resolved)
        return resolved;
    return 'claude'; // last-resort fallback (preflight will report "not found")
}
const CLAUDE_BIN = resolveClaudeBin();
const KIMI_BIN = process.env.KIMI_BIN || resolveBinPath('kimi') || 'kimi';
const VC_PATH = () => process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');
/**
 * Working directory for the AGENT'S interactive tool spawns (claude-cli / kimi-cli chat).
 * Defaults to the project root (gateway behavior, unchanged). The embedded Vodou CLI sets
 * VODOU_CLI_AGENT_CWD to the user's launch directory so the CLI provider's native file
 * tools (Read/Write/Edit/Bash) operate where the user ran `vodou`, like Claude Code.
 * Only the chat spawns honor this; memory-extraction / routing-feedback spawns stay at root.
 */
// PLAN-GATEWAY-PROJECTS Phase 2 — precedence: the embedded CLI's launch dir wins
// (VODOU_CLI_AGENT_CWD), then the active gateway project's root (per-turn async context),
// then the install root. The gateway never sets VODOU_CLI_AGENT_CWD, so a project turn
// roots claude-cli's native file tools at the project directory; Default → install root.
const agentCwd = () => process.env.VODOU_CLI_AGENT_CWD || projectContextRoot() || getProjectRoot();
// PLAN-PROJECT-FS-JAIL — a non-Default project's root is a BOUNDARY, not just a cwd
// (alpha bug 2026-07-09: project chats could read anywhere on disk; an "index" walk
// reached ~/Pictures). Returns the jail root for a spawn, or null when unjailed:
// Default workspace (install root), isolated tmpdir sessions, the embedded vodou-cli
// (VODOU_CLI_AGENT_CWD — Claude Code parity, launch dir is a base not a boundary),
// or the VODOU_PROJECT_FS_JAIL=0 kill switch. Enforcement lives in
// scripts/project-jail-hook.cjs (PreToolUse hooks fire even under
// --dangerously-skip-permissions; permission rules can't express "deny outside root").
function projectJailRoot(spawnCwd) {
    if (process.env.VODOU_PROJECT_FS_JAIL === '0')
        return null;
    if (process.env.VODOU_CLI_AGENT_CWD)
        return null;
    if (!spawnCwd || spawnCwd === getProjectRoot() || spawnCwd === os.tmpdir())
        return null;
    return projectContextRoot() === spawnCwd ? spawnCwd : null;
}
const PROJECT_JAIL_HOOK_PATH = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-Console', 'scripts', 'project-jail-hook.cjs');
const OPERATOR_GUARD_HOOK_PATH = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-Console', 'scripts', 'operator-guard-hook.cjs');
/** --settings payload for a claude-cli spawn.
 *  PLAN-OPERATOR-SURFACE P1-c: the operator-guard Bash hook rides EVERY spawn
 *  (NEVER-tier command ban — brain / live rediscovery / mem drains; prompts
 *  guide, guards guarantee). The project-jail hook joins only when the session
 *  is confined to a project root. Kill switch: VODOU_OPERATOR_GUARD=0. */
function cliSettingsJson(jailRoot) {
    const preToolUse = [
        {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `"${process.execPath}" "${OPERATOR_GUARD_HOOK_PATH}"` }],
        },
    ];
    if (jailRoot) {
        preToolUse.push({
            matcher: 'Read|Write|Edit|NotebookEdit|Glob|Grep|Bash',
            hooks: [{ type: 'command', command: `"${process.execPath}" "${PROJECT_JAIL_HOOK_PATH}"` }],
        });
    }
    return JSON.stringify({ hooks: { PreToolUse: preToolUse } });
}
let currentProvider = 'none';
// Provider-specific config (loaded from DB settings)
let openaiApiKey = '';
let openaiModel = 'gpt-4o';
let ollamaBaseUrl = 'http://localhost:11434';
let ollamaModel = '';
let customBaseUrl = '';
let customModel = '';
let customApiKey = '';
// Local runtimes (OpenAI-compatible, no API key): LM Studio + bundled llama.cpp
let lmstudioBaseUrl = 'http://localhost:1234';
let lmstudioModel = '';
let llamacppBaseUrl = 'http://127.0.0.1:11436';
let llamacppModel = '';
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
// Two distinct Fireworks keys so we can tell BYOK from Vodou-managed:
//   - fireworksApiKeyUser  : per-account key from Settings UI ('fireworks_api_key'
//                            row in db settings). User is BYOK → Vodou doesn't meter.
//   - fireworksApiKeyManaged: server-side shared key from VODOU_FIREWORKS_KEY (or the
//                            legacy FIREWORKS_API_KEY env var). User is hosted-tier →
//                            metered against Vodou quota + billed via Stripe.
// `fireworksApiKey` is the one actually sent to Fireworks; user-supplied wins
// when both are present (so a paying customer can still BYOK if they want).
let fireworksApiKeyUser = '';
let fireworksApiKeyManaged = '';
let fireworksApiKey = '';
let fireworksModel = 'accounts/fireworks/models/kimi-k2p6';
// Vodou managed LLM (branded): always routes through the proxy with the server
// key, metered against the user's plan. Curated allowlisted models only.
let vodouModel = 'accounts/fireworks/models/kimi-k2p6';
let togetherApiKey = '';
let togetherModel = 'moonshotai/Kimi-K2.6';
// --- Smart Model Routing (#2 from Hermes learnings) ---
// Routes simple queries to a cheaper/faster model. Kill switch: VODOU_SMART_ROUTING=0
let smartRoutingEnabled = process.env.VODOU_SMART_ROUTING !== '0'; // ON by default
let smartRoutingModel = process.env.VODOU_SMART_ROUTING_MODEL || ''; // empty = auto-detect cheap model
/** Technical words that ALWAYS force the primary model, regardless of message length */
const TECHNICAL_KEYWORDS = /\b(code|bug|error|fix|debug|deploy|build|create|write|implement|implementation|refactor|test|schema|database|db|api|server|function|class|module|component|config|install|migrate|auth|security|encrypt|performance|optimize|docker|kubernetes|k8s|script|compile|async|stream|websocket|webhook|endpoint|route|query|sql|css|html|react|node|rust|python|typescript|javascript|golang|java|swift|file|commit|merge|branch|git|npm|pip|cargo|make|run|execute|parse|render|fetch|upload|download|backup|restore|cron|schedule|scheduler|monitor|log|trace|profile|lint|format|scaffold|setup|init|provision|terraform|ansible|redis|mongo|postgres|mysql|graphql|grpc|socket|cors|jwt|token|cert|ssl|tls|proxy|nginx|apache|ci|cd|pipeline|workflow|container|image|volume|network|port|daemon|process|thread|memory|cpu|disk|cache|index|reindex|shard|replica|cluster|helm|yaml|json|xml|csv|regex|pattern|template|middleware|plugin|extension|hook|callback|promise|observable|listener|handler|controller|service|repository|factory|singleton|interface|type|enum|struct|trait|protocol|generic|abstract|virtual|override|decorator|annotation|macro|crate|package|dependency|version|release|patch|hotfix|rollback|revert|cherry.pick|stash|rebase|analyze|investigate|benchmark|diagnose|troubleshoot|inspect|audit|crawl|scrape|data|refine|architect|design|spec|schema|model|train|inference|embed|vector|chunk|tokenize|serialize|deserialize|marshal|unmarshal)\b/i;
/** Conservative simple query detection — whitelist approach.
 *  A query is "simple" ONLY if it's clearly trivial AND contains no technical words.
 *  Everything else goes to the primary model. Safe default. */
function isSimpleQuery(message) {
    const trimmed = message.trim();
    const len = trimmed.length;
    const words = trimmed.split(/\s+/).length;
    // Never route long messages to cheap model
    if (len > 120 || words > 20)
        return false;
    // Never route messages with code, URLs, or multi-line
    if (/```/.test(trimmed))
        return false;
    if (/https?:\/\//.test(trimmed))
        return false;
    if (trimmed.includes('\n'))
        return false;
    // ANY technical keyword → primary model, no exceptions
    if (TECHNICAL_KEYWORDS.test(trimmed))
        return false;
    // Menu/stopping point replies — always simple (already passed technical check)
    if (/^\d{1,2}[\.\)\s:]/.test(trimmed) || /^\d{1,2}$/.test(trimmed))
        return true;
    if (/^(all|yes|no|y|n)\s*[!?.]*$/i.test(trimmed))
        return true;
    // Short non-technical messages (greetings, thanks, casual questions)
    // Conservative: only very short messages that passed the technical keyword filter
    if (len <= 50 && words <= 8)
        return true;
    // Everything else → primary model (safe default)
    return false;
}
/** Get the cheap model for the current provider */
function getSmartRoutingCheapModel() {
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
        case 'fireworks':
            // No DeepSeek-flash variant currently in Fireworks catalog; fall back to gpt-oss-120b
            // (cheap at $0.15/$0.60) for smart-routing of simple queries
            return { model: 'accounts/fireworks/models/gpt-oss-120b', cliModel: '' };
        default:
            return { model: '', cliModel: '' }; // No cheap alternative known
    }
}
/** Normalize external provider names ("claude") to the internal canonical
 *  form ("claude-cli"). The settings page + memProviderMap use "claude" as
 *  the user-facing name for the Claude CLI provider, but llm.ts switches
 *  and equality checks throughout this file use "claude-cli". Without this
 *  normalization, a DB value of "claude" propagates as currentProvider and
 *  every `currentProvider === 'claude-cli'` check fails — chat dies with
 *  "Unknown provider: claude". */
function normalizeProvider(p) {
    if (!p)
        return 'none';
    if (p === 'claude')
        return 'claude-cli';
    return p;
}
function detectProvider() {
    // Check DB settings first
    try {
        const dbProvider = getSetting('llm_provider');
        if (dbProvider && dbProvider !== 'none') {
            const normalized = normalizeProvider(dbProvider);
            console.error(`[Auth] Using provider from settings: ${dbProvider}${dbProvider !== normalized ? ` (normalized to ${normalized})` : ''}`);
            return normalized;
        }
    }
    catch { }
    // Check env override
    if (process.env.LLM_PROVIDER) {
        console.error(`[Auth] Using LLM_PROVIDER env: ${process.env.LLM_PROVIDER}`);
        return normalizeProvider(process.env.LLM_PROVIDER);
    }
    // ANTHROPIC_API_KEY env var is the only remaining auto-detect.
    // `which claude` PATH detection is intentionally removed for BYOK-only alpha:
    // silently binding to claude-cli when the user hasn't chosen a provider
    // confuses non-Anthropic BYOK users and violates local-first positioning.
    // Users must explicitly select a provider in Settings.
    if (process.env.ANTHROPIC_API_KEY) {
        console.error('[Auth] Using ANTHROPIC_API_KEY (SDK mode)');
        return 'anthropic';
    }
    console.error('[Auth] No provider configured — open Settings to select one');
    return 'none';
}
function loadProviderConfig() {
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
        // LM Studio (local, OpenAI-compatible GUI runtime — no API key)
        lmstudioBaseUrl = (getSetting('lmstudio_base_url') || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234').replace(/\/$/, '');
        lmstudioModel = getSetting('lmstudio_model') || process.env.LMSTUDIO_MODEL || '';
        // llama.cpp (bundled local server — port is ours; base URL derived from VODOU_LLAMACPP_PORT)
        llamacppBaseUrl = ('http://127.0.0.1:' + (process.env.VODOU_LLAMACPP_PORT || '11436')).replace(/\/$/, '');
        llamacppModel = getSetting('llamacpp_model') || process.env.LLAMACPP_MODEL || '';
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
        // BYOK signal: only the per-user Settings row counts. Env vars are reserved
        // for Vodou's managed key (paid by Vodou, metered against the user's Stripe
        // plan). VODOU_FIREWORKS_KEY is canonical; FIREWORKS_API_KEY is a legacy
        // fallback for installs that pre-date the rename.
        fireworksApiKeyUser = getSetting('fireworks_api_key') || '';
        fireworksApiKeyManaged = process.env.VODOU_FIREWORKS_KEY || process.env.FIREWORKS_API_KEY || '';
        fireworksApiKey = fireworksApiKeyUser || fireworksApiKeyManaged;
        fireworksModel = getSetting('fireworks_model') || process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/kimi-k2p6';
        vodouModel = getSetting('vodou_model') || 'accounts/fireworks/models/kimi-k2p6';
        togetherApiKey = getSetting('together_api_key') || process.env.TOGETHER_API_KEY || '';
        togetherModel = getSetting('together_model') || process.env.TOGETHER_MODEL || 'moonshotai/Kimi-K2.6';
        // Manage ANTHROPIC_API_KEY in process.env based on active provider.
        // Claude CLI MUST NOT have this set — it causes CLI to use API key auth
        // instead of Max subscription OAuth → "credit balance too low" error.
        const dbProvider = getSetting('llm_provider');
        if (dbProvider === 'anthropic') {
            const dbAnthropicKey = getSetting('anthropic_api_key');
            if (dbAnthropicKey)
                process.env.ANTHROPIC_API_KEY = dbAnthropicKey;
        }
        else {
            // For ALL non-Anthropic providers (including claude-cli), remove the key
            delete process.env.ANTHROPIC_API_KEY;
        }
    }
    catch { }
}
/** Reload provider + model fields from DB/env and sync `currentProvider` (fixes stale footer / routing). */
function syncProviderFromDb() {
    loadProviderConfig();
    currentProvider = detectProvider();
    // Sync smart routing settings from DB (env vars are fallback)
    try {
        const dbSmartRouting = getSetting('smart_routing');
        if (dbSmartRouting !== null)
            smartRoutingEnabled = dbSmartRouting !== '0' && dbSmartRouting !== 'false';
        // Hard kill switch: VODOU_SMART_ROUTING=0 wins over the DB setting (the Vodou CLI
        // sets this so it always uses the configured model, never a cheap-routed downgrade).
        if (process.env.VODOU_SMART_ROUTING === '0')
            smartRoutingEnabled = false;
        const dbSmartModel = getSetting('smart_routing_model');
        if (dbSmartModel)
            smartRoutingModel = dbSmartModel;
    }
    catch { }
}
async function initAuth() {
    syncProviderFromDb();
    // Reset SDK client in case key changed
    client = null;
}
/**
 * Reinitialize auth after settings change — called from settings API
 */
async function reinitAuth() {
    syncProviderFromDb();
    client = null;
    _cachedSystemPrompts.clear();
    _bootstrappedConversations.clear();
    _workspaceBootstrap = '';
    _bootstrapLoadedAt = 0; // force bootstrap re-read on next message
    console.error(`[Auth] Reinitialized — provider: ${currentProvider}, caches cleared`);
}
// --- System prompt (simplified — Claude no longer picks tools) ---
function buildActiveModelLabel() {
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
        case 'lmstudio': return `LM Studio (${lmstudioModel})`;
        case 'llamacpp': return `Vodou Local (${llamacppModel})`;
        case 'custom': return `Custom (${customModel})`;
        case 'vodou': return `Vodou LLM (${vodouModel.replace('accounts/fireworks/models/', '')})`;
        case 'fireworks': return `Fireworks (${fireworksModel})`;
        case 'together': return `Together (${togetherModel})`;
        default: return 'None';
    }
}
function getActiveModelLabel() {
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
/**
 * Operator Surface — BEST mid-turn mix of Vodou capabilities (Bash skin).
 * Canonical plan: PLANS/0.6.18/PLAN-OPERATOR-SURFACE.md
 * Keep ~20 verbs. Integrations stay discover→call. Never live rediscovery mid-turn.
 */
function getVodouCoreBashCheatsheet() {
    const vc = VC_PATH();
    return `### Vodou Operator Surface (mid-turn — use these)

**Discover → Act** (integrations = this path, never guess tool names):
- \`${vc} list-tools-db --server <name>\` / \`--filter "<substr>"\` — instant catalog (DB)
- \`${vc} intent-search "<what you want>"\` — semantic tool find
- \`${vc} tool-schema <tool>\` — args before calling
- \`${vc} call <server> <tool> '<json_args>'\` — preferred execute
- \`${vc} call-tool <tool> '<json_args>'\` — auto-route when server unknown

**Memory** (durable vault — re-query when injection missed or user pivots):
- \`${vc} mem search "query"\` — hybrid FTS5+vector via daemon
- \`${vc} mem get <chunk-id-or-path>\` — exact read after a hit
- \`${vc} mem store "fact"\` — remember mid-chat (import:mcp; not auto-promoted)
- \`${vc} mem similar --chunk <id>\` — more like this
- \`${vc} mem profile\` — durable "who is the user" snapshot
- \`${vc} mem refs <anchor>\` — memories tied to a plan/file (e.g. PLAN-X.md)
- Same-thread chat history: \`${vc} call Vodou-Recall search_conversation '{"conversation_id":"…","query":"…"}'\`
- Prefer Recall MCP when calling via tools: search_memory / memory_get / memory_store
- **If the turn carries \`### Vodou Memory: DEGRADED\`:** injection failed, memory may still exist — re-query yourself (\`${vc} mem search "<topic>" --json\`) BEFORE ever saying "no record". Empty results ≠ no memory: rephrase once.
- **Never claim a fact was saved unless the store returned \`ok:true\`** — on an error result, fix the args and retry once, or say it failed.

**Think:**
- \`${vc} call Vodou-Enhanced-Thinking start_thinking_session '{"topic":"...","estimated_steps":5}'\`
- then \`add_thought\` / \`analyze_thinking\` / \`complete_thinking_session\`

**Orient:**
- \`${vc} runtime-status --json\` — daemon/worker/MCP kernel
- \`${vc} context-truth --json\` — cwd, project, git, MCP, skills, memory counts
- \`${vc} list\` / \`${vc} list-skills\` / \`${vc} skill show <name>\`

**Orchestrate:**
- \`${vc} board list\` / \`${vc} board show <id>\` / \`${vc} board ask "what's blocked?"\`
- \`${vc} schedule list\`

**Connect / automate** (only when needed):
- Channels: \`${vc} call Vodou-channels …\` (status/send — check schema first)
- Screenshot: \`${vc} call chrome-devtools take_screenshot '{}'\`
- Scripts: \`${vc} call Vodou-script-executor …\` when user asks to run a job

**NEVER mid-turn** (slow or LLM-loop hazards):
- \`${vc} tools <server>\` / \`all-tools\` / \`find-tool\` / \`reconnect*\` — live MCP + re-embed
- \`./oi\` / \`${vc} brain\` — BrainLoader already ran; process zombies
- \`${vc} mem keygen|reextract|extract-*|janitor\` — operator/drain only

Refresh the tool catalog only via Capabilities → Refresh (or deliberate offline rediscovery).`;
}
const SYSTEM_PROMPT_TOOLS_BASH_RESTRICTED = `
## Follow-Up Tool Calls

When Vodou results require follow-up actions (multi-step workflows, skills, interactive sessions), use Bash to call vodou-core directly.

${getVodouCoreBashCheatsheet()}`;
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

${getVodouCoreBashCheatsheet()}`;
function getToolsBashPrompt() {
    const mode = getGatewayShellMode();
    return mode === 'restricted' ? SYSTEM_PROMPT_TOOLS_BASH_RESTRICTED : SYSTEM_PROMPT_TOOLS_BASH_FULL;
}
// Tool-calling guidance for API providers. Flag-aware (PLAN 0.6.4 §4.3): the FS
// tools block is appended ONLY when fsActive (VODOU_FS_TOOLS_ENABLED + web-chat
// source) so flag-off installs aren't told about tools they don't have. The
// stale "two tools" wording is gone — board_* and (when enabled) FS tools also
// exist, so an exact count would mislead.
export function getSystemPromptToolsNative(fsActive, fsTargetedEdits = true) {
    // Keep in sync with getVodouCoreBashCheatsheet() + PLANS/0.6.18/PLAN-OPERATOR-SURFACE.md
    const base = `
## Vodou Operator Surface (mid-turn)

You can call these tools for follow-up actions. Prefer this playbook over inventing shell commands.

### Discover → Act (all integrations)
1. **search_tools** — semantic find by meaning when you know the *task* not the tool name.
2. **list_available_tools** — instant catalog from vodou-core.db (no live MCP).
3. **describe_tool** — \`{ server, tool }\` — schema BEFORE calling; never guess args.
4. **vodou_core_call** — \`{ server, tool, args }\` — execute any MCP tool.
   Flow: **search_tools / list_available_tools → describe_tool → vodou_core_call**.

### Memory (Vodou-Recall — institutional memory mid-turn)
- Recall: \`vodou_core_call(server="Vodou-Recall", tool="search_memory", args={"query":"…"})\`
- Exact read after a hit: \`tool="memory_get"\` (chunk id or path)
- Save a fact: \`tool="memory_store"\` (import:mcp scope; not auto-promoted to MEMORY.md)
- Same-thread history: \`tool="search_conversation"\` with this conversation_id
- Use when injection missed a pivot ("what did we decide…", "remember that…"). Do NOT call search on every prompt.
- **If the turn carries \`### Vodou Memory: DEGRADED\`:** injection failed, memory may still exist — call search_memory yourself BEFORE ever saying "no record". Empty results ≠ no memory: rephrase once.
- **Never claim a fact was saved unless the store call returned \`ok:true\`.** An \`isError\`/\`"error"\` result means NOT saved — read the error, fix the args (usually a missing \`text\`), retry once; if it still fails, tell the user it failed. Saying "Done — saved" over a failed call plants false trust in memory.

### Think
- \`vodou_core_call(server="Vodou-Enhanced-Thinking", tool="start_thinking_session", args={"topic":"…","estimated_steps":5})\`
- then \`add_thought\` / \`analyze_thinking\` / \`complete_thinking_session\`

### Orient / monitor
- System: \`vodou_core_call(server="mcp-monitor", tool="get_cpu_info")\` (etc.)
- Screenshot: \`vodou_core_call(server="chrome-devtools", tool="take_screenshot")\`

### Orchestrate
- Board workers: **board_show** / **board_complete** / **board_block** / **board_heartbeat**
- For open-task overview from chat, prefer discover→call on Vodou-Board (\`list\` / \`ask\`) when available — do not invent board state.

### Connect
- Messaging: \`vodou_core_call\` → **Vodou-channels** (describe_tool first). Only when the user wants a send/status.

**Never** invent \`vodou-core tools\` / \`all-tools\` / \`brain\` / \`./oi\` in replies or as pretend shell — those are slow live rediscovery or zombie spawns. Catalog refresh is a Capabilities UI / operator action, not mid-turn.

**Do not** paste terminal fiction: never write \`<execute_bash>\`, \`<tool_code>\`, or simulated \`vodou-core\` shell lines in your visible reply. The gateway runs tools via the API — only use the tools above.`;
    if (!fsActive)
        return base;
    // Targeted-edit tools are described only when offered (#8 §1.3): a 'whole-file'
    // model gets write/read/list and rewrites whole files via write_file instead.
    const targetedBlock = fsTargetedEdits ? `
- **edit_file** — \`{ path, old_string, new_string, replace_all? }\` — string replace (whitespace/indent differences tolerated); \`old_string\` must be UNIQUE unless \`replace_all\`. If it isn't found the edit fails with no write — read_file first and include surrounding context.
- **multi_edit** — \`{ path, edits: [{ old_string, new_string, replace_all? }] }\` — apply several edits to one file ATOMICALLY (all-or-nothing; order doesn't matter; overlapping edits are rejected). Prefer this over multiple edit_file calls on the same file.` : `
- To change an existing file, read it with read_file and write the full updated contents back with write_file (mode "overwrite").`;
    return base + `

## File Tools (your per-conversation workspace)

You can create and edit text files in a private workspace scoped to THIS conversation. Always use relative paths.

- **write_file** — \`{ path, content, mode? }\` — create (default; fails if it exists), \`overwrite\`, or \`append\`. Parent folders are created automatically.
- **read_file** — \`{ path, max_bytes? }\` — read a file back.
- **list_dir** — \`{ path? }\` — list the workspace (default \`.\`) to orient yourself before reading or editing.${targetedBlock}

The workspace is sandboxed: paths outside it (\`..\`, absolute paths) and protected files (\`.env\`, \`.git\`, \`*.db\`) are refused. **Never claim you saved or edited a file unless you actually performed the write and it succeeded.**`;
}
const SYSTEM_PROMPT_RULES = `

## CRITICAL RULES

1. **Skills are Layer 1 — they ALWAYS come first.** When Vodou returns a skill, follow it completely. Never bypass, skip stopping points, or substitute your own answer. The skill IS the answer.

2. **Stopping points are sacred.** When you see numbered menus, display ALL options and STOP. Wait for the user to choose. Never assume their choice.

3. **Actually use the tools.** When a skill says to call an MCP tool (start_thinking_session, etc.), CALL IT. Do NOT fake the output or answer from your own knowledge.

4. **Be concise.** Don't over-explain. Chad knows the platform.

5. **Most tool calls auto-run.** You're in the Vodou-Console web chat — there is no terminal, so never ask for *terminal* approval. Most tools execute immediately; just run them. A few sensitive actions may require the user's approval: if a tool result says it is **awaiting your approval**, briefly tell the user exactly what needs approving and that they can approve it, then STOP and wait — do NOT retry the tool and never claim it succeeded.

6. **NEVER run \`./oi\` or \`vodou-core brain\`.** The gateway already ran BrainLoader before your response arrived. Running it again spawns a new vodou-core subprocess inside the gateway process, which becomes an unresponsive zombie and can force the user to restart their machine. Use \`vodou-core call <server> <tool>\` for direct MCP tool calls only.

7. **Execute obvious intents — never invent disambiguation menus.** When the user types a known system query like \`cpu\`, \`memory\`, \`disk\`, \`network\`, \`processes\`, or combinations (\`cpu memory disk\`, \`cpu memory disk network\`), call the relevant MCP tool(s) immediately via \`vodou_core_call\` and present the live numbers. **Do NOT** respond with a numbered "Scope" menu, "What would you like to know?" question, or any other clarifier. The user already told you the scope; their query IS the scope. The ONLY time you show a numbered menu is when a SKILL explicitly returns one (rule #2) — never invent one yourself.

8. **Lens payloads use exact field names — do not invent or rename.** When emitting a lens block, the \`payload\` object MUST use the exact field names from the lens's "Required payload keys" line in the Visual Lenses section below, and the shape from its "Example payload" line. Copy verbatim. Do not paraphrase keys (e.g., \`map.directions\` requires \`origin\`/\`destination\` — NEVER \`from\`/\`to\`, \`start\`/\`end\`, or \`pickup\`/\`dropoff\`). If "Required payload keys" is empty (\`[]\`), pass \`payload: {}\` and rely on \`source_url\`. Wrong field names cause the user to see "card rejected payload" — a visible bug.

Style: Direct, occasional humor. You know the user from your bootstrap context.`;
/**
 * PLAN-LLM-CAPABILITY-AWARENESS Phase 4 — a tiny, ALWAYS-RESIDENT capability map
 * built from live DB counts (never stale), so the model always knows the breadth
 * of what it can reach and how to drill to it. ~Few hundred tokens. Returns '' when
 * nothing is cached yet (stay silent rather than claim zero capabilities) or on any
 * DB error, so it can never break prompt assembly.
 */
export function getCapabilityIndexHeader() {
    try {
        const db = getDb();
        const tools = db.prepare(`SELECT COUNT(*) AS n FROM tools t JOIN mcp_servers s ON t.server_id = s.id WHERE COALESCE(s.active,1) != 0`).get()?.n ?? 0;
        if (!tools)
            return '';
        const servers = db.prepare(`SELECT COUNT(*) AS n FROM mcp_servers WHERE COALESCE(active,1) != 0`).get()?.n ?? 0;
        const skills = db.prepare(`SELECT COUNT(*) AS n FROM skills_registry WHERE COALESCE(is_active,1) = 1`).get()?.n ?? 0;
        const top = db.prepare(`SELECT s.name AS name, COUNT(t.id) AS c FROM tools t JOIN mcp_servers s ON t.server_id = s.id
        WHERE COALESCE(s.active,1) != 0 GROUP BY s.name ORDER BY c DESC LIMIT 10`).all().map((r) => r.name).join(', ');
        return [
            '',
            '## Capabilities (live)',
            `You can act through **${servers} connected MCP servers · ${tools} tools · ${skills} skills** — expandable; users connect more anytime.`,
            top ? `Largest servers: ${top}.` : '',
            'To act on a request: if a `USE THIS ROUTE` / `Intent Signal` match is surfaced, prefer it. Otherwise discover, don\'t guess — **list_available_tools** to find the server/tool, **describe_tool** for its exact arguments, then **vodou_core_call** to run it. Never invent tools or servers that aren\'t in the catalog.',
            '',
        ].filter((l) => l !== '').join('\n');
    }
    catch {
        return '';
    }
}
// CLI gets Bash instructions (mode-aware); all other providers get native tool calling guidance.
// Composed per-request now (not module load) so the FS-tools block can be gated by fsActive.
function getSystemPromptToolCalling(fsActive, fsTargetedEdits = true) {
    return SYSTEM_PROMPT_BASE + getSystemPromptToolsNative(fsActive, fsTargetedEdits) + getCapabilityIndexHeader() + SYSTEM_PROMPT_RULES;
}
/**
 * Inject recall instructions into the FIRST turn of an API-provider conversation.
 * Mirrors the <convo_recall_tool> block injected for claude-cli, but uses
 * vodou_core_call syntax since API providers don't have a Bash escape hatch.
 * Returns empty string on warm turns or when VODOU_CONVO_RECALL_TOOL=0.
 */
function buildApiRecallBlock(conversationId, isCold) {
    if (process.env.VODOU_CONVO_RECALL_TOOL === '0' || !isCold)
        return '';
    return `<convo_recall_tool>
When the user references something discussed earlier in THIS conversation that you
do not have in your current context window, search the full history before answering:

vodou_core_call(server="Vodou-Recall", tool="search_conversation", args={"conversation_id": "${conversationId}", "query": "<search terms>", "limit": 5})

Returns: {results: [{id, role, content, created_at, rank}], count}. Lower rank = more relevant.
Use ONLY when the user clearly references prior work you cannot find in recent turns — do NOT call on every prompt.
</convo_recall_tool>

`;
}
function getAppsSystemBlock() {
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
/**
 * PLAN-LENSES-MVP — Cards system-prompt block.
 * Enumerates installed cards so the LLM knows when to emit ```card``` blocks.
 * Read live from the registry so newly-installed cards (0.5.89) appear
 * without restart. Capped at top-15 by usage in 0.5.89 (router-LLM); MVP
 * just enumerates all non-debug cards.
 */
function getLensesSystemBlock() {
    try {
        // ESM import at top of file. Registry singleton — load happens at gateway
        // boot via ensureRegistryLoaded(); if not yet loaded, returns empty.
        const manifests = getLensesRegistry().listManifests().filter((m) => m.category !== 'debug');
        if (!manifests.length) {
            // [DIAG] If you see this in the gateway log, the registry hasn't loaded yet.
            console.warn('[lenses] getLensesSystemBlock: registry has 0 manifests — system prompt will lack lenses block');
            return '';
        }
        const lines = manifests.map((m) => {
            const sessionTag = m.requires?.needs_session ? ' (needs Vodou Bridge)' : '';
            const patterns = (m.url_patterns || []).slice(0, 2).join(', ');
            const head = `  - \`${m.type}\`${sessionTag} — ${m.motive}${patterns ? ` Matches: ${patterns}` : ''}`;
            // Explicit payload schema so non-Anthropic models (Kimi K2.x, etc.) don't have to infer.
            const reqd = Array.isArray(m.payload_required) && m.payload_required.length
                ? `\n    Required payload keys: [${m.payload_required.map((k) => `"${k}"`).join(', ')}]`
                : '';
            const exShape = m.payload_example !== undefined ? m.payload_example : {};
            const exStr = `\n    Example payload: ${JSON.stringify(exShape)}`;
            return head + reqd + exStr;
        }).join('\n');
        return `
## Visual Lenses

When the answer is **fundamentally visual or about a specific URL**, you can emit a lens block that renders a purpose-built UI inline in chat. Lenses beat plain text + a link for: maps, recipes, GitHub PRs, images, npm packages.

**Emit format:** Always include a one-sentence text answer first, then the lens block (fence is \`lens\`, not \`card\`):

\`\`\`lens
{
  "type": "<lens type>",
  "source_url": "<URL the lens fetches from>",
  "payload": { ... lens-specific args ... }
}
\`\`\`

The text sentence is the user's answer if the lens fails to render — it must stand alone.

**Installed lenses:**
${lines}

When the user pastes a URL that matches one of these patterns, prefer rendering a lens over describing the link. Don't force a lens if the user is asking a conversational question.

**🚨 LENS PREFERENCE OVER MCP TOOLS — read this carefully.**
If an installed lens above can answer the user's intent, **emit the lens block immediately as your first response**. Do NOT call MCP tools (Zapier, Gmail MCP, Slack MCP, etc.) for data the lens fetches, even if those tools exist and look applicable. The lens path is one round-trip and renders inline; the tool path requires multiple back-and-forth turns and lands as raw text. Specifically:
- *"show me my unread gmail"* → emit \`gmail.unread\` lens; **do not** call \`zapier::gmail_*\` tools.
- *"summarize this PR <github-url>"* → emit \`github.pr\` lens; **do not** call \`github::*\` tools.
- *"recipe at allrecipes.com/..."* → emit \`recipe.allrecipes\` lens; **do not** fetch the URL via Bash.
- *"what's the latest hn?"* → emit \`hackernews.item\` for a specific item; for the front page, fall back to chat.
Only call MCP tools when no lens matches OR when the user explicitly asks for a *write* action (send email, post message, archive thread). Lenses are read-only; tools handle writes.

**⚠️ Do NOT invent URLs.** Each lens's \`source_url\` must be a real URL that you either (a) got from the user, (b) just received from a tool result (exa search, etc.), or (c) know with high confidence to exist (e.g. canonical pages like \`https://en.wikipedia.org/wiki/<topic>\` where you're sure). If the user asks for "a recipe for X" without giving a URL, **do not guess a recipe ID** — instead, run a web search via the \`exa\` tool first, take the top result URL, and emit the lens with that. Hallucinated URLs hit 404s and the lens shows empty fields, which looks like a product bug.
`.trim();
    }
    catch (err) {
        // Registry not yet loaded or no cards — return empty block
        return '';
    }
}
/**
 * Vodou-CLI working-directory steer. Set ONLY by the embedded CLI (VODOU_CLI_AGENT_CWD);
 * the gateway never sets it, so this is a no-op there. Lives in the SYSTEM prompt (not the
 * user message) so it doesn't pollute BrainLoader intent routing or skill menu-reply
 * detection, while still countering the workspace bootstrap's install-dir bias.
 */
function cliCwdDirective() {
    const cwd = process.env.VODOU_CLI_AGENT_CWD;
    if (!cwd)
        return '';
    return `\n\n## Working directory (Vodou CLI)\nYou are running as the Vodou CLI in: ${cwd}\nTreat relative paths and "here" / "this directory" / "the current directory" as ${cwd}. Create/read/edit files there by default. Do NOT touch the Vodou install directory unless the user gives an absolute path or explicitly asks.`;
}
/**
 * PLAN-GATEWAY-PROJECTS Phase 1 — per-turn project directive.
 *
 * The gateway runs concurrent turns across different projects in one process,
 * so the active project's instructions must NOT live in a process-global (that
 * would bleed across interleaved turns). AsyncLocalStorage carries the directive
 * down the per-turn async context to getSystemPrompt() without threading a new
 * argument through every dispatchToProvider() call site. Empty for the Default
 * project → byte-identical system prompt → Anthropic prompt cache preserved.
 *
 * NB Phase 1: we inject the project NAME + INSTRUCTIONS only. The working-directory
 * steer (relative paths → project root) waits for Phase 2, when the file-tool root
 * actually follows the project; claiming a cwd the fs tools don't honor yet would
 * reproduce the "model steering vs ground truth" mismatch.
 */
/** Build the directive string from a project's name + instructions + root (or '' for Default). */
function buildProjectDirective(name, instructions, root) {
    const instr = (instructions ?? '').trim();
    const nm = (name ?? '').trim();
    // Default project (no name beyond "Default", no instructions) → no directive, preserve cache.
    if (!instr && (!nm || nm === 'Default'))
        return '';
    const header = nm ? `## Active project: ${nm}` : '## Active project';
    // Working-directory steer. The claude-cli subprocess is spawned with cwd = this root,
    // but Claude Code can intermittently resolve relative writes against a different project
    // marker when several instances start at once — so instruct ABSOLUTE paths under root to
    // make file operations deterministic regardless of its cwd resolution.
    const wd = root && root.trim()
        ? `\nWorking directory: ${root}\nTreat relative paths and "here" / "this directory" / "the current directory" as ${root}. When creating, reading, or editing files, use ABSOLUTE paths under ${root} (do not rely on the shell's working directory). Do not touch the Vodou install directory unless the user gives an absolute path outside ${root} or explicitly asks.`
        : '';
    const body = instr ? `\n${instr}` : '';
    return `\n\n${header}${wd}${body}`;
}
/** Read the current turn's project directive from async-local context (shared module). */
function projectDirective() {
    return projectContextDirective();
}
function getSystemPrompt(opts) {
    const lensesEnabled = opts?.lensesEnabled !== false;
    const fsActive = opts?.fsActive === true;
    const fsTargetedEdits = opts?.fsTargetedEdits !== false; // default true
    const appsBlock = getAppsSystemBlock();
    const lensesBlock = lensesEnabled ? getLensesSystemBlock() : '';
    // Non-CLI providers with tool calling support get native tool guidance
    if (currentProvider !== 'claude-cli' && currentProvider !== 'kimi-cli') {
        return getSystemPromptToolCalling(fsActive, fsTargetedEdits) + '\n\n' + appsBlock + (lensesBlock ? '\n\n' + lensesBlock : '') + cliCwdDirective() + projectDirective();
    }
    // CLI mode: tool instructions vary by shell mode (restricted vs full)
    return SYSTEM_PROMPT_BASE + getToolsBashPrompt() + SYSTEM_PROMPT_RULES + '\n\n' + appsBlock + (lensesBlock ? '\n\n' + lensesBlock : '') + cliCwdDirective() + projectDirective();
}
function resolveLensesEnabled(conversationId, explicit) {
    if (explicit === false)
        return false;
    if (explicit === true)
        return true;
    const row = getConversation(conversationId);
    return lensesAllowedForConversation(conversationId, row?.source);
}
function systemPromptStaticPrefix(bootstrap, lensesEnabled, fsActive = false, fsTargetedEdits = true) {
    return [getSystemPrompt({ lensesEnabled, fsActive, fsTargetedEdits }), bootstrap].filter(Boolean).join('\n\n---\n\n');
}
/**
 * WS3 (PLAN-GATEWAY-STATE-LAYER): Anthropic prompt-cache breakpoints for the direct
 * `anthropic` SDK provider (the claude-CLI path caches natively; this path did not).
 * Anthropic processes the prompt as tools→system→messages and caches the prefix up to
 * each cache_control breakpoint, so a breakpoint on the LAST tool caches the (byte-stable)
 * tool defs even when volatile memory in `system` changes turn-to-turn; a breakpoint on
 * the system block caches it when stable. Exported for unit testing the request shape.
 */
/**
 * WS6 (PLAN-GATEWAY-STATE-LAYER): hard per-turn token-ceiling cut decision. True → end the
 * OpenAI-compat tool loop early and stream the final answer. Disabled when budget ≤ 0; never
 * cuts before the first tool round (iterations > 0) so a turn always makes some progress.
 */
export function shouldCutForBudget(cumulativeInputTokens, budget, iterations) {
    return budget > 0 && iterations > 0 && cumulativeInputTokens > budget;
}
export function anthropicCacheSystem(systemPrompt) {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
}
/** Clone the LAST tool def with a cache_control breakpoint — never mutates the shared registry objects. */
export function anthropicCacheTools(tools) {
    if (!tools || !tools.length)
        return tools;
    return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
}
/**
 * Detect auth-related failures in a vodou-core tool result and replace them with
 * actionable guidance so the LLM directs the user to the Apps tab instead of
 * hallucinating OAuth setup instructions.
 */
function rewriteAuthError(raw, serverName) {
    if (!raw)
        return raw;
    const authFailurePattern = /invalid_token|AuthenticationRequired|Missing or invalid access token|HTTP\s*401\b|"code"\s*:\s*401\b|www-authenticate:\s*Bearer/i;
    if (!authFailurePattern.test(raw))
        return raw;
    const base = (process.env.GATEWAY_BASE_URL || `http://localhost:${process.env.WEB_PORT || '8765'}`).replace(/\/$/, '');
    // Try to extract server name from the error text if the caller didn't supply one
    let name = serverName;
    if (!name) {
        const fromMsg = raw.match(/(?:Authentication required for|for server|server_name[":\s]*"?)([A-Za-z0-9_.-]+)/i);
        if (fromMsg)
            name = fromMsg[1];
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
let client = null;
function getClient() {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error('No ANTHROPIC_API_KEY set');
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
const _bootstrappedConversations = new Set();
const _pendingDisambiguations = new Map();
const _lastMemoryUsed = new Map();
/** Track active skill per conversation — prevents menu replies from being re-routed through BrainLoader */
const _activeSkill = new Map();
/**
 * #7 Item 2 (chat-side) — parse a loaded skill's ENFORCED tool policy from its
 * `format_skill_output` header (`Allowed Tools:` / `Disallowed Tools:` lines that
 * `skills_executor.rs` emits). Only the header (before `## Skill Instructions:`) is
 * scanned so body prose can't false-match. Empty = unrestricted.
 */
export function parseSkillToolPolicy(skillContent) {
    const header = skillContent.split('## Skill Instructions:')[0] || skillContent;
    const grab = (label) => {
        const m = header.match(new RegExp('^' + label + ':\\s*(.+)$', 'mi'));
        return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    };
    return { allowed: grab('Allowed Tools'), disallowed: grab('Disallowed Tools') };
}
/** The active skill's tool policy for a conversation, or undefined if none/empty.
 *  Lazily parsed + memoized on the `_activeSkill` entry (skillContent is stable). */
function activeToolPolicyFor(conversationId) {
    const sk = _activeSkill.get(conversationId);
    if (!sk)
        return undefined;
    if (sk._policy === undefined) {
        const p = parseSkillToolPolicy(sk.skillContent);
        sk._policy = p.allowed.length || p.disallowed.length ? p : null;
    }
    return sk._policy ?? undefined;
}
/** Sticky Vodou context — stores last BrainLoader result per conversation so follow-ups don't lose context */
const _lastOiContext = new Map();
/** Cached system prompt per conversation — stable across turns for prompt caching */
const _cachedSystemPrompts = new Map();
/**
 * Append the scope-specific suffix + per-scope workbench instructions to a
 * fully-built system prompt. No-op for unscoped (`scope == null`).
 * Lives here so every provider helper (SDK, CLI, OpenAI-compat) can apply
 * it uniformly without duplicating the logic. Cost per call: one short
 * string build + one SQLite getSetting() read.
 */
function maybeAppendScopeBlock(prompt, scope) {
    if (!scope)
        return prompt;
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
function buildAutomationContextBlock(automationId) {
    try {
        const id = Number(automationId);
        if (!Number.isFinite(id))
            return '';
        const db = getDb();
        const row = db
            .prepare(`SELECT id, name, description, trigger_json, actions_json, notify_json,
                enabled, interval_minutes, last_run_at, next_run_at, run_count,
                last_error
           FROM automations WHERE id = ?`)
            .get(id);
        if (!row)
            return '\n\n## Automation\n(not found — may have been deleted)';
        const trigger = safeParse(row.trigger_json);
        const actions = safeParse(row.actions_json);
        const notify = row.notify_json ? safeParse(row.notify_json) : null;
        const runs = db
            .prepare(`SELECT started_at, events_matched, success, error
           FROM automation_runs
          WHERE automation_id = ?
       ORDER BY started_at DESC
          LIMIT 5`)
            .all(id);
        let block = `\n\n## Automation: ${row.name}\n`;
        if (row.description)
            block += `${row.description}\n`;
        block += `\n- **Enabled:** ${row.enabled ? 'yes' : 'no'}\n`;
        block += `- **Interval:** every ${row.interval_minutes ?? 15} min\n`;
        block += `- **Run count:** ${row.run_count ?? 0}\n`;
        if (row.last_run_at)
            block += `- **Last run:** ${row.last_run_at}\n`;
        if (row.next_run_at)
            block += `- **Next run:** ${row.next_run_at}\n`;
        if (row.last_error)
            block += `- **Last error:** ${row.last_error}\n`;
        if (trigger && typeof trigger === 'object') {
            const t = trigger;
            block += `\n**Trigger:** \`${t.integration || '?'}.${t.tool || '?'}\``;
            if (t.args && typeof t.args === 'object' && Object.keys(t.args).length > 0) {
                block += `\n\`\`\`json\n${JSON.stringify(t.args, null, 2)}\n\`\`\``;
            }
            block += '\n';
        }
        if (Array.isArray(actions) && actions.length > 0) {
            block += `\n**Actions (${actions.length}):**\n`;
            for (let i = 0; i < actions.length; i++) {
                const a = actions[i];
                block += `${i + 1}. \`${a.integration || '?'}.${a.tool || '?'}\`\n`;
            }
        }
        else {
            block += `\n**Actions:** none (notify-only)\n`;
        }
        if (notify && typeof notify === 'object') {
            const n = notify;
            if (n.url)
                block += `\n**Notify:** ${n.url.substring(0, 80)}${n.url.length > 80 ? '…' : ''}\n`;
        }
        if (runs.length > 0) {
            block += `\n**Recent runs:**\n`;
            for (const r of runs) {
                const status = r.success ? '✓' : '✗';
                const errSuffix = r.error ? ` — ${r.error.substring(0, 120)}` : '';
                block += `- ${status} ${r.started_at} · ${r.events_matched || 0} event(s)${errSuffix}\n`;
            }
        }
        else {
            block += `\n**Recent runs:** none yet\n`;
        }
        return block;
    }
    catch (err) {
        return `\n\n## Automation\n(failed to load context: ${err.message})`;
    }
}
function safeParse(s) {
    if (!s)
        return null;
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
const SYSTEM_PROMPT_CACHE_MS = 300_000; // 5 min
/** Track files modified during a conversation (for context injection) */
const _fileChanges = new Map();
function detectFileChanges(toolName, toolArgs, _toolResult) {
    const files = [];
    const name = (toolName || '').toLowerCase();
    // Direct file operations from tool name
    if (/write|edit|mv|cp|rm|mkdir|touch/i.test(name)) {
        if (toolArgs?.file_path)
            files.push(toolArgs.file_path);
        if (toolArgs?.path)
            files.push(toolArgs.path);
    }
    // Bash commands with redirection or file-modifying commands
    if (name === 'bash' && toolArgs?.command) {
        const cmd = toolArgs.command;
        // Detect redirections: >, >>
        const redirectMatches = cmd.matchAll(/[^>]>>?\s*["']?([^\s"'|;&]+)/g);
        for (const m of redirectMatches) {
            if (m[1] && !m[1].startsWith('-'))
                files.push(m[1]);
        }
        // Detect common file-modifying commands (take last non-flag arg)
        if (/\b(sed\s+-i|mv|cp|rm|mkdir|touch|chmod|chown)\b/.test(cmd)) {
            const parts = cmd.split(/\s+/);
            const lastArg = parts[parts.length - 1];
            if (lastArg && !lastArg.startsWith('-') && !lastArg.startsWith('|'))
                files.push(lastArg);
        }
    }
    return files;
}
function addFileChanges(conversationId, files) {
    if (!_fileChanges.has(conversationId))
        _fileChanges.set(conversationId, new Set());
    const set = _fileChanges.get(conversationId);
    for (const f of files)
        set.add(f);
}
export function getFileChangeSummary(conversationId) {
    const files = _fileChanges.get(conversationId);
    if (!files || files.size === 0)
        return '';
    return `\n<files_modified_this_session>\n${[...files].join('\n')}\n</files_modified_this_session>\n`;
}
/** Get the memories used in the last response for a conversation */
export function getLastMemoryUsed(conversationId) {
    return _lastMemoryUsed.get(conversationId) || [];
}
/** Get total memory count from memory.db via better-sqlite3 (no shell exec) */
let _memoryCountCache = { count: 0, expires: 0 };
export function getTotalMemoryCount() {
    const now = Date.now();
    if (_memoryCountCache.expires > now)
        return _memoryCountCache.count;
    try {
        const memDb = getMemoryDb();
        if (!memDb)
            return 0;
        const row = memDb.prepare('SELECT count(*) as cnt FROM memory_chunks').get();
        const count = row?.cnt ?? 0;
        _memoryCountCache = { count, expires: now + 60_000 }; // Cache 60s
        return count;
    }
    catch {
        return 0;
    }
}
// --- Heartbeat tracking ---
const _heartbeatConversations = new Set();
const _conversationMaxTokens = new Map();
const _conversationMaxToolIterations = new Map();
export function markHeartbeatConversation(conversationId) {
    _heartbeatConversations.add(conversationId);
    _suppressTranscript = true; // F4: Don't save heartbeat turns to memory transcript
}
// F4: When true, skip transcript saving for current turn (reset after chat completes)
let _suppressTranscript = false;
export function setConversationMaxTokens(conversationId, maxTokens) {
    _conversationMaxTokens.set(conversationId, maxTokens);
}
export function setConversationMaxToolIterations(conversationId, maxIterations) {
    _conversationMaxToolIterations.set(conversationId, maxIterations);
}
/**
 * Abort the in-flight CLI turn for a conversation (e.g. when HTTP client disconnects).
 * No-op if no turn is pending.
 */
export function abortConversationCliTurn(conversationId) {
    const session = _cliSessions.get(conversationId);
    if (!session?.pending)
        return;
    console.error(`[CLI pool] aborting turn for ${conversationId.substring(0, 8)} (client disconnected)`);
    const { pending } = session;
    if (pending.timeout)
        clearTimeout(pending.timeout);
    session.pending = null;
    pending.onEvent({ type: 'error', error: 'HTTP client disconnected before response completed' });
    pending.reject(new Error('HTTP client disconnected'));
    _cliSessions.delete(conversationId);
    session.poolKillReason = 'abort';
    killCliSession(session);
}
const _convAborts = new Map();
// B2 follow-up (stop-before-begin race): a Stop that lands during the
// pre-provider window (BrainLoader routing / tool exec, before beginConvAbort
// has registered a ConvAbort) has nothing to mark, so it was silently lost and
// the turn streamed + billed. We remember the conversationId here; beginConvAbort
// honors it by starting the entry pre-aborted. FOOTGUN: a stale idle-Stop must
// not kill a *later* turn, so clearPendingAbort() is called at the start of every
// new user turn (chat()/chatWithSkill() entry) to discard any unconsumed mark.
const _pendingAborts = new Set();
/**
 * B2 follow-up: discard any pending (pre-provider-window) abort mark for this
 * conversation. MUST be called synchronously at the top of every new-user-turn
 * entry point so an idle Stop from a prior turn can't pre-abort the next one.
 */
function clearPendingAbort(conversationId) {
    _pendingAborts.delete(conversationId);
}
function beginConvAbort(conversationId) {
    // Replace any stale entry from a prior turn on the same conversation.
    const entry = { controller: new AbortController(), aborted: false };
    // B2 follow-up (stop-before-begin race): honor a Stop that arrived before the
    // provider call registered. Start the entry already-aborted + cancel its
    // controller so the very first stream/fetch short-circuits. Consume the mark
    // so it can't leak into a later turn.
    if (_pendingAborts.delete(conversationId)) {
        entry.aborted = true;
        try {
            entry.controller.abort();
        }
        catch { }
    }
    _convAborts.set(conversationId, entry);
    return entry;
}
function endConvAbort(conversationId, entry) {
    // Only clear if it's still the same entry (a newer turn may have replaced it).
    if (!entry || _convAborts.get(conversationId) === entry) {
        _convAborts.delete(conversationId);
    }
}
/** True once Stop has been requested for this conversation's current turn. */
export function isConversationAborted(conversationId) {
    return _convAborts.get(conversationId)?.aborted === true;
}
/**
 * B2: Cancel the in-flight provider call for a conversation. Aborts the fetch
 * signal (OpenAI-compat), the SDK stream controller, and any one-shot child
 * process, then tears down the pooled CLI turn. Safe to call when nothing is
 * in flight.
 */
export function abortConversationTurn(conversationId) {
    const entry = _convAborts.get(conversationId);
    if (entry) {
        entry.aborted = true;
        try {
            entry.controller.abort();
        }
        catch { }
        try {
            entry.sdkStream?.controller.abort();
        }
        catch { }
        try {
            entry.child?.kill('SIGTERM');
        }
        catch { }
    }
    else {
        // B2 follow-up (stop-before-begin race): no provider call has registered yet
        // (the turn is still in the pre-provider window — BrainLoader routing / tool
        // exec). Remember the Stop so beginConvAbort starts the imminent entry
        // pre-aborted. Cleared at the next new-user-turn entry so it can't leak.
        _pendingAborts.add(conversationId);
    }
    // Pooled CLI turn lives in its own structure — reuse the existing killer.
    abortConversationCliTurn(conversationId);
}
/** Get max tokens for a conversation — uses per-conversation override if set, otherwise global MAX_TOKENS */
function getMaxTokens(conversationId) {
    if (conversationId) {
        const override = _conversationMaxTokens.get(conversationId);
        if (override)
            return override;
        const prof = getCostProfile(conversationId); // COGS Governor (explicit override above still wins)
        if (prof)
            return prof.maxTokens;
    }
    return MAX_TOKENS;
}
/** Get max tool iterations for a conversation — uses per-conversation override if set, otherwise global MAX_TOOL_ITERATIONS */
function getMaxToolIterations(conversationId) {
    if (conversationId) {
        const override = _conversationMaxToolIterations.get(conversationId);
        if (override)
            return override;
        const prof = getCostProfile(conversationId); // COGS Governor (explicit override above still wins)
        if (prof)
            return prof.maxToolIterations; // governor already folded agent-mode into its base
        // PLAN-AGENT-LOOP Phase 1: governor OFF but agent mode on → raise the ceiling.
        if (agentModeFor(conversationId))
            return agentModeMaxIters();
    }
    return MAX_TOOL_ITERATIONS;
}
function getWorkspaceBootstrap() {
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
    }
    catch (err) {
        console.error(`[Bootstrap] context cache not available: ${err.message}`);
    }
    return _workspaceBootstrap;
}
/** Bundle 1.5 — scope.raw for daemon memory hook (prefers ChatOptions.scope, then conv id, then DB source). */
function memoryHookScopeRaw(conversationId, optionsScope) {
    if (optionsScope?.raw)
        return optionsScope.raw;
    if (!conversationId)
        return undefined;
    // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W1b) — BYOK capture scope. `byok:<app>:`
    // conversation ids resolve to `capture:byok:<app>` (mirrors Rust
    // gateway_extractor::derive_scope). Forwarding this to the daemon's prompt
    // buffer means the buffered-prompt flush and the gateway extractor stamp the
    // SAME scope, so the two bullets dedup to ONE capture-scoped copy instead of
    // colliding into an unscoped `web` one. Scoped here (not resolveScope) to
    // keep the capture tier out of the system-prompt/suffix scope machinery.
    if (conversationId.startsWith('byok:')) {
        const app = conversationId.split(':')[1]?.replace(/[^a-z0-9_-]/gi, '') || 'unknown';
        return `capture:byok:${app.toLowerCase()}`;
    }
    const fromId = resolveScope(conversationId);
    if (fromId?.raw)
        return fromId.raw;
    const row = getConversation(conversationId);
    return resolveScope(row?.source)?.raw;
}
/** Channel workbench only — threads into worker `brain` + `VODOU_BRAIN_MEMORY_ACTIVE_SCOPE` for CLI fallback. */
function channelScopeRawForBrainLoader(conversationId, optionsScope) {
    const raw = memoryHookScopeRaw(conversationId, optionsScope);
    return raw?.startsWith('workbench:channel:') ? raw : undefined;
}
// --- Gateway periodic memory flush ---
// Flush every N messages so daily logs get written even when Claude Code is active
let _gatewayMsgCount = 0;
const FLUSH_EVERY_N = parseInt(process.env.VODOU_FLUSH_EVERY_N_PROMPTS || '15', 10) || 15;
function maybeFlushMemory() {
    _gatewayMsgCount++;
    if (_gatewayMsgCount >= FLUSH_EVERY_N) {
        _gatewayMsgCount = 0;
        triggerMemoryFlush();
    }
}
// --- Memory injection via daemon socket ---
export function getMemoryContext(prompt, conversationId) {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    // V2-C gateway: include recent conversation turns as context for the daemon's
    // memory search. This is the gateway equivalent of file-context boosting —
    // when the user says "tell me more about that", the daemon sees the last few
    // turns and can boost memories related to the recent topic.
    const messages = [];
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
        }
        catch { /* conversation manager may not have this convo yet */ }
    }
    const hookJson = { prompt };
    if (messages.length > 0) {
        hookJson.messages = messages;
    }
    // Phase B + Bundle 1.5: forward active scope (conversation id or gateway row source).
    if (conversationId) {
        try {
            const raw = memoryHookScopeRaw(conversationId);
            if (raw)
                hookJson.scope = raw;
        }
        catch { /* fall back to unscoped */ }
    }
    // PLAN-PROJECT-SCOPED-MEMORY — forward the turn's project so the daemon
    // (a) buffers the prompt with it for extraction-time `project:` tagging and
    // (b) hard-filters other projects' chunks out of this turn's recall.
    const activeProjectId = projectContextProjectId();
    if (activeProjectId)
        hookJson.project = activeProjectId;
    // PLAN-CONTEXT-GROUND-TRUTH Opt 1 — name + root give the daemon's search
    // query the tokens project chunks actually contain, so short prompts
    // ("what dir") rank the right project chunk first. Search-side only.
    const activeProjectName = projectContextProjectName();
    if (activeProjectName)
        hookJson.project_name = activeProjectName;
    const activeProjectRoot = projectContextRoot();
    if (activeProjectRoot)
        hookJson.project_root = activeProjectRoot;
    const request = JSON.stringify({
        cmd: 'prompt',
        payload: { hook_json: JSON.stringify(hookJson) }
    }) + '\n';
    // One socket attempt. countDegraded gates the reliability counters so a
    // retried-and-recovered turn doesn't double-count as two failures.
    const attemptFetch = (countDegraded) => new Promise((resolve) => {
        const client = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
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
            }
            catch {
                resolve('');
            }
        });
        client.on('error', (err) => {
            // Connect refusals/EAGAIN are degradation too — count them, don't just
            // swallow into an empty context block.
            if (countDegraded) {
                _memoryReliability.memoryContextErrors++;
                _memoryReliability.lastDegradedAt = new Date().toISOString();
            }
            console.warn(`[Memory] daemon socket error for query "${prompt.substring(0, 50)}": ${err.code || err.message}`);
            resolve(gatewayDegradedMarker(`daemon-error:${err.code || 'unknown'}`));
        });
        client.on('timeout', () => {
            if (countDegraded) {
                _memoryReliability.memoryContextTimeouts++;
                _memoryReliability.lastDegradedAt = new Date().toISOString();
            }
            console.warn(`[Memory] Search timed out after 3000ms for query: "${prompt.substring(0, 50)}"`);
            client.destroy();
            resolve(gatewayDegradedMarker('timeout'));
        });
    });
    // Eval wave-1 finding F2 (VERIFY-MEMORY-TEST-HARNESS.md): the recipe marker
    // reached the model and it STILL answered "no record". Infrastructure-level
    // recovery beats model cooperation: the daemon provably recovers within
    // seconds, so retry the fetch once after 1.5s before burdening the model.
    // The marker (with recipe) remains the fallback when both attempts fail.
    return attemptFetch(false).then((first) => {
        if (!first.startsWith('### Vodou Memory: DEGRADED'))
            return first;
        return new Promise((r) => setTimeout(r, 1500)).then(() => attemptFetch(true).then((second) => {
            if (!second.startsWith('### Vodou Memory: DEGRADED')) {
                _memoryReliability.memoryContextRetrySuccesses++;
                console.warn('[Memory] first fetch degraded; 1.5s retry recovered — memories injected normally');
            }
            return second;
        }));
    });
}
/**
 * PLAN-OPERATOR-SURFACE P1-a (gateway lane) — an empty context block on a failed
 * memory fetch is indistinguishable from "no relevant memories exist"; that
 * ambiguity is how blackouts hide (same lesson as the hook lane's EAGAIN
 * blackout). Inject an honest marker WITH the recovery recipe so the model
 * re-queries instead of asserting "no record". Mirrors vodou-hook's marker.
 */
function gatewayDegradedMarker(reason) {
    return `### Vodou Memory: DEGRADED (reason: ${reason})
The memory daemon did not answer this turn, so NO memories were injected. This is NOT the same as "no relevant memories exist" — saved context may be missing.
RECOVER FIRST: if this turn may depend on saved context, re-query memory yourself NOW — call Vodou-Recall search_memory via vodou_core_call with {"query":"<topic>"} (Bash lane: \`./vodou-core mem search "<topic>" --json\`). The daemon often recovers within seconds.
Only if the re-query also fails: tell the user memory was degraded rather than asserting you have no record of something.`;
}
/**
 * PLAN-MEMORY-VISIBILITY-UI Phase B.2 — stash for the structured `memory_recall_debug`
 * payload returned by the daemon's `cmd:'prompt'`. Per-conversation; consumed when
 * the gateway emits the `done` event.
 */
const _lastMemoryDebug = new Map();
export function getLastMemoryDebug(conversationId) {
    return _lastMemoryDebug.get(conversationId) || null;
}
/**
 * Parse daemon `additional_context` (lines like `- [path] snippet`) and store for the
 * WebSocket `done.memory` payload / chat footer. Must run for every turn that injects
 * memory — not only the main chat() path (workflows and skill replies also prefetch).
 */
function recordMemoriesInjected(conversationId, memoryContext) {
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
function getTranscriptPath() {
    return path.join(getProjectRoot(), '.vodou', 'workspace', '.gateway_transcript.jsonl');
}
/**
 * Append a message to the gateway transcript file in JSONL format
 * compatible with parse_transcript_lines in memory_flush.rs.
 */
function appendToTranscript(role, content) {
    const trimmed = content.trim();
    if (!trimmed || trimmed.length < 20)
        return;
    const transcriptPath = getTranscriptPath();
    try {
        mkdirSync(path.dirname(transcriptPath), { recursive: true });
        const entry = JSON.stringify({ type: role, content: trimmed });
        appendFileSync(transcriptPath, entry + '\n');
        console.error(`[Memory] saved ${role} message (${trimmed.length} chars) to gateway transcript`);
    }
    catch (err) {
        console.error(`[Memory] failed to save ${role} message: ${err.message}`);
    }
}
/**
 * Save user message to transcript. Called when we receive a user prompt.
 */
function saveUserToTranscript(message) {
    appendToTranscript('user', message);
}
/**
 * Save assistant response to transcript and maybe trigger a flush.
 */
function saveAssistantToBuffer(response) {
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
function triggerMemoryFlush() {
    const root = getProjectRoot();
    // Binary carries a .exe suffix on Windows. Without it spawn() throws ENOENT
    // asynchronously (an 'error' event, NOT caught by the surrounding try/catch),
    // which would take down the gateway.
    const hookBin = path.join(root, process.platform === 'win32' ? 'vodou-hook-bin.exe' : 'vodou-hook-bin');
    const transcriptPath = getTranscriptPath();
    // Ensure daemon is running before attempting flush
    try {
        const ensureProc = spawn(hookBin, ['ensure'], { cwd: root, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
        ensureProc.on('error', () => { }); // never let a missing binary crash the process
        ensureProc.unref();
    }
    catch { }
    // Pass transcript_path so daemon uses flush_with_transcript (full filtering pipeline)
    const hookJson = JSON.stringify({ transcript_path: transcriptPath });
    try {
        const proc = spawn(hookBin, ['sock', 'flush'], {
            windowsHide: true, // claude/kimi/hook are console apps — detached:true would allocate a visible console on Windows
            cwd: root,
            stdio: ['pipe', 'ignore', 'ignore'],
            env: { ...process.env },
        });
        proc.on('error', (e) => console.error(`[Memory] flush spawn failed: ${e.message}`));
        proc.stdin?.write(hookJson);
        proc.stdin?.end();
        proc.on('close', (code) => {
            if (code === 0) {
                console.error('[Memory] flush triggered via vodou-hook-bin sock flush (transcript mode)');
                // Clear transcript after successful flush — daemon has consumed it
                try {
                    writeFileSync(transcriptPath, '', 'utf-8');
                }
                catch { }
            }
            else {
                console.error(`[Memory] vodou-hook-bin flush exited with code ${code}`);
            }
        });
        proc.on('error', (err) => {
            console.error(`[Memory] vodou-hook-bin flush error: ${err.message}`);
        });
        proc.unref();
    }
    catch (err) {
        console.error(`[Memory] flush spawn error: ${err.message}`);
    }
}
// --- BrainLoader execution ---
/**
 * Run user's query through the BrainLoader.
 * Worker socket only. Cap at 8s so a slow/cold pipeline can't make the user
 * wait — on timeout we return empty and the chat proceeds with no injected
 * context (memory context comes through a separate getMemoryContext path).
 *
 * History: this used to fall back to a `vodou-core brain` CLI spawn with its
 * own 60s timeout, which is how a single message could block for 72s. The
 * worker has full BrainLoader functionality, so the CLI fallback was just
 * doubling the worst-case wait. Removed.
 */
async function runBrainLoader(query, memoryActiveScope) {
    const t0 = Date.now();
    console.error(`[BrainLoader] "${query.substring(0, 80)}..."`);
    const sockArgs = { query, clean: false };
    if (memoryActiveScope)
        sockArgs.memory_active_scope = memoryActiveScope;
    // PLAN-PROJECT-SCOPED-MEMORY — worker BrainLoader memory prefetch filters to
    // the turn's project (read from the async-local project context).
    const brainProjectId = projectContextProjectId();
    if (brainProjectId)
        sockArgs.memory_active_project = brainProjectId;
    // Timeout is env-tunable: a COLD worker's first brain call loads embedding models and
    // can exceed 8s, which silently skips intent routing + memory recall. The embedded CLI
    // raises this (VODOU_BRAINLOADER_TIMEOUT_MS) so the first turn still gets the full
    // pipeline; the gateway keeps the snappy 8s default (its worker is already warm).
    const brainTimeout = parseInt(process.env.VODOU_BRAINLOADER_TIMEOUT_MS || '8000', 10) || 8000;
    const sockResult = await callWorkerSocket('brain', sockArgs, brainTimeout);
    const elapsed = Date.now() - t0;
    if (sockResult === null) {
        // DEGRADED, not "no match": the pipeline never answered. Callers must
        // surface this to the user and the /health counters — a timeout rendered
        // as "no match" is silent amnesia (2026-07-16 incident: 29 turns ran
        // memory-blind and looked like empty recall).
        _memoryReliability.brainTimeouts++;
        _memoryReliability.lastDegradedAt = new Date().toISOString();
        console.error(`[BrainLoader] socket unavailable/timeout after ${elapsed}ms — proceeding without context (degraded=timeout)`);
        return { matched: false, output: '', degraded: 'timeout' };
    }
    if (!sockResult.ok) {
        _memoryReliability.brainSocketErrors++;
        _memoryReliability.lastDegradedAt = new Date().toISOString();
        console.error(`[BrainLoader] socket error after ${elapsed}ms (code=${sockResult.code}) — proceeding without context (degraded=socket_error)`);
        return { matched: false, output: '', degraded: 'socket_error' };
    }
    const output = (sockResult.stdout || '').trim();
    if (!output) {
        console.error(`[BrainLoader] no intent matched in ${elapsed}ms`);
        return { matched: false, output: '', degraded: null };
    }
    console.error(`[BrainLoader] matched via socket in ${elapsed}ms, ${output.length} chars`);
    return { matched: true, output, degraded: null };
}
/**
 * Memory-injection reliability counters (PLAN-MEMORY-INJECTION-RELIABILITY P0-C).
 * A degraded turn = the brain/memory pipeline failed to answer inside its
 * budget, so the turn ran without injected context. Surfaced at /health so
 * operators can distinguish "no relevant memories" from "memory layer down".
 */
const _memoryReliability = {
    brainTimeouts: 0,
    brainSocketErrors: 0,
    memoryContextTimeouts: 0,
    memoryContextErrors: 0,
    // Turns where the first fetch degraded but the 1.5s retry recovered — the
    // infrastructure-level recovery working (eval wave-1 F2 fix).
    memoryContextRetrySuccesses: 0,
    lastDegradedAt: null,
};
export function getMemoryReliabilityStats() {
    return { ..._memoryReliability };
}
/** Conversations with a background brain re-warm in flight (P0-D). */
const _brainRewarmInflight = new Set();
// runBrainLoaderCLI removed — worker socket handles all BrainLoader calls.
// The CLI spawn fallback existed before the worker; it added a second 60s
// timeout window and was the source of the 72s "Loading context..." waits.
// If the worker is unhealthy the watchdog (worker::ensure 30s tick in
// src/daemon.rs) recycles it; in the meantime callers proceed without
// injected context rather than waiting on a stale subprocess.
/**
 * Check if VODOU_SHOW_RAW_RESULTS=1 in .env (re-reads from disk, no restart needed).
 */
function showRawOIResults() {
    try {
        const envPath = path.resolve(getProjectRoot(), '.env');
        const lines = readFileSync(envPath, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#'))
                continue;
            if (trimmed.startsWith('VODOU_SHOW_RAW_RESULTS=')) {
                return trimmed.split('=')[1]?.trim() === '1';
            }
        }
    }
    catch { }
    return false;
}
/**
 * Quick synchronous check: does this message contain (or is contained by) any intent keyword?
 * Used to override isFollowUp so short intent queries like "cpu memory disk" always hit BrainLoader.
 */
function messageMatchesIntent(message) {
    try {
        const db = getDb();
        const lower = message.trim().toLowerCase();
        // Same LIKE logic as brain_loader.rs analyze_query_intent
        const rows = db.prepare("SELECT keyword FROM intent_mappings WHERE ? LIKE '%' || keyword || '%' OR keyword LIKE '%' || ? || '%' LIMIT 1").all(lower, lower);
        return rows.length > 0;
    }
    catch {
        return false; // DB unavailable — don't override, let existing logic decide
    }
}
/**
 * Detect if a message is conversational (no tool needed) vs actionable (needs BrainLoader).
 * Simple heuristic — most messages go through BrainLoader, pure chat doesn't.
 */
function isConversationalOnly(message) {
    const lower = message.trim().toLowerCase();
    // Pure greetings and small talk. The leading-greeting patterns now allow
    // a short tail ("hello world", "hi there", "hey y'all") so common
    // conversational openers bypass BrainLoader instead of accidentally
    // matching skill-trigger keywords like `hello world → hello-skill`.
    // Tail is capped at 3 words so we don't swallow real questions like
    // "hello, what is the cpu doing right now and how much memory…".
    const greetingTail = /(?:\s+[a-z0-9'!?.,-]{1,20}){0,3}[\s!?.]*$/;
    const chatPatterns = [
        new RegExp('^(hi|hey|hello|sup|yo|howdy|good morning|good evening|gm|what\'?s up)' + greetingTail.source),
        /^(thanks|thank you|thx|ty|cool|nice|ok|okay|got it|understood|perfect|great)[\s!?.]*$/,
        new RegExp('^(bye|goodbye|see ya|later|gn|good night)' + greetingTail.source),
        // Short numeric/menu replies — stopping-point selections (1, 2, 3, etc.)
        /^\d{1,2}$/,
        // "all" or "yes"/"no" — common skill replies
        /^(all|yes|no|y|n)[\s!?.]*$/,
    ];
    return chatPatterns.some(p => p.test(lower));
}
function isNoIntentFoundOutput(output) {
    const t = (output || '').toLowerCase();
    return (t.includes('no intent found') ||
        t.includes('no matching intent') ||
        t.includes('could not find intent'));
}
function shouldBypassNoIntentToDirectLLM() {
    return currentProvider !== 'claude-cli' && currentProvider !== 'kimi-cli';
}
// PLAN-SKILLS-V2 §6 B4-remainder: dynamic ${VODOU_*} substitution.
// The Rust loader (src/skills_executor.rs::preprocess_skill_content) resolves the static
// vars (VODOU_SKILL_DIR, VODOU_PROJECT_ROOT, VODOU_USER) but leaves session-scoped ones for
// the gateway, which has the conversation context. No-op when the input has no placeholders.
function substituteVodouDynamicVars(text, conversationId, scope) {
    if (!text.includes('${VODOU_'))
        return text;
    return text
        .replace(/\$\{VODOU_SESSION_ID\}/g, conversationId)
        .replace(/\$\{VODOU_SCOPE\}/g, scope?.raw ?? 'default');
}
function buildUserPromptWithOIResults(message, oiResults) {
    if (!oiResults)
        return message;
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
export function isConfigured() {
    return currentProvider !== 'none';
}
export function getAuthType() {
    return currentProvider;
}
export async function chat(conversationId, message, onEvent, options) {
    const turnId = options?.turnId?.trim() || '';
    const lensesEnabled = resolveLensesEnabled(conversationId, options?.lensesEnabled);
    const chatOpts = { ...options, lensesEnabled };
    // PLAN-GATEWAY-PROJECTS — bind this turn's project context (root + directive) to the
    // async branch so getSystemPrompt() (directive), agentCwd() (claude-cli spawn cwd), and
    // unsandboxedBase() (fs-tool relative root) all read it without threading a param through
    // every provider dispatch. Concurrency-safe across interleaved turns. Phase 2 adds `root`.
    enterProjectContext({
        root: options?.projectRoot ?? undefined,
        directive: buildProjectDirective(options?.projectName, options?.projectInstructions, options?.projectRoot),
        // PLAN-PROJECT-SCOPED-MEMORY — proj_default = the install-root "Default"
        // home; its memories stay global (project_id NULL) so behavior matches
        // pre-project installs exactly.
        projectId: options?.projectId && options.projectId !== 'proj_default'
            ? options.projectId
            : undefined,
        // PLAN-CONTEXT-GROUND-TRUTH — name rides to the daemon prompt hook (Opt 1
        // project-aware retrieval) + the per-turn ground-truth facts block.
        projectName: options?.projectId && options.projectId !== 'proj_default'
            ? options?.projectName ?? undefined
            : undefined,
    });
    // [DIAG] Log every chat() invocation so we can spot duplicate/recursive calls
    console.error(`[Gateway DIAG] chat() ENTRY turnId=${turnId || '(none)'} convId=${conversationId} lenses=${lensesEnabled} msg_len=${message.length} preview=${JSON.stringify(message.substring(0, 60))}`);
    // B2 follow-up (stop-before-begin race): a new user turn has begun. Discard any
    // stale pending-abort mark from a prior idle Stop BEFORE any await, so it can't
    // pre-abort this turn. (A Stop arriving *after* this point, during the
    // pre-provider window, is correctly applied to the new turn by beginConvAbort.)
    clearPendingAbort(conversationId);
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
        }
        catch {
            return null;
        }
    })();
    const _phase0Counters = phase0.makeCounters();
    const _phase0Stage = {
        daemon_intent_matched: false,
        daemon_intent_keyword: null,
        daemon_intent_confidence: null,
        daemon_auto_routed: false,
        brainloader_fired: false,
        brainloader_skill: null,
    };
    let _phase0Finalized = false;
    const _phase0Finalize = () => {
        if (_phase0Finalized)
            return;
        _phase0Finalized = true;
        try {
            phase0.finalize({
                begin: _phase0Begin,
                startMs: _phase0Start,
                counters: _phase0Counters,
                ..._phase0Stage,
            });
        }
        catch { /* never break the chat path */ }
    };
    // Wrap the original onEvent to side-track stream events into counters.
    // Also fires finalize() on `done` and `error` so all return paths are covered.
    const _origOnEvent = onEvent;
    onEvent = phase0.instrumentCallback(_phase0Start, _phase0Counters, (e) => {
        if (e.type === 'done' || e.type === 'error')
            _phase0Finalize();
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
                    detached: process.platform !== 'win32', // win32: DETACHED voids windowsHide
                    windowsHide: true,
                }).unref();
                console.error(`[Feedback] Stored: "${pending.query}" → ${selected.server}::${selected.tool}`);
            }
            catch { }
        }
        _pendingDisambiguations.delete(conversationId);
    }
    // Step 0d: Heartbeat — skip BrainLoader, inject memory, dispatch directly to LLM
    if (_heartbeatConversations.has(conversationId) || message.startsWith('[Heartbeat')) {
        const memoryContext = await getMemoryContext(message, conversationId);
        recordMemoriesInjected(conversationId, memoryContext);
        console.error(`[Heartbeat] Dispatching heartbeat to provider (skip BrainLoader)`);
        console.error(`[Gateway DIAG] dispatchToProvider site=heartbeat convId=${conversationId}`);
        return dispatchToProvider(conversationId, message, onEvent, memoryContext, '', '', chatOpts.channelAttachments, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
    }
    // Step 0b: Check if this is a workflow follow-up (AGENT_ACTIONS — engine-enforced)
    // This MUST come before the active skill check — workflows have deterministic execution
    // CRITICAL: Engine-handled messages must return BEFORE the LLM sees them
    if (hasActiveWorkflow(conversationId)) {
        const wfPre = getActiveWorkflow(conversationId);
        if (wfPre?.workflowOrigin === 'skill_console' &&
            wfPre.initialSteps?.length &&
            !wfPre.initialStepsRan) {
            console.error(`[Workflow] skill_console: running ${wfPre.initialSteps.length} initial step(s) before choice`);
            wfPre.initialStepsRan = true;
            const ir = await executeInitialSteps(wfPre, onEvent, conversationId);
            if (ir.trim()) {
                onEvent({ type: 'text', content: ir + '\n\n' });
            }
        }
        const workflowResult = await handleWorkflowChoice(conversationId, message, onEvent);
        if (workflowResult) {
            if (workflowResult.startsWith('__MENU_ONLY__')) {
                // Menu-only: stream directly, don't touch conversation history, don't call LLM
                const menuContent = workflowResult.replace('__MENU_ONLY__', '').trim();
                const wfMenu = getActiveWorkflow(conversationId);
                const isRetry = menuContent.includes('That did not match') || menuContent.includes('numbered option');
                const intro = wfMenu?.workflowOrigin === 'skill_console' && !isRetry
                    ? '*Guided step for this skill:* pick one of the numbered options below (or type `/menu` anytime).\n\n'
                    : '';
                onEvent({ type: 'text', content: intro + menuContent });
                onEvent({ type: 'done' });
                console.error(`[Workflow] Streaming menu directly (no LLM)`);
                return intro + menuContent;
            }
            if (workflowResult.startsWith('__RESULTS_AND_MENU__')) {
                // Tool results + next menu: format results via LLM, then stream menu directly.
                // Producer (workflow-driver) joins results and menu with a stable
                // '__MENU_FOLLOWS__' token so the split is whitespace-independent.
                const content = workflowResult.replace('__RESULTS_AND_MENU__', '');
                const MENU_TOKEN = '__MENU_FOLLOWS__';
                const menuSplit = content.indexOf(MENU_TOKEN);
                if (menuSplit >= 0) {
                    const toolResults = content.substring(0, menuSplit).trim();
                    const menuPart = content.substring(menuSplit + MENU_TOKEN.length).trim();
                    // Format tool results via LLM
                    const cleanResults = toolResults.replace(/<!--[\s\S]*?-->/g, '');
                    const memoryContext = await getMemoryContext(message, conversationId);
                    recordMemoriesInjected(conversationId, memoryContext);
                    console.error(`[Gateway DIAG] dispatchToProvider site=workflow_results_and_menu convId=${conversationId}`);
                    const formatted = await dispatchToProvider(conversationId, message, onEvent, memoryContext, cleanResults, '', undefined, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
                    // Stream the next menu directly after LLM response
                    onEvent({ type: 'text', content: '\n\n' + menuPart });
                    return formatted + '\n\n' + menuPart;
                }
                // Fallback: treat as results only
                const cleanResults = content.replace(/<!--[\s\S]*?-->/g, '');
                const memoryContext = await getMemoryContext(message, conversationId);
                recordMemoriesInjected(conversationId, memoryContext);
                console.error(`[Gateway DIAG] dispatchToProvider site=workflow_results_only_fallback convId=${conversationId}`);
                return dispatchToProvider(conversationId, message, onEvent, memoryContext, cleanResults, '', undefined, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
            }
            // Has tool results — give to LLM to format (but strip AGENT_ACTIONS from context)
            const cleanResults = workflowResult.replace(/<!--[\s\S]*?-->/g, '');
            const memoryContext = await getMemoryContext(message, conversationId);
            recordMemoriesInjected(conversationId, memoryContext);
            console.error(`[Gateway DIAG] dispatchToProvider site=workflow_has_results convId=${conversationId}`);
            return dispatchToProvider(conversationId, message, onEvent, memoryContext, cleanResults, '', undefined, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
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
        }
        catch { }
    }
    // Step 0d: Check if this is a skill stopping point reply — skip BrainLoader
    // For skills WITHOUT AGENT_ACTIONS, number inputs go to the LLM with context
    const activeSkill = _activeSkill.get(conversationId);
    const isSkillReply = isMenuReplyCheck(message.trim());
    if (activeSkill && isSkillReply && !hasActiveWorkflow(conversationId)) {
        if (Date.now() - activeSkill.loadedAt < 1_800_000) { // 30 min TTL (sliding window)
            console.error(`[Skill] Routing "${message}" to active skill "${activeSkill.skillName}" (skipping BrainLoader)`);
            activeSkill.loadedAt = Date.now();
            try {
                saveSkillState(conversationId, activeSkill.skillName, activeSkill.skillContent, activeSkill.loadedAt);
            }
            catch { }
            const memoryContext = await getMemoryContext(message, conversationId);
            recordMemoriesInjected(conversationId, memoryContext);
            const skillPrompt = activeSkill.skillContent
                ? `You are continuing an active Vodou skill. Follow the skill instructions. Respect all stopping points.\n\n--- SKILL ---\n${activeSkill.skillContent}\n--- END SKILL ---`
                : '';
            console.error(`[Gateway DIAG] dispatchToProvider site=active_skill_reply convId=${conversationId} skill=${activeSkill.skillName}`);
            return dispatchToProvider(conversationId, message, onEvent, memoryContext, '', skillPrompt, undefined, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
        }
        else {
            _activeSkill.delete(conversationId);
            try {
                clearSkillState(conversationId);
            }
            catch { }
        }
    }
    // Clear active skill + stored context if user sends a non-trivial non-number message (they moved on)
    if (activeSkill && !isMenuReplyCheck(message.trim()) && message.trim().length > 3) {
        _activeSkill.delete(conversationId);
        _lastOiContext.delete(conversationId);
        try {
            clearSkillState(conversationId);
        }
        catch { }
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
    // P19: Suppress skill routing for long queries without /prefix.
    // Exception: queries that START with a known skill trigger phrase (e.g. "deep think about X")
    // should never be suppressed — they are explicit skill invocations regardless of length.
    const wordCount = message.trim().split(/\s+/).length;
    const lowerMsg = message.trim().toLowerCase();
    const SKILL_TRIGGER_PREFIXES = [
        'deep think', 'think deep', 'deep research', 'analyze deeply', 'comprehensive analysis',
    ];
    const startsWithSkillTrigger = SKILL_TRIGGER_PREFIXES.some(p => lowerMsg.startsWith(p));
    const suppressSkills = !explicitSkill && wordCount > 5 && !startsWithSkillTrigger;
    if (suppressSkills) {
        console.error(`[P19] Long query (${wordCount} words, no /prefix) — skills suppressed`);
    }
    else if (startsWithSkillTrigger) {
        console.error(`[P19] Skill trigger prefix detected — skills NOT suppressed despite ${wordCount} words`);
    }
    // Step 1+2: Run memory search + BrainLoader IN PARALLEL (saves ~1s)
    // Skip BrainLoader for short follow-up messages in active conversations.
    // Without this, "do it" or "yes" triggers a new BrainLoader query that returns
    // different/no results, making the LLM "forget" what it was working on.
    //
    // Scoped workbench (integration/skill/flow): BrainLoader + daemon memory are
    // redundant with SDK `vodou_core_call` + scope-filtered catalog — skipping
    // cuts multi-second stalls. Channel workbenches keep prefetch so memory is
    // scoped to `workbench:channel:*` (Bundle 1.5). Use `/skill …` to force brain.
    const skipPrefetchForWorkbench = Boolean(options?.scope) &&
        !explicitSkill &&
        options?.scope?.type !== 'channel';
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
    const needsBrainLoader = !skipPrefetchForWorkbench && !isConversationalOnly(message) && !isFollowUp;
    if (skipPrefetchForWorkbench) {
        console.error('[Workbench] Skipping daemon memory + BrainLoader prefetch (use /skill to force brain)');
    }
    onEvent({
        type: 'status',
        status: skipPrefetchForWorkbench
            ? 'Thinking...'
            : (needsBrainLoader ? 'Loading context...' : 'Searching memory...'),
    });
    // PLAN-CONTEXT-GROUND-TRUTH (pre-warm): fire the daemon facts probe NOW, before
    // the memory+brain awaits below, so its socket round-trip overlaps that CPU work
    // instead of starving behind it at the provider chokepoint (where both attempts
    // used to time out at the wall clock — see ground-truth.ts). We're inside the
    // turn's AsyncLocalStorage scope here, so agentCwd()/projectContext*() resolve
    // the real values; dispatchToProvider later consumes this via consumeGroundTruth.
    prewarmGroundTruth({
        cwd: agentCwd(),
        projectId: projectContextProjectId(),
        projectRoot: projectContextRoot(),
        projectName: projectContextProjectName(),
        conversationId,
    });
    const memoryPromise = skipPrefetchForWorkbench
        ? Promise.resolve('')
        : getMemoryContext(message, conversationId);
    const brainMemScope = channelScopeRawForBrainLoader(conversationId, options?.scope ?? null);
    const brainPromise = needsBrainLoader
        ? (async () => {
            const startMs = Date.now();
            const result = explicitSkill
                ? await runBrainLoader(`/skill ${explicitSkill} ${brainQuery}`, brainMemScope)
                : await runBrainLoader(suppressSkills ? `[NO_SKILLS] ${brainQuery}` : brainQuery, brainMemScope);
            return { ...result, execTime: Date.now() - startMs };
        })()
        : Promise.resolve({ matched: false, output: '', degraded: null, execTime: 0 });
    const [memoryContext, brainResult] = await Promise.all([memoryPromise, brainPromise]);
    recordMemoriesInjected(conversationId, memoryContext);
    // Phase 0: stage daemon + brainloader signals from already-resolved state.
    try {
        // memoryContext carries the daemon's `additional_context` block which contains the
        // intent-signal hint when daemon auto-routed. Look for the markers we already emit.
        if (memoryContext && /### Vodou Tool Results \(auto-routed/i.test(memoryContext)) {
            _phase0Stage.daemon_intent_matched = true;
            _phase0Stage.daemon_auto_routed = true;
            const m = memoryContext.match(/`([^`]+)` → `([^`]+)`\s+\(confidence:\s*(\d+)\)/);
            if (m) {
                _phase0Stage.daemon_intent_keyword = m[1];
                _phase0Stage.daemon_intent_confidence = parseInt(m[3], 10) / 100;
            }
        }
        else if (memoryContext && /Intent Signal/i.test(memoryContext)) {
            _phase0Stage.daemon_intent_matched = true;
        }
        if (brainResult && brainResult.matched && brainResult.output) {
            _phase0Stage.brainloader_fired = true;
            const skillMatch = brainResult.output.match(/^#\s*SKILL:\s*([^\n]+)/m);
            if (skillMatch)
                _phase0Stage.brainloader_skill = skillMatch[1].trim();
        }
    }
    catch { /* phase0 must never break chat */ }
    // Fix 1: when daemon already ran the tool via auto-routing, extract its output and skip brainResult
    let autoRoutedOutput = null;
    if (_phase0Stage.daemon_auto_routed && memoryContext) {
        const m = memoryContext.match(/### Vodou Tool Results[\s\S]+/);
        if (m)
            autoRoutedOutput = m[0];
    }
    let oiResults = '';
    if (needsBrainLoader) {
        if (autoRoutedOutput) {
            // Daemon already ran the tool — use its output, skip redundant brainResult
            oiResults = substituteVodouDynamicVars(autoRoutedOutput, conversationId, options?.scope ?? null);
            console.error(`[BrainLoader] daemon auto-routed — using memoryContext tool results (${oiResults.length} chars), skipping brainResult`);
            detectWorkflow(conversationId, oiResults, message);
            const skillMatch = oiResults.match(/# SKILL:\s*(\S+)/i);
            const now = Date.now();
            if (skillMatch) {
                _activeSkill.set(conversationId, { skillName: skillMatch[1], loadedAt: now, skillContent: oiResults });
                console.error(`[Skill] Tracking active skill: ${skillMatch[1]}`);
            }
            _lastOiContext.set(conversationId, { oiResults, skillName: skillMatch ? skillMatch[1] : null, timestamp: now });
        }
        else if (brainResult.matched) {
            const noIntentFound = isNoIntentFoundOutput(brainResult.output);
            if (noIntentFound) {
                // Suppress "No intent found" from being injected as active_context regardless of provider.
                // For non-CLI providers we also bypass to direct LLM; for CLI providers we let it fall through
                // to direct LLM naturally (oiResults stays empty = no context noise injected).
                console.error(`[BrainLoader] no intent found in ${brainResult.execTime}ms — suppressing context injection for provider=${currentProvider}`);
            }
            else if (/^Tool execution failed:|^Error:/i.test(brainResult.output.trim())) {
                // BrainLoader returned an error (e.g. broken pipe, daemon down) — don't inject
                // error text as context or the LLM will misinterpret it as a channel/tool failure.
                console.error(`[BrainLoader] error result in ${brainResult.execTime}ms, suppressing: ${brainResult.output.trim().substring(0, 80)}`);
            }
            else {
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
                    try {
                        saveSkillState(conversationId, skillMatch[1], oiResults, now);
                    }
                    catch { }
                }
            }
        }
        else {
            // BrainLoader didn't match — check if we have stored context from a previous turn
            const stored = _lastOiContext.get(conversationId);
            if (stored && Date.now() - stored.timestamp < 600_000) {
                oiResults = stored.oiResults;
                stored.timestamp = Date.now(); // refresh TTL on use
                console.error(`[BrainLoader] no match (${brainResult.execTime}ms) — reusing stored context (${oiResults.length} chars, skill: ${stored.skillName || 'none'})`);
            }
            else {
                console.error(`[BrainLoader] no match (${brainResult.execTime}ms)`);
            }
            if (brainResult.degraded) {
                // ALWAYS visible (not gated by VODOU_SHOW_RAW_RESULTS): the pipeline
                // failed to answer, which is a different fact from "no relevant
                // memories" and the user must be able to tell them apart.
                const label = brainResult.degraded === 'timeout'
                    ? `context pipeline timed out (${brainResult.execTime}ms)`
                    : 'context pipeline socket error';
                onEvent({
                    type: 'text',
                    content: `<details><summary>⚠️ Memory degraded this turn — ${label}; saved context may be missing${oiResults ? ' (reusing cached context from a previous turn)' : ''}</summary></details>\n\n`,
                });
                // P0-D: re-warm in the background with a generous budget so the NEXT
                // turn in this conversation gets skill/context without re-paying a
                // cold or starved pipeline. One in-flight re-warm per conversation.
                if (brainResult.degraded === 'timeout' && !_brainRewarmInflight.has(conversationId)) {
                    _brainRewarmInflight.add(conversationId);
                    const rewarmQuery = explicitSkill
                        ? `/skill ${explicitSkill} ${brainQuery}`
                        : suppressSkills
                            ? `[NO_SKILLS] ${brainQuery}`
                            : brainQuery;
                    const rewarmArgs = { query: rewarmQuery, clean: false };
                    if (brainMemScope)
                        rewarmArgs.memory_active_scope = brainMemScope;
                    // 60s: a freshly restarted worker's BrainLoader warmup takes 30-70s
                    // (model load); 30s re-warms were observed timing out mid-warmup.
                    callWorkerSocket('brain', rewarmArgs, 60_000)
                        .then((res) => {
                        const warmOutput = (res?.ok ? res.stdout || '' : '').trim();
                        if (!warmOutput)
                            return;
                        const cleaned = substituteVodouDynamicVars(rewriteAuthError(warmOutput), conversationId, options?.scope ?? null);
                        const warmSkill = cleaned.match(/# SKILL:\s*(\S+)/i);
                        _lastOiContext.set(conversationId, {
                            oiResults: cleaned,
                            skillName: warmSkill ? warmSkill[1] : null,
                            timestamp: Date.now(),
                        });
                        console.error(`[BrainLoader] background re-warm landed for ${conversationId.substring(0, 12)} (${cleaned.length} chars) — next turn reuses it`);
                    })
                        .catch(() => { })
                        .finally(() => _brainRewarmInflight.delete(conversationId));
                }
            }
            else if (showRawOIResults()) {
                onEvent({ type: 'text', content: `<details><summary>🔍 BrainLoader: no match (${brainResult.execTime}ms)${oiResults ? ' — using stored context' : ''}</summary></details>\n\n` });
            }
        }
    }
    else {
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
                const resolveVars = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || `{{${k}}}`);
                if (sp.type === 'text_input') {
                    // Text input phase — show prompt, wait for any input
                    menuText = resolveVars(sp.title) + '\n\n*(Type your answer)*';
                }
                else {
                    menuText += `## ${resolveVars(sp.title)}\n\n`;
                    for (const [key, opt] of Object.entries(sp.options)) {
                        menuText += `${key}. ${resolveVars(opt.label)}\n`;
                    }
                }
            }
            else {
                const vars = workflow.variables || {};
                const resolveVars = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || `{{${k}}}`);
                for (const [key, opt] of Object.entries(workflow.options)) {
                    menuText += `${key}. ${resolveVars(opt.label)}\n`;
                }
            }
            // Execute initial_steps if they exist (auto-fire on skill load)
            let initialResults = '';
            if (workflow.initialSteps && workflow.initialSteps.length > 0 && !workflow.initialStepsRan) {
                console.error(`[Workflow] Executing ${workflow.initialSteps.length} initial steps`);
                initialResults = await executeInitialSteps(workflow, onEvent, conversationId);
                workflow.initialStepsRan = true;
            }
            // On the first phase (phase 0), prepend the skill's intro/overview from oiResults
            // so the user sees what the skill does before the menu options.
            // Extract text between end of YAML frontmatter and first stopping-point heading.
            let skillIntro = '';
            if (workflow.currentPhase === 0 && oiResults && !initialResults) {
                const stripped = oiResults.replace(/^---[\s\S]*?---\s*/m, '');
                const stopIdx = stripped.search(/##\s*[⏸️🛑]*\s*STOPPING POINT|##\s*Choose|##\s*Agent Instructions/i);
                const rawIntro = stopIdx > 0 ? stripped.substring(0, stopIdx).trim() : '';
                // Filter out lines that are only YAML-like key:value (leftover frontmatter fields)
                const filteredLines = rawIntro.split('\n').filter(l => !/^\s*\w[\w_-]*:\s/.test(l) || /^#/.test(l));
                skillIntro = filteredLines.join('\n').trim();
                if (skillIntro.length < 20)
                    skillIntro = ''; // too short = nothing useful
            }
            // Stream results + menu directly — no LLM call, no conversation history pollution
            const fullContent = initialResults ? initialResults + '\n\n' + menuText.trim() : menuText.trim();
            // If there are initial results, send to LLM to format; otherwise stream menu directly
            if (initialResults) {
                const memoryContext = await getMemoryContext(message, conversationId);
                recordMemoriesInjected(conversationId, memoryContext);
                console.error(`[Gateway DIAG] dispatchToProvider site=workflow_initial_steps_format convId=${conversationId} initialResults_len=${initialResults.length}`);
                return dispatchToProvider(conversationId, message, onEvent, memoryContext, fullContent, '', undefined, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
            }
            const outputText = skillIntro ? `${skillIntro}\n\n---\n\n${menuText.trim()}` : menuText.trim();
            onEvent({ type: 'text', content: outputText });
            onEvent({ type: 'done' });
            console.error(`[Workflow] Presenting first stopping point menu (skipping LLM, no history)${skillIntro ? ` + ${skillIntro.length}ch intro` : ''}`);
            return outputText;
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
        const parsedOptions = [];
        for (const line of lines) {
            const m = line.match(/\(([^:]+)::([^)]+)\)/);
            if (m)
                parsedOptions.push({ server: m[1], tool: m[2] });
        }
        if (parsedOptions.length > 0) {
            _pendingDisambiguations.set(conversationId, { query: message, options: parsedOptions });
        }
        let output = '';
        if (intro)
            output += intro + '\n\n';
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
    return dispatchToProvider(conversationId, message, onEvent, memoryContext, oiResults, '', chatOpts.channelAttachments, chatOpts.scope ?? null, chatOpts.preferModel ?? null, chatOpts.lensesEnabled);
}
/**
 * Chat with Claude using a skill as the system prompt.
 * Skips BrainLoader — the skill IS the intelligence.
 * The SKILL.md content becomes the system prompt, guiding Claude through
 * stopping points and interactive workflows.
 */
export async function chatWithSkill(conversationId, message, skillContent, onEvent, turnId) {
    const tid = turnId?.trim() || '';
    console.error(`[Gateway DIAG] chatWithSkill ENTRY turnId=${tid || '(none)'} convId=${conversationId} msg_len=${message.length}`);
    // B2 follow-up (stop-before-begin race): new user turn — discard any stale
    // pending-abort mark before any await (see chat() for rationale).
    clearPendingAbort(conversationId);
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
    console.error(`[Gateway DIAG] dispatchToProvider site=chatWithSkill turnId=${tid || '(none)'} convId=${conversationId} skill_len=${skillContent.length}`);
    return dispatchToProvider(conversationId, message, onEvent, memoryContext, '', skillSystemPrompt, undefined, null, null, resolveLensesEnabled(conversationId));
}
// --- Token-aware context management ---
/** Context window limits by provider (in tokens). */
const CONTEXT_LIMITS = {
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
    'lmstudio': 32_000,
    'llamacpp': 32_000,
    'custom': 64_000,
    'fireworks': 131_072,
    'together': 131_072,
};
const CONTEXT_THRESHOLD = 0.80; // compress at 80% usage
const KEEP_RECENT = 10; // always keep last N messages verbatim
/** Rough token estimate: chars / 4. Fast, no dependency. */
function estimateTokens(messages) {
    let chars = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            chars += msg.content.length;
        }
        else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if ('text' in block && typeof block.text === 'string')
                    chars += block.text.length;
                else if ('content' in block && typeof block.content === 'string')
                    chars += block.content.length;
                else if (block.type === 'image')
                    chars += 8000 * 4; // rough budget for vision tiles
                else if (block.type === 'document') {
                    const d = block.source?.data;
                    chars += typeof d === 'string' ? Math.min(d.length, 400_000) : 50_000;
                }
            }
        }
    }
    return Math.ceil(chars / 4);
}
/** Extract plain text from a message for summarization. */
function extractMessageText(msg) {
    if (typeof msg.content === 'string')
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .map((b) => b.text || (typeof b.content === 'string' ? b.content : ''))
            .filter(Boolean)
            .join(' ');
    }
    return '';
}
/** Summarize older messages into a condensed block. */
function summarizeOlderMessages(messages) {
    const userTopics = [];
    const assistantPoints = [];
    const toolResults = [];
    for (const msg of messages) {
        const text = extractMessageText(msg);
        if (!text)
            continue;
        if (msg.role === 'user') {
            // Check if it's a tool_result
            if (Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result')) {
                const preview = text.substring(0, 150).replace(/\n/g, ' ');
                toolResults.push(preview);
            }
            else {
                const preview = text.substring(0, 100).replace(/\n/g, ' ');
                if (preview.trim())
                    userTopics.push(preview);
            }
        }
        else if (msg.role === 'assistant') {
            const preview = text.substring(0, 150).replace(/\n/g, ' ');
            if (preview.trim())
                assistantPoints.push(preview);
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
const _rollingSummaries = new Map();
// DEFAULT ON for the managed `vodou` tier (cost control on long convos); OFF for BYOK/other
// installs unless explicitly set. Explicit VODOU_ROLLING_SUMMARY (0/1) always wins.
// COGS Governor (WS-D): consult the per-conversation cost profile so a free / near-limit user's
// tokens aren't spent on the background summary refresh (rollingSummaryFor only fires the refresh
// when this returns true). Explicit env (0/1) always wins; else profile; else managed default.
const ROLLING_SUMMARY_ON = (conversationId) => {
    if (process.env.VODOU_ROLLING_SUMMARY != null)
        return process.env.VODOU_ROLLING_SUMMARY === '1';
    const prof = getCostProfile(conversationId);
    if (prof)
        return prof.rollingSummary;
    return currentProvider === 'vodou';
};
const ROLLING_REFRESH_EVERY = parseInt(process.env.VODOU_ROLLING_SUMMARY_EVERY || '6', 10); // re-summarize when the older-set grows by ≥ this many msgs
async function refreshRollingSummary(conversationId, olderMessages) {
    const prev = _rollingSummaries.get(conversationId);
    if (prev?.refreshing)
        return;
    _rollingSummaries.set(conversationId, { text: prev?.text || '', coveredCount: prev?.coveredCount || 0, refreshing: true });
    try {
        const transcript = olderMessages
            .map((m) => { const t = extractMessageText(m); return t ? `${String(m.role).toUpperCase()}: ${t.slice(0, 2000)}` : ''; })
            .filter(Boolean)
            .join('\n');
        if (!transcript.trim()) {
            _rollingSummaries.set(conversationId, { text: prev?.text || '', coveredCount: olderMessages.length, refreshing: false });
            return;
        }
        const sys = 'You compress conversation history for continuity. Produce a tight factual summary (≤250 words) that PRESERVES: the user\'s goals, decisions made, concrete facts/names/values, unresolved questions, and what was done/produced. No preamble or "the user asked" filler — only the durable facts a continuation needs.';
        const prompt = (prev?.text
            ? `Existing summary so far:\n${prev.text}\n\n---\nFold in these additional earlier messages, keeping the result ≤250 words:\n`
            : `Summarize this earlier conversation:\n`) + transcript;
        const text = (await rawLLMCall(prompt, sys, { maxTokens: 600 })).trim();
        _rollingSummaries.set(conversationId, text
            ? { text, coveredCount: olderMessages.length, refreshing: false }
            : { text: prev?.text || '', coveredCount: prev?.coveredCount || 0, refreshing: false });
    }
    catch (e) {
        console.error(`[WS5] rolling summary refresh failed for ${conversationId.substring(0, 8)}: ${e.message}`);
        _rollingSummaries.set(conversationId, { text: prev?.text || '', coveredCount: prev?.coveredCount || 0, refreshing: false });
    }
}
/**
 * WS5: best available summary of `olderMessages` NOW, triggering a background refresh when
 * the rolling summary is missing or stale. Synchronous — never blocks the turn. Falls back
 * to the naive summary when the flag is off, no convId, or no LLM summary cached yet.
 */
function rollingSummaryFor(conversationId, olderMessages) {
    if (!ROLLING_SUMMARY_ON(conversationId) || !conversationId)
        return summarizeOlderMessages(olderMessages);
    const cached = _rollingSummaries.get(conversationId);
    const stale = !cached || (olderMessages.length - cached.coveredCount) >= ROLLING_REFRESH_EVERY;
    if (stale && !cached?.refreshing && isConfigured()) {
        void refreshRollingSummary(conversationId, olderMessages); // fire-and-forget → ready next turn
    }
    return cached?.text
        ? `## Earlier in this conversation\n\n${cached.text}`
        : summarizeOlderMessages(olderMessages); // naive fallback until the first refresh lands
}
// Test seams (no Anthropic/provider key needed to exercise the sync read/cache/fallback logic).
export function __setRollingSummaryForTest(conversationId, text, coveredCount) {
    _rollingSummaries.set(conversationId, { text, coveredCount, refreshing: false });
}
export function __clearRollingSummariesForTest() { _rollingSummaries.clear(); }
export function __rollingSummaryForTest(conversationId, olderMessages) {
    return rollingSummaryFor(conversationId, olderMessages);
}
/** Proactive compression threshold — compress at 50% of message-only tokens.
 *  Real usage is higher (system prompt + tools + Vodou results add 20-40K tokens). */
const PROACTIVE_THRESHOLD = 0.50;
/**
 * Phase 1 compression: replace old tool_result content with short placeholders.
 * Returns a NEW array — never mutates the original.
 * Messages in the KEEP_RECENT tail are left untouched.
 */
function pruneOldToolOutputs(messages, keepRecent = KEEP_RECENT) {
    if (messages.length <= keepRecent)
        return messages;
    const boundary = messages.length - keepRecent;
    const result = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Recent messages: pass through unchanged
        if (i >= boundary) {
            result[i] = msg;
            continue;
        }
        // Old user messages containing tool_result blocks: prune content
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            const blocks = msg.content;
            const hasToolResult = blocks.some((b) => b.type === 'tool_result');
            if (hasToolResult) {
                const prunedBlocks = blocks.map((b) => {
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
function sanitizeToolPairs(messages) {
    const toolUseIds = new Set();
    const toolResultIds = new Set();
    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const b of msg.content) {
                if (b.type === 'tool_use' && b.id)
                    toolUseIds.add(b.id);
            }
        }
        else if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const b of msg.content) {
                if (b.type === 'tool_result' && b.tool_use_id)
                    toolResultIds.add(b.tool_use_id);
            }
        }
    }
    // IDs that have both a tool_use and a tool_result
    const pairedIds = new Set();
    for (const id of toolUseIds) {
        if (toolResultIds.has(id))
            pairedIds.add(id);
    }
    const result = [];
    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const blocks = msg.content.filter((b) => {
                if (b.type === 'tool_use')
                    return pairedIds.has(b.id);
                return true;
            });
            if (blocks.length > 0)
                result.push({ role: 'assistant', content: blocks });
        }
        else if (msg.role === 'user' && Array.isArray(msg.content)) {
            const blocks = msg.content.filter((b) => {
                if (b.type === 'tool_result')
                    return pairedIds.has(b.tool_use_id);
                return true;
            });
            if (blocks.length > 0)
                result.push({ role: 'user', content: blocks });
        }
        else {
            result.push(msg);
        }
    }
    // Ensure first message is role:user with text content (API requirement).
    // Drop leading assistant messages and orphaned tool_result-only user messages.
    while (result.length > 0) {
        const first = result[0];
        if (first.role === 'assistant') {
            result.shift();
            continue;
        }
        if (first.role === 'user' && Array.isArray(first.content)) {
            const allTR = first.content.every((b) => b.type === 'tool_result');
            if (allTR) {
                result.shift();
                continue;
            }
        }
        break;
    }
    return result;
}
/**
 * Get messages with Phase 1 compression: prune old tool outputs + sanitize pairs.
 * All provider paths should use this instead of conversations.getMessages() directly.
 */
function getCompressedMessages(conversationId) {
    const raw = getConversationManager().getMessages(conversationId);
    if (raw.length <= KEEP_RECENT)
        return raw;
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
function maybeProactiveCompact(conversationId, onEvent) {
    const messages = getConversationManager().getMessages(conversationId);
    if (messages.length <= KEEP_RECENT)
        return false;
    const estimated = estimateTokens(messages);
    const limit = CONTEXT_LIMITS[currentProvider] || 200_000;
    const threshold = Math.floor(limit * PROACTIVE_THRESHOLD);
    if (estimated < threshold)
        return false;
    console.error(`[Proactive Compaction] ${estimated} est. tokens >= ${PROACTIVE_THRESHOLD * 100}% of ${limit} ` +
        `(threshold ${threshold}) — compacting ${conversationId.substring(0, 8)}`);
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
function compactConversation(conversationId) {
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
                const toolResults = msg.content.filter((b) => b.type === 'tool_result');
                if (toolResults.length > 0) {
                    for (const tr of toolResults) {
                        conversations.addToolResult(conversationId, tr.tool_use_id, tr.content, tr.is_error);
                    }
                    continue;
                }
                const hasMultimodal = msg.content.some((b) => b.type === 'image' || b.type === 'document');
                if (hasMultimodal) {
                    conversations.addUserMessage(conversationId, msg.content);
                    continue;
                }
            }
            const text = extractMessageText(msg);
            if (text)
                conversations.addUserMessage(conversationId, text);
        }
        else if (msg.role === 'assistant') {
            const content = Array.isArray(msg.content)
                ? msg.content
                : [{ type: 'text', text: String(msg.content) }];
            conversations.addAssistantMessage(conversationId, content);
        }
    }
    // Ensure pairs are intact after re-adding recent messages
    conversations.trimAfterToolResults(conversationId);
    const newCount = conversations.getMessages(conversationId).length;
    console.error(`[Compaction] Compacted ${messages.length} → ${newCount} messages (removed ${olderMessages.length} older)`);
    return newCount < messages.length;
}
// --- CLI mode implementation ---
function formatConversationForCLI(conversationId, newMessage) {
    const conversations = getConversationManager();
    const messages = getCompressedMessages(conversationId);
    if (messages.length === 0)
        return newMessage;
    // Token-aware trimming: estimate tokens and compress if over threshold
    const limit = CONTEXT_LIMITS[currentProvider] || 200_000;
    const threshold = Math.floor(limit * CONTEXT_THRESHOLD);
    const totalTokens = estimateTokens(messages);
    let messagesToUse;
    let summaryPrefix = '';
    if (totalTokens > threshold && messages.length > KEEP_RECENT) {
        // Split: summarize old, keep recent verbatim
        const olderMessages = messages.slice(0, -KEEP_RECENT);
        const recentMessages = messages.slice(-KEEP_RECENT);
        summaryPrefix = summarizeOlderMessages(olderMessages);
        messagesToUse = recentMessages;
        console.error(`[Context] Token-aware trim: ${totalTokens} tokens > ${threshold} threshold. Compacted ${olderMessages.length} older messages, keeping ${recentMessages.length} recent.`);
    }
    else {
        const WINDOW = parseInt(process.env.VODOU_CONVO_WINDOW_TURNS || '20', 10);
        messagesToUse = messages.slice(-WINDOW);
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
                    ? msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
                    : '';
            // Strip Vodou context blocks from history — they're re-injected fresh per turn
            text = text
                .replace(/<active_context>[\s\S]*?<\/active_context>\s*/g, '')
                .replace(/<oi_results>[\s\S]*?<\/oi_results>\s*/g, '')
                .replace(/Vodou execution results:[\s\S]*?(?=User's new message:|$)/g, '')
                .replace(/IMPORTANT: The active_context[\s\S]*?\n\n/g, '')
                .replace(/Interpret the active_context[\s\S]*?\n\n/g, '')
                .trim();
            if (text)
                context += `User: ${text}\n`;
        }
        else if (msg.role === 'assistant') {
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
            if (text)
                context += `Assistant: ${text}\n`;
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
function useClaudeCliStreamJsonStdin() {
    const v = process.env.VODOU_GATEWAY_CLI_LEGACY_ARGV_PROMPT;
    return v !== '1' && v !== 'true';
}
function usePersistentClaudeCliPool() {
    const v = process.env.VODOU_GATEWAY_DISABLE_PERSISTENT_CLI;
    return v !== '1' && v !== 'true';
}
function restartPoolOnSystemPromptChange() {
    const v = process.env.VODOU_GATEWAY_POOL_RESTART_ON_SYSTEM_PROMPT_CHANGE;
    return v === '1' || v === 'true';
}
/** One NDJSON line for `--input-format=stream-json` (aligned with CC SDK / directConnect shape). */
function streamJsonUserMessageLine(userText) {
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
const _cliSessions = new Map();
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
function logPoolStats() {
    const { pool_spawned, pool_reused, pool_restarts, pool_timeout_kills, pool_idle_kills, pool_crash_kills } = _cliPoolStats;
    console.error(`[CLI pool stats] spawned=${pool_spawned} reused=${pool_reused} restarts=${pool_restarts} timeout_kills=${pool_timeout_kills} idle_kills=${pool_idle_kills} crash_kills=${pool_crash_kills} active=${_cliSessions.size}`);
}
/** Check if any CLI session is alive (process running). Used by ensure endpoint to skip blocking live test. */
export function hasActiveCliSession() {
    for (const s of _cliSessions.values()) {
        if (!s.proc.killed && s.proc.exitCode === null)
            return true;
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
        if (s.pending)
            pendingSessions++;
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
function getGatewayShellMode() {
    const raw = (process.env.VODOU_GATEWAY_SHELL_MODE || 'full').toLowerCase().trim();
    if (raw === 'restricted' || raw === 'verify' || raw === 'full')
        return raw;
    return 'full';
}
function shellModeAllowedTools(mode) {
    switch (mode) {
        case 'restricted': return 'Bash';
        case 'verify': return 'Bash,Read,Grep,Glob';
        case 'full': return 'Bash,Read,Write,Edit,Grep,Glob';
    }
}
function shellModeMaxTurns(mode, isMenuReply) {
    if (isMenuReply)
        return '1';
    const override = process.env.VODOU_GATEWAY_MAX_TURNS;
    if (override && /^\d+$/.test(override.trim()))
        return override.trim();
    switch (mode) {
        case 'restricted': return '200';
        case 'verify': return '400';
        case 'full': return '1000';
    }
}
function shellModeInjectsVodouCoreGuard(mode) {
    return mode === 'restricted';
}
function buildPersistentCliArgs(systemPrompt, jailRoot = null) {
    const mode = getGatewayShellMode();
    return [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--no-session-persistence',
        '--settings', cliSettingsJson(jailRoot),
        '--model', CLI_MODEL,
        '--max-turns', shellModeMaxTurns(mode, false),
        '--dangerously-skip-permissions',
        '--allowedTools', shellModeAllowedTools(mode),
        // C1: system prompt via file, not argv — a 22K-char --system-prompt exceeds
        // Windows' 32,767-char command-line limit (spawn ENAMETOOLONG). File works
        // identically on all platforms.
        ...systemPromptFileArgs(systemPrompt),
    ];
}
function killCliSession(session) {
    if (session.idleTimer)
        clearTimeout(session.idleTimer);
    try {
        session.stdin.destroy();
    }
    catch { }
    try {
        session.stdout.destroy();
    }
    catch { }
    try {
        session.stderr.destroy();
    }
    catch { }
    try {
        session.proc.kill('SIGTERM');
    }
    catch { }
    // A.5 bootstrap-once: the new claude process that replaces this one must
    // receive the workspace bootstrap (CLAUDE.md/AGENTS.md/MEMORY.md) in its
    // system prompt. Without these invalidations, the cached system prompt
    // (built with bootstrap='' since !isFirstMessage) is reused and the fresh
    // process never sees workspace context until the 5-min TTL expires.
    _bootstrappedConversations.delete(session.conversationId);
    _cachedSystemPrompts.delete(session.conversationId);
}
function armIdleTimer(session) {
    if (session.idleTimer)
        clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        if (!session.pending && session.queue.length === 0) {
            console.error(`[CLI pool] Idle timeout — closing ${session.conversationId.substring(0, 8)}`);
            _cliPoolStats.pool_idle_kills++;
            logPoolStats();
            _cliSessions.delete(session.conversationId);
            session.poolKillReason = 'idle';
            killCliSession(session);
        }
        else {
            armIdleTimer(session);
        }
    }, CLI_SESSION_IDLE_MS);
}
// Heartbeat sessions use a shorter turn timeout so a stalled heartbeat doesn't block
// the pool for 15min. The Rust scheduler gives up after 120s; give the gateway 240s
// (enough for tool rounds) before killing the session.
const HEARTBEAT_CLI_TURN_TIMEOUT_MS = parseInt(process.env.VODOU_GATEWAY_HEARTBEAT_CLI_TIMEOUT_MS || '240000', 10);
function processNextQueuedTurn(session) {
    if (session.pending || session.queue.length === 0)
        return;
    const next = session.queue.shift();
    const isHbSession = session.conversationId === 'vodou-heartbeat';
    const effectiveTimeoutMs = isHbSession ? HEARTBEAT_CLI_TURN_TIMEOUT_MS : CLI_TURN_TIMEOUT_MS;
    let turnTimeout;
    if (effectiveTimeoutMs > 0) {
        turnTimeout = setTimeout(() => {
            if (session.pending) {
                const err = new Error(`claude CLI turn timed out after ${Math.round(effectiveTimeoutMs / 1000)}s ` +
                    `(set VODOU_GATEWAY_CLI_TURN_TIMEOUT_MS=0 to disable, or increase the limit)`);
                _cliPoolStats.pool_timeout_kills++;
                logPoolStats();
                const partial = session.pending.fullText?.trim() || '';
                if (partial) {
                    // B3: a partial answer already streamed to the user — resolve cleanly
                    // with a trailing timeout notice rather than a hard error (which
                    // would drop the visible text from history). Persistence happens at
                    // the resolve site (chatWithCLI's pooled branch adds the assistant
                    // message) — persisting here TOO double-added the message to history.
                    next.onEvent({ type: 'status', status: `Response timed out after ${Math.round(effectiveTimeoutMs / 1000)}s — partial answer shown.` });
                    next.onEvent({ type: 'done' }); // index.ts persists assistantFullText to the memory transcript
                    next.resolve(partial);
                }
                else {
                    next.onEvent({ type: 'error', error: err.message });
                    next.reject(err);
                }
                session.pending = null;
                _cliSessions.delete(session.conversationId);
                session.poolKillReason = 'timeout';
                killCliSession(session);
            }
        }, effectiveTimeoutMs);
    }
    session.pending = {
        onEvent: next.onEvent,
        resolve: next.resolve,
        reject: next.reject,
        fullText: '',
        lastAllText: '',
        needsTextSeparator: false,
        seenToolIds: new Set(),
        toolStartTimes: new Map(),
        trajToolMeta: new Map(),
        startMs: Date.now(),
        thinkingStatusSent: false,
        timeout: turnTimeout,
    };
    session.lastActivityAt = Date.now();
    const line = streamJsonUserMessageLine(next.prompt) + '\n';
    const pendingRef = session.pending;
    const attempt = next.attempt || 0;
    const retryTurnOnce = () => {
        if (attempt >= 1)
            return false;
        try {
            _cliSessions.delete(session.conversationId);
            session.poolKillReason = 'stdin';
            // Clear pending BEFORE kill so the close handler (fired by SIGTERM)
            // doesn't emit a spurious "claude CLI exited with code 143" error to the user.
            // The turn is being retried on a fresh session — not failing.
            if (turnTimeout)
                clearTimeout(turnTimeout);
            session.pending = null;
            killCliSession(session);
            const revived = getOrCreateCliSession(session.conversationId, session.systemPrompt);
            revived.queue.unshift({ ...next, attempt: attempt + 1 });
            processNextQueuedTurn(revived);
            return true;
        }
        catch (e) {
            console.error(`[CLI pool] failed to auto-recover dead stdin: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    };
    const failTurn = (message, kill) => {
        if (turnTimeout)
            clearTimeout(turnTimeout);
        if (session.pending !== pendingRef)
            return;
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
            if (!err)
                return;
            const code = err.code;
            const isPipe = code === 'EPIPE' ||
                code === 'ERR_STREAM_DESTROYED' ||
                code === 'ECANCELED' || // process died between alive-check and write
                /EPIPE|destroyed|ECANCELED/i.test(err.message);
            const msg = isPipe
                ? 'Claude CLI closed stdin (process exited or crashed). The next message will start a new session.'
                : err.message;
            console.error(`[CLI pool] stdin write error: ${msg}`);
            if (isPipe && retryTurnOnce())
                return;
            failTurn(msg, true);
        });
    }
    catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const isPipe = /EPIPE|destroyed|ECANCELED/i.test(raw);
        if (isPipe && retryTurnOnce())
            return;
        failTurn(isPipe
            ? 'Claude CLI closed stdin (process exited or crashed). The next message will start a new session.'
            : raw, true);
    }
}
// User-actionable remediation messages for recognized Claude CLI failures.
// Reused by BOTH the result-event handler (is_error result, session stays alive)
// and the process-close handler (non-zero exit) so the user sees one consistent
// fix-it message regardless of how the CLI surfaced the failure.
const CLAUDE_CLI_AUTH_REMEDIATION = 'Claude CLI session expired or not authenticated. Open a terminal and run `claude` → `/login` to re-authenticate, then retry. '
    + '(Or switch to a provider you have a key for in Settings.)';
const CLAUDE_CLI_CREDIT_REMEDIATION = 'Claude CLI returned a billing error (credit balance too low). Add credit to your Anthropic account, sign in with a Claude Pro/Max subscription (`claude` → `/login`), or switch providers in Settings.';
const CLAUDE_CLI_CONNECTION_REMEDIATION = 'Claude CLI could not reach the API (connection error). This usually means the CLI session is logged out, or your network/proxy is blocking it. Open a terminal and run `claude` → `/login` to re-authenticate, or check your connection. (Or switch providers in Settings.)';
/**
 * Classify a Claude CLI error string (from stderr OR an is_error result) into a
 * user-actionable remediation message, or null if it isn't a recognized
 * auth/billing/connection failure (caller should then surface the raw error).
 */
function classifyClaudeCliError(text) {
    if (!text)
        return null;
    const t = text.toLowerCase();
    if (t.includes('401') ||
        t.includes('authentication_error') ||
        t.includes('invalid authentication') ||
        t.includes('failed to authenticate') ||
        t.includes('not authenticated') ||
        t.includes('not logged in') ||
        t.includes('invalid api key') ||
        t.includes('please log in') ||
        t.includes('please run /login') ||
        t.includes('/login') ||
        t.includes('claude auth login') ||
        (t.includes('oauth') && t.includes('expired')))
        return CLAUDE_CLI_AUTH_REMEDIATION;
    if (t.includes('credit balance') ||
        t.includes('too low to access') ||
        t.includes('insufficient_quota'))
        return CLAUDE_CLI_CREDIT_REMEDIATION;
    // Connection failures — when the CLI is logged out it often fails trying to
    // refresh/reach the API rather than emitting a clean auth error (the
    // ConnectionRefused we saw in the wild). Treat as a login-or-network problem.
    if (t.includes('unable to connect') ||
        t.includes('connection refused') ||
        t.includes('econnrefused') ||
        t.includes('connect econn') ||
        t.includes('network error') ||
        t.includes('fetch failed'))
        return CLAUDE_CLI_CONNECTION_REMEDIATION;
    return null;
}
let _claudeCliAuth = { ok: true, message: null, checkedAt: 0 };
export function getClaudeCliAuthState() { return _claudeCliAuth; }
function markClaudeCliAuthBad(message) {
    if (_claudeCliAuth.ok)
        console.error('[CLI auth] marked signed-out — chat will show the Reconnect banner');
    _claudeCliAuth = { ok: false, message, checkedAt: Date.now() };
}
function markClaudeCliAuthOk() {
    if (!_claudeCliAuth.ok)
        console.error('[CLI auth] recovered — turns succeeding again');
    _claudeCliAuth = { ok: true, message: null, checkedAt: Date.now() };
}
/** Fast, cached `claude auth status` probe (same command the warmup uses).
 *  Returns true if authenticated. Failure modes (subcommand absent, throws) are
 *  treated as authenticated so we never block on an inconclusive probe. */
/// `claude auth status` WITHOUT a shell. execSync ran it through `cmd.exe /c`
/// on Windows — a VISIBLE cmd window on the chat path (the per-prompt popup).
/// spawnSync invokes claude.exe directly; windowsHide suppresses its console.
function claudeAuthStatusRaw() {
    try {
        const { spawnSync } = require('child_process');
        const r = spawnSync(CLAUDE_BIN, ['auth', 'status'], {
            stdio: 'pipe', timeout: 5000, windowsHide: true, encoding: 'utf-8',
        });
        return { rc: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
    }
    catch (e) {
        return { rc: 1, out: String(e?.message || e) };
    }
}
let _authProbeAt = 0;
let _authProbeOk = true;
function probeClaudeCliAuthenticated() {
    const now = Date.now();
    if (now - _authProbeAt < 8000)
        return _authProbeOk;
    _authProbeAt = now;
    try {
        const { rc, out } = claudeAuthStatusRaw();
        _authProbeOk = !(rc !== 0 && /not authenticated|not logged in|please run \/login/i.test(out));
    }
    catch {
        _authProbeOk = true;
    }
    return _authProbeOk;
}
function wireCliSessionStreams(session) {
    session.stdout.on('data', (data) => {
        const pending = session.pending;
        session.buffer += data.toString();
        if (pending)
            session.lastActivityAt = Date.now();
        const lines = session.buffer.split('\n');
        session.buffer = lines.pop() || '';
        if (!pending)
            return;
        for (const line of lines) {
            if (!line.trim())
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            // Debug: log event types to trace tool events and stop reasons
            if (event.type === 'result') {
                console.error(`[CLI pool] RESULT: stop=${event.stop_reason || event.subtype} turns=${event.num_turns} duration=${event.duration_ms}ms cost=$${event.total_cost_usd?.toFixed(4) || '?'}`);
            }
            else if (event.type !== 'stream_event' && event.type !== 'assistant' && event.type !== 'rate_limit_event') {
                console.error(`[CLI pool event] type=${event.type} tool=${event.tool || ''}`);
            }
            else if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
                console.error(`[CLI pool stream] content_block_start block_type=${event.event.content_block?.type} name=${event.event.content_block?.name || ''}`);
            }
            if (event.type === 'stream_event' && event.event) {
                const se = event.event;
                if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
                    if (process.env.VODOU_CLI_DEBUG_DUP)
                        console.error(`[dup] text_delta +${se.delta.text.length} ${JSON.stringify(se.delta.text.slice(0, 24))}`);
                    let text = se.delta.text;
                    // A text block resuming AFTER a tool call is a separate assistant
                    // message; its deltas would concatenate straight onto the prior segment
                    // ("right now:Calculator…"). Insert the same `\n\n` break the
                    // assistant-snapshot path below already emits for new segments — but
                    // only once, and not if the prior text already ends in a newline.
                    if (pending.needsTextSeparator) {
                        pending.needsTextSeparator = false;
                        if (pending.lastAllText && !pending.lastAllText.endsWith('\n')) {
                            text = '\n\n' + text;
                        }
                    }
                    pending.onEvent({ type: 'text', content: text });
                    pending.fullText += text;
                    pending.lastAllText += text;
                }
                if (se.type === 'content_block_delta' && se.delta?.type === 'thinking_delta') {
                    const th = se.delta.thinking;
                    if (th && !pending.thinkingStatusSent) {
                        pending.thinkingStatusSent = true;
                        pending.onEvent({
                            type: 'status',
                            status: 'Model is reasoning (answer will appear when ready)…',
                        });
                    }
                }
                // Tool use — create chip immediately for UI feedback
                if (se.type === 'content_block_start' && se.content_block?.type === 'tool_use') {
                    pending.needsTextSeparator = true;
                    const toolId = se.content_block.id || se.content_block.name + '_' + Date.now();
                    if (!pending.seenToolIds.has(toolId)) {
                        pending.seenToolIds.add(toolId);
                        pending.toolStartTimes.set(toolId, Date.now());
                        pending.trajToolMeta?.set(toolId, { tool: se.content_block.name, args: {} });
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
                    .filter((b) => b.type === 'text' && b.text)
                    .map((b) => b.text)
                    .join(''); // '' not '\n': text_delta stream has no inter-block separator, joining with '\n' diverges and triggers false re-emit
                if (process.env.VODOU_CLI_DEBUG_DUP && allText)
                    console.error(`[dup] ASSISTANT allText.len=${allText.length} last.len=${pending.lastAllText.length} full.len=${pending.fullText.length} | startsW=${allText.startsWith(pending.lastAllText)} revStartsW=${pending.lastAllText.startsWith(allText)} endsW=${pending.lastAllText.endsWith(allText)} inclFull=${pending.fullText.includes(allText)} | allTail=${JSON.stringify(allText.slice(-30))} lastTail=${JSON.stringify(pending.lastAllText.slice(-30))}`);
                if (allText !== pending.lastAllText) {
                    if (allText.startsWith(pending.lastAllText)) {
                        const delta = allText.substring(pending.lastAllText.length);
                        if (delta)
                            pending.onEvent({ type: 'text', content: delta });
                        pending.lastAllText = allText;
                    }
                    else if (pending.lastAllText.startsWith(allText)) {
                        // `text_delta` already streamed past this partial `assistant` snapshot.
                        // Emitting `\n\n` + allText here corrupts the transcript (mid-URL
                        // splices, duplicated bullets). Keep streamed state as canonical.
                    }
                    else if (pending.lastAllText.endsWith(allText) || pending.fullText.includes(allText)) {
                        // DIVERGENCE that is NOT genuinely new text. `lastAllText` is CUMULATIVE across
                        // every assistant message this turn, but each `assistant` snapshot is ONE message
                        // — so on a text→tools→text turn the 2nd message's snapshot is a SUFFIX of what
                        // we already streamed via text_delta, failing both startsWith checks above. Without
                        // this guard the else re-emitted it → the whole answer printed twice.
                    }
                    else {
                        pending.onEvent({ type: 'text', content: '\n\n' + allText });
                        pending.lastAllText = allText;
                    }
                }
                pending.fullText = pending.lastAllText;
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
                        pending.trajToolMeta?.set(toolId, { tool: block.name, args: block.input ?? {} });
                        if (!pending.seenToolIds.has(toolId)) {
                            pending.seenToolIds.add(toolId);
                            if (!pending.toolStartTimes.has(toolId))
                                pending.toolStartTimes.set(toolId, Date.now());
                            pending.onEvent({
                                type: 'tool_call_start',
                                toolName: block.name,
                                toolId,
                                toolArgs: block.input,
                            });
                        }
                        else if (block.input && Object.keys(block.input).length > 0) {
                            pending.onEvent({
                                type: 'tool_call_start',
                                toolName: block.name,
                                toolId,
                                toolArgs: block.input,
                            });
                        }
                    }
                    if (block.type === 'tool_result') {
                        const content = Array.isArray(block.content)
                            ? block.content.map((c) => c.text || '').join('')
                            : typeof block.content === 'string' ? block.content : '';
                        pending.onEvent({
                            type: 'tool_call_end',
                            toolName: pending.trajToolMeta?.get(block.tool_use_id)?.tool || 'Bash',
                            toolId: block.tool_use_id,
                            toolResult: content,
                            success: !block.is_error,
                        });
                    }
                }
            }
            // Standalone tool events from CLI. Eval wave-3 F3: these events carry the
            // tool name as `name` (stream-json tool_use shape), not `tool` — the old
            // `event.tool || 'tool'` collapsed every CLI-lane call to the generic
            // label "tool", blinding trace-based verdicts. Register the resolved name
            // in trajToolMeta so the matching tool_result can recover it too.
            if (event.type === 'tool_use') {
                const resolvedName = event.tool || event.name || 'tool';
                const toolId = event.tool_use_id || resolvedName + '_' + Date.now();
                pending.trajToolMeta?.set(toolId, { tool: resolvedName, args: event.input ?? {} });
                if (!pending.seenToolIds.has(toolId)) {
                    pending.seenToolIds.add(toolId);
                    pending.toolStartTimes.set(toolId, Date.now());
                    pending.onEvent({
                        type: 'tool_call_start',
                        toolName: resolvedName,
                        toolId,
                        toolArgs: event.input,
                    });
                }
            }
            if (event.type === 'tool_result') {
                const tid = event.tool_use_id;
                const startedAt = tid ? pending.toolStartTimes.get(tid) : undefined;
                const executionTime = startedAt ? Date.now() - startedAt : undefined;
                if (tid)
                    pending.toolStartTimes.delete(tid);
                // F3: capture the real name from the registry BEFORE the trajectory
                // block deletes the meta — `event.tool` is absent on stream-json
                // results, which is how every CLI-lane call got labeled "tool".
                const resultName = event.tool || (tid ? pending.trajToolMeta?.get(tid)?.tool : undefined) || 'tool';
                // Trajectory: record one step (dedupe via trajToolMeta presence).
                if (tid && pending.trajToolMeta?.has(tid)) {
                    const meta = pending.trajToolMeta.get(tid);
                    pending.trajToolMeta.delete(tid);
                    for (const norm of normalizeCliToolSteps(meta.tool || event.tool || 'tool', meta.args)) {
                        recordTrajectoryStep(session.conversationId, { ...norm, ok: !event.is_error, ms: executionTime ?? 0 });
                    }
                }
                pending.onEvent({
                    type: 'tool_call_end',
                    toolName: resultName,
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
                    if (block.type !== 'tool_result')
                        continue;
                    const tid = block.tool_use_id;
                    const startedAt = tid ? pending.toolStartTimes.get(tid) : undefined;
                    const executionTime = startedAt ? Date.now() - startedAt : undefined;
                    if (tid)
                        pending.toolStartTimes.delete(tid);
                    // F3 (eval wave-3): resolve the real tool name from the registry
                    // BEFORE the trajectory block deletes it — this path fired for every
                    // Bash/MCP tool with a hardcoded 'tool' label, blinding trace-based
                    // eval verdicts and the /chat toolCalls payload alike.
                    const blockName = (tid ? pending.trajToolMeta?.get(tid)?.tool : undefined) || 'tool';
                    // Trajectory: record one step (dedupe via trajToolMeta presence). This
                    // is the path that fires for Bash/MCP tools per the comment above.
                    if (tid && pending.trajToolMeta?.has(tid)) {
                        const meta = pending.trajToolMeta.get(tid);
                        pending.trajToolMeta.delete(tid);
                        for (const norm of normalizeCliToolSteps(meta.tool || 'tool', meta.args)) {
                            recordTrajectoryStep(session.conversationId, { ...norm, ok: !block.is_error, ms: executionTime ?? 0 });
                        }
                    }
                    const content = Array.isArray(block.content)
                        ? block.content.map((c) => c.text || '').join('')
                        : typeof block.content === 'string' ? block.content : '';
                    pending.onEvent({
                        type: 'tool_call_end',
                        toolName: blockName,
                        toolId: tid,
                        toolResult: content,
                        success: !block.is_error,
                        executionTime,
                    });
                }
            }
            if (event.type === 'result') {
                // Do NOT emit text from `event.result`. `text_delta` + `assistant` events
                // are the authoritative stream. `event.result` is the concatenated full-
                // turn text, but `lastAllText` resets per-segment in the `assistant`
                // handler above (lines ~2722–2732), so on any turn with ≥1 tool call
                // `result.startsWith(lastAllText)` is false → the old else-branch
                // re-emitted the entire turn prefixed with `\n\n` (visible duplicate
                // assistant message). Only harvest usage stats here.
                if (event.result && typeof event.result === 'string') {
                    pending.fullText = event.result;
                }
                const u = event.usage || {};
                // claude-cli reports modelUsage keyed by model — a turn often spans TWO models:
                // a tiny haiku internal step AND the real answer on the configured model. Pick the
                // model that did the actual work (most output tokens, tie-break by cost), not the
                // first key — otherwise the footer mislabels a sonnet answer as haiku.
                let muModel;
                let mu = null;
                if (event.modelUsage && typeof event.modelUsage === 'object') {
                    const entries = Object.entries(event.modelUsage);
                    entries.sort((a, b) => ((b[1]?.outputTokens || 0) - (a[1]?.outputTokens || 0)) ||
                        ((b[1]?.costUSD || 0) - (a[1]?.costUSD || 0)));
                    if (entries.length) {
                        muModel = entries[0][0];
                        mu = entries[0][1];
                    }
                }
                pending.finalUsage = {
                    inputTokens: mu?.inputTokens || u.input_tokens,
                    outputTokens: mu?.outputTokens || u.output_tokens,
                    cacheReadTokens: mu?.cacheReadInputTokens || u.cache_read_input_tokens,
                    cacheCreateTokens: mu?.cacheCreationInputTokens || u.cache_creation_input_tokens,
                    costUsd: event.total_cost_usd,
                    durationMs: event.duration_ms,
                    model: muModel,
                    tokenBudget: CLI_POOL_TOKEN_BUDGET > 0 ? CLI_POOL_TOKEN_BUDGET : undefined,
                };
                // Auto-continuation when CLI hits --max-turns: spawn a fresh session
                // and push a "Continue." turn carrying the original callbacks so the
                // user's promise stays open and streaming continues uninterrupted.
                const hitMaxTurns = event.stop_reason === 'max_turns' || event.subtype === 'max_turns';
                if (hitMaxTurns) {
                    const maxTurnsConvId = session.conversationId;
                    console.error(`[CLI pool] max_turns hit for ${maxTurnsConvId.substring(0, 8)} — auto-continuing on fresh session`);
                    pending.onEvent({ type: 'status', status: '…continuing (auto-resuming after turn limit)' });
                    if (pending.timeout)
                        clearTimeout(pending.timeout);
                    const savedOnEvent = pending.onEvent;
                    const savedResolve = pending.resolve;
                    const savedReject = pending.reject;
                    session.pending = null;
                    session.poolKillReason = 'restart';
                    _cliSessions.delete(maxTurnsConvId);
                    killCliSession(session);
                    const revived = getOrCreateCliSession(maxTurnsConvId, session.systemPrompt);
                    revived.queue.push({
                        prompt: 'Continue.',
                        onEvent: savedOnEvent,
                        resolve: savedResolve,
                        reject: savedReject,
                        attempt: 0,
                    });
                    processNextQueuedTurn(revived);
                    return;
                }
                // Surface CLI-reported turn failures (auth/credit/etc.) instead of
                // leaking the raw error result as a normal assistant reply. A persistent
                // stream-json session does NOT exit non-zero on these — it emits an
                // is_error result and stays alive — so the process-close auth detector
                // below never sees them. `max_turns` already returned above; exclude its
                // error variant so auto-continue behavior is unchanged.
                const isMaxTurnsResult = event.subtype === 'max_turns' || event.subtype === 'error_max_turns' || event.stop_reason === 'max_turns';
                if (!isMaxTurnsResult && (event.is_error === true || event.subtype === 'error_during_execution')) {
                    const raw = (typeof event.result === 'string' && event.result.trim()) || event.subtype || 'unknown error';
                    const classified = classifyClaudeCliError(raw);
                    const errMsg = classified || `Claude CLI error: ${raw}`;
                    // Flag the signed-out / connection state so the chat banner appears.
                    if (classified === CLAUDE_CLI_AUTH_REMEDIATION || classified === CLAUDE_CLI_CONNECTION_REMEDIATION) {
                        markClaudeCliAuthBad(classified);
                    }
                    console.error(`[CLI pool] result is_error (${event.subtype || 'error'}) — ${errMsg}`);
                    pending.onEvent({ type: 'error', error: errMsg });
                    if (pending.timeout)
                        clearTimeout(pending.timeout);
                    pending.reject(new Error(errMsg));
                    session.pending = null;
                    session.lastActivityAt = Date.now();
                    session.turnCount++;
                    armIdleTimer(session);
                    processNextQueuedTurn(session);
                    return;
                }
                pending.onEvent({ type: 'usage', usage: pending.finalUsage });
                pending.onEvent({ type: 'done', usage: pending.finalUsage });
                if (pending.timeout)
                    clearTimeout(pending.timeout);
                const text = pending.fullText;
                if (text && text.trim())
                    markClaudeCliAuthOk(); // a real completion → CLI is authenticated
                pending.resolve(text);
                session.pending = null;
                session.lastActivityAt = Date.now();
                session.turnCount++;
                // Track cache read tokens and recycle pool if over budget
                const cacheRead = pending.finalUsage?.cacheReadTokens || 0;
                if (cacheRead > 0)
                    session.lastCacheReadTokens = cacheRead;
                if (CLI_POOL_TOKEN_BUDGET > 0 && cacheRead > CLI_POOL_TOKEN_BUDGET) {
                    console.error(`[CLI pool recycle] Cache read ${cacheRead} > budget ${CLI_POOL_TOKEN_BUDGET} ` +
                        `after ${session.turnCount} turns — recycling ${session.conversationId.substring(0, 8)}`);
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
    session.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (!msg)
            return;
        session.stderrBuffer += msg + '\n';
        console.error(`[CLI pool stderr] ${msg}`);
        // Reactive compaction: detect context length errors from CLI stderr
        const isContextError = /prompt.too.long|context.length|token.*limit|request too large|maximum context/i.test(msg);
        if (isContextError && session.pending && !session._compactionAttempted) {
            session._compactionAttempted = true;
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
            if (session.pending.timeout)
                clearTimeout(session.pending.timeout);
            // Vanishing-response fix (2026-07-04): if text already STREAMED to the
            // user before the process died (crash, external kill, recycle), rescue
            // it exactly like the turn-timeout path — resolve with the partial so
            // the caller persists it to conversation history. Rejecting here fired
            // an error event AND triggered the single-shot fallback re-run, while
            // the streamed bubble evaporated on the next render because nothing had
            // been persisted. Textless failures keep the error path (auth
            // remediation / fallback both depend on the rejection).
            const partialOnClose = session.pending.fullText?.trim() || '';
            if (partialOnClose) {
                session.pending.onEvent({ type: 'status', status: `Claude CLI exited mid-turn (code ${code}) — partial answer preserved.` });
                session.pending.onEvent({ type: 'done' });
                session.pending.resolve(partialOnClose);
                session.pending = null;
            }
            else {
                // Detect auth/billing failures from accumulated stderr so we surface a
                // meaningful, actionable message instead of the raw "exited with code N"
                // error. Shared classifier with the result-event handler above.
                const remediation = code !== 0 ? classifyClaudeCliError(session.stderrBuffer) : null;
                if (remediation) {
                    if (remediation === CLAUDE_CLI_AUTH_REMEDIATION || remediation === CLAUDE_CLI_CONNECTION_REMEDIATION) {
                        markClaudeCliAuthBad(remediation);
                    }
                    session.pending.onEvent({ type: 'error', error: remediation });
                    session.pending.reject(new Error(remediation));
                }
                else {
                    const err = new Error(`claude CLI exited with code ${code}`);
                    session.pending.onEvent({ type: 'error', error: err.message });
                    session.pending.reject(err);
                }
                session.pending = null;
            }
        }
        while (session.queue.length > 0) {
            const q = session.queue.shift();
            q.reject(new Error(`claude CLI unavailable (exit code ${code})`));
        }
        killCliSession(session);
    });
}
/**
 * Tier 3 chat-latency fix (2026-05-12) — anonymous warm CLI pool.
 *
 * Cold-spawning the Claude CLI on first turn costs ~5-8s. Existing warmup
 * fires when the user switches to a conversation in the UI, but the FIRST EVER
 * new chat (e.g. "+ new conversation" or first /chat after boot) still cold-spawns.
 *
 * Strategy: pre-spawn 1 anonymous session at gateway boot with the default
 * system prompt. When a new conversation arrives whose system prompt matches,
 * "adopt" the warm session by rekeying it in `_cliSessions`, then refill the
 * warm pool in the background. First-new-chat goes from ~5-8s cold to ~ms warm.
 *
 * Adoption is gated on exact systemPrompt equality — same recipe is used on
 * both ends (`bootstrap + getSystemPrompt()`), so the default-conversation
 * shape matches. Mismatches just fall through to a fresh spawn.
 */
const _warmAnonymousSessions = [];
const WARM_POOL_TARGET_SIZE = parseInt(process.env.VODOU_GATEWAY_WARM_POOL_SIZE || '1', 10);
const WARM_POOL_DISABLED = process.env.VODOU_GATEWAY_DISABLE_WARM_POOL === '1';
function buildDefaultSystemPromptForWarm() {
    const bootstrap = getWorkspaceBootstrap();
    return bootstrap ? bootstrap + '\n\n---\n\n' + getSystemPrompt() : getSystemPrompt();
}
function spawnWarmAnonymousSession() {
    if (WARM_POOL_DISABLED)
        return;
    if (_warmAnonymousSessions.length >= WARM_POOL_TARGET_SIZE)
        return;
    try {
        if (!resolveBinPath(CLAUDE_BIN))
            throw new Error('claude not found'); // cross-platform (was `which`, Unix-only)
    }
    catch {
        return; // claude not installed; chat path will surface install hint
    }
    const sentinelId = `__warm__-${Math.random().toString(36).slice(2, 10)}`;
    const systemPrompt = buildDefaultSystemPromptForWarm();
    const env = freshEnv();
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    env.PWD = agentCwd(); // claude CLI reports $PWD as its working dir — keep it == cwd (CLI launch-dir support)
    const args = buildPersistentCliArgs(systemPrompt);
    // C2: this warm-pool spawn is fire-and-forget (not awaited), so a synchronous
    // throw would be an uncaughtException → gateway crash. Guard it.
    let proc;
    try {
        proc = spawn(CLAUDE_BIN, args, {
            windowsHide: true, // claude/kimi/hook are console apps — detached:true would allocate a visible console on Windows
            env,
            cwd: agentCwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32', // unix: own process group (SIGTERM survival). win32: DETACHED_PROCESS makes CreateProcess IGNORE CREATE_NO_WINDOW → visible claude console; children survive parent exit on Windows anyway
        });
    }
    catch (err) {
        console.error(`[CLI warm-pool] Spawn threw synchronously: ${err.message}`);
        return;
    }
    proc.unref(); // don't block gateway exit on warm pool subprocess lifetime
    proc.on('error', (err) => {
        console.error(`[CLI warm-pool] Spawn error: ${err.message}`);
        const idx = _warmAnonymousSessions.findIndex((s) => s.proc === proc);
        if (idx >= 0)
            _warmAnonymousSessions.splice(idx, 1);
    });
    const stdin = proc.stdin;
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (!stdin || !stdout || !stderr) {
        console.error('[CLI warm-pool] spawn: missing stdio pipes');
        return;
    }
    const session = {
        conversationId: sentinelId,
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
        // Warm sessions are pre-spawned with no project context → install root. They can
        // therefore only be adopted by Default-project turns (matching cwd); a project turn
        // skips warm adoption and spawns fresh at the project dir (getOrCreateCliSession).
        spawnCwd: agentCwd(),
    };
    wireCliSessionStreams(session);
    _warmAnonymousSessions.push(session);
    _cliPoolStats.pool_spawned++;
    console.error(`[CLI warm-pool] Pre-spawned anonymous session pid=${proc.pid} (size=${_warmAnonymousSessions.length}/${WARM_POOL_TARGET_SIZE})`);
}
/**
 * Try to adopt a warm anonymous session for the given conversation. Returns
 * the adopted session if systemPrompt matches and one is available, else null.
 * Caller is responsible for inserting into `_cliSessions` and arming idle timer.
 */
function tryAdoptWarmAnonymousSession(conversationId, systemPrompt, desiredCwd) {
    if (WARM_POOL_DISABLED)
        return null;
    // Persona/skill conversations need a fresh subprocess spawned with their SKILL.md
    // as the system prompt arg. Warm sessions were pre-spawned with the workspace
    // bootstrap prompt — adopting one would leave the persona with the wrong identity.
    if (conversationId.startsWith('workbench:skill:') || conversationId.startsWith('skill-')) {
        console.error(`[CLI warm-pool] Skipping warm adoption for skill/persona conv ${conversationId.substring(0, 24)} — needs fresh spawn`);
        return null;
    }
    // PLAN-GATEWAY-PROJECTS Phase 2 — only adopt a warm session whose cwd matches what this
    // turn needs. Warm sessions spawn at the install root, so a project turn (different root)
    // must spawn fresh; otherwise its files would land in the install dir, not the project.
    const idx = _warmAnonymousSessions.findIndex((s) => s.proc.exitCode === null && (desiredCwd === undefined || s.spawnCwd === desiredCwd));
    if (process.env.VODOU_PROJ_CWD_DIAG === '1') {
        console.error(`[proj-cwd DIAG] tryAdopt conv=${conversationId.substring(0, 14)} desiredCwd=${desiredCwd ?? '(any)'} warmCwds=[${_warmAnonymousSessions.map((s) => s.spawnCwd).join(',')}] matched=${idx >= 0}`);
    }
    if (idx < 0)
        return null;
    const session = _warmAnonymousSessions.splice(idx, 1)[0];
    session.conversationId = conversationId;
    session.systemPrompt = systemPrompt; // update to fresh bootstrap at adoption time
    _cliPoolStats.pool_reused++;
    console.error(`[CLI warm-pool] Adopted anonymous session for ${conversationId.substring(0, 8)} pid=${session.proc.pid} (remaining=${_warmAnonymousSessions.length})`);
    // Refill in background so the next new conversation is also warm.
    setImmediate(() => spawnWarmAnonymousSession());
    return session;
}
/**
 * Kick off the warm pool at gateway startup. Called from index.ts after the
 * server starts listening so it doesn't block boot.
 */
export function kickstartWarmCliPool() {
    if (WARM_POOL_DISABLED) {
        console.error('[CLI warm-pool] disabled via VODOU_GATEWAY_DISABLE_WARM_POOL=1');
        return;
    }
    // Defer one tick so the gateway is fully up before we spend the spawn budget.
    setTimeout(() => {
        for (let i = 0; i < WARM_POOL_TARGET_SIZE; i++) {
            spawnWarmAnonymousSession();
        }
    }, 250);
}
/**
 * Kill all active and warm CLI sessions on gateway shutdown.
 * Call from cleanup() BEFORE process.exit() so sessions get proper SIGTERM
 * with poolKillReason='shutdown' — prevents the close handler from emitting
 * spurious "claude CLI exited with code 143" errors to any in-flight requests.
 */
export function shutdownCliPool() {
    for (const session of _cliSessions.values()) {
        session.poolKillReason = 'shutdown';
        if (session.pending) {
            if (session.pending.timeout)
                clearTimeout(session.pending.timeout);
            // Vanishing-response fix (2026-07-04): a gateway restart mid-turn used
            // to silently drop whatever had streamed — the browser bubble died with
            // the WS and nothing was in the DB. The caller's promise won't survive
            // the process, so persist directly here (better-sqlite3 is synchronous;
            // safe inside SIGTERM cleanup) with an explicit interruption marker.
            const partial = session.pending.fullText?.trim() || '';
            if (partial) {
                try {
                    getConversationManager().addAssistantMessage(session.conversationId, [
                        { type: 'text', text: `${partial}\n\n*(response interrupted by a gateway restart — ask again to continue)*` },
                    ]);
                    console.error(`[CLI pool] shutdown: preserved ${partial.length} chars of in-flight response for ${session.conversationId.substring(0, 8)}`);
                }
                catch { /* shutdown must never throw */ }
            }
            session.pending = null;
        }
        killCliSession(session);
    }
    _cliSessions.clear();
    for (const session of _warmAnonymousSessions) {
        session.poolKillReason = 'shutdown';
        killCliSession(session);
    }
    _warmAnonymousSessions.length = 0;
}
function getOrCreateCliSession(conversationId, systemPrompt, isolated = false) {
    // PLAN-GATEWAY-PROJECTS Phase 2 — the cwd this turn needs (project root via async
    // context, or install root for Default). A pooled session spawned at a different cwd
    // must be recycled so claude-cli's native file tools root at the right directory.
    const desiredCwd = isolated ? os.tmpdir() : agentCwd();
    // [proj-cwd DIAG] kept (gated) — proved the per-project spawn cwd is computed correctly;
    // invaluable if file-routing ever regresses. Enable with VODOU_PROJ_CWD_DIAG=1.
    if (process.env.VODOU_PROJ_CWD_DIAG === '1') {
        console.error(`[proj-cwd DIAG] getOrCreate conv=${conversationId.substring(0, 14)} desiredCwd=${desiredCwd} ctxRoot=${projectContextRoot() ?? '(none)'} existing=${_cliSessions.get(conversationId) ? 'y@' + _cliSessions.get(conversationId).spawnCwd : 'n'}`);
    }
    const existing = _cliSessions.get(conversationId);
    if (existing) {
        if (existing.cliModel !== CLI_MODEL) {
            console.error(`[CLI pool] Model changed (${existing.cliModel} -> ${CLI_MODEL}); restarting session ${conversationId.substring(0, 8)}`);
            _cliSessions.delete(conversationId);
            _cliPoolStats.pool_restarts++;
            existing.poolKillReason = 'restart';
            killCliSession(existing);
        }
        else if (existing.spawnCwd !== desiredCwd) {
            console.error(`[CLI pool] Project cwd changed (${existing.spawnCwd} -> ${desiredCwd}); restarting session ${conversationId.substring(0, 8)}`);
            _cliSessions.delete(conversationId);
            _cliPoolStats.pool_restarts++;
            existing.poolKillReason = 'restart';
            killCliSession(existing);
        }
        else 
        // Default to reusing the same warm process to avoid cold starts on every turn.
        // Some context fields (bootstrap/memory) naturally vary by message.
        if (existing.systemPrompt !== systemPrompt) {
            if (restartPoolOnSystemPromptChange()) {
                console.error(`[CLI pool] System prompt changed; restarting session ${conversationId.substring(0, 8)}`);
                _cliSessions.delete(conversationId);
                _cliPoolStats.pool_restarts++;
                existing.poolKillReason = 'restart';
                killCliSession(existing);
            }
            else {
                console.error(`[CLI pool] Reusing session ${conversationId.substring(0, 8)} pid=${existing.proc.pid}`);
                _cliPoolStats.pool_reused++;
                return existing;
            }
        }
        else {
            console.error(`[CLI pool] Reusing session ${conversationId.substring(0, 8)} pid=${existing.proc.pid}`);
            _cliPoolStats.pool_reused++;
            return existing;
        }
    }
    // Tier 3: try to adopt a warm anonymous session before paying cold-spawn cost.
    // Only when the warm session's cwd matches what this turn needs — warm sessions are
    // pre-spawned at the install root, so a project turn (different cwd) skips adoption
    // and spawns fresh below, rooted at the project directory.
    const adopted = tryAdoptWarmAnonymousSession(conversationId, systemPrompt, desiredCwd);
    if (adopted) {
        armIdleTimer(adopted);
        _cliSessions.set(conversationId, adopted);
        return adopted;
    }
    const env = freshEnv();
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY; // force Max OAuth path
    // Isolated sessions (workflow LLM calls) run in tmpdir with no tools so
    // Claude generates text only and doesn't spin up Bash research loops.
    const args = isolated
        ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
            '--verbose', '--include-partial-messages', '--no-session-persistence',
            '--settings', '{"hooks":{}}', '--model', CLI_MODEL,
            '--max-turns', '1', '--dangerously-skip-permissions',
            '--allowedTools', 'none',
            ...systemPromptFileArgs(systemPrompt || 'You are a helpful assistant. Be concise and direct.')]
        : buildPersistentCliArgs(systemPrompt, projectJailRoot(desiredCwd));
    const spawnCwd = desiredCwd;
    env.PWD = spawnCwd; // claude CLI reports $PWD as its working dir — keep it == cwd (CLI launch-dir support)
    delete env.VODOU_PROJECT_PATH; // prevent project-root inheritance in isolated sessions
    // PLAN-PROJECT-FS-JAIL — confine this session's file tools to the project root.
    // Session identity already keys on spawnCwd (recycled on project switch), so the
    // jail env is stable for the session's whole life.
    const _jailRoot = projectJailRoot(desiredCwd);
    if (_jailRoot) {
        env.VODOU_PROJECT_JAIL_ROOT = _jailRoot;
        env.VODOU_INSTALL_ROOT = getProjectRoot(); // hook allows Bash access to vodou-core tooling
    }
    const proc = spawn(CLAUDE_BIN, args, {
        windowsHide: true, // claude/kimi/hook are console apps — detached:true would allocate a visible console on Windows
        env,
        cwd: spawnCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // unix: own process group (SIGTERM survival). win32: DETACHED_PROCESS makes CreateProcess IGNORE CREATE_NO_WINDOW → visible claude console; children survive parent exit on Windows anyway
    });
    proc.unref(); // don't block gateway exit; cleanup() kills explicitly via killCliSession
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
    const session = {
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
        spawnCwd,
    };
    wireCliSessionStreams(session);
    armIdleTimer(session);
    _cliSessions.set(conversationId, session);
    _cliPoolStats.pool_spawned++;
    console.error(`[CLI pool] Spawned session for ${conversationId.substring(0, 8)} pid=${proc.pid}`);
    return session;
}
// PLAN-GATEWAY-PROJECTS Phase 2 — concurrency hardening for per-project file roots.
//
// Claude Code intermittently resolves a relative write against the install root (itself a
// .claude project) when two `claude` instances START into marker-less project dirs at the
// same instant — a race INSIDE claude-cli, not our cwd logic (proven correct by DIAG). We
// can't fix claude-cli, but we can stop two non-Default project subprocesses from spawning
// simultaneously: serialize their spawns and hold the slot through claude-cli's startup
// settle window so the second begins only after the first is past the racy init.
//
// Scope is deliberately narrow: Default turns (warm pool, install root) are NOT serialized,
// and session REUSE (no spawn) is never gated — only fresh spawns into a non-install root.
const PROJECT_SPAWN_SETTLE_MS = parseInt(process.env.VODOU_PROJECT_SPAWN_SETTLE_MS || '1200', 10);
let _projectSpawnChain = Promise.resolve();
/** True iff a fresh claude-cli spawn into a NON-Default project dir is imminent for this conv. */
function projectSpawnImminent(conversationId, desiredCwd) {
    if (desiredCwd === getProjectRoot())
        return false; // Default root → no serialization
    const existing = _cliSessions.get(conversationId);
    if (existing && existing.cliModel === CLI_MODEL && existing.spawnCwd === desiredCwd)
        return false; // reuse, no spawn
    return true; // will cold-spawn into a project dir
}
/** Run `fn` (the spawn) as the sole project-spawner; hold the slot through the settle window. */
async function withProjectSpawnSlot(fn) {
    const prev = _projectSpawnChain;
    let release;
    _projectSpawnChain = new Promise((r) => { release = r; });
    await prev.catch(() => { });
    try {
        return fn();
    }
    finally {
        // Release after a settle delay so the NEXT project spawn starts only once this
        // claude-cli is past its racy startup (cwd/project resolution). Non-blocking.
        setTimeout(release, PROJECT_SPAWN_SETTLE_MS);
    }
}
async function chatWithCLIPooled(conversationId, prompt, onEvent, systemPrompt) {
    const desiredCwd = agentCwd();
    const session = projectSpawnImminent(conversationId, desiredCwd)
        ? await withProjectSpawnSlot(() => getOrCreateCliSession(conversationId, systemPrompt))
        : getOrCreateCliSession(conversationId, systemPrompt);
    return new Promise((resolve, reject) => {
        session.queue.push({ prompt, onEvent, resolve, reject });
        processNextQueuedTurn(session);
    });
}
/**
 * Chat using Claude CLI — BrainLoader results are included in the prompt.
 * Claude's job is purely conversational — interpret results, answer questions.
 */
async function chatWithCLI(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    // Check if Claude CLI is actually installed
    try {
        if (!resolveBinPath(CLAUDE_BIN))
            throw new Error('claude not found'); // cross-platform (was `which`, Unix-only)
    }
    catch {
        const installMsg = `**Claude CLI not found.**\n\nYour LLM provider is set to "Claude CLI" but the \`claude\` command isn't installed.\n\n` +
            claudeInstallInstructionsMd() + `\n\n` +
            `**Or switch providers** in Settings (sidebar) — you can use Anthropic API, OpenAI, Ollama (free/local), or others.`;
        onEvent({ type: 'text', content: installMsg });
        onEvent({ type: 'done' });
        return installMsg;
    }
    const conversations = getConversationManager();
    const cliMessage = channelAttachments?.length && channelAttachments.length > 0
        ? appendChannelAttachmentHints(message, channelAttachments)
        : message;
    conversations.addUserMessage(conversationId, cliMessage);
    // Proactive compaction before building prompt
    maybeProactiveCompact(conversationId, onEvent);
    // A.5 bootstrap-once: when an existing warm CLI session has already received
    // bootstrap + history on a prior turn (turnCount > 0), the in-process claude
    // already holds the conversation state. Skip re-feeding <conversation_history>
    // — saves ~8-10k tokens per warm turn. Falls back to full payload on cold
    // spawn, recycle, idle-kill, crash, or any path where session is missing/fresh.
    // Per-prompt fresh content (Vodou tool results, scope, user msg) still flows.
    const bootstrapOnceEnabled = process.env.VODOU_CONVO_BOOTSTRAP_ONCE !== '0';
    const existingSession = _cliSessions.get(conversationId);
    const isWarmReuse = bootstrapOnceEnabled
        && !!existingSession
        && existingSession.turnCount > 0
        && !existingSession.proc.killed
        && existingSession.proc.exitCode === null;
    if (isWarmReuse) {
        console.error(`[A.5] warm reuse ${conversationId.substring(0, 8)} turn=${existingSession.turnCount + 1} — skipping <conversation_history> block`);
    }
    // Phase 4 — convo_recall tool reference prepended on cold path only. The
    // first turn of every conversation goes through this branch (including
    // adopted anonymous sessions where turnCount=0), so claude sees the tool
    // description once and remembers it for the warm turns that follow.
    const convoRecallToolBlock = (process.env.VODOU_CONVO_RECALL_TOOL !== '0' && !isWarmReuse)
        ? `<convo_recall_tool>
When the user references something discussed earlier in THIS conversation that you
do not have in your current context window, you can search this conversation's full
history before answering. Run via Bash from the project root:

\`node MCP-servers/Vodou-Console/scripts/convo-recall.mjs '${conversationId}' '<search query>' [limit=5]\`

The tool returns JSON: {results: [{id, role, content, created_at, rank}], count}.
Lower rank = more relevant. Use it only when the user clearly references prior
work and you cannot find it in the recent turns — do NOT call it on every prompt.
</convo_recall_tool>

`
        : '';
    const fullPrompt = convoRecallToolBlock + (isWarmReuse ? cliMessage : formatConversationForCLI(conversationId, cliMessage));
    // Build system prompt — cached per conversation for stability + Anthropic prompt caching.
    // Skill mode always builds fresh (skill content is the system prompt).
    let systemPrompt;
    if (skillSystemPromptOverride) {
        const contextParts = [memoryContext].filter(Boolean).join('\n\n');
        systemPrompt = contextParts
            ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
            : skillSystemPromptOverride;
        if (!_bootstrappedConversations.has(conversationId)) {
            _bootstrappedConversations.add(conversationId);
        }
        console.error(`[SkillRunner] Using skill system prompt for ${conversationId.substring(0, 8)} (${skillSystemPromptOverride.length} chars)`);
    }
    else {
        // Check cached system prompt — stable across turns
        const cached = _cachedSystemPrompts.get(conversationId);
        if (cached && cached.lensesEnabled === lensesEnabled && Date.now() - cached.builtAt < SYSTEM_PROMPT_CACHE_MS) {
            systemPrompt = cached.prompt;
            if (!_bootstrappedConversations.has(conversationId)) {
                _bootstrappedConversations.add(conversationId);
            }
            console.error(`[Context] Using cached system prompt for ${conversationId.substring(0, 8)} (${systemPrompt.length} chars, ${Math.round((Date.now() - cached.builtAt) / 1000)}s old)`);
        }
        else {
            // Build fresh system prompt (first message or cache expired)
            // Order: base_prompt + bootstrap (static, cacheable prefix) + memory (dynamic suffix)
            // Anthropic caches the longest matching prefix — static content first maximizes cache hits
            const isFirstMessage = !_bootstrappedConversations.has(conversationId);
            // Heartbeat sessions inject their own context via HEARTBEAT.md in the message body.
            // Sending the full workspace bootstrap (CLAUDE.md + AGENTS.md + MEMORY.md) bloats the
            // context and is a primary cause of the 15-minute CLI hang.
            const isHbConv = _heartbeatConversations.has(conversationId) || conversationId === 'vodou-heartbeat';
            const bootstrap = (isFirstMessage && !isHbConv) ? getWorkspaceBootstrap() : '';
            if (isFirstMessage) {
                _bootstrappedConversations.add(conversationId);
                console.error(`[Context] First message in ${conversationId.substring(0, 8)} — sending full bootstrap (${getWorkspaceBootstrap().length} chars)`);
            }
            else {
                console.error(`[Context] Rebuilding system prompt for ${conversationId.substring(0, 8)} (cache expired)`);
            }
            const staticParts = systemPromptStaticPrefix(bootstrap, lensesEnabled);
            // Fix 2: strip tool results block from system prompt — it's already in <active_context> via oiResults
            const memoryForSystem = (oiResults && memoryContext)
                ? memoryContext.replace(/### Vodou Tool Results[\s\S]+/, '').trim()
                : memoryContext;
            systemPrompt = memoryForSystem
                ? staticParts + '\n\n---\n\n' + memoryForSystem
                : staticParts;
            // Cache it
            _cachedSystemPrompts.set(conversationId, { prompt: systemPrompt, builtAt: Date.now(), lensesEnabled });
        }
    }
    // Scope-aware suffix — appended AFTER the cached prompt body so scope changes
    // (or per-scope instruction edits) take effect immediately without cache bust.
    systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);
    // PLAN-LONG-CONVO-RECALL.md Phase 4 — convo_recall tool reference is injected
    // into the cold-path user-message body below (in fullPrompt assembly), NOT
    // here. Reason: warm anonymous sessions adopted from the pre-spawn pool keep
    // their original --system-prompt arg, so appending here would be invisible to
    // claude. Injecting into the user message body means claude reads it on the
    // first turn of any conversation — including adopted sessions — and retains
    // it in conversation state for subsequent warm turns.
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
    // PLAN-CONTEXT-GROUND-TRUTH — per-turn facts block rides the USER prompt on
    // the CLI path: the system prompt is cached per-conversation and fixed at
    // pooled-session spawn, so facts there would go stale (the original bug).
    // Skipped for menu replies (pure formatting turns, zero tools).
    const _gtBlock = isMenuReply ? '' : groundTruthFor(conversationId);
    if (_gtBlock) {
        userPrompt = `<vodou_ground_truth>\n${_gtBlock}\n</vodou_ground_truth>\n\n${userPrompt}`;
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
                conversations.addAssistantMessage(conversationId, [{ type: 'text', text: pooledText }]);
                saveAssistantToBuffer(pooledText);
            }
            return pooledText;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Timeout errors already delivered an error event to the client — don't
            // compound with a broken single-shot attempt that produces an empty Done.
            if (/timed out/i.test(msg)) {
                console.error(`[CLI pool] turn timed out, skipping single-shot fallback (error already delivered)`);
                return '';
            }
            console.error(`[CLI pool] falling back to single-shot path: ${msg}`);
        }
    }
    return new Promise((resolve, reject) => {
        // Tool exposure is governed by VODOU_GATEWAY_SHELL_MODE (restricted/verify/full).
        // Menu replies still get zero tools — we only want the model to format the next step.
        const _mode = getGatewayShellMode();
        const useStdinUser = useClaudeCliStreamJsonStdin();
        const _oneShotJail = projectJailRoot(agentCwd()); // PLAN-PROJECT-FS-JAIL
        const args = [
            '-p',
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--no-session-persistence',
            '--settings', cliSettingsJson(_oneShotJail),
            '--model', CLI_MODEL,
            '--max-turns', shellModeMaxTurns(_mode, isMenuReply),
            '--dangerously-skip-permissions',
            ...(isMenuReply ? [] : ['--allowedTools', shellModeAllowedTools(_mode)]),
            ...systemPromptFileArgs(systemPrompt),
            ...(useStdinUser ? ['--input-format', 'stream-json'] : []),
            ...(useStdinUser ? [] : [userPrompt]),
        ];
        console.error(`[CLI] Spawning claude -p (${useStdinUser ? 'stdin stream-json user message' : 'argv user prompt'}) for ${conversationId.substring(0, 8)}...`);
        const env = freshEnv();
        delete env.CLAUDECODE;
        // Ensure CLI uses Max subscription OAuth, not API key auth
        delete env.ANTHROPIC_API_KEY;
        env.PWD = agentCwd(); // claude CLI reports $PWD as its working dir — keep it == cwd (CLI launch-dir support)
        if (_oneShotJail) { // PLAN-PROJECT-FS-JAIL
            env.VODOU_PROJECT_JAIL_ROOT = _oneShotJail;
            env.VODOU_INSTALL_ROOT = getProjectRoot();
        }
        // C2: spawn() can throw SYNCHRONOUSLY (e.g. ENAMETOOLONG on Windows, or a
        // bad cwd) BEFORE the async 'error' handler below is attached — that throw
        // would reach process.on('uncaughtException') and kill the whole gateway.
        // Catch it here and route to the same clean per-turn error path.
        let proc;
        try {
            proc = spawn(CLAUDE_BIN, args, {
                windowsHide: true, // claude/kimi/hook are console apps — detached:true would allocate a visible console on Windows
                env,
                cwd: agentCwd(),
                stdio: [useStdinUser ? 'pipe' : 'ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32', // unix-only: DETACHED_PROCESS voids CREATE_NO_WINDOW on win32
            });
        }
        catch (err) {
            const e = err;
            const msg = `Claude CLI spawn failed (${e.code || 'error'}): ${e.message}`;
            console.error(`[CLI direct] ${msg}`);
            try {
                onEvent({ type: 'error', error: msg });
            }
            catch { }
            reject(new Error(msg));
            return;
        }
        proc.unref();
        // CRITICAL: catch spawn errors (notably ENOENT when `claude` isn't on
        // PATH) so they don't crash the entire gateway. Without this listener,
        // Node treats the 'error' event as unhandled and throws — killing the
        // gateway process and every in-flight chat / WS connection with it.
        // The two warm-pool spawn sites already have this; the direct chat
        // spawn was missing it. Reproduced 2026-05-15 in chat — gateway crashed
        // mid-call with `spawn claude ENOENT`.
        proc.on('error', (err) => {
            const msg = err.code === 'ENOENT'
                ? `Claude CLI not found on PATH (\`${CLAUDE_BIN}\`). Install it via \`npm install -g @anthropic-ai/claude-code\` or add it to PATH, then restart the gateway.`
                : `Claude CLI spawn error: ${err.message}`;
            console.error(`[CLI direct] ${msg}`);
            try {
                onEvent({ type: 'error', error: msg });
            }
            catch { }
            // Reject the outer promise so the chat handler returns a clean
            // error to the user instead of hanging until WS timeout.
            reject(new Error(msg));
        });
        const stdout = proc.stdout;
        const stderr = proc.stderr;
        if (!stdout || !stderr) {
            onEvent({ type: 'error', error: 'claude spawn: missing stdio pipes' });
            reject(new Error('claude spawn: missing stdio pipes'));
            return;
        }
        let fullText = '';
        let lastAllText = ''; // last concatenated text from assistant events
        let buffer = '';
        let stderrBuffer = '';
        const seenToolIds = new Set();
        const toolStartTimes = new Map();
        const toolNames = new Map(); // toolId → real tool name (for tool_call_end)
        const cliStartTime = Date.now();
        let finalUsage = undefined;
        let thinkingStatusSent = false;
        // Set on tool-call start, consumed by the next text_delta so a text block
        // resuming after tools gets a `\n\n` break (parity with the assistant path).
        let needsTextSeparator = false;
        stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const event = JSON.parse(line);
                    // Token-level streaming from --include-partial-messages
                    if (event.type === 'stream_event' && event.event) {
                        const se = event.event;
                        if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
                            let text = se.delta.text;
                            if (needsTextSeparator) {
                                needsTextSeparator = false;
                                if (lastAllText && !lastAllText.endsWith('\n'))
                                    text = '\n\n' + text;
                            }
                            onEvent({ type: 'text', content: text });
                            fullText += text;
                            lastAllText += text;
                        }
                        if (se.type === 'content_block_delta' && se.delta?.type === 'thinking_delta') {
                            const th = se.delta.thinking;
                            if (th && !thinkingStatusSent) {
                                thinkingStatusSent = true;
                                onEvent({
                                    type: 'status',
                                    status: 'Model is reasoning (answer will appear when ready)…',
                                });
                            }
                        }
                        // Tool use streaming — create the chip immediately for UI feedback.
                        // Args are empty here; they'll be updated via tool_args_update when the assistant event arrives.
                        if (se.type === 'content_block_start' && se.content_block?.type === 'tool_use') {
                            needsTextSeparator = true;
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
                            .filter((b) => b.type === 'text' && b.text)
                            .map((b) => b.text)
                            .join(''); // '' not '\n': text_delta has no inter-block separator
                        if (allText !== lastAllText) {
                            if (allText.startsWith(lastAllText)) {
                                // Text grew — emit just the new part
                                const delta = allText.substring(lastAllText.length);
                                onEvent({ type: 'text', content: delta });
                                lastAllText = allText;
                            }
                            else if (lastAllText.startsWith(allText)) {
                                // Partial `assistant` JSON behind `text_delta` stream — same fix
                                // as CLI pool path; never splice a shorter snapshot onto the UI.
                            }
                            else {
                                // Text changed completely (new turn after tool use)
                                // Always start on a new line
                                onEvent({ type: 'text', content: '\n\n' + allText });
                                lastAllText = allText;
                            }
                        }
                        fullText = lastAllText;
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
                                toolNames.set(toolId, block.name);
                                if (!seenToolIds.has(toolId)) {
                                    seenToolIds.add(toolId);
                                    if (!toolStartTimes.has(toolId))
                                        toolStartTimes.set(toolId, Date.now());
                                    onEvent({
                                        type: 'tool_call_start',
                                        toolName: block.name,
                                        toolId,
                                        toolArgs: block.input,
                                    });
                                }
                                else if (block.input && Object.keys(block.input).length > 0) {
                                    // Chip already exists (from content_block_start) — update its args
                                    onEvent({
                                        type: 'tool_call_start',
                                        toolName: block.name,
                                        toolId,
                                        toolArgs: block.input,
                                    });
                                }
                            }
                            if (block.type === 'tool_result') {
                                const tid = block.tool_use_id;
                                const startedAt = tid ? toolStartTimes.get(tid) : undefined;
                                const executionTime = startedAt ? Date.now() - startedAt : undefined;
                                if (tid)
                                    toolStartTimes.delete(tid);
                                const content = Array.isArray(block.content)
                                    ? block.content.map((c) => c.text || '').join('')
                                    : typeof block.content === 'string' ? block.content : '';
                                onEvent({
                                    type: 'tool_call_end',
                                    toolName: (tid && toolNames.get(tid)) || 'Bash',
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
                                toolArgs: event.input,
                            });
                        }
                    }
                    if (event.type === 'tool_result') {
                        const tid = event.tool_use_id;
                        const startedAt = tid ? toolStartTimes.get(tid) : undefined;
                        const executionTime = startedAt ? Date.now() - startedAt : undefined;
                        if (tid)
                            toolStartTimes.delete(tid);
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
                            if (block.type !== 'tool_result')
                                continue;
                            const tid = block.tool_use_id;
                            const startedAt = tid ? toolStartTimes.get(tid) : undefined;
                            const executionTime = startedAt ? Date.now() - startedAt : undefined;
                            if (tid)
                                toolStartTimes.delete(tid);
                            const content = Array.isArray(block.content)
                                ? block.content.map((c) => c.text || '').join('')
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
                        // Do NOT emit text from `event.result`. See identical fix in the
                        // CLI-pool path (~line 2840). `lastAllText` resets per-segment in
                        // the `assistant` handler above (lines ~3576–3590), so on any
                        // turn with ≥1 tool call `result.startsWith(lastAllText)` is
                        // false → the old else-branch re-emitted the entire turn
                        // prefixed with `\n\n` (visible duplicate assistant message).
                        // Only harvest usage stats here.
                        if (event.result && typeof event.result === 'string') {
                            fullText = event.result;
                        }
                        // Capture final usage stats from result event
                        const u = event.usage || {};
                        const mu = event.modelUsage ? Object.values(event.modelUsage)[0] : null;
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
                }
                catch {
                    // Ignore partial JSON
                }
            }
        });
        stderr.on('data', (data) => {
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
                conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText }]);
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
            }
            catch (e) {
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
async function chatWithKimiCLI(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    try {
        if (!resolveBinPath(KIMI_BIN))
            throw new Error('kimi not found'); // cross-platform (was `which`, Unix-only)
    }
    catch {
        const installMsg = process.platform === 'win32'
            ? `**Kimi CLI not found.**\n\nThe Kimi Code CLI installer is not yet available for Windows.\n\n` +
                `**Use Kimi (Moonshot API) instead** — switch in Settings and paste a key from https://platform.moonshot.ai/console/api-keys`
            : `**Kimi CLI not found.**\n\n` +
                `**Install:** \`curl -LsSf https://code.kimi.com/install.sh | bash\`\n\n` +
                `Then run \`kimi login\` once (browser OAuth or API key).\n\n` +
                `**Or** use **Kimi (Moonshot API)** in Settings with a key from https://platform.moonshot.ai/console/api-keys\n\n` +
                `Docs: https://moonshotai.github.io/kimi-cli/en/`;
        onEvent({ type: 'text', content: installMsg });
        onEvent({ type: 'done' });
        return installMsg;
    }
    const conversations = getConversationManager();
    const cliMessage = channelAttachments?.length && channelAttachments.length > 0
        ? appendChannelAttachmentHints(message, channelAttachments)
        : message;
    conversations.addUserMessage(conversationId, cliMessage);
    maybeProactiveCompact(conversationId, onEvent);
    const fullPrompt = formatConversationForCLI(conversationId, cliMessage);
    let systemPrompt;
    if (skillSystemPromptOverride) {
        const contextParts = [memoryContext].filter(Boolean).join('\n\n');
        systemPrompt = contextParts
            ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
            : skillSystemPromptOverride;
        if (!_bootstrappedConversations.has(conversationId)) {
            _bootstrappedConversations.add(conversationId);
        }
        console.error(`[KimiCLI] skill system prompt for ${conversationId.substring(0, 8)}`);
    }
    else {
        const cached = _cachedSystemPrompts.get(conversationId);
        if (cached && cached.lensesEnabled === lensesEnabled && Date.now() - cached.builtAt < SYSTEM_PROMPT_CACHE_MS) {
            systemPrompt = cached.prompt;
            if (!_bootstrappedConversations.has(conversationId)) {
                _bootstrappedConversations.add(conversationId);
            }
        }
        else {
            const isFirstMessage = !_bootstrappedConversations.has(conversationId);
            const bootstrap = isFirstMessage ? getWorkspaceBootstrap() : '';
            if (isFirstMessage) {
                _bootstrappedConversations.add(conversationId);
            }
            const staticParts = systemPromptStaticPrefix(bootstrap, lensesEnabled);
            const memoryForSystem = (oiResults && memoryContext)
                ? memoryContext.replace(/### Vodou Tool Results[\s\S]+/, '').trim()
                : memoryContext;
            systemPrompt = memoryForSystem ? staticParts + '\n\n---\n\n' + memoryForSystem : staticParts;
            _cachedSystemPrompts.set(conversationId, { prompt: systemPrompt, builtAt: Date.now(), lensesEnabled });
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
    // PLAN-CONTEXT-GROUND-TRUTH — per-turn facts block on the user side (kimi-cli
    // is a one-shot spawn per turn, but system prompt here reuses the cached
    // claude-cli prompt map — keep the channel consistent with chatWithCLI).
    const _gtBlockKimi = isMenuReply ? '' : groundTruthFor(conversationId);
    if (_gtBlockKimi) {
        userPrompt = `<vodou_ground_truth>\n${_gtBlockKimi}\n</vodou_ground_truth>\n\n${userPrompt}`;
    }
    const _shellMode = getGatewayShellMode();
    if (hasBrainResults && !isMenuReply && shellModeInjectsVodouCoreGuard(_shellMode)) {
        userPrompt +=
            '\n\n<instruction>Vodou already executed tools and returned results above. If you need additional data, you may ONLY use Bash to run vodou-core commands (e.g. `./vodou-core call <server> <tool> \'{"arg":"value"}\'`). Do NOT run general shell commands, file reads, grep, find, or codebase exploration. Focus on interpreting the Vodou results for the user.</instruction>';
    }
    const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
    const timeoutMs = parseInt(process.env.VODOU_GATEWAY_KIMI_CLI_TIMEOUT_MS || '120000', 10);
    return new Promise((resolve, reject) => {
        // PLAN-SKILL-LEARNING-LOOP Phase 1A — kimi-cli is a first-class CLI provider
        // (peer of claude-cli) that reaches vodou tools via Bash `./vodou-core call`.
        // To capture trajectories we need structured events, so opt into kimi's
        // `--output-format stream-json` (drops --final-message-only) and parse it like
        // the claude-cli path, reusing normalizeCliToolStep. Gated behind a setting so
        // the proven text path stays the default until verified on a kimi-installed
        // box (kimi binary isn't present in all dev envs). Flush is handled uniformly
        // by dispatchToProvider; capture keys on conversationId (in scope — one-shot
        // process per turn, no pooling).
        const captureMode = process.env.VODOU_KIMI_STREAM_CAPTURE === '1'
            || getSetting('kimi_cli_stream_capture') === '1';
        const args = captureMode
            ? ['--print', '--output-format', 'stream-json', '--yolo', '--model', kimiCliModel, '-p', combined]
            : ['--print', '--output-format', 'text', '--final-message-only', '--yolo', '--model', kimiCliModel, '-p', combined];
        const env = { ...freshEnv(), ...freshEnvVars(), PWD: agentCwd() }; // PWD == cwd for CLI launch-dir support
        const proc = spawn(KIMI_BIN, args, {
            windowsHide: true, // claude/kimi/hook are console apps — detached:true would allocate a visible console on Windows
            env,
            cwd: agentCwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let errBuf = '';
        let lineBuf = '';
        const kimiToolMeta = new Map();
        let to;
        if (timeoutMs > 0) {
            to = setTimeout(() => {
                try {
                    proc.kill('SIGTERM');
                }
                catch { }
            }, timeoutMs);
        }
        const recordKimiResult = (tid, isErr) => {
            const meta = kimiToolMeta.get(tid);
            if (!meta)
                return;
            kimiToolMeta.delete(tid);
            const ms = Date.now() - meta.startMs;
            for (const norm of normalizeCliToolSteps(meta.tool, meta.args)) {
                recordTrajectoryStep(conversationId, { ...norm, ok: !isErr, ms });
            }
            onEvent({ type: 'tool_call_end', toolName: meta.tool, toolId: tid, success: !isErr, executionTime: ms });
        };
        proc.stdout?.on('data', (d) => {
            const chunk = d.toString();
            if (!captureMode) {
                out += chunk;
                onEvent({ type: 'text', content: chunk });
                return;
            }
            // stream-json (JSONL): best-effort parse mirroring the claude-cli shapes.
            // Defensive: unknown shapes are ignored; the `result` event backfills text
            // so the user still gets an answer even if delta shapes differ.
            lineBuf += chunk;
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                let ev;
                try {
                    ev = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.text) {
                    out += ev.event.delta.text;
                    onEvent({ type: 'text', content: ev.event.delta.text });
                }
                else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
                    for (const b of ev.message.content) {
                        if (b.type === 'tool_use' && b.name) {
                            const tid = b.id || `${b.name}_${Date.now()}`;
                            if (!kimiToolMeta.has(tid)) {
                                kimiToolMeta.set(tid, { tool: b.name, args: b.input ?? {}, startMs: Date.now() });
                                onEvent({ type: 'tool_call_start', toolName: b.name, toolId: tid, toolArgs: b.input });
                            }
                        }
                    }
                }
                if (ev.type === 'tool_result' && ev.tool_use_id)
                    recordKimiResult(ev.tool_use_id, !!ev.is_error);
                if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
                    for (const b of ev.message.content) {
                        if (b.type === 'tool_result' && b.tool_use_id)
                            recordKimiResult(b.tool_use_id, !!b.is_error);
                    }
                }
                if (ev.type === 'result' && typeof ev.result === 'string' && !out.trim())
                    out = ev.result;
            }
        });
        proc.stderr?.on('data', (d) => {
            errBuf += d.toString();
        });
        proc.on('close', (code) => {
            if (to)
                clearTimeout(to);
            const trimmed = out.trim();
            if (code !== 0 && !trimmed) {
                const fail = `**Kimi CLI failed** (exit ${code})\n\n` +
                    (errBuf.trim().slice(0, 1200) || 'No output. Run `kimi login` or switch to **Kimi (Moonshot API)** in Settings.');
                onEvent({ type: 'text', content: fail });
                onEvent({ type: 'done' });
                resolve(fail);
                return;
            }
            if (trimmed) {
                conversations.addAssistantMessage(conversationId, [{ type: 'text', text: trimmed }]);
                saveAssistantToBuffer(trimmed);
            }
            onEvent({ type: 'done' });
            resolve(trimmed);
        });
        proc.on('error', (err) => {
            if (to)
                clearTimeout(to);
            onEvent({ type: 'error', error: err.message });
            reject(err);
        });
    });
}
// --- SDK mode implementation ---
async function chatWithSDK(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    const conversations = getConversationManager();
    // PLAN 0.6.4 §4.3: FS tools gate on (flag ON && web-chat source). One source
    // read drives both the system-prompt block and the tools array on this path.
    const convSource = getConversation(conversationId)?.source ?? null;
    const fsActive = fsToolsActive(convSource, conversationId);
    const fsTargetedEdits = fsActive && modelCapabilities(MODEL).editFormat === 'targeted'; // #8 §1.3
    const isColdSdk = !_bootstrappedConversations.has(conversationId);
    const baseText = buildApiRecallBlock(conversationId, isColdSdk) + buildUserPromptWithOIResults(message, oiResults);
    const userContent = channelAttachments?.length && channelAttachments.length > 0
        ? buildAnthropicUserContent(baseText, channelAttachments)
        : baseText;
    conversations.addUserMessage(conversationId, userContent);
    // Proactive compaction before API call
    maybeProactiveCompact(conversationId, onEvent);
    // Build system prompt — skill mode uses skill content directly
    let systemPrompt;
    if (skillSystemPromptOverride) {
        const contextParts = [memoryContext].filter(Boolean).join('\n\n');
        systemPrompt = contextParts
            ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
            : skillSystemPromptOverride;
        if (!_bootstrappedConversations.has(conversationId))
            _bootstrappedConversations.add(conversationId);
        console.error(`[SkillRunner] SDK mode — skill system prompt for ${conversationId.substring(0, 8)}`);
    }
    else {
        const isFirstMsg = !_bootstrappedConversations.has(conversationId);
        const bootstrap = isFirstMsg ? getWorkspaceBootstrap() : '';
        if (isFirstMsg)
            _bootstrappedConversations.add(conversationId);
        const staticParts = systemPromptStaticPrefix(bootstrap, lensesEnabled, fsActive, fsTargetedEdits);
        const memoryForSystem = (oiResults && memoryContext)
            ? memoryContext.replace(/### Vodou Tool Results[\s\S]+/, '').trim()
            : memoryContext;
        systemPrompt = memoryForSystem
            ? staticParts + '\n\n---\n\n' + memoryForSystem
            : staticParts;
    }
    systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);
    const messages = conversations.getMessages(conversationId);
    const skipTools = isMenuReplyCheck(message);
    // B2 abort seam: register this turn so the WS `stop` handler can cancel the
    // in-flight SDK stream (abortConversationTurn → index.ts stop handler).
    const _abort = beginConvAbort(conversationId);
    // B2 follow-up (partial-text persistence on Stop): hoisted to function scope so
    // the catch can persist whatever streamed before a user-Stop aborted the SDK
    // stream (finalMessage() rejects, so `response` is unreachable there). Reset
    // before each stream so it only ever holds the in-flight round's text (prior
    // rounds are persisted via response.content). Mirrors the OpenAI-compat fullText.
    let sdkPartialText = '';
    const accumulatePartial = (t) => { sdkPartialText += t; };
    try {
        // B2 follow-up (stop-before-begin race): if Stop landed during the pre-provider
        // window, beginConvAbort started the entry already-aborted. Short-circuit before
        // the first stream so we never open (and bill) a provider call for a turn the
        // user already stopped. End cleanly — the stop handler already acked the client.
        // (finally → endConvAbort tears down the registry entry.)
        if (isConversationAborted(conversationId)) {
            onEvent({ type: 'done' });
            return '';
        }
        const anthropic = getClient();
        const maxToolIter = getMaxToolIterations(conversationId);
        // PLAN-AGENT-LOOP Phase 1: budget adds a one-shot grace round + refund for
        // all-cheap (read-only) rounds so a deep agent-mode turn doesn't burn its
        // depth on file reads. With agent mode OFF, maxToolIter is the base 10 and
        // refunds rarely fire → behavior matches today.
        const budget = makeIterationBudget(maxToolIter);
        let iterations = 0;
        let allText = '';
        // Initial stream — include tools unless it's a menu reply
        const effectiveMaxTokens = getMaxTokens(conversationId);
        // WS3 (PLAN-GATEWAY-STATE-LAYER): Anthropic prompt-cache breakpoints. The direct
        // `anthropic` SDK provider gets ZERO caching without explicit cache_control (only the
        // claude-CLI path caches natively). Breakpoint the tool defs (always byte-stable →
        // ~90%-off cache reads) and the system block. Anthropic's cache order is
        // tools→system→messages, so the tools breakpoint still hits even when volatile memory
        // in `system` changes turn-to-turn. Clone the last tool — never mutate the shared
        // registry objects. usage already surfaces cache_read/creation tokens (the done event).
        // Default ON; VODOU_SDK_CACHE_CONTROL=0 disables.
        const SDK_CACHE = process.env.VODOU_SDK_CACHE_CONTROL !== '0';
        const sdkSystem = SDK_CACHE ? anthropicCacheSystem(systemPrompt) : systemPrompt;
        const cacheTools = (tools) => SDK_CACHE ? anthropicCacheTools(tools) : tools;
        const streamParams = {
            model: MODEL,
            max_tokens: effectiveMaxTokens,
            system: sdkSystem,
            messages: getCompressedMessages(conversationId),
        };
        if (!skipTools)
            streamParams.tools = cacheTools(getAnthropicTools({ source: convSource, model: MODEL, conversationId }));
        const sdkStartTime = Date.now();
        let stream = anthropic.messages.stream(streamParams);
        _abort.sdkStream = stream; // B2: expose .controller.abort() to the stop handler
        sdkPartialText = ''; // reset: holds only the in-flight round's text (prior rounds are persisted via response.content)
        let response = await collectStreamResponse(stream, onEvent, sdkStartTime, accumulatePartial);
        // Tool calling loop — handle tool_use blocks
        // PLAN-SKILL-LEARNING-LOOP Phase 1A — tool calls here are recorded centrally
        // in executeOITool (the shared API-provider sink) keyed by conversationId,
        // and flushed once in dispatchToProvider. No per-loop capture needed.
        while (budget.tryConsume() || budget.useGrace()) {
            const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
            if (toolBlocks.length === 0)
                break;
            // Add assistant message with tool_use blocks to conversation
            conversations.addAssistantMessage(conversationId, response.content);
            // Execute each tool and collect results
            const toolResultContent = [];
            for (const tb of toolBlocks) {
                onEvent({ type: 'tool_call_start', toolName: tb.name, toolId: tb.id, toolArgs: tb.input });
                const result = await executeOITool(tb.name, tb.input, { scope, conversationId, onEvent, activeToolPolicy: activeToolPolicyFor(conversationId) });
                onEvent({
                    type: 'tool_call_end', toolName: tb.name, toolId: tb.id,
                    toolResult: result.output, success: result.success, executionTime: result.executionTime,
                });
                // Track file changes from tool execution
                if (result.success) {
                    const changedFiles = detectFileChanges(tb.name, tb.input, result.output);
                    if (changedFiles.length > 0)
                        addFileChanges(conversationId, changedFiles);
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
            // PLAN-AGENT-LOOP Phase 1: an all-cheap (read-only) round is refunded so it
            // doesn't consume the depth budget.
            if (roundIsRefundable(toolBlocks.map((b) => b.name)))
                budget.refund();
            // B2c: a Stop during tool execution must not fire another billable LLM
            // round. The abort can't cancel this re-stream the usual way (it doesn't
            // exist yet when Stop fires mid-tool), so break before creating it.
            if (isConversationAborted(conversationId))
                break;
            const nextStream = anthropic.messages.stream({
                model: MODEL,
                max_tokens: effectiveMaxTokens,
                system: sdkSystem, // WS3: same cache_control breakpoints across tool rounds
                messages: getCompressedMessages(conversationId),
                tools: cacheTools(getAnthropicTools({ source: convSource, model: MODEL, conversationId })),
            });
            _abort.sdkStream = nextStream; // B2: keep abort handle current across tool rounds
            sdkPartialText = ''; // reset: only the in-flight round's text (prior rounds persisted via response.content)
            response = await collectStreamResponse(nextStream, onEvent, sdkStartTime, accumulatePartial);
            iterations++;
        }
        conversations.addAssistantMessage(conversationId, response.content);
        allText = response.content
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('');
        if (allText) {
            saveAssistantToBuffer(allText);
        }
        onEvent({ type: 'done', usage: {
                inputTokens: response.usage?.input_tokens,
                outputTokens: response.usage?.output_tokens,
                cacheReadTokens: response.usage?.cache_read_input_tokens,
                cacheCreateTokens: response.usage?.cache_creation_input_tokens,
                durationMs: Date.now() - sdkStartTime,
                model: response.model,
            } });
        return allText;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // B2c: a user-initiated Stop aborts the SDK stream (APIUserAbortError). Don't
        // surface it as an error toast, and don't let the context-error heuristic
        // below misdiagnose it as "conversation too long" and fire a billable
        // compaction retry — the stop handler already told the client. End cleanly.
        // (Symmetric with the OpenAI-compat catch; also avoids the compaction
        // recursion re-registering a fresh abort entry.)
        if (isConversationAborted(conversationId)) {
            // B2 follow-up (partial-text persistence on Stop): persist whatever streamed
            // before the abort so the assistant turn pairs with the user turn already in
            // history (otherwise a dangling unpaired user message). Cost stays suppressed
            // — no `usage` event fires on this abort path, and dispatchToProvider drops
            // usage when aborted.
            if (sdkPartialText) {
                conversations.addAssistantMessage(conversationId, [{ type: 'text', text: sdkPartialText }]);
                saveAssistantToBuffer(sdkPartialText);
            }
            onEvent({ type: 'done' });
            return sdkPartialText;
        }
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
                }
                catch (retryError) {
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
    finally {
        endConvAbort(conversationId, _abort);
    }
}
/**
 * Collect streaming response (SDK path)
 */
async function collectStreamResponse(stream, onEvent, startTime, 
// B2 follow-up (partial-text persistence): caller-supplied sink that accumulates
// every text delta so a user-Stop abort (which rejects finalMessage()) can still
// persist what already streamed.
onText) {
    let thinkingStatusSent = false;
    stream.on('text', (text) => {
        if (onText)
            onText(text);
        onEvent({ type: 'text', content: text });
    });
    // Extended-thinking models emit `thinking` before `text`; without this the gateway sends no chunks until the first text delta.
    const s = stream;
    if (typeof s.on === 'function') {
        s.on('thinking', () => {
            if (thinkingStatusSent)
                return;
            thinkingStatusSent = true;
            onEvent({ type: 'status', status: 'Model is reasoning (answer will appear when ready)…' });
        });
    }
    const msg = await stream.finalMessage();
    // Emit usage from final message
    if (msg.usage) {
        onEvent({
            type: 'usage',
            usage: {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheReadTokens: msg.usage.cache_read_input_tokens,
                cacheCreateTokens: msg.usage.cache_creation_input_tokens,
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
function dispatchToProvider(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, 
// PLAN-SKILL-CONSOLE-LOOP §31 — per-skill model override threaded through
// from ChatOptions.preferModel. Optional + last-positional so existing
// callers don't need to change.
preferModelOverride, lensesEnabled = true) {
    // Claude CLI signed-out guard (PLAN-CLAUDE-RECONNECT-BANNER). A logged-out CLI
    // otherwise hangs the turn up to the 15-min timeout. If we've never confirmed
    // auth OR it's known bad, probe `claude auth status` first (cached 8s, and it
    // auto-recovers after a /login). Still bad → return the actionable message now.
    if (currentProvider === 'claude-cli' && (_claudeCliAuth.checkedAt === 0 || !_claudeCliAuth.ok)) {
        if (probeClaudeCliAuthenticated()) {
            markClaudeCliAuthOk();
        }
        else {
            markClaudeCliAuthBad(_claudeCliAuth.message || CLAUDE_CLI_AUTH_REMEDIATION);
            const msg = _claudeCliAuth.message || CLAUDE_CLI_AUTH_REMEDIATION;
            onEvent({ type: 'text', content: msg });
            onEvent({ type: 'done' });
            return Promise.resolve(msg);
        }
    }
    // Phase 2 token tracking — wrap onEvent to intercept the `usage` event
    // emitted at end-of-completion by every provider path. Computes COGS using
    // the provider+model active at dispatch time and POSTs to app.vodou.ai.
    // Fire-and-forget; failures don't block the chat response.
    const dispatchStartMs = Date.now();
    const userId = process.env.VODOU_USER_ID || process.env.OI_USER_ID || 'default_user';
    // BYOK separation: if the user pasted their own API key into Settings, they
    // pay the vendor directly → don't meter against Vodou's quota and don't gate
    // on Vodou's hosted limits. Vodou's own server-side key (VODOU_FIREWORKS_KEY)
    // does NOT count as BYOK — those calls are billed to Vodou and need metering.
    // Managed tier = the explicit branded 'vodou' provider, period. Picking it
    // means "use Vodou's key, route via proxy, meter against my plan." Every other
    // provider (incl. Fireworks) is strictly BYOK — own key, direct. BYOK is never
    // GATED against Vodou's hosted quota, but its usage IS now recorded (flagged
    // is_hosted_tier=false) for the user's own dashboard + future usage-based billing;
    // see the usage-recording block below and VODOU_USAGE_TELEMETRY=0 to opt out.
    // (The old implicit "Fireworks + blank key → managed" path is retired.)
    const isVodouHostedTier = currentProvider === 'vodou';
    // Phase B (managed LLM proxy): when VODOU_LLM_PROXY_URL is set, hosted-tier
    // chats route through the server-side proxy (llm.vodou.ai) instead of calling
    // Fireworks directly — the managed key lives ONLY on the proxy box, and the
    // proxy meters tokens server-side. BYOK is unaffected. Empty env = direct
    // (legacy behavior) so this is an opt-in flip per gateway.
    const VODOU_LLM_PROXY_URL = process.env.VODOU_LLM_PROXY_URL || '';
    const usingManagedProxy = isVodouHostedTier && !!VODOU_LLM_PROXY_URL;
    // Auth the user to the proxy with the exact `Bearer token:user_id` shape the
    // app box's token-auth.php already validates (same as recordTokenUsage).
    const vodouProxyAuth = `${process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || ''}:${userId}`;
    console.error(`[TRACK-DIAG] dispatchToProvider currentProvider=${currentProvider} isVodouHostedTier=${isVodouHostedTier} usingManagedProxy=${usingManagedProxy} vodouModel=${vodouModel} managedKeyLen=${fireworksApiKeyManaged.length}`);
    // Capture the original onEvent BEFORE wrapping — otherwise the closure resolves
    // `onEvent` to wrappedOnEvent after the reassignment below, causing infinite
    // recursion on every streamed event (RangeError: Maximum call stack size exceeded).
    const originalOnEvent = onEvent;
    // Empty-turn guard state (see the `done` handler at the end of wrappedOnEvent).
    let _sawText = false;
    let _sawToolCall = false;
    const wrappedOnEvent = (ev) => {
        if (ev.type === 'usage') {
            console.error(`[TRACK-DIAG] usage event received: hosted=${isVodouHostedTier} input=${ev.usage?.inputTokens} output=${ev.usage?.outputTokens}`);
        }
        // Record usage for BOTH hosted AND BYOK turns. Hosted = billed against plan;
        // BYOK = recorded (flagged is_hosted_tier=false) for the user's own dashboard and
        // future usage-based billing — but NEVER gated on quota (see needsQuotaCheck below,
        // which stays hosted-only). Skip only:
        //   (a) the managed-proxy path — the PROXY records server-side from Fireworks'
        //       authoritative usage object (avoid double-count);
        //   (b) a Stopped turn — aborted mid-flight, so the usage object is partial/untrustworthy;
        //   (c) BYOK users who opted out via VODOU_USAGE_TELEMETRY=0 (hosted users can't
        //       opt out — billing requires the record).
        // Single chokepoint for the SDK, OpenAI-compat, AND Claude-CLI paths.
        const _byokTelemetryOptOut = !isVodouHostedTier && process.env.VODOU_USAGE_TELEMETRY === '0';
        if (ev.type === 'usage' && ev.usage && !usingManagedProxy && !_byokTelemetryOptOut
            && !isConversationAborted(conversationId)) {
            const provider = currentProvider;
            const model = ev.usage.model || buildActiveModelLabel().replace(/^.*?\(/, '').replace(/\)$/, '');
            const usage = {
                inputTokens: ev.usage.inputTokens,
                outputTokens: ev.usage.outputTokens,
                cachedInputTokens: ev.usage.cacheReadTokens,
            };
            const cogs = computeCogs(provider, model, usage);
            void recordTokenUsage({
                userId,
                sessionId: conversationId,
                executionTimeMs: Date.now() - dispatchStartMs,
                serverName: 'gateway-llm',
                toolName: `${provider}/${model}`,
                success: true,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                modelProvider: provider,
                modelName: model,
                estimatedCostUsd: cogs,
                isHostedTier: isVodouHostedTier,
            });
            // Invalidate quota cache so the next pre-flight check sees fresh usage
            invalidateQuotaCache(userId);
        }
        // Empty-turn guard (provider-agnostic; this wrapper is the single chokepoint for
        // the SDK, OpenAI-compat, and CLI paths). Some providers — notably reasoner-style
        // models like Kimi — occasionally end a WHOLE turn with no text AND no tool calls
        // (the 0-char stall the board surfaced). Without this the turn closes silently and
        // the user is left staring at a blank reply. Surface a visible message instead.
        if (ev.type === 'text' && ev.content)
            _sawText = true;
        if (ev.type === 'tool_call_start')
            _sawToolCall = true;
        if (ev.type === 'done' && !_sawText && !_sawToolCall && !isConversationAborted(conversationId)) {
            _sawText = true; // guard against a double `done` re-firing the notice
            originalOnEvent({
                type: 'text',
                content: '⚠️ The model returned an empty response (no text and no tool call). '
                    + 'Some providers do this on complex prompts — try again, rephrase, or switch the provider in Settings.',
            });
        }
        originalOnEvent(ev);
    };
    onEvent = wrappedOnEvent;
    // Phase 3c: pre-flight quota check — only for hosted providers (Fireworks/Together).
    // BYOK providers (claude-cli, anthropic, openai, etc.) skip this since the user
    // pays the vendor directly. We return a Promise that does the gate-then-dispatch
    // inline so the rest of dispatchToProvider stays synchronous-flavored.
    // Gate on Vodou's hosted quota only when the user is on the hosted tier
    // (hosted provider + no user-supplied key). Computed above.
    const needsQuotaCheck = isVodouHostedTier;
    const _dispatchAfterQuotaCheck = async () => {
        // PLAN-CONTEXT-GROUND-TRUTH — fetch the turn's deterministic facts block
        // ONCE at the provider chokepoint (async-local project context is live
        // here, agentCwd() resolves the real spawn root). Providers consume it on
        // their per-turn channel:
        //   claude-cli / kimi-cli → user prompt (their system prompt is cached /
        //     fixed at pooled-session spawn — putting facts there would go stale,
        //     which is the exact bug this plan kills);
        //   everything else      → prepended to memoryContext, which those paths
        //     rebuild into system (or the late context turn) every call.
        // Bounded: daemon socket 1.5s timeout, local fallback — never blocks a turn.
        try {
            // Consume the probe pre-warmed at turn ingress (chat()); already resolved by
            // now since it overlapped the memory+brain work. Falls back to a fresh fetch
            // for paths that didn't pre-warm (heartbeat, skill replies).
            const gtBlock = await consumeGroundTruth({
                cwd: agentCwd(),
                projectId: projectContextProjectId(),
                projectRoot: projectContextRoot(),
                projectName: projectContextProjectName(),
                conversationId,
            });
            setGroundTruthBlock(conversationId, gtBlock);
            if (gtBlock && currentProvider !== 'claude-cli' && currentProvider !== 'kimi-cli') {
                memoryContext = memoryContext ? gtBlock + '\n\n' + memoryContext : gtBlock;
            }
        }
        catch { /* facts are additive — never fail the turn over them */ }
        if (needsQuotaCheck) {
            const quota = await checkQuota(userId);
            if (!quota.canExecute) {
                const planLabel = quota.planId === 'free' ? 'free tier' : `${quota.planId} plan`;
                const reason = quota.exceededLimit === 'monthly_tokens'
                    ? `You've used **${quota.tokensUsed.toLocaleString()}** of your **${quota.monthlyTokenLimit.toLocaleString()}** monthly tokens on the ${planLabel}.`
                    : quota.exceededLimit === 'inactive'
                        ? `Your account is currently inactive.`
                        : `You've hit your ${quota.exceededLimit || 'usage'} limit on the ${planLabel}.`;
                const upgradeUrl = (process.env.VODOU_WEB_SERVER_URL || 'https://app.vodou.ai').replace(/\/$/, '') + '/dashboard/billing';
                const msg = `## Usage limit reached\n\n${reason}\n\n**[Upgrade your plan →](${upgradeUrl})**\n\nOr switch to a BYOK provider (Claude CLI, Anthropic API) in Settings — those don't count against hosted quotas.`;
                onEvent({ type: 'text', content: msg });
                onEvent({ type: 'done' });
                return msg;
            }
            if (quota.status === 'warning' && quota.monthlyTokenLimit > 0) {
                const pct = Math.round(quota.tokensUsed / quota.monthlyTokenLimit * 100);
                onEvent({ type: 'status', status: `${pct}% of monthly hosted tokens used (${quota.tokensUsed.toLocaleString()}/${quota.monthlyTokenLimit.toLocaleString()})` });
            }
            // COGS Governor (PLAN-COGS-GOVERNOR): turn the quota signal we already have into a per-turn
            // cost envelope the knob sites consult (env > profile > base). Flag OFF by default → no
            // profile set → knobs use base = identical to today. Never tightens the paid 'ok' path.
            if (governorEnabled()) {
                const base = {
                    stablePrefix: currentProvider === 'vodou',
                    rollingSummary: currentProvider === 'vodou',
                    // PLAN-AGENT-LOOP Phase 1: agent mode raises the ceiling here; the tier
                    // table in deriveCostProfile still tightens it for free/low/warning turns.
                    maxToolIterations: agentModeFor(conversationId) ? agentModeMaxIters() : MAX_TOOL_ITERATIONS,
                    maxTokens: MAX_TOKENS,
                    turnTokenBudget: parseInt(process.env.VODOU_TURN_TOKEN_BUDGET || '0', 10),
                    toolResultCap: parseInt(process.env.VODOU_TOOL_RESULT_CAP || '16000', 10),
                };
                const profile = deriveCostProfile({
                    managed: isVodouHostedTier,
                    planId: quota.planId,
                    status: quota.status,
                    degraded: !!quota.degraded,
                    tokensRemaining: quota.tokensRemaining,
                    monthlyTokenLimit: quota.monthlyTokenLimit,
                    serverEnvelope: quota.costEnvelope ?? null, // Option B: per-plan envelope from app.vodou.ai
                }, base);
                setCostProfile(conversationId, profile);
                console.error(`[cogs-gov] conv=${conversationId.substring(0, 8)} profile=${profile.label} iters=${profile.maxToolIterations} budget=${profile.turnTokenBudget} cap=${profile.toolResultCap} summary=${profile.rollingSummary} maxTok=${profile.maxTokens}`);
            }
        }
        return _runProviderDispatch();
    };
    const _runProviderDispatch = () => {
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
        let savedFireworksModel = fireworksModel;
        let savedTogetherModel = togetherModel;
        // PLAN-SKILL-CONSOLE-LOOP §31 Phase 2 — skill-bound prefer_model override.
        // If a skill console set prefer_model, force that model for this turn and
        // skip smart routing entirely. The teardown block below restores the
        // saved values regardless of which path swapped.
        const preferModel = preferModelOverride?.trim();
        if (preferModel) {
            modelSwapped = true;
            MODEL = preferModel;
            CLI_MODEL = preferModel;
            if (currentProvider === 'google')
                googleModel = preferModel;
            if (currentProvider === 'groq')
                groqModel = preferModel;
            if (currentProvider === 'openai')
                openaiModel = preferModel;
            if (currentProvider === 'ollama')
                ollamaModel = preferModel;
            if (currentProvider === 'kimi')
                kimiModel = preferModel;
            if (currentProvider === 'openrouter')
                openrouterModel = preferModel;
            if (currentProvider === 'fireworks')
                fireworksModel = preferModel;
            if (currentProvider === 'together')
                togetherModel = preferModel;
            console.error(`[SkillConsole] prefer_model override → ${preferModel} (was ${savedModel})`);
        }
        // Don't swap models when there's already a warm CLI pool session for this
        // conversation. Killing the warm session to spawn haiku creates a race where
        // the user message is delivered to a session that's mid-teardown, producing
        // exit code 0 with no reply. The cache savings on a reused warm session beat
        // the per-token discount of haiku anyway.
        const hasWarmCliSession = currentProvider === 'claude-cli' && _cliSessions.has(conversationId);
        if (smartRoutingEnabled &&
            !oiResults &&
            !skillSystemPromptOverride &&
            !channelAttachments?.length &&
            !hasWarmCliSession &&
            !preferModel &&
            isSimpleQuery(message)) {
            const cheap = getSmartRoutingCheapModel();
            if (cheap.model) {
                modelSwapped = true;
                MODEL = cheap.model;
                CLI_MODEL = cheap.cliModel || cheap.model;
                // Also swap provider-specific models
                if (currentProvider === 'google')
                    googleModel = cheap.model;
                if (currentProvider === 'groq')
                    groqModel = cheap.model;
                if (currentProvider === 'openai')
                    openaiModel = cheap.model;
                if (currentProvider === 'ollama')
                    ollamaModel = cheap.model;
                if (currentProvider === 'kimi')
                    kimiModel = cheap.model;
                if (currentProvider === 'openrouter')
                    openrouterModel = cheap.model;
                if (currentProvider === 'fireworks')
                    fireworksModel = cheap.model;
                if (currentProvider === 'together')
                    togetherModel = cheap.model;
                console.error(`[SmartRouting] Simple query → ${cheap.model} (was ${savedModel})`);
            }
        }
        // Capture the provider call (model vars are read synchronously at function entry)
        let result;
        switch (currentProvider) {
            case 'claude-cli':
                result = chatWithCLI(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'kimi-cli':
                result = chatWithKimiCLI(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'anthropic':
                result = chatWithSDK(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'openai':
                result = chatWithOpenAI(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'google':
                result = chatWithOpenAICompat('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', googleApiKey, googleModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'groq':
                result = chatWithOpenAICompat('https://api.groq.com/openai/v1/chat/completions', groqApiKey, groqModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'deepseek':
                result = chatWithOpenAICompat('https://api.deepseek.com/v1/chat/completions', deepseekApiKey, deepseekModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'xai':
                result = chatWithOpenAICompat('https://api.x.ai/v1/chat/completions', xaiApiKey, xaiModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'mistral':
                result = chatWithOpenAICompat('https://api.mistral.ai/v1/chat/completions', mistralApiKey, mistralModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'kimi':
                result = chatWithOpenAICompat('https://api.moonshot.ai/v1/chat/completions', kimiApiKey, kimiModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'openrouter':
                result = chatWithOpenAICompat('https://openrouter.ai/api/v1/chat/completions', openrouterApiKey, openrouterModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'vodou':
                // Vodou managed LLM → ALWAYS the server-side proxy. Same OpenAI-compat
                // client, proxy URL + `Bearer token:user_id` auth (fn builds 'Bearer '+apiKey).
                // The managed key never leaves the proxy box; usage meters against the plan.
                {
                    const vTok = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
                    if (!VODOU_LLM_PROXY_URL) {
                        onEvent({ type: 'error', error: 'Vodou managed LLM is not enabled on this gateway (VODOU_LLM_PROXY_URL unset).' });
                        onEvent({ type: 'done' });
                        result = Promise.resolve('');
                    }
                    else if (!vTok || !userId) {
                        // Require a valid Vodou account (token + user id) — without these the
                        // proxy can't authenticate/meter. Fail clearly instead of a proxy 401.
                        onEvent({ type: 'error', error: 'Connect your Vodou account to use the Vodou LLM — your Vodou token or user ID is missing. Sign in at app.vodou.ai and add VODOU_TOKEN / VODOU_USER_ID.' });
                        onEvent({ type: 'done' });
                        result = Promise.resolve('');
                    }
                    else {
                        // proxy still validates token→user→plan authoritatively (401/402); this is just a fast, clear pre-flight.
                        result = chatWithOpenAICompat(VODOU_LLM_PROXY_URL, vodouProxyAuth, vodouModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                    }
                }
                break;
            case 'fireworks':
                // BYOK only — user's own key, direct to Fireworks, never our proxy, not metered.
                result = chatWithOpenAICompat('https://api.fireworks.ai/inference/v1/chat/completions', fireworksApiKey, fireworksModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'together':
                result = chatWithOpenAICompat('https://api.together.ai/v1/chat/completions', togetherApiKey, togetherModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'ollama':
                result = chatWithOllama(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'lmstudio':
                result = chatWithLMStudio(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'llamacpp':
                result = chatWithLlamaCpp(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            case 'custom':
                result = chatWithCustom(conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
                break;
            default: {
                const claudeLine = process.platform === 'win32'
                    ? `   PowerShell: \`irm https://claude.ai/install.ps1 | iex\` — then open a NEW window and run \`claude\` to authenticate.\n\n`
                    : `   \`curl -fsSL https://claude.ai/install.sh | bash\`\n` +
                        `   Then: \`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${process.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc'} && source ${process.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc'}\`\n` +
                        `   Then run \`claude\` in a terminal once to authenticate.\n\n`;
                const setupMsg = `**No LLM provider configured.**\n\nGo to **Settings** (sidebar) to connect an AI model. Options:\n\n` +
                    `1. **Claude CLI** (recommended with Anthropic Max subscription):\n` +
                    claudeLine +
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
            fireworksModel = savedFireworksModel;
            togetherModel = savedTogetherModel;
        }
        // PLAN-SKILL-LEARNING-LOOP Phase 1A — universal turn-end flush. Every provider
        // (and skill mode, which delegates here) settles this promise, so one flush
        // persists the conversation's accumulated tool trajectory for ALL LLMs.
        return result.finally(() => { try {
            flushTrajectory(conversationId, message);
        }
        catch { /* best-effort */ } });
    };
    return _dispatchAfterQuotaCheck();
}
/** Convert stored Anthropic-shaped user blocks to OpenAI message content. */
function anthropicUserBlocksToOpenAIUserContent(blocks, visionCompat) {
    if (!visionCompat) {
        let t = '';
        for (const b of blocks) {
            if (b.type === 'text' && b.text)
                t += b.text + '\n';
            else if (b.type === 'image')
                t += '\n[Image attachment — enable vision endpoint (OpenAI / Gemini) or use Anthropic API]\n';
            else if (b.type === 'document')
                t += '\n[PDF/text document — use Anthropic API for full document in context]\n';
        }
        return t.trim();
    }
    const parts = [];
    for (const b of blocks) {
        if (b.type === 'text' && b.text)
            parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64' && b.source?.media_type && b.source?.data) {
            parts.push({
                type: 'image_url',
                image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            });
        }
        else if (b.type === 'document') {
            parts.push({
                type: 'text',
                text: '[Attached PDF or text document is not forwarded to this provider as binary — use Anthropic API for native documents.]',
            });
        }
    }
    if (parts.length === 0)
        return '';
    if (parts.length === 1 && parts[0].type === 'text')
        return parts[0].text;
    return parts;
}
/**
 * Build OpenAI-format messages from Anthropic-format conversation history.
 * Preserves tool_use and tool_result blocks by converting to OpenAI equivalents.
 */
function buildOpenAIMessages(history, systemPrompt, visionCompat = false, conversationId) {
    const messages = [{ role: 'system', content: systemPrompt }];
    // Token-aware trimming
    const limit = CONTEXT_LIMITS[currentProvider] || 64_000;
    const threshold = Math.floor(limit * CONTEXT_THRESHOLD);
    const totalTokens = estimateTokens(history);
    let historyToUse;
    if (totalTokens > threshold && history.length > KEEP_RECENT) {
        const olderMessages = history.slice(0, -KEEP_RECENT);
        historyToUse = history.slice(-KEEP_RECENT);
        const summary = rollingSummaryFor(conversationId, olderMessages); // WS5: LLM rolling summary (or naive fallback)
        messages.push({ role: 'system', content: summary });
        console.error(`[Context] OpenAI token-aware trim: ${totalTokens} tokens > ${threshold}. Compacted ${olderMessages.length} older messages${ROLLING_SUMMARY_ON(conversationId) ? ' (rolling-summary)' : ''}.`);
    }
    else {
        historyToUse = history.slice(-20);
    }
    for (const msg of historyToUse) {
        if (msg.role === 'user') {
            if (Array.isArray(msg.content)) {
                // Check for tool_result blocks (stored by addToolResult)
                const toolResults = msg.content.filter((b) => b.type === 'tool_result');
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
                const nonTool = msg.content;
                const hasVisiony = nonTool.some((b) => b.type === 'image' || b.type === 'document');
                if (hasVisiony) {
                    const converted = anthropicUserBlocksToOpenAIUserContent(nonTool, visionCompat);
                    if (typeof converted === 'string') {
                        if (converted)
                            messages.push({ role: 'user', content: converted });
                    }
                    else if (Array.isArray(converted) && converted.length > 0) {
                        messages.push({ role: 'user', content: converted });
                    }
                    continue;
                }
                const text = nonTool.filter((b) => b.type === 'text').map((b) => b.text).join('');
                if (text)
                    messages.push({ role: 'user', content: text });
            }
            else {
                const text = typeof msg.content === 'string' ? msg.content : '';
                if (text)
                    messages.push({ role: 'user', content: text });
            }
        }
        else if (msg.role === 'assistant') {
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
            if (toolUseBlocks.length > 0) {
                // Convert Anthropic tool_use to OpenAI tool_calls format
                messages.push({
                    role: 'assistant',
                    content: text || '',
                    tool_calls: toolUseBlocks.map((b) => ({
                        id: b.id,
                        type: 'function',
                        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
                    })),
                });
            }
            else if (text) {
                messages.push({ role: 'assistant', content: text });
            }
        }
    }
    return messages;
}
// --- OpenAI-compatible chat (used by openai + custom providers) ---
/**
 * B4: Turn a raw provider error body into a short, human-readable message.
 * Falls back to a truncated raw body only when the body isn't parseable JSON.
 */
function normalizeProviderError(status, rawBody, retryAfter) {
    let providerMsg = '';
    try {
        const j = JSON.parse(rawBody);
        providerMsg = j?.error?.message || j?.error || j?.message || '';
        if (typeof providerMsg !== 'string')
            providerMsg = '';
    }
    catch { /* not JSON */ }
    if (status === 401 || status === 403) {
        return `**API key rejected (${status}).** Your provider key is invalid or expired. Open **Settings** and re-paste your API key, then try again.` + (providerMsg ? `\n\n_Provider: ${providerMsg}_` : '');
    }
    if (status === 429) {
        const wait = retryAfter ? ` Try again in ~${retryAfter}s.` : ' Please wait a moment and retry.';
        return `**Rate limit / quota reached (429).**${wait}` + (providerMsg ? `\n\n_Provider: ${providerMsg}_` : '');
    }
    if (status >= 500) {
        return `**Provider is having problems (${status}).** This is on the provider's side — please retry shortly.` + (providerMsg ? `\n\n_Provider: ${providerMsg}_` : '');
    }
    if (providerMsg)
        return `**LLM API error (${status}):** ${providerMsg}`;
    return `**LLM API error (${status}).** ${rawBody.slice(0, 300)}${rawBody.length > 300 ? '…' : ''}`;
}
/**
 * Fetch helper with retry on 429 (rate limit) and 503 (capacity).
 * Honors Retry-After header when present (seconds-since-epoch or delta-seconds),
 * otherwise exponential backoff: 1s, 2s, 4s. Max 3 attempts total.
 * Emits a status event so the user knows we're waiting on the provider.
 */
async function fetchWithRetry(url, init, onEvent, maxAttempts = 3, signal) {
    let lastResp = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        const resp = await fetch(url, { ...init, signal });
        if (resp.status !== 429 && resp.status !== 503)
            return resp;
        lastResp = resp;
        if (attempt === maxAttempts - 1)
            break; // out of attempts
        const retryAfter = resp.headers.get('retry-after') || resp.headers.get('Retry-After');
        let delayMs = Math.min(4000, 1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
        if (retryAfter) {
            const asInt = parseInt(retryAfter, 10);
            if (!Number.isNaN(asInt)) {
                // Either delta-seconds (small int) or HTTP-date (parse as Date).
                delayMs = asInt < 1_000_000 ? Math.min(30_000, asInt * 1000) : delayMs;
            }
            else {
                const ts = Date.parse(retryAfter);
                if (!Number.isNaN(ts))
                    delayMs = Math.max(0, Math.min(30_000, ts - Date.now()));
            }
        }
        onEvent({ type: 'status', status: `Provider rate-limited (${resp.status}) — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 2}/${maxAttempts})` });
        console.error(`[llm] ${resp.status} from ${new URL(url).host} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
        // Try to consume body so the connection is reusable. Ignore failures.
        try {
            await resp.text();
        }
        catch { }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return lastResp;
}
async function chatWithOpenAICompat(endpoint, apiKey, model, conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    const conversations = getConversationManager();
    // PLAN 0.6.4 §4.3: FS tools gate on (flag ON && web-chat source) — drives both
    // the system-prompt block and the tools array on this path.
    const convSource = getConversation(conversationId)?.source ?? null;
    const fsActive = fsToolsActive(convSource, conversationId);
    const fsTargetedEdits = fsActive && modelCapabilities(model).editFormat === 'targeted'; // #8 §1.3
    // B2 abort seam: register this turn so the WS `stop` handler can cancel the
    // in-flight OpenAI-compat fetch (signal threaded into fetchWithRetry below).
    const _abort = beginConvAbort(conversationId);
    const isColdCompat = !_bootstrappedConversations.has(conversationId);
    const bodyText = buildApiRecallBlock(conversationId, isColdCompat) + buildUserPromptWithOIResults(message, oiResults);
    const userTurn = channelAttachments?.length && channelAttachments.length > 0
        ? buildAnthropicUserContent(bodyText, channelAttachments)
        : bodyText;
    conversations.addUserMessage(conversationId, userTurn);
    // Proactive compaction before API call
    maybeProactiveCompact(conversationId, onEvent);
    // Build system prompt
    // WS2 (PLAN-GATEWAY-STATE-LAYER): VODOU_COMPAT_STABLE_PREFIX makes the RE-SENT
    // request tail byte-stable so the OpenAI-compat provider (Fireworks/kimi)
    // prompt-caches [core system + tool-defs + history]. The win: relocate the
    // query-dependent memory OUT of the system message into a late turn (spliced
    // before the current user turn below) so it stops busting the cache. Bootstrap
    // stays ONCE-per-conversation (NOT re-sent every turn — re-send+cache bills at
    // ~50% on Fireworks and loses to not-sending; see the bootstrap note below).
    // Scope STAYS in the prefix: constant per conversation, doesn't bust the cache.
    // Benchmarked 2026-06-05: stable prefix → 87-97% cache on warm kimi turns (~2-turn warm-up),
    // answers coherent, continuity preserved. DEFAULT ON for the managed `vodou` tier; OFF for
    // BYOK/other OpenAI-compat installs unless explicitly set. Explicit env (0/1) always wins.
    const STABLE_PREFIX = process.env.VODOU_COMPAT_STABLE_PREFIX != null
        ? process.env.VODOU_COMPAT_STABLE_PREFIX === '1'
        : currentProvider === 'vodou';
    let lateContextBlock = '';
    let systemPrompt;
    if (skillSystemPromptOverride) {
        const contextParts = [memoryContext].filter(Boolean).join('\n\n');
        systemPrompt = contextParts
            ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
            : skillSystemPromptOverride;
        if (!_bootstrappedConversations.has(conversationId))
            _bootstrappedConversations.add(conversationId);
    }
    else {
        const isFirstMsg = !_bootstrappedConversations.has(conversationId);
        // Bootstrap (AGENTS.md operating manual + MEMORY.md, ~6K) is sent ONCE per
        // conversation — the original design ("don't resend 413 lines every message").
        // WS2 deliberately does NOT re-send it every turn: on a stateless API "always
        // send + cache" still bills cached input at ~50% (Fireworks), which loses to
        // simply not sending it. The model keeps the core rules (getSystemPrompt, sent
        // every turn) + conversation history + per-turn memory recall (memoryForSystem).
        // WS2's caching win comes from making the RE-SENT tail (system + tool-defs +
        // history) byte-stable via memory relocation below, not from re-sending bootstrap.
        const bootstrap = isFirstMsg ? getWorkspaceBootstrap() : '';
        if (isFirstMsg)
            _bootstrappedConversations.add(conversationId);
        const staticParts = systemPromptStaticPrefix(bootstrap, lensesEnabled, fsActive, fsTargetedEdits);
        const memoryForSystem = (oiResults && memoryContext)
            ? memoryContext.replace(/### Vodou Tool Results[\s\S]+/, '').trim()
            : memoryContext;
        if (STABLE_PREFIX) {
            systemPrompt = staticParts; // frozen → cacheable prefix
            lateContextBlock = memoryForSystem || ''; // volatile → relocated to a late turn (below)
        }
        else {
            systemPrompt = memoryForSystem
                ? staticParts + '\n\n---\n\n' + memoryForSystem
                : staticParts;
        }
    }
    systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);
    const visionCompat = openaiCompatVisionEnabled(endpoint);
    // WS2: assemble [system, ...history] and (when stable-prefix is on) splice the
    // relocated memory in as a late `system` turn immediately before the current
    // user turn — keeps [system + tool-defs + prior turns] byte-stable for caching
    // while memory rides the volatile tail. Shared closure so the reactive-compaction
    // rebuild below stays identical.
    const assembleMessages = (h) => {
        const m = buildOpenAIMessages(h, systemPrompt, visionCompat, conversationId); // WS5: convId enables rolling summary
        if (STABLE_PREFIX && lateContextBlock) {
            const insertAt = Math.max(1, m.length - 1); // before the trailing current-user turn
            m.splice(insertAt, 0, { role: 'system', content: '### Relevant context for this turn\n\n' + lateContextBlock });
        }
        return m;
    };
    // Build messages array from conversation history (preserves tool interactions)
    const history = getCompressedMessages(conversationId);
    const openaiMessages = assembleMessages(history);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey)
        headers['Authorization'] = 'Bearer ' + apiKey;
    if (endpoint.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER || (process.env.GATEWAY_BASE_URL || 'http://localhost:8765').replace(/\/$/, '');
        headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Vodou-Console';
    }
    // WS2: serverless prompt-cache routing. Fireworks accepts the affinity key in EITHER
    // the `user` body field (set on the request bodies below) OR the `x-session-affinity`
    // header; docs' examples use the header and community reports (opencode #23450,
    // openclaw #16387) found it more reliable, so we set BOTH, keyed by conversationId.
    // NB (measured 2026-06-05): affinity does NOT eliminate the ~15-30% periodic cold
    // miss a single caller sees on serverless (replica rebalancing/eviction — same rate
    // with/without it); affinity's real payoff is pinning the replica under multi-replica
    // + concurrent production load. Fully eliminating the cold miss needs a dedicated
    // deployment (PLAN §6 self-host). Harmless on non-Fireworks endpoints (ignored).
    if (STABLE_PREFIX)
        headers['x-session-affinity'] = conversationId;
    // #8 §1.5b: skip tools for menu replies OR a model the operator marked no-tools
    // (VODOU_NO_TOOLS_MODELS) — that model then runs plain text-only chat.
    const skipTools = isMenuReplyCheck(message) || !modelCapabilities(model).supportsTools;
    // WS6 rider (PLAN-GATEWAY-STATE-LAYER): respect the per-conversation/board override
    // instead of a hard-coded 10. Previously this constant shadowed getMaxToolIterations()
    // so setConversationMaxToolIterations() silently no-op'd on the OpenAI-compat path
    // (the SDK path already wires it at chatWithSDK). Falls back to the global default.
    const MAX_TOOL_ITERATIONS = getMaxToolIterations(conversationId);
    // B2 follow-up (partial-text persistence on Stop): hoisted to function scope so
    // the catch can persist whatever streamed before a user-Stop aborted the fetch.
    // Without this the abort drops the partial assistant text, leaving an unpaired
    // user turn in conversation history / the transcript.
    let fullText = '';
    try {
        // Tool-calling loop: non-streaming rounds for tool detection, streaming for final text
        let currentMessages = [...openaiMessages];
        let iterations = 0;
        const oaiStartTime = Date.now();
        // [token-budget] Part A instrumentation — measure per-turn input growth so we can
        // prove the Part B (truncate-with-handle) win. Observability only; zero behavior change.
        const TOKEN_DIAG = process.env.VODOU_TOKEN_DIAG !== '0';
        const TURN_TOKEN_WARN = parseInt(process.env.VODOU_TURN_TOKEN_WARN || '120000', 10);
        // WS6 (PLAN-GATEWAY-STATE-LAYER): hard per-turn input ceiling that actually CUTS the
        // tool loop (TURN_TOKEN_WARN above only logs). Backstop for anything WS4/WS5 miss — when
        // the cumulative input billed across a turn's tool rounds crosses the budget, stop issuing
        // more tool calls and fall through to the final streamed answer (the user still gets a reply
        // from the context gathered so far) + log LOUDLY (never silent). Always ≥1 tool round first.
        // Default 0 = disabled (opt-in backstop — no behavior change by default).
        // env > COGS-governor profile > 0 (off). The governor can arm a budget for free/near-limit turns.
        const TURN_TOKEN_BUDGET = process.env.VODOU_TURN_TOKEN_BUDGET != null
            ? parseInt(process.env.VODOU_TURN_TOKEN_BUDGET, 10)
            : (getCostProfile(conversationId)?.turnTokenBudget ?? 0);
        const TRACK_TOKENS = TOKEN_DIAG || TURN_TOKEN_BUDGET > 0; // compute cumulative even when DIAG is off, so the cut works
        const convTag = conversationId.substring(0, 8);
        let cumulativeInputTokens = 0;
        // PLAN-AGENT-LOOP Phase 1: budget = cap (MAX_TOOL_ITERATIONS, already per-conv/
        // governor/agent-mode aware) + one grace round + refund of all-cheap rounds.
        // toolLoopExhausted distinguishes "ran out of rounds" (model may have a pending
        // call → fire the write-drop guard below) from a natural stop / WS6 cut.
        const budget = makeIterationBudget(MAX_TOOL_ITERATIONS);
        let toolLoopExhausted = false;
        while (true) {
            if (!(budget.tryConsume() || budget.useGrace())) {
                toolLoopExhausted = true;
                break;
            }
            if (TRACK_TOKENS) {
                const reqTokens = estimateTokens(currentMessages);
                cumulativeInputTokens += reqTokens;
                if (TOKEN_DIAG) {
                    console.error(`[token-budget] conv=${convTag} iter=${iterations} req_input≈${reqTokens}tok msgs=${currentMessages.length} cumulative≈${cumulativeInputTokens}tok`);
                    if (cumulativeInputTokens > TURN_TOKEN_WARN) {
                        console.error(`[token-budget] ⚠️ conv=${convTag} cumulative turn input ≈${cumulativeInputTokens}tok exceeds warn=${TURN_TOKEN_WARN}`);
                    }
                }
                // WS6 hard cut — end the tool loop early (after ≥1 round) and force the final answer.
                if (shouldCutForBudget(cumulativeInputTokens, TURN_TOKEN_BUDGET, iterations)) {
                    console.error(`[token-budget] 🛑 conv=${convTag} CUT — cumulative ≈${cumulativeInputTokens}tok exceeds VODOU_TURN_TOKEN_BUDGET=${TURN_TOKEN_BUDGET} after ${iterations} tool round(s); ending tool loop, forcing final answer.`);
                    onEvent({ type: 'status', status: 'Reached this turn’s context budget — wrapping up with what I have.' });
                    break;
                }
            }
            // Non-streaming request with tools to detect tool_calls
            const toolResp = await fetchWithRetry(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    max_tokens: MAX_TOKENS,
                    stream: false,
                    messages: currentMessages,
                    // WS2: stable per-conversation session-affinity key → Fireworks routes
                    // every turn to the replica holding the warm prefix (matters under
                    // multi-replica/concurrent production load; secondary to prefix stability).
                    ...(STABLE_PREFIX ? { user: conversationId } : {}),
                    ...(!skipTools ? { tools: getOpenAITools({ source: convSource, model, conversationId }) } : {}),
                }),
            }, onEvent, undefined, _abort.controller.signal); // B2: cancel on Stop
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
                        currentMessages = assembleMessages(newHistory);
                        iterations++; // prevent infinite loop
                        continue;
                    }
                }
                onEvent({ type: 'error', error: normalizeProviderError(toolResp.status, errText, toolResp.headers.get('retry-after')) });
                onEvent({ type: 'done' });
                return '';
            }
            const toolJson = await toolResp.json();
            const choice = toolJson.choices?.[0];
            let toolCalls = choice?.message?.tool_calls;
            let recoveredFromContent = false;
            // #8 §1.5 tool-call-in-content fallback: some providers (DeepSeek ~11%,
            // self-hosted Qwen/vLLM) emit the call as TEXT with finish_reason="stop"
            // instead of a structured tool_calls array. Recover it — but ONLY a call
            // naming a tool we actually offered this turn (no-op on normal prose/code).
            if ((!toolCalls || toolCalls.length === 0) && !skipTools && toolCallRecoveryEnabled()) {
                const activeToolNames = getActiveTools({ source: convSource }).map((t) => t.name);
                const recovered = recoverToolCallsFromContent(choice?.message?.content, choice?.finish_reason, activeToolNames);
                if (recovered.length > 0) {
                    console.error(`[toolcall-recovery] conv=${convTag} recovered ${recovered.length} tool call(s) from content (finish_reason=${choice?.finish_reason})`);
                    toolCalls = recovered;
                    recoveredFromContent = true;
                }
            }
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
                    conversations.addAssistantMessage(conversationId, [{ type: 'text', text: directText }]);
                    saveAssistantToBuffer(directText);
                    onEvent({ type: 'done' });
                    return directText;
                }
                break;
            }
            // Execute tool calls
            // When the call was recovered FROM content, blank that content in the echoed
            // assistant message — feeding the raw serialized-call text back risks an
            // echo loop (#8 §1.5 review). The tool result carries the needed info forward.
            const assistantMsg = { role: 'assistant', content: recoveredFromContent ? '' : (choice.message.content || ''), tool_calls: toolCalls };
            currentMessages.push(assistantMsg);
            for (const tc of toolCalls) {
                const fnName = tc.function?.name || '';
                // #8 §1.5 arg repair: parse-with-repair + light schema coercion instead of
                // silently dropping malformed args to {} (which made a bad payload run empty).
                const fnArgs = repairToolArgs(tc.function?.arguments, getTool(fnName)?.input_schema);
                onEvent({ type: 'tool_call_start', toolName: fnName, toolId: tc.id, toolArgs: fnArgs });
                const result = await executeOITool(fnName, fnArgs, { scope, conversationId, onEvent, activeToolPolicy: activeToolPolicyFor(conversationId) });
                onEvent({
                    type: 'tool_call_end', toolName: fnName, toolId: tc.id,
                    toolResult: result.output, success: result.success, executionTime: result.executionTime,
                });
                if (result.success) {
                    const changedFiles = detectFileChanges(fnName, fnArgs, result.output);
                    if (changedFiles.length > 0)
                        addFileChanges(conversationId, changedFiles);
                }
                const toolResultStr = result.success ? result.output : `Error: ${result.error}`;
                currentMessages.push({
                    role: 'tool', tool_call_id: tc.id,
                    content: toolResultStr,
                });
                if (TOKEN_DIAG) {
                    const ttok = Math.ceil((toolResultStr?.length || 0) / 4);
                    console.error(`[token-budget] conv=${convTag} tool=${fnName} result≈${ttok}tok (${toolResultStr?.length || 0} chars)`);
                }
            }
            // PLAN-AGENT-LOOP Phase 1: refund an all-cheap (read-only) round.
            if (roundIsRefundable(toolCalls.map((tc) => tc.function?.name || '')))
                budget.refund();
            iterations++;
        }
        // §10.2 #10 — last-iteration write-drop fix. If the loop exited because it hit the
        // iteration cap (not because the model was done), the model may still have a PENDING
        // tool call (classically a closing write_file). The final stream below carries NO
        // tools, so that call would be silently dropped while the model says "saved it".
        // Give it ONE more non-streaming tool round (hard-bounded; no loop) so a pending
        // write is actually dispatched and the closing text reflects reality.
        if (toolLoopExhausted && !skipTools && !isConversationAborted(conversationId)) {
            try {
                const capResp = await fetchWithRetry(endpoint, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, stream: false, messages: currentMessages, tools: getOpenAITools({ source: convSource, model, conversationId }) }),
                }, onEvent, undefined, _abort.controller.signal);
                if (capResp.ok) {
                    const capJson = await capResp.json();
                    const capChoice = capJson.choices?.[0];
                    let capToolCalls = capChoice?.message?.tool_calls;
                    if ((!capToolCalls || capToolCalls.length === 0) && toolCallRecoveryEnabled()) {
                        const activeToolNames = getActiveTools({ source: convSource, model, conversationId }).map((t) => t.name);
                        const rec = recoverToolCallsFromContent(capChoice?.message?.content, capChoice?.finish_reason, activeToolNames);
                        if (rec.length > 0)
                            capToolCalls = rec;
                    }
                    if (capToolCalls && capToolCalls.length > 0) {
                        console.error(`[toolcall] conv=${convTag} cap-hit final round: dispatching ${capToolCalls.length} pending tool call(s) so a closing write isn't dropped`);
                        currentMessages.push({ role: 'assistant', content: capChoice.message?.content || '', tool_calls: capToolCalls });
                        for (const tc of capToolCalls) {
                            const fnName = tc.function?.name || '';
                            const fnArgs = repairToolArgs(tc.function?.arguments, getTool(fnName)?.input_schema);
                            onEvent({ type: 'tool_call_start', toolName: fnName, toolId: tc.id, toolArgs: fnArgs });
                            const result = await executeOITool(fnName, fnArgs, { scope, conversationId, onEvent, activeToolPolicy: activeToolPolicyFor(conversationId) });
                            onEvent({ type: 'tool_call_end', toolName: fnName, toolId: tc.id, toolResult: result.output, success: result.success, executionTime: result.executionTime });
                            if (result.success) {
                                const cf = detectFileChanges(fnName, fnArgs, result.output);
                                if (cf.length > 0)
                                    addFileChanges(conversationId, cf);
                            }
                            currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.success ? result.output : `Error: ${result.error}` });
                        }
                    }
                }
            }
            catch { /* best-effort — fall through to the closing stream */ }
        }
        if (TOKEN_DIAG) {
            const finalTokens = estimateTokens(currentMessages);
            cumulativeInputTokens += finalTokens;
            console.error(`[token-budget] conv=${convTag} FINAL stream req_input≈${finalTokens}tok total_turn_input≈${cumulativeInputTokens}tok iters=${iterations}`);
        }
        // Final streaming response (no tools — just text)
        const resp = await fetchWithRetry(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                max_tokens: MAX_TOKENS,
                stream: true,
                stream_options: { include_usage: true },
                messages: currentMessages,
                ...(STABLE_PREFIX ? { user: conversationId } : {}), // WS2: session affinity (see tool-detection request)
            }),
        }, onEvent, undefined, _abort.controller.signal); // B2: cancel on Stop
        if (!resp.ok) {
            const errText = await resp.text();
            onEvent({ type: 'error', error: normalizeProviderError(resp.status, errText, resp.headers.get('retry-after')) });
            onEvent({ type: 'done' });
            return '';
        }
        // Parse SSE stream (fullText hoisted above for partial-text persistence on Stop)
        let oaiUsage = null;
        const reader = resp.body?.getReader();
        if (!reader) {
            onEvent({ type: 'error', error: 'No response stream' });
            onEvent({ type: 'done' });
            return '';
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let reasoningStatusSent = false;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]')
                    continue;
                if (!trimmed.startsWith('data: '))
                    continue;
                try {
                    const json = JSON.parse(trimmed.substring(6));
                    const d = json.choices?.[0]?.delta;
                    const delta = d?.content;
                    const reasoningPiece = d?.reasoning_content ?? d?.reasoning;
                    if (reasoningPiece && !reasoningStatusSent) {
                        reasoningStatusSent = true;
                        onEvent({
                            type: 'status',
                            status: 'Model is reasoning (answer will stream when ready)…',
                        });
                    }
                    if (delta) {
                        fullText += delta;
                        onEvent({ type: 'text', content: delta });
                    }
                    // Capture usage from final chunk (OpenAI includes it when stream_options.include_usage is set, or in the last chunk)
                    if (json.usage)
                        oaiUsage = json.usage;
                }
                catch { }
            }
        }
        if (fullText) {
            conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText }]);
            saveAssistantToBuffer(fullText);
        }
        // Emit usage event BEFORE done so the token-tracking handler in chat()
        // (which only listens for type === 'usage') actually fires. Mirrors the
        // Ollama path. cacheReadTokens is what computeCogs expects for the
        // half-price cached-input discount Fireworks/OpenAI both apply.
        const oaiUsageEvent = {
            inputTokens: oaiUsage?.prompt_tokens,
            outputTokens: oaiUsage?.completion_tokens,
            cacheReadTokens: oaiUsage?.prompt_tokens_details?.cached_tokens,
            durationMs: Date.now() - oaiStartTime,
            model,
        };
        // WS1 cache-hit observability (PLAN-GATEWAY-STATE-LAYER). cached≈0 means the re-sent
        // prefix is FULL PRICE every turn (the cache is busted — likely volatile content in the
        // prefix; that's WS2 prefix-stability). This is the readable companion to TRACK-DIAG.
        if (TOKEN_DIAG) {
            const _pt = oaiUsage?.prompt_tokens ?? 0;
            const _ct = oaiUsage?.prompt_tokens_details?.cached_tokens ?? 0;
            console.error(`[cache] conv=${convTag} prompt=${_pt} cached=${_ct} (${_pt ? Math.round((_ct / _pt) * 100) : 0}% hit) out=${oaiUsage?.completion_tokens ?? 0} model=${model.replace('accounts/fireworks/models/', '')}`);
        }
        console.error(`[TRACK-DIAG] chatWithOpenAICompat emit usage: oaiUsage=${JSON.stringify(oaiUsage)} model=${model}`);
        onEvent({ type: 'usage', usage: oaiUsageEvent });
        onEvent({ type: 'done', usage: oaiUsageEvent });
        return fullText;
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // B2: a user-initiated Stop aborts the fetch (AbortError) — don't surface it
        // as an error toast; the stop handler already told the client. End cleanly.
        if (!isConversationAborted(conversationId)) {
            onEvent({ type: 'error', error: errMsg });
        }
        else if (fullText) {
            // B2 follow-up (partial-text persistence on Stop): the user stopped mid-stream
            // but some text already streamed to them. Persist it so the assistant turn
            // pairs with the user turn already in history (otherwise we leave a dangling
            // unpaired user message). Cost is still suppressed (no `usage` event fires
            // here, and dispatchToProvider drops usage when aborted).
            conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText }]);
            saveAssistantToBuffer(fullText);
        }
        onEvent({ type: 'done' });
        return isConversationAborted(conversationId) ? fullText : '';
    }
    finally {
        endConvAbort(conversationId, _abort);
    }
}
async function chatWithOpenAI(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    console.error(`[OpenAI] Sending to ${openaiModel}...`);
    return chatWithOpenAICompat('https://api.openai.com/v1/chat/completions', openaiApiKey, openaiModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
}
async function chatWithCustom(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    console.error(`[Custom] Sending to ${customModel} at ${customBaseUrl}...`);
    return chatWithOpenAICompat(customBaseUrl + '/v1/chat/completions', customApiKey, customModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
}
// --- LM Studio chat (OpenAI-compatible, local, no API key) ---
async function chatWithLMStudio(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    console.error(`[LMStudio] Sending to ${lmstudioModel} at ${lmstudioBaseUrl}...`);
    return chatWithOpenAICompat(lmstudioBaseUrl + '/v1/chat/completions', '', lmstudioModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
}
// --- llama.cpp chat (bundled llama-server, OpenAI-compatible, loopback, no API key) ---
async function chatWithLlamaCpp(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    console.error(`[llama.cpp] Sending to ${llamacppModel} at ${llamacppBaseUrl}...`);
    return chatWithOpenAICompat(llamacppBaseUrl + '/v1/chat/completions', '', llamacppModel, conversationId, message, onEvent, memoryContext, oiResults, skillSystemPromptOverride, channelAttachments, scope, lensesEnabled);
}
// --- Ollama chat (NDJSON stream) ---
async function chatWithOllama(conversationId, message, onEvent, memoryContext = '', oiResults = '', skillSystemPromptOverride = '', channelAttachments, scope = null, lensesEnabled = true) {
    const conversations = getConversationManager();
    // PLAN 0.6.4 §4.3: FS tools gate on (flag ON && web-chat source).
    const convSource = getConversation(conversationId)?.source ?? null;
    const fsActive = fsToolsActive(convSource, conversationId);
    const fsTargetedEdits = fsActive && modelCapabilities(ollamaModel).editFormat === 'targeted'; // #8 §1.3
    console.error(`[Ollama] Sending to ${ollamaModel} at ${ollamaBaseUrl}...`);
    const isColdOllama = !_bootstrappedConversations.has(conversationId);
    const bodyText = buildApiRecallBlock(conversationId, isColdOllama) + buildUserPromptWithOIResults(message, oiResults);
    const userTurn = channelAttachments?.length && channelAttachments.length > 0
        ? buildAnthropicUserContent(bodyText, channelAttachments)
        : bodyText;
    conversations.addUserMessage(conversationId, userTurn);
    // Proactive compaction before API call
    maybeProactiveCompact(conversationId, onEvent);
    // Build system prompt
    let systemPrompt;
    if (skillSystemPromptOverride) {
        const contextParts = [memoryContext].filter(Boolean).join('\n\n');
        systemPrompt = contextParts
            ? contextParts + '\n\n---\n\n' + skillSystemPromptOverride
            : skillSystemPromptOverride;
        if (!_bootstrappedConversations.has(conversationId))
            _bootstrappedConversations.add(conversationId);
    }
    else {
        const isFirstMsg = !_bootstrappedConversations.has(conversationId);
        const bootstrap = isFirstMsg ? getWorkspaceBootstrap() : '';
        if (isFirstMsg)
            _bootstrappedConversations.add(conversationId);
        const staticParts = systemPromptStaticPrefix(bootstrap, lensesEnabled, fsActive, fsTargetedEdits);
        const memoryForSystem = (oiResults && memoryContext)
            ? memoryContext.replace(/### Vodou Tool Results[\s\S]+/, '').trim()
            : memoryContext;
        systemPrompt = memoryForSystem
            ? staticParts + '\n\n---\n\n' + memoryForSystem
            : staticParts;
    }
    systemPrompt = maybeAppendScopeBlock(systemPrompt, scope);
    const ollamaVision = process.env.CHANNEL_OLLAMA_VISION === '1' || process.env.CHANNEL_OLLAMA_VISION === 'true';
    // Build messages (preserves tool interactions from history)
    const history = getCompressedMessages(conversationId);
    const ollamaMessages = buildOpenAIMessages(history, systemPrompt, ollamaVision, conversationId); // WS5
    // #8 §1.5b: skip tools for menu replies OR an operator-marked no-tools model.
    const skipTools = isMenuReplyCheck(message) || !modelCapabilities(ollamaModel).supportsTools;
    // PLAN-AGENT-LOOP Phase 1: honor the per-conversation / governor / agent-mode cap
    // (was a hard-coded 10 — the only loop that still shadowed getMaxToolIterations()).
    const MAX_TOOL_ITERATIONS = getMaxToolIterations(conversationId);
    try {
        // Tool-calling loop: non-streaming for tool detection, streaming for final
        let currentMessages = [...ollamaMessages];
        let iterations = 0;
        while (iterations < MAX_TOOL_ITERATIONS && !skipTools) {
            const toolResp = await fetch(ollamaBaseUrl + '/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ollamaModel,
                    stream: false,
                    messages: currentMessages,
                    tools: getOpenAITools({ source: convSource, model: ollamaModel, conversationId }),
                    options: { num_predict: MAX_TOKENS },
                }),
            });
            if (!toolResp.ok)
                break;
            const toolJson = await toolResp.json();
            const toolCalls = toolJson.message?.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
                // No tools — use text if we had tool rounds, else fall through to streaming
                const directText = toolJson.message?.content || '';
                if (directText && iterations > 0) {
                    onEvent({ type: 'text', content: directText });
                    conversations.addAssistantMessage(conversationId, [{ type: 'text', text: directText }]);
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
                let fnArgs = {};
                try {
                    fnArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
                }
                catch { }
                onEvent({ type: 'tool_call_start', toolName: fnName, toolId: tcId, toolArgs: fnArgs });
                const result = await executeOITool(fnName, fnArgs, { scope, conversationId, onEvent, activeToolPolicy: activeToolPolicyFor(conversationId) });
                onEvent({ type: 'tool_call_end', toolName: fnName, toolId: tcId, toolResult: result.output, success: result.success, executionTime: result.executionTime });
                if (result.success) {
                    const changedFiles = detectFileChanges(fnName, fnArgs, result.output);
                    if (changedFiles.length > 0)
                        addFileChanges(conversationId, changedFiles);
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
                tools: getOpenAITools({ source: convSource, model: ollamaModel, conversationId }),
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
        let ollamaUsage = null;
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
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
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
                }
                catch { }
            }
        }
        if (fullText) {
            conversations.addAssistantMessage(conversationId, [{ type: 'text', text: fullText }]);
            saveAssistantToBuffer(fullText);
        }
        onEvent({ type: 'done', usage: ollamaUsage });
        return fullText;
    }
    catch (err) {
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
export async function rawLLMCallStrict(prompt, systemPrompt) {
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
            let text;
            if (process.platform === 'win32') {
                // No shell (cmd.exe would flash a visible window). claude -p reads the
                // prompt from stdin; system prompt via file (argv-length safe).
                const { spawnSync } = await import('child_process');
                const r = spawnSync(CLAUDE_BIN, ['-p', '--model', CLI_MODEL, '--output-format', 'text', ...systemPromptFileArgs(systemPrompt)], { cwd: os.tmpdir(), timeout: 90_000, encoding: 'utf-8', env: cliEnv, maxBuffer: 8 * 1024 * 1024, input: prompt, windowsHide: true });
                if (r.status !== 0)
                    throw new Error(`claude -p exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
                text = (r.stdout || '').trim();
            }
            else {
                text = execSync(`echo '${escapedPrompt}' | ${CLAUDE_BIN} -p --model ${CLI_MODEL} --output-format text --system-prompt '${escapedSys}'`, { cwd: os.tmpdir(), timeout: 90_000, encoding: 'utf-8', env: cliEnv, maxBuffer: 8 * 1024 * 1024 }).toString().trim();
            }
            console.error(`[Gateway] rawLLMCallStrict claude-cli ${Date.now() - startMs}ms (${text.length} chars)`);
            return text;
        }
        catch (err) {
            console.error(`[Gateway] rawLLMCallStrict claude-cli failed: ${err.message}`);
            throw err;
        }
    }
    // Non-cli providers respect system prompt natively — defer to rawLLMCall.
    return rawLLMCall(prompt, systemPrompt);
}
export async function rawLLMCall(prompt, systemPrompt, opts) {
    const startMs = Date.now();
    const sys = systemPrompt || 'You are a helpful assistant. Be concise.';
    // Project-scoped planning: when the caller passes a project root, run the
    // claude -p subprocess THERE so its Read/Grep tools can explore that codebase
    // (and it picks up that project's CLAUDE.md). Default os.tmpdir() = sandboxed,
    // no file access (the safe default for general completions).
    const spawnCwdRaw = opts?.cwd;
    // claude-cli one-shot wall clock. The old hardcoded 90s killed large board
    // plans + research mid-synthesis (the inner claude -p died before the
    // planner's own budget). Callers that do heavy work (planner synthesize +
    // research gate) pass their full budget; default is generous and env-tunable
    // via VODOU_RAWLLM_TIMEOUT_MS. This is a safety net, not a normal-case limit.
    const cliTimeoutMs = Math.max(30_000, opts?.timeoutMs ?? (parseInt(process.env.VODOU_RAWLLM_TIMEOUT_MS || '300000', 10) || 300_000));
    // Output-token cap. Defaults to 1024 (deep-think thoughts, simple completions);
    // callers that need a longer structured reply (e.g. the board planner's JSON
    // synthesis) pass a higher value. Only affects providers that take a cap —
    // claude-cli / kimi-cli one-shot modes have no token-limit flag.
    const maxTokens = opts?.maxTokens ?? 1024;
    // jsonMode forces a strict JSON object reply on OpenAI-compatible providers
    // (incl. the managed `vodou` proxy → Fireworks). Without it, reasoning-style
    // models (e.g. kimi) "think out loud" and never emit parseable JSON.
    const jsonMode = opts?.jsonMode === true;
    try {
        // Quota pre-flight for the managed Vodou tier on background / non-chat calls
        // (workflow driver, board orchestration, deep-think). The interactive chat path
        // gates in dispatchToProvider; this closes the same hole for rawLLMCall — which
        // rawLLMCallPooled and rawLLMCallStrict both delegate to. Fail-OPEN on a degraded
        // (transient / missing-token) result so a blip doesn't kill background work, but
        // refuse a real over-limit / inactive account. Defense-in-depth; the proxy also enforces.
        if (currentProvider === 'vodou') {
            const quotaUid = process.env.VODOU_USER_ID || process.env.OI_USER_ID || 'default_user';
            const quota = await checkQuota(quotaUid);
            if (!quota.degraded && !quota.canExecute) {
                console.error(`[quota] rawLLMCall refused (managed over-limit): plan=${quota.planId} exceeded=${quota.exceededLimit}`);
                return '';
            }
        }
        let text = '';
        if (currentProvider === 'anthropic') {
            // Direct Anthropic SDK — non-streaming, no conversation
            const anthropic = getClient();
            const resp = await anthropic.messages.create({
                model: MODEL,
                max_tokens: maxTokens,
                system: sys,
                messages: [{ role: 'user', content: prompt }],
            });
            text = resp.content.filter((b) => b.type === 'text').map(b => b.text).join('');
        }
        else if (currentProvider === 'ollama') {
            // Direct Ollama — non-streaming
            const resp = await fetch(ollamaBaseUrl + '/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ollamaModel,
                    stream: false,
                    messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
                    options: { num_predict: maxTokens },
                }),
            });
            if (resp.ok) {
                const json = await resp.json();
                text = json.message?.content || '';
            }
        }
        else if (currentProvider === 'claude-cli') {
            // Claude CLI — one-shot spawn using -p (print) mode, tmpdir cwd.
            // tmpdir prevents loading CLAUDE.md/MEMORY.md workspace bootstrap, saving
            // ~28KB of context tokens per call (important for 15-thought deep-think loops).
            // Uses async exec (not execSync) so the event loop stays free.
            const escaped = prompt.replace(/'/g, "'\\''");
            const cliEnv = { ...process.env, ...freshEnvVars() };
            delete cliEnv.ANTHROPIC_API_KEY; // force Max subscription OAuth, not API key auth
            delete cliEnv.CLAUDECODE;
            delete cliEnv.VODOU_PROJECT_PATH; // belt-and-suspenders: prevent project root inheritance
            // Project-scoped planning: run in the requested project dir (if it exists)
            // so claude's Read/Grep tools can explore that codebase; else sandbox in
            // tmpdir (the default — no file access).
            let spawnCwd = os.tmpdir();
            // NOTE: this file is ESM — `require('fs')` throws here (require is not
            // defined), which silently kept the planner in tmpdir. Use the top-level
            // `existsSync` import instead.
            if (spawnCwdRaw) {
                try {
                    if (existsSync(spawnCwdRaw))
                        spawnCwd = spawnCwdRaw;
                }
                catch { /* keep tmpdir */ }
            }
            text = await new Promise((resolve, reject) => {
                if (process.platform === 'win32') {
                    // No shell pipeline on Windows (cmd.exe flashes). stdin the prompt.
                    const { spawn: spawnCp } = require('child_process');
                    const p = spawnCp(CLAUDE_BIN, ['-p', '--model', CLI_MODEL, '--output-format', 'text'], { cwd: spawnCwd, env: cliEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
                    let so = '';
                    let done = false;
                    const t = setTimeout(() => { if (!done) {
                        done = true;
                        try {
                            p.kill();
                        }
                        catch { }
                        reject(new Error('claude -p timeout'));
                    } }, cliTimeoutMs);
                    p.stdout.on('data', (d) => { so += d.toString(); });
                    p.on('error', (e) => { if (!done) {
                        done = true;
                        clearTimeout(t);
                        reject(e);
                    } });
                    p.on('close', (code) => {
                        if (done)
                            return;
                        done = true;
                        clearTimeout(t);
                        if (code !== 0 && !so)
                            reject(new Error(`claude -p exited ${code}`));
                        else
                            resolve(so.trim());
                    });
                    p.stdin.write(prompt);
                    p.stdin.end();
                    return;
                }
                exec(`echo '${escaped}' | ${CLAUDE_BIN} -p --model ${CLI_MODEL} --output-format text`, { cwd: spawnCwd, timeout: cliTimeoutMs, env: cliEnv }, (err, stdout) => {
                    if (err && !stdout)
                        reject(err);
                    else
                        resolve((stdout || '').trim());
                });
            });
        }
        else if (currentProvider === 'kimi-cli') {
            const full = `${sys}\n\n${prompt}`;
            const r = spawnSync(KIMI_BIN, ['--quiet', '--yolo', '--model', kimiCliModel, '-p', full], { cwd: getProjectRoot(), encoding: 'utf-8', timeout: 60_000, env: { ...process.env, ...freshEnvVars() } });
            text = (r.stdout || '').trim();
            if (!text && r.stderr)
                text = String(r.stderr).trim();
        }
        else {
            // OpenAI-compatible (Google, Groq, DeepSeek, xAI, Mistral, OpenAI, Custom, Kimi API)
            const { endpoint, apiKey, model } = getOpenAICompatConfig();
            if (!endpoint)
                throw new Error('No OpenAI-compatible endpoint configured');
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey)
                headers['Authorization'] = 'Bearer ' + apiKey;
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    max_tokens: maxTokens,
                    stream: false,
                    messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
                    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
                }),
            });
            if (resp.ok) {
                const json = await resp.json();
                text = json.choices?.[0]?.message?.content || '';
            }
        }
        console.error(`[rawLLMCall] ${currentProvider} responded in ${Date.now() - startMs}ms (${text.length} chars)`);
        return text.trim();
    }
    catch (err) {
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
 * For claude-cli: delegates to rawLLMCall which uses one-shot -p mode in
 * tmpdir (no workspace bootstrap, no tools). rawLLMCall is now async (exec
 * not execSync) so the event loop stays free during thought generation.
 *
 * Keeping this wrapper so callers don't need to change.
 */
export async function rawLLMCallPooled(conversationId, prompt, systemPrompt) {
    const startMs = Date.now();
    const result = await rawLLMCall(prompt, systemPrompt);
    console.error(`[rawLLMCallPooled] ${conversationId.substring(0, 8)} responded in ${Date.now() - startMs}ms (${result.length} chars)`);
    return result;
}
/** Get OpenAI-compatible endpoint/key/model for current provider */
function getOpenAICompatConfig() {
    switch (currentProvider) {
        case 'openai': return { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: openaiApiKey, model: openaiModel };
        case 'google': return { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: googleApiKey, model: googleModel };
        case 'groq': return { endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: groqApiKey, model: groqModel };
        case 'deepseek': return { endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: deepseekApiKey, model: deepseekModel };
        case 'xai': return { endpoint: 'https://api.x.ai/v1/chat/completions', apiKey: xaiApiKey, model: xaiModel };
        case 'mistral': return { endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: mistralApiKey, model: mistralModel };
        case 'kimi': return { endpoint: 'https://api.moonshot.ai/v1/chat/completions', apiKey: kimiApiKey, model: kimiModel };
        case 'openrouter': return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: openrouterApiKey, model: openrouterModel };
        case 'vodou': {
            const tok = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
            const uid = process.env.VODOU_USER_ID || process.env.OI_USER_ID || '';
            return { endpoint: process.env.VODOU_LLM_PROXY_URL || '', apiKey: `${tok}:${uid}`, model: vodouModel };
        }
        case 'fireworks': return { endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', apiKey: fireworksApiKey, model: fireworksModel };
        case 'together': return { endpoint: 'https://api.together.ai/v1/chat/completions', apiKey: togetherApiKey, model: togetherModel };
        case 'custom': return { endpoint: customBaseUrl, apiKey: customApiKey, model: customModel };
        case 'lmstudio': return { endpoint: lmstudioBaseUrl + '/v1/chat/completions', apiKey: '', model: lmstudioModel };
        case 'llamacpp': return { endpoint: llamacppBaseUrl + '/v1/chat/completions', apiKey: '', model: llamacppModel };
        default: return { endpoint: '', apiKey: '', model: '' };
    }
}
/** Get fresh env vars (re-read .env) for subprocess spawning */
function freshEnvVars() {
    try {
        const envPath = path.join(getProjectRoot(), '.env');
        const content = readFileSync(envPath, 'utf-8');
        const vars = {};
        for (const line of content.split('\n')) {
            const match = line.match(/^([^#=]+)=(.*)$/);
            if (match)
                vars[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
        }
        return vars;
    }
    catch {
        return {};
    }
}
/**
 * Simple non-streaming chat (for MCP tool use)
 */
export async function simpleChat(conversationId, message) {
    let result = '';
    await chat(conversationId, message, (event) => {
        if (event.type === 'text' && event.content) {
            result += event.content;
        }
    });
    return result;
}
export function clearConversation(conversationId) {
    const conversations = getConversationManager();
    conversations.clear(conversationId);
    clearWorkflow(conversationId);
    _bootstrappedConversations.delete(conversationId); // resend bootstrap on next message
    _activeSkill.delete(conversationId);
    _lastOiContext.delete(conversationId);
    _cachedSystemPrompts.delete(conversationId);
    _fileChanges.delete(conversationId);
    try {
        clearSkillState(conversationId);
    }
    catch { }
}
export function getStats() {
    syncProviderFromDb();
    let model = MODEL;
    switch (currentProvider) {
        case 'claude-cli':
            model = CLI_MODEL;
            break;
        case 'anthropic':
            model = MODEL;
            break;
        case 'kimi-cli':
            model = kimiCliModel;
            break;
        case 'kimi':
            model = kimiModel;
            break;
        case 'openai':
            model = openaiModel;
            break;
        case 'google':
            model = googleModel;
            break;
        case 'groq':
            model = groqModel;
            break;
        case 'deepseek':
            model = deepseekModel;
            break;
        case 'xai':
            model = xaiModel;
            break;
        case 'mistral':
            model = mistralModel;
            break;
        case 'openrouter':
            model = openrouterModel;
            break;
        case 'ollama':
            model = ollamaModel;
            break;
        case 'lmstudio':
            model = lmstudioModel;
            break;
        case 'llamacpp':
            model = llamacppModel;
            break;
        case 'custom':
            model = customModel;
            break;
        case 'vodou':
            model = vodouModel;
            break;
        case 'fireworks':
            model = fireworksModel;
            break;
        case 'together':
            model = togetherModel;
            break;
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
export function warmupCliSession(conversationId) {
    if (currentProvider !== 'claude-cli')
        return;
    if (!usePersistentClaudeCliPool())
        return;
    if (_cliSessions.has(conversationId))
        return;
    // Skip warmup for skill / persona conversations. Warmup builds the prompt
    // from the workspace bootstrap, which would lock that prompt onto the
    // pooled session — when the real skill_message arrives later, the session
    // gets reused with the wrong prompt and SKILL.md never reaches the LLM.
    // Let the first skill_message spawn the session with the correct prompt.
    if (conversationId.startsWith('workbench:skill:') || conversationId.startsWith('skill-')) {
        return;
    }
    // Check if Claude CLI is authenticated before spawning.
    // Tightened detection: require non-zero exit AND an exact "Not authenticated"
    // line — the old loose substring match ("not logged") tripped on benign
    // output and opened Terminal windows on every conversation switch.
    try {
        const { rc: authRc, out: authOut } = claudeAuthStatusRaw();
        const notAuthed = authRc !== 0 && /^\s*Not authenticated\b/im.test(authOut);
        if (notAuthed) {
            // Flag it so the chat Reconnect banner shows immediately after a restart
            // with a logged-out CLI (the exact scenario that hid this incident).
            markClaudeCliAuthBad(CLAUDE_CLI_AUTH_REMEDIATION);
            console.error('[CLI warmup] Claude CLI not authenticated — run `claude auth login` (auto-popup disabled; set VODOU_CLI_AUTOLOGIN=1 to re-enable)');
            if (process.env.VODOU_CLI_AUTOLOGIN === '1') {
                try {
                    spawn('osascript', [
                        '-e', 'tell application "Terminal" to do script "echo \'Claude CLI needs authentication. Running: claude auth login\' && claude auth login"',
                        '-e', 'tell application "Terminal" to activate',
                    ], { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true }).unref();
                }
                catch (termErr) {
                    console.error(`[CLI warmup] Could not open Terminal: ${termErr.message}`);
                }
            }
            return;
        }
    }
    catch {
        // auth subcommand may not exist — proceed with spawn
    }
    // Build system prompt same way as chatWithCLI first-message path
    const bootstrap = getWorkspaceBootstrap();
    const systemPrompt = bootstrap
        ? bootstrap + '\n\n---\n\n' + getSystemPrompt()
        : getSystemPrompt();
    // Cache it so the first real message reuses it
    _cachedSystemPrompts.set(conversationId, { prompt: systemPrompt, builtAt: Date.now(), lensesEnabled: true });
    _bootstrappedConversations.add(conversationId);
    try {
        getOrCreateCliSession(conversationId, systemPrompt);
        console.error(`[CLI warmup] Pre-spawned session for ${conversationId.substring(0, 8)}`);
    }
    catch (err) {
        console.error(`[CLI warmup] Failed: ${err.message}`);
    }
}
export { initAuth, reinitAuth, triggerMemoryFlush, getActiveModelLabel };
