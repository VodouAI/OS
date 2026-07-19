/**
 * Vodou Tool Definitions for Claude - Simplified Single Generic Tool
 *
 * Instead of defining dozens of tools for Claude, we define ONE generic tool
 * that lets Claude call ANY vodou-core MCP tool directly.
 *
 * Version: 0.5.33.6 - Direct vodou-core Integration
 */

import Anthropic from '@anthropic-ai/sdk';

export type Tool = Anthropic.Messages.Tool;

export const VODOU_TOOLS: Tool[] = [
  {
    name: "vodou_core_call",
    description: `Call any Vodou/vodou-core MCP tool directly.

Available servers and tools (examples):
- mcp-monitor: get_cpu_usage, get_memory_usage, get_disk_usage, get_top_processes
- Vodou-Enhanced-Thinking: start_thinking_session, get_session_state
- chrome-devtools: take_screenshot, navigate_page, take_snapshot, list_console_messages
- vodou-core: vc_load_skill, vc_list_servers

Use this tool to execute system monitoring, deep thinking, memory operations, etc.
Pass server name, tool name, and optional arguments.`,
    input_schema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "MCP server name (e.g., 'mcp-monitor', 'Vodou-Enhanced-Thinking')"
        },
        tool: {
          type: "string",
          description: "Tool name (e.g., 'get_cpu_usage', 'start_thinking_session')"
        },
        args: {
          type: "object",
          description: "Tool arguments as JSON object (optional)"
        }
      },
      required: ["server", "tool"]
    }
  },
  {
    name: "list_available_tools",
    description:
      "List MCP servers and tools from the local vodou-core.db cache (instant). Use to discover capabilities without connecting to remotes. Refresh **Capabilities → MCP Servers** (or run `./vodou-core all-tools` once) if the list looks stale.",
    input_schema: {
      type: "object" as const,
      properties: {}
    }
  }
];

/**
 * Get tool by name
 */
export function getTool(name: string): Tool | undefined {
  return VODOU_TOOLS.find(tool => tool.name === name);
}

/**
 * Get all tool names
 */
export function getToolNames(): string[] {
  return VODOU_TOOLS.map(tool => tool.name);
}

/**
 * OpenAI-compatible tool format (used by OpenAI, Gemini, Groq, Ollama, etc.)
 */
export function getOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return VODOU_TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/** Detect menu/stopping-point replies — these should skip tool calling and stay in active skill.
 *  Matches: "1", "1. Quick Start", "3) Option", "2: something", "yes", "no", "all", "y", "n" */
export function isMenuReply(message: string): boolean {
  return /^\d{1,2}[\.\)\s:]|^\d{1,2}$|^(all|yes|no|y|n)\s*[!?.]*$/i.test(message.trim());
}
