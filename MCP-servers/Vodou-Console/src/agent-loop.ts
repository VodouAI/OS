/**
 * Agent-loop iteration budget — PLANS/0.6.5/DO/PLAN-AGENT-LOOP.md (Phase 1).
 *
 * Ports Hermes' IterationBudget (agent/iteration_budget.py): a per-turn counter
 * with a one-shot GRACE call after exhaustion and REFUND for cheap local tool
 * rounds (read-only FS/recall tools shouldn't burn the model's "thinking" budget).
 *
 * DEP-FREE on purpose (mirrors cost-profile.ts) — must NOT import llm/executor,
 * both of which import this. Single-threaded JS → no lock (Hermes needs one for
 * concurrent subagents; our future in-process delegate would give each child its
 * OWN budget, so there is still no shared mutable counter).
 *
 * Flag VODOU_AGENT_MODE (default OFF) → agentModeFor() false → getMaxToolIterations
 * in llm.ts falls back to MAX_TOOL_ITERATIONS → behavior identical to today.
 */

/** Read-only / cheap local tools whose rounds are refunded (don't consume budget). */
export const CHEAP_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'grep', 'glob', 'file_stat', 'directory_tree',
  'search_files', 'expand_result', 'list_directory',
]);

export interface IterationBudget {
  /** Consume one iteration. Returns false when exhausted (then try useGrace()). */
  tryConsume(): boolean;
  /** One-shot final attempt after exhaustion — lets the model wrap up cleanly. */
  useGrace(): boolean;
  /** Give an iteration back (Hermes refund) — called when a round was all-cheap. */
  refund(): void;
  readonly used: number;
  readonly max: number;
  readonly remaining: number;
}

export function makeIterationBudget(max: number): IterationBudget {
  const cap = Number.isFinite(max) && max > 0 ? max : 1;
  let used = 0;
  let graceSpent = false;
  return {
    tryConsume() {
      if (used >= cap) return false;
      used++;
      return true;
    },
    useGrace() {
      if (graceSpent) return false;
      graceSpent = true;
      return true;
    },
    refund() {
      if (used > 0) used--;
    },
    get used() { return used; },
    get max() { return cap; },
    get remaining() { return Math.max(0, cap - used); },
  };
}

/** True if EVERY tool executed this round was cheap/read-only ⇒ round is refundable. */
export function roundIsRefundable(toolNames: string[]): boolean {
  return toolNames.length > 0 && toolNames.every((n) => CHEAP_TOOL_NAMES.has(n));
}

// --- Agent-mode per-conversation flag (mirrors _conversationMaxToolIterations) ---

const _agentMode = new Map<string, boolean>();

/** Agent-mode cap when no explicit override / governor profile is in play. */
export function agentModeMaxIters(): number {
  const n = parseInt(process.env.VODOU_AGENT_MAX_ITERS || '40', 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

/** Master switch (mirrors governorEnabled()). */
export function agentModeEnabled(): boolean {
  return process.env.VODOU_AGENT_MODE === '1';
}

export function setConversationAgentMode(conversationId: string, on: boolean): void {
  if (conversationId) _agentMode.set(conversationId, on);
}

/** A conversation is in agent mode if the global flag is on OR it was set per-conv. */
export function agentModeFor(conversationId?: string): boolean {
  if (!conversationId) return agentModeEnabled();
  return _agentMode.get(conversationId) ?? agentModeEnabled();
}

export function clearConversationAgentMode(conversationId?: string): void {
  if (conversationId) _agentMode.delete(conversationId);
}

// Test seam.
export function __clearAgentModeForTest(): void { _agentMode.clear(); }
