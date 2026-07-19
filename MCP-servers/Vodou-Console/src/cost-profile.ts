/**
 * COGS Governor — PLANS/0.6.5/PLAN-COGS-GOVERNOR.md
 *
 * A per-turn "cost envelope" derived from the managed quota/plan signal and consulted by the
 * state-layer knobs (tool-loop depth, output cap, WS6 budget, WS4 tool-result cap, WS5 summary).
 * Keyed by conversationId so it reuses the existing per-conversation override pattern; populated
 * once per managed turn by dispatchToProvider from the quota it already fetched (no new fetch).
 *
 * DEP-FREE on purpose: both llm.ts and executor.ts import this, so it must not import either.
 *
 * SECURITY: this is NOT an enforcement boundary (the gateway is open source). It only *shapes*
 * how efficiently a user spends their allowance; the proxy + app-box enforce the dollar limit.
 * See PLAN-COGS-GOVERNOR §0b. Flag VODOU_COGS_GOVERNOR (default OFF) → no profile set → every
 * knob falls back to its base default → behavior identical to today.
 */

export interface CostProfile {
  stablePrefix: boolean;     // WS2 (kept = base; caching is a pure win at every tier)
  rollingSummary: boolean;   // WS5 (incl. background refresh)
  maxToolIterations: number; // tool-loop depth
  maxTokens: number;         // output cap
  turnTokenBudget: number;   // WS6 hard cut; 0 = no cut
  toolResultCap: number;     // WS4 inline char cap
  label: string;             // for logs/telemetry: 'pro:ok' | 'free' | 'warning' | 'degraded' | 'unmanaged'
}

const _profiles = new Map<string, CostProfile>();

export function setCostProfile(conversationId: string, p: CostProfile): void {
  if (conversationId) _profiles.set(conversationId, p);
}
export function getCostProfile(conversationId?: string): CostProfile | undefined {
  return conversationId ? _profiles.get(conversationId) : undefined;
}
export function clearCostProfile(conversationId?: string): void {
  if (conversationId) _profiles.delete(conversationId);
}

/** The governor is opt-in. When off, dispatchToProvider sets no profile → knobs use base defaults. */
export function governorEnabled(): boolean {
  return process.env.VODOU_COGS_GOVERNOR === '1';
}

/** Minimal projection of QuotaCheckResult the governor needs (keeps this module dep-free + testable). */
export interface GovernorInputs {
  managed: boolean;          // isVodouHostedTier (provider === 'vodou' on the hosted tier)
  planId: string;
  status: 'ok' | 'warning' | 'exceeded';
  degraded: boolean;
  tokensRemaining: number;
  monthlyTokenLimit: number;
  /** Option B: per-plan envelope from app.vodou.ai (/api/usage/limits cost_envelope). Wins over the local tier table. */
  serverEnvelope?: Record<string, unknown> | null;
}

/** Base (current) defaults — what a generous 'ok'/paid turn gets; also the non-managed fallback. */
export interface BaseDefaults {
  stablePrefix: boolean;
  rollingSummary: boolean;
  maxToolIterations: number;
  maxTokens: number;
  turnTokenBudget: number;
  toolResultCap: number;
}

interface TierKnobs {
  maxToolIterations?: number;
  maxTokens?: number;
  turnTokenBudget?: number;
  toolResultCap?: number;
  rollingSummary?: boolean;
}
export interface TierTable {
  ok: TierKnobs;
  low: TierKnobs & { _floorPct?: number };
  warning: TierKnobs;
  free: TierKnobs;
}

