/**
 * Token usage tracking — Phase 2 of PLAN-FIREWORKS-INTEGRATION.md.
 *
 * Captures per-event token counts from the `usage` StreamEvent emitted by
 * chatWithOpenAICompat / chatWithSDK / chatWithOllama and POSTs them to the
 * app.vodou.ai usage tracker so we can bill against tokens, not query count.
 *
 * Pricing table is application-side. Cached input tokens get the per-provider
 * discount automatically (most providers do 50% off cached prefix).
 */

import { getSetting } from './db.js';

/** Per-million-token pricing in USD. Source: vendor docs as of 2026-05-20. */
interface ProviderPricing {
  input: number;            // $/M input tokens
  output: number;           // $/M output tokens
  cachedInput?: number;     // $/M cached input tokens (when caching kicks in)
}

/**
 * Provider+model pricing. Keys are matched bottom-up:
 *   1. exact `${provider}::${model}` match
 *   2. provider+family prefix (e.g. fireworks::kimi-k2)
 *   3. provider default (fallback)
 *
 * Add new entries as vendor pricing or models change. Stale entries silently
 * over- or under-estimate COGS — keep this in sync with the live vendor pages.
 */
const PRICING: Record<string, ProviderPricing> = {
  // Fireworks (verified 2026-05-20)
  'fireworks::kimi-k2p6': { input: 0.95, output: 4.00, cachedInput: 0.16 },
  'fireworks::kimi-k2p5': { input: 0.60, output: 3.00, cachedInput: 0.10 },
  'fireworks::deepseek-v4-pro': { input: 1.74, output: 3.48, cachedInput: 0.145 },
  'fireworks::deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'fireworks::llama-v3p3-70b-instruct': { input: 0.90, output: 0.90 },
  'fireworks::gpt-oss-120b': { input: 0.15, output: 0.60, cachedInput: 0.015 },
  'fireworks::gpt-oss-20b': { input: 0.07, output: 0.30, cachedInput: 0.035 },
  'fireworks::glm-5p1': { input: 1.40, output: 4.40, cachedInput: 0.26 },
  'fireworks::': { input: 0.95, output: 4.00, cachedInput: 0.16 }, // provider default ≈ K2.6

  // Anthropic (verified — Claude 4.6/4.7 family)
  'anthropic::claude-opus-4-7': { input: 15.00, output: 75.00, cachedInput: 1.50 },
  'anthropic::claude-opus-4-6': { input: 15.00, output: 75.00, cachedInput: 1.50 },
  'anthropic::claude-sonnet-4-6': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'anthropic::claude-haiku-4-5': { input: 0.80, output: 4.00, cachedInput: 0.08 },
  'anthropic::': { input: 3.00, output: 15.00, cachedInput: 0.30 },

  // OpenAI
  'openai::gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'openai::gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  'openai::o3-mini': { input: 1.10, output: 4.40, cachedInput: 0.55 },
  'openai::': { input: 2.50, output: 10.00 },

  // Groq (LPU pricing)
  'groq::llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'groq::llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'groq::': { input: 0.59, output: 0.79 },

  // DeepSeek (direct API)
  'deepseek::deepseek-chat': { input: 0.27, output: 1.10, cachedInput: 0.07 },
  'deepseek::deepseek-reasoner': { input: 0.55, output: 2.19, cachedInput: 0.14 },
  'deepseek::': { input: 0.27, output: 1.10 },

  // Google Gemini
  'google::gemini-2.5-pro': { input: 1.25, output: 5.00, cachedInput: 0.31 },
  'google::gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'google::': { input: 0.075, output: 0.30 },

  // Moonshot direct / kimi-cli
  'kimi::': { input: 0.60, output: 2.50 },
  'kimi-cli::': { input: 0.60, output: 2.50 },

  // Together.ai
  'together::moonshotai/kimi-k2.6': { input: 1.20, output: 4.50, cachedInput: 0.20 },
  'together::': { input: 1.20, output: 4.50, cachedInput: 0.20 },

  // OpenRouter — NVIDIA Nemotron 3 (verified 2026-06-06, openrouter.ai/nvidia)
  'openrouter::nvidia/nemotron-3-ultra-550b-a55b': { input: 0.50, output: 2.50 },
  'openrouter::nvidia/nemotron-3-super-120b-a12b': { input: 0.09, output: 0.45 },
  'openrouter::nvidia/nemotron-3-nano-30b-a3b': { input: 0.05, output: 0.20 },
  'openrouter::nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': { input: 0.05, output: 0.20 }, // ≈ nano tier (free-only listing)
  // OpenRouter / Mistral / xAI fall back to provider default; no granular models here yet
  'openrouter::': { input: 1.00, output: 3.00 },
  'mistral::': { input: 2.00, output: 6.00 },
  'xai::': { input: 5.00, output: 15.00 },

  // Local / unknown providers get $0 — accurate for self-hosted
  'ollama::': { input: 0, output: 0 },
  'custom::': { input: 0, output: 0 },
  'claude-cli::': { input: 0, output: 0 }, // Claude Max subscription — flat fee, no per-token COGS
};

