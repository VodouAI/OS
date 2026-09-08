/**
 * Vodou Router - Intelligent routing using LLM
 * Determines the best skill/MCP/script to handle any query
 */

import { prompt } from './llm-client.js';
import { getCapabilitiesForRouting, loadCapabilities } from './capabilities.js';
import { getBrainContextForQuery } from './workspace-context.js';

export interface RouteDecision {
  type: 'skill' | 'mcp' | 'script' | 'chat';
  target?: string;
  tools?: string[];
  reasoning: string;
  confidence: number;
  originalQuery: string;
}

// MS-5 — the hardcoded MCP_TOOLS table is GONE.
//
// It listed tool names by hand and they had rotted. Checked against the live
// registry the day it was removed:
//
//   mcp-monitor              0/6 correct  (every name wrong)
//   Vodou-session-manager    2/5
//   Vodou-script-executor    2/4
//   browser-tools-stdio      4/5
//   vodou-core               not a registered server at all
//
// Those names went into the routing LLM's prompt as fact, so the router was
// being told to call tools that do not exist — the same class as QA-B2, where
// the scheduler called `run_script` against a server that exports
// `execute_script`.
//
// It was also REDUNDANT: `ctx.promptSection` below already carries a
// "## MCP servers & tools" section built from the live database, and this
// prompt's own routing rule 2 points the model at it ("full list is in 'MCP
// servers & tools' above"). So the model was handed two lists — one live, one
// three months stale — and no way to tell which to believe.
//
// Deleting beats regenerating: a generated copy is still a copy, and the thing
// that made this wrong was having a second source at all.

/**
 * Build the system prompt for routing decisions. Loads full Vodou context (DB intents + memory search + capabilities) so the LLM has everything before answering.
 */
function buildRoutingPrompt(query: string): string {
  const ctx = getBrainContextForQuery(query);

  return `You are Vodou's intelligent router. Your job is to analyze user queries and determine the BEST way to handle them.

Below is the current Vodou state (live from DB and memory). Use it to stay in sync with what the brain can do.

${ctx.promptSection}

## Routing Rules

0. **Intent mappings (from Vodou DB)** — When the user query clearly matches a keyword from the "Intent mappings" list above, prefer that server::tool so the brain's fast path and the router stay in sync.

1. **Skills** are for expert workflows that need guidance and user interaction
   - Use skills for: learning, tutorials, complex multi-step workflows, security audits
   - Skills have stopping points for user decisions

2. **MCP Servers** are for direct tool execution (full list is in "MCP servers & tools" above)
   - Use MCP for: system monitoring, memory, browser automation, thinking sessions
   - Fast, direct tool calls

3. **Scheduler** — "scheduled tasks", "schedule list", "what's scheduled" → vodou-core::vc_schedule_list. Adding tasks → vc_schedule_add.

4. **Scripts** are for custom automation (see "Script registry" above)
   - Use scripts for: batch operations, scheduled tasks, custom workflows

5. **Chat** is for general conversation
   - Use chat for: greetings, questions, jokes, explanations, general Q&A
   - When no specific tool or skill is needed

## Response Format

You MUST respond with ONLY a JSON object in this exact format:
{
  "type": "skill" | "mcp" | "script" | "chat",
  "target": "name of skill/server/script if applicable",
  "tools": ["specific", "tool", "names"] (only for MCP type),
  "reasoning": "brief explanation of why this route was chosen",
  "confidence": 0.0 to 1.0
}

## Examples

Query: "What's my CPU usage?"
Response: {"type": "mcp", "target": "mcp-monitor", "tools": ["get_cpu_usage"], "reasoning": "Direct system monitoring query", "confidence": 0.95}

Query: "Hello, how are you?"
Response: {"type": "chat", "reasoning": "General greeting, no specific tool needed", "confidence": 0.99}

Query: "Deep think about API design"
Response: {"type": "mcp", "target": "Vodou-Enhanced-Thinking", "tools": ["start_thinking_session"], "reasoning": "Requires deep thinking session", "confidence": 0.9}

Query: "security audit"
Response: {"type": "skill", "target": "code-review", "reasoning": "Security audit is a complex workflow with user decisions", "confidence": 0.85}

IMPORTANT: Respond with ONLY the JSON object. No other text.`;
}

/**
 * Quick pattern matching for obvious routes (optimization)
 */