const _num = (v: string | undefined, d: number): number => {
  if (v == null || v.trim() === '') return d;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const _bool = (v: string | undefined, d: boolean): boolean => {
  if (v == null || v.trim() === '') return d;
  return v === '1' || v === 'true';
};
const _pct = (v: string | undefined, d: number): number => {
  if (v == null || v.trim() === '') return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Tunable per-tier envelope (starting points — gate the final numbers on WS-E margin data).
 * Each value overridable via env: VODOU_COGS_<TIER>_<KNOB>. `stablePrefix` is never tier-varied
 * (caching is a pure win → always base). An `ok`/paid turn uses base defaults unchanged.
 */
export const DEFAULT_TIER_TABLE: TierTable = {
  ok: {}, // base defaults — generous, no change vs today
  low: {
    _floorPct: _pct(process.env.VODOU_COGS_LOW_FLOOR_PCT, 0.15), // < 15% of allowance remaining
    maxToolIterations: _num(process.env.VODOU_COGS_LOW_MAX_ITERS, 8),
    turnTokenBudget: _num(process.env.VODOU_COGS_LOW_BUDGET, 180_000),
    rollingSummary: _bool(process.env.VODOU_COGS_LOW_SUMMARY, true),
  },
  warning: {
    maxToolIterations: _num(process.env.VODOU_COGS_WARNING_MAX_ITERS, 6),
    turnTokenBudget: _num(process.env.VODOU_COGS_WARNING_BUDGET, 120_000),
    rollingSummary: _bool(process.env.VODOU_COGS_WARNING_SUMMARY, false),
    toolResultCap: _num(process.env.VODOU_COGS_WARNING_CAP, 10_000),
  },
  free: {
    maxToolIterations: _num(process.env.VODOU_COGS_FREE_MAX_ITERS, 5),
    turnTokenBudget: _num(process.env.VODOU_COGS_FREE_BUDGET, 80_000),
    rollingSummary: _bool(process.env.VODOU_COGS_FREE_SUMMARY, false),
    toolResultCap: _num(process.env.VODOU_COGS_FREE_CAP, 8_000),
    maxTokens: _num(process.env.VODOU_COGS_FREE_MAX_TOKENS, 4_096),
  },
};

/** PURE: which envelope a turn falls into. near-limit ('warning'/'exceeded') → glide-path. */
export function classifyTier(q: GovernorInputs, table: TierTable = DEFAULT_TIER_TABLE): keyof TierTable {
  if (q.status === 'warning' || q.status === 'exceeded') return 'warning'; // near/at limit (any plan) → tighten
  const free = q.planId === 'free' || q.monthlyTokenLimit === 0;
  if (free) return 'free';
  const floor = table.low._floorPct ?? 0.15;
  if (q.monthlyTokenLimit > 0 && q.tokensRemaining / q.monthlyTokenLimit < floor) return 'low';
  return 'ok';
}

/**
 * PURE: derive the cost envelope. Non-managed or degraded → base defaults (never punish).
 * Precedence per knob: **server envelope (Option B) > tier table > base**. The server envelope
 * is the per-plan `cost_envelope` from app.vodou.ai — set in the admin plan editor — so packages
 * own their cost behavior without a gateway deploy. Omitted keys fall back to the tier/base value.
 */
export function deriveCostProfile(q: GovernorInputs, base: BaseDefaults, table: TierTable = DEFAULT_TIER_TABLE): CostProfile {
  if (!q.managed || q.degraded) {
    return { ...base, label: q.degraded ? 'degraded' : 'unmanaged' };
  }
  const tier = classifyTier(q, table);
  const t = table[tier];
  const env = (q.serverEnvelope && typeof q.serverEnvelope === 'object') ? q.serverEnvelope : null;
  const numKnob = (k: string, tierV: number | undefined, baseV: number): number => {
    const ev = env?.[k];
    if (typeof ev === 'number' && Number.isFinite(ev)) return ev;
    return tierV ?? baseV;
  };
  const boolKnob = (k: string, tierV: boolean | undefined, baseV: boolean): boolean => {
    const ev = env?.[k];
    if (typeof ev === 'boolean') return ev;
    return tierV ?? baseV;
  };
  return {
    stablePrefix: base.stablePrefix, // caching stays on at every tier
    rollingSummary: boolKnob('rollingSummary', t.rollingSummary, base.rollingSummary),
    maxToolIterations: numKnob('maxToolIterations', t.maxToolIterations, base.maxToolIterations),
    maxTokens: numKnob('maxTokens', t.maxTokens, base.maxTokens),
    turnTokenBudget: numKnob('turnTokenBudget', t.turnTokenBudget, base.turnTokenBudget),
    toolResultCap: numKnob('toolResultCap', t.toolResultCap, base.toolResultCap),
    label: `${q.planId}:${tier}${env ? '+env' : ''}`,
  };
}

// Test seam.
export function __clearAllCostProfilesForTest(): void { _profiles.clear(); }
