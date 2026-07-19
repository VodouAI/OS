#!/usr/bin/env node

/**
 * Vodou-LLM-Router MCP Server
 *
 * Intelligent routing using LLM to find the RIGHT skill/MCP/script for any query.
 * This is the brain that makes Vodou "smart" at understanding user intent.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { routeQuery, explainRoute } from './router.js';
import { loadCapabilities, getCapabilitiesSummary } from './capabilities.js';
import { getIntentMappings, getBrainContextForQuery, getRelevantMatchesForQuery } from './workspace-context.js';
import { isLLMConfigured, getAuthMode, chat as llmChat, LLMMessage } from './llm-client.js';
import { complete } from './providers/index.js';

const server = new Server(
  {
    name: 'Vodou-LLM-router',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Conversation history for chat
const conversationHistory: LLMMessage[] = [];
const MAX_HISTORY = 20;

// Define tools
const TOOLS: Tool[] = [
  {
    name: 'route_query',
    description: 'Analyze a user query and determine the best skill/MCP/script to handle it. Returns a routing decision with type, target, tools, reasoning, and confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The user query to route',
        },
        context: {
          type: 'string',
          description: 'Optional additional context about the query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'chat',
    description: 'Handle general conversation when no specific tool is needed. Maintains conversation history for context.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to respond to',
        },
        clear_history: {
          type: 'boolean',
          description: 'Clear conversation history before this message',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_capabilities',
    description: 'List all available Vodou capabilities: skills, MCP servers, and scripts. Useful for understanding what Vodou can do.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['summary', 'detailed', 'json'],
          description: 'Output format (default: summary)',
        },
        refresh: {
          type: 'boolean',
          description: 'Force refresh capabilities cache',
        },
      },
    },
  },
  {
    name: 'explain_route',
    description: 'Get a detailed explanation of how a query would be routed. Useful for debugging and understanding routing decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The query to explain routing for',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'complete',
    description: 'Generic LLM completion for extraction, planning, agent. Supports claude, anthropic, ollama, script, openai, custom. Returns { text }. Use when vodou-core needs a single completion (memory extraction, planning step, agent insight).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User prompt' },
        system: { type: 'string', description: 'Optional system instruction' },
        provider: { type: 'string', description: 'Override: claude | anthropic | ollama | script | openai | custom' },
        model: { type: 'string', description: 'Model override (provider-specific)' },
        timeout_secs: { type: 'number', description: 'Request timeout in seconds (default 60)' },
        max_tokens: { type: 'number', description: 'Max tokens (default 1024)' },
        script_command: { type: 'string', description: 'For script provider: command to run' },
        base_url: { type: 'string', description: 'For custom provider: OpenAI-compatible endpoint base URL' },
        api_key_env: { type: 'string', description: 'For custom provider: env var name for API key' },
        ollama_base_url: { type: 'string', description: 'For ollama: base URL (default http://localhost:11434)' },
      },
      required: ['prompt'],
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'No arguments provided' }) }],
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'route_query': {
        const query = args.query as string;
        const context = args.context as string | undefined;

        // Check if LLM is configured
        if (!isLLMConfigured()) {
          // Fall back to pattern matching only
          console.error('Warning: ANTHROPIC_API_KEY not set. Using pattern matching only.');
        }

        const decision = await routeQuery(query, context);
        const matching = getRelevantMatchesForQuery(query);

        const payload: Record<string, unknown> = {
          decision,
          matching_skills: matching.skills.map((s) => ({ type: 'skill', target: s.name })),
          matching_mcp_servers: matching.mcpServers.map((m) => ({ type: 'mcp', target: m.server_name, tools: m.tools })),
          matching_scripts: matching.scripts.map((s) => ({ type: 'script', target: `${s.server_name}/${s.script_name}` })),
          note: 'Skills and MCP servers can be called directly via vodou-core (bt4).',
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }

      case 'chat': {
        const message = args.message as string;
        const clearHistory = args.clear_history as boolean | undefined;

        if (clearHistory) {
          conversationHistory.length = 0;
        }

        if (!isLLMConfigured()) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'LLM not configured. Set ANTHROPIC_API_KEY environment variable.',
                  message: 'I would respond to your message, but I need an API key to be configured.',
                }),
              },
            ],
          };
        }

        const ctx = getBrainContextForQuery(message);
        const systemPrompt = `You are Vodou, a helpful AI assistant. You have full Vodou context below (intents, memories, capabilities). When users need specific capabilities, suggest using the route_query tool or the right tool. For general conversation, be helpful, friendly, and concise.

${ctx.promptSection}`;

        const response = await llmChat(systemPrompt, conversationHistory, message);

        // Update history
        conversationHistory.push({ role: 'user', content: message });
        conversationHistory.push({ role: 'assistant', content: response });

        // Trim history if needed
        while (conversationHistory.length > MAX_HISTORY * 2) {
          conversationHistory.shift();
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                response,
                history_length: conversationHistory.length / 2,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_capabilities': {
        const format = (args.format as string) || 'summary';
        const refresh = args.refresh as boolean | undefined;

        const capabilities = loadCapabilities(refresh);

        if (format === 'json') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(capabilities, null, 2),
              },
            ],
          };
        }

        if (format === 'detailed') {
          const summary = getCapabilitiesSummary();
          return {
            content: [
              {
                type: 'text',
                text: summary,
              },
            ],
          };
        }

        // Summary format
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                skills: capabilities.skills.length,
                mcp_servers: capabilities.mcpServers.length,
                scripts: capabilities.scripts.length,
                intents_from_db: getIntentMappings().length,
                skill_names: capabilities.skills.slice(0, 10).map(s => s.name),
                mcp_server_names: capabilities.mcpServers.map(s => s.name),
                last_updated: capabilities.lastUpdated,
              }, null, 2),
            },
          ],
        };
      }

      case 'explain_route': {
        const query = args.query as string;
        const explanation = await explainRoute(query);

        return {
          content: [
            {
              type: 'text',
              text: explanation,
            },
          ],
        };
      }

      case 'complete': {
        const prompt = args.prompt as string;
        if (!prompt || typeof prompt !== 'string') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'provider_not_configured', message: 'prompt is required' }) }],
            isError: true,
          };
        }
        try {
          const text = await complete({
            prompt,
            system: args.system as string | undefined,
            provider: args.provider as string | undefined,
            model: args.model as string | undefined,
            timeout_secs: args.timeout_secs as number | undefined,
            max_tokens: args.max_tokens as number | undefined,
            script_command: args.script_command as string | undefined,
            base_url: args.base_url as string | undefined,
            api_key_env: args.api_key_env as string | undefined,
            ollama_base_url: args.ollama_base_url as string | undefined,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({ text }) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorCode = message.includes('timed out') ? 'timeout' : message.includes('not set') ? 'provider_not_configured' : 'api_error';
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: errorCode, message }) }],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  // Pre-load capabilities
  loadCapabilities();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🧠 Vodou-LLM-Router MCP Server running on stdio');
  const mode = getAuthMode();
  console.error(`   LLM: ${mode === 'api-key' ? 'API key' : mode === 'claude-cli' ? 'Claude CLI' : 'None (pattern matching only)'}`);
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