function quickMatch(query: string): RouteDecision | null {
  const q = query.toLowerCase().trim();

  // CPU/Memory/Disk - definitely mcp-monitor
  if (/\b(cpu|memory|ram|disk|storage|network|processes?|system info)\b/i.test(q)) {
    const tools: string[] = [];
    if (/cpu/i.test(q)) tools.push('get_cpu_usage');
    if (/memory|ram/i.test(q)) tools.push('get_memory_usage');
    if (/disk|storage/i.test(q)) tools.push('get_disk_usage');
    if (/network/i.test(q)) tools.push('get_network_stats');
    if (/process/i.test(q)) tools.push('get_top_processes');
    if (/system info/i.test(q)) tools.push('get_system_info');
    if (tools.length === 0) tools.push('get_system_info');

    return {
      type: 'mcp',
      target: 'mcp-monitor',
      tools,
      reasoning: 'System monitoring query - direct MCP tool match',
      confidence: 0.95,
      originalQuery: query,
    };
  }

  // Deep think - Enhanced Thinking
  if (/\b(deep think|think deeply|think about|analyze deeply)\b/i.test(q)) {
    return {
      type: 'mcp',
      target: 'Vodou-Enhanced-Thinking',
      tools: ['start_thinking_session'],
      reasoning: 'Deep thinking request - starting thinking session',
      confidence: 0.9,
      originalQuery: query,
    };
  }

  // Screenshot
  if (/\b(screenshot|take\s+picture|capture\s+screen)\b/i.test(q)) {
    return {
      type: 'mcp',
      target: 'chrome-devtools',
      tools: ['take_screenshot'],
      reasoning: 'Screenshot request',
      confidence: 0.9,
      originalQuery: query,
    };
  }

  // Script execution
  if (/\b(run|execute)\s+(script|bash|shell)\b/i.test(q)) {
    return {
      type: 'mcp',
      target: 'Vodou-script-executor',
      tools: ['execute_script'],
      reasoning: 'Script execution request',
      confidence: 0.85,
      originalQuery: query,
    };
  }

  // Check skill triggers
  const { skillTriggers } = getCapabilitiesForRouting();
  for (const [trigger, skillName] of skillTriggers) {
    if (q.includes(trigger)) {
      return {
        type: 'skill',
        target: skillName,
        reasoning: `Matched skill trigger: "${trigger}"`,
        confidence: 0.85,
        originalQuery: query,
      };
    }
  }

  // Common greetings - chat
  if (/^(hi|hello|hey|howdy|what'?s up|yo)\b/i.test(q) && q.length < 50) {
    return {
      type: 'chat',
      reasoning: 'Greeting detected',
      confidence: 0.95,
      originalQuery: query,
    };
  }

  return null;
}

/**
 * Route a query using LLM intelligence
 */
export async function routeQuery(query: string, context?: string): Promise<RouteDecision> {
  // First try quick pattern matching
  const quickResult = quickMatch(query);
  if (quickResult) {
    return quickResult;
  }

  // Use LLM for complex routing (with full Vodou context loaded)
  const systemPrompt = buildRoutingPrompt(query);
  const userPrompt = context
    ? `Context: ${context}\n\nQuery: ${query}`
    : `Query: ${query}`;

  try {
    const response = await prompt(systemPrompt, userPrompt);

    // Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Omit<RouteDecision, 'originalQuery'>;
      return {
        ...parsed,
        originalQuery: query,
      };
    }

    // Fallback to chat if parsing fails
    return {
      type: 'chat',
      reasoning: 'Could not determine specific route, defaulting to chat',
      confidence: 0.5,
      originalQuery: query,
    };
  } catch (error) {
    console.error('Routing error:', error);

    // Fallback to chat on error
    return {
      type: 'chat',
      reasoning: `Routing error: ${error}. Defaulting to chat.`,
      confidence: 0.3,
      originalQuery: query,
    };
  }
}

/**
 * Get routing explanation for a query (for debugging)
 */
export async function explainRoute(query: string): Promise<string> {
  const decision = await routeQuery(query);

  return `Query: "${query}"
Route Type: ${decision.type}
${decision.target ? `Target: ${decision.target}` : ''}
${decision.tools ? `Tools: ${decision.tools.join(', ')}` : ''}
Reasoning: ${decision.reasoning}
Confidence: ${(decision.confidence * 100).toFixed(0)}%`;
}