/** Look up pricing with progressive fallback: exact → family → provider default. */
function resolvePricing(provider: string, model: string): ProviderPricing {
  const exact = PRICING[`${provider}::${model}`];
  if (exact) return exact;
  // Family prefix match (e.g. `kimi-k2p6-fast` → `kimi-k2p6` if present, then `kimi-k2`)
  const tokens = model.split(/[-./]/);
  for (let i = tokens.length; i >= 2; i--) {
    const familyKey = `${provider}::${tokens.slice(0, i).join('-')}`;
    if (PRICING[familyKey]) return PRICING[familyKey];
  }
  return PRICING[`${provider}::`] ?? { input: 0, output: 0 };
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Compute estimated COGS in USD for the given usage on the given provider/model. */
export function computeCogs(provider: string, model: string, usage: TokenUsage): number {
  const p = resolvePricing(provider, model);
  const inTok = Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0));
  const cachedTok = Math.max(0, usage.cachedInputTokens ?? 0);
  const outTok = Math.max(0, usage.outputTokens ?? 0);
  const cogs =
    (inTok * p.input) / 1_000_000 +
    (cachedTok * (p.cachedInput ?? p.input * 0.5)) / 1_000_000 +
    (outTok * p.output) / 1_000_000;
  return Math.round(cogs * 1_000_000) / 1_000_000; // round to micro-USD
}

interface TrackPayload {
  userId: string;
  sessionId: string;
  executionTimeMs: number;
  serverName: string;
  toolName: string;
  success: boolean;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  modelProvider?: string;
  modelName?: string;
  estimatedCostUsd?: number;
  /** true = Vodou hosted tier (billed against plan); false = BYOK (own key, recorded
   * for the user's own dashboard + future usage-based billing, never gated on quota). */
  isHostedTier?: boolean;
}

/**
 * POST the usage event to app.vodou.ai. Fire-and-forget; failures are logged
 * but don't block the chat response. Mirrors the Rust usage_tracker.rs path
 * so we don't double-count in the Rust BrainLoader path (Rust handles tool
 * exec tracking; this handles LLM token tracking).
 */
export async function recordTokenUsage(payload: TrackPayload): Promise<void> {
  const url = process.env.VODOU_WEB_SERVER_URL || process.env.OI_WEB_SERVER_URL || 'https://app.vodou.ai';
  const token = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
  if (!token) {
    // No auth = no tracking. This is the BYOK path where the user hasn't
    // signed up for billing yet; nothing to report.
    return;
  }
  const body = {
    user_id: payload.userId,
    session_id: payload.sessionId,
    execution_time_ms: payload.executionTimeMs,
    // RFC3339 with zone marker — the Rust usage tracker sends to_rfc3339() to
    // the same endpoint; two shapes for one API is how parse bugs are born.
    timestamp: new Date().toISOString(),
    server_name: payload.serverName,
    tool_name: payload.toolName,
    success: payload.success,
    error_message: payload.errorMessage ?? null,
    input_tokens: payload.inputTokens ?? 0,
    output_tokens: payload.outputTokens ?? 0,
    cached_input_tokens: payload.cachedInputTokens ?? 0,
    model_provider: payload.modelProvider ?? null,
    model_name: payload.modelName ?? null,
    estimated_cost_usd: payload.estimatedCostUsd ?? 0,
    // Distinguishes hosted (billed against plan) from BYOK (recorded for the user's
    // own dashboard + future usage-based billing). Backend ignores it until the
    // usage_events.is_hosted_tier column lands (see PLANS/0.6.5/DO follow-on).
    is_hosted_tier: payload.isHostedTier ?? false,
  };
  try {
    const resp = await fetch(`${url}/api/usage/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}:${payload.userId}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok && process.env.DEBUG) {
      console.error(`[usage-tracking] non-2xx: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`[usage-tracking] POST failed:`, err);
    }
  }
}

