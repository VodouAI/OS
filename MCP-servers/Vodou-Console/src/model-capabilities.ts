/**
 * model-capabilities.ts — per-model tool-calling capability map (PLAN 0.6.4 #8 §1.5b).
 *
 * Pure, no IO. The single place that encodes how a given model id should be treated
 * by the OpenAI-compat tool loop. Today it carries three things:
 *
 *   - supportsTools      — whether to OFFER tools to this model at all. Default true.
 *                          Driven by the VODOU_NO_TOOLS_MODELS operator lever so an
 *                          operator can disable tool offers for a model that mishandles
 *                          them (it then falls back to plain text-only chat) WITHOUT a
 *                          code change. This is the one ACTIVE behavior wired in.
 *   - toolChoiceMode     — the only sanctioned tool_choice for the compat path is
 *                          'auto'. Reasoner / thinking-mode models REQUIRE 'auto'
 *                          (they reject `required`/named tool_choice). The compat path
 *                          currently NEVER sends tool_choice (so it's implicitly auto);
 *                          this field + resolveToolChoice() are the guard any FUTURE
 *                          tool-forcing code MUST use so it can't 400 a reasoner.
 *   - isReasoner         — informational; reasoner/thinking model detection.
 *
 * Verified NON-issue (do NOT "fix"): the 0.6.4 plan claimed reasoner models need
 * `reasoning_content` round-tripped on tool turns "or the API 400s". That is INVERTED
 * vs. DeepSeek's actual contract — `reasoning_content` must NOT be sent back in
 * subsequent messages. The gateway already reads it for display only and never echoes
 * it into outbound messages, so the correct behavior is already in place. No round-trip.
 */

export interface ModelCapabilities {
  supportsTools: boolean;
  toolChoiceMode: 'auto';
  isReasoner: boolean;
  /**
   * Edit pathway (#8 §1.3): 'targeted' models get edit_file/multi_edit (precise,
   * token-efficient); 'whole-file' models are downgraded to write_file-only rewrites
   * because they can't reliably produce a matchable old_string — over-structuring a
   * weak model regresses it (Aider). Default 'targeted' (the #1.1 fuzzy applier
   * already tolerates most imprecision); operators opt a model down via
   * VODOU_WHOLE_FILE_MODELS. (Adaptive auto-downgrade from observed edit-failure rate
   * is deferred — needs a per-model benchmark / trajectory signal.)
   */
  editFormat: 'targeted' | 'whole-file';
}

// Reasoner / thinking-mode signatures (heuristic, lowercased id).
const REASONER_RE = /reasoner|qwq|thinking|-think\b|\bo1\b|\bo3\b/;

/** Operator lever: env var = comma/space list of model-id SUBSTRINGS (lowercased). */
function envSubstrings(name: string): string[] {
  return (process.env[name] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function modelCapabilities(model: string | undefined | null): ModelCapabilities {
  const id = (model || '').toLowerCase();
  const denied = id.length > 0 && envSubstrings('VODOU_NO_TOOLS_MODELS').some((sub) => id.includes(sub));
  const wholeFile = id.length > 0 && envSubstrings('VODOU_WHOLE_FILE_MODELS').some((sub) => id.includes(sub));
  return {
    supportsTools: !denied,
    toolChoiceMode: 'auto',
    isReasoner: REASONER_RE.test(id),
    editFormat: wholeFile ? 'whole-file' : 'targeted',
  };
}

/**
 * Clamp a DESIRED tool_choice to what the model accepts. Reasoner/thinking models
 * only accept 'auto', so any attempt to force a specific tool / 'required' is
 * downgraded to 'auto' (prevents a 400). No current caller forces tool_choice — this
 * is the guard for future tool-forcing code so it can't regress reasoner support.
 */
export function resolveToolChoice(
  model: string | undefined | null,
  desired: 'auto' | 'none' | 'required' | string = 'auto',
): 'auto' | 'none' | 'required' | string {
  if (desired === 'none') return 'none';
  const caps = modelCapabilities(model);
  if (caps.isReasoner) return 'auto'; // reasoners reject required/named
  return desired;
}
