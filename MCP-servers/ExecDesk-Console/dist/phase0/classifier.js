/**
 * Phase 0 classifier — determines which cascade layer would have caught a prompt.
 *
 * Buckets (one per prompt):
 *  - deterministic_intent_match : daemon already matched, ≤1 tool call → L1 short-circuit
 *  - bash_safelist_eligible     : matches L2 safelist regex, ≤1 tool call
 *  - preflight_eligible         : in scope + single tool call to that scope's adapter
 *  - single_tool_routable       : 1 tool call, short prompt, scope-aware → L4 router would catch
 *  - multi_tool_workflow        : ≥5 tool calls → L6.e skill auto-extraction candidate
 *  - claude_required            : nothing else applies
 *
 * Eligibility filters (non-cascade-eligible at all):
 *  - prompt > 800 chars
 *  - prompt > 3 lines
 *  - has code block
 *  - starts with { [ <
 */
const BASH_SAFELIST_REGEXES = [
    /\b(cpu|cpu usage|processor)\b/i,
    /\b(disk|free space|disk space)\b/i,
    /\b(current branch|git branch)\b/i,
    /\b(open ports|listening ports)\b/i,
    /\buptime\b/i,
    /\b(memory|ram usage)\b/i,
    /\b(hostname|machine name)\b/i,
    /\b(date|today's date|what day)\b/i,
    /\b(working directory|pwd|where am i)\b/i,
    /\b(git status|uncommitted)\b/i,
    /\b(git log|recent commits)\b/i,
    /\b(processes|ps aux|running)\b/i,
];
export function classifyPrompt(a) {
    // Eligibility filters first
    if (a.prompt_len > 800)
        return 'claude_required';
    if (a.prompt_lines > 3)
        return 'claude_required';
    if (a.has_code_block)
        return 'claude_required';
    if (a.starts_with_punct)
        return 'claude_required';
    if (a.daemon_intent_matched && a.tool_calls_count <= 1) {
        return 'deterministic_intent_match';
    }
    if (a.tool_calls_count >= 5) {
        return 'multi_tool_workflow';
    }
    if (a.tool_calls_count <= 1 && BASH_SAFELIST_REGEXES.some(r => r.test(a.prompt_normalized))) {
        return 'bash_safelist_eligible';
    }
    if (a.scope && a.tool_calls_count === 1) {
        return 'preflight_eligible';
    }
    if (a.tool_calls_count === 1 && a.prompt_len < 300) {
        return 'single_tool_routable';
    }
    return 'claude_required';
}
export const CLASSIFICATIONS = [
    'deterministic_intent_match',
    'bash_safelist_eligible',
    'preflight_eligible',
    'single_tool_routable',
    'multi_tool_workflow',
    'claude_required',
];
export const SHORT_CIRCUIT_CLASSIFICATIONS = new Set([
    'deterministic_intent_match',
    'bash_safelist_eligible',
    'preflight_eligible',
    'single_tool_routable',
]);