// Phase 3c: pre-flight quota check
// Cache to avoid hammering /api/usage/limits on every chat. 30s TTL is a balance
// between "user upgrades, immediate effect" and "save 90% of network calls".
interface CachedLimit {
  result: QuotaCheckResult;
  fetchedAt: number;
}
const _limitsCache = new Map<string, CachedLimit>();
const LIMITS_TTL_MS = 30_000;

export interface QuotaCheckResult {
  canExecute: boolean;
  tokensUsed: number;
  tokensRemaining: number;
  monthlyTokenLimit: number;
  planId: string;
  status: 'ok' | 'warning' | 'exceeded';
  exceededLimit: string | null;
  /** COGS Governor (Option B): per-plan cost envelope from app.vodou.ai, or null (use gateway default). */
  costEnvelope?: Record<string, unknown> | null;
  /**
   * True when this result is the fail-open fallback (no token, or a transient
   * app.vodou.ai fetch failure) rather than a real answer from the cloud. Callers
   * that gate on entitlement (e.g. the Vodou-LLM activation gate) must NOT treat a
   * degraded result as "free / not entitled" — a paid user mid-outage would be
   * falsely blocked. The chat hot path ignores this and stays fail-open.
   */
  degraded?: boolean;
}

/**
 * Pre-flight quota check. Returns canExecute + remaining tokens for UI display.
 * Fail-open on network error (returns canExecute: true) — we'd rather over-serve
 * than block users on a transient app.vodou.ai outage. Audit drift via nightly
 * reconciliation cron, not by failing-closed at the chat hot path.
 */
export async function checkQuota(userId: string): Promise<QuotaCheckResult> {
  const cached = _limitsCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < LIMITS_TTL_MS) {
    return cached.result;
  }
  const url = process.env.VODOU_WEB_SERVER_URL || process.env.OI_WEB_SERVER_URL || 'https://app.vodou.ai';
  const token = process.env.VODOU_TOKEN || process.env.OI_TOKEN || getSetting('vodou_token') || '';
  const failOpen: QuotaCheckResult = {
    canExecute: true,
    tokensUsed: 0,
    tokensRemaining: 0,
    monthlyTokenLimit: 0,
    planId: 'free',
    status: 'ok',
    exceededLimit: null,
    degraded: true, // fallback, not a real cloud answer — see QuotaCheckResult.degraded
  };
  if (!token) return failOpen; // BYOK / no billing — never gate
  try {
    const resp = await fetch(`${url}/api/usage/limits`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}:${userId}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) return failOpen;
    const body = await resp.json() as any;
    if (body?.success === false) return failOpen;
    const data = body?.data || body;
    const result: QuotaCheckResult = {
      canExecute: data.can_execute !== false,
      tokensUsed: data.tokens_used ?? 0,
      tokensRemaining: data.tokens_remaining ?? 0,
      monthlyTokenLimit: data.monthly_token_limit ?? 0,
      planId: data.plan_id ?? 'free',
      status: data.status ?? 'ok',
      exceededLimit: data.exceeded_limit ?? null,
      costEnvelope: (data.cost_envelope && typeof data.cost_envelope === 'object') ? data.cost_envelope : null,
      degraded: false, // real answer from the cloud
    };
    _limitsCache.set(userId, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    return failOpen;
  }
}

/** Invalidate cache for a user — call after token POST so meter updates immediately. */
export function invalidateQuotaCache(userId: string): void {
  _limitsCache.delete(userId);
}
