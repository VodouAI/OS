#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ThinkingServer } from './thinking-server.js';

const server = new Server(
  {
    name: 'Vodou-Enhanced-Thinking',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const thinkingServer = new ThinkingServer();

// Define all 6 tools
const TOOLS: Tool[] = [
  {
    name: 'start_thinking_session',
    description: 'Start a new thinking session with a topic. Returns session_id for subsequent operations.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'What to think about (e.g., "database optimization", "API design")',
        },
        estimated_steps: {
          type: 'integer',
          description: 'Estimated number of thinking steps (default: 5)',
          minimum: 1,
        },
        metadata: {
          type: 'object',
          description: 'Additional context (agent_id, skill, etc.)',
        },
        oi_session_id: {
          type: 'string',
          description: 'Optional: Link to Vodou-session-manager session',
        },
        oi_agent_id: {
          type: 'string',
          description: 'Optional: Link to agent/work log ID',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'add_thought',
    description: 'Add a thought to an existing thinking session. Returns full context including previous thoughts and suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID from start_thinking_session',
        },
        thought: {
          type: 'string',
          description: 'The current thinking step content',
        },
        thoughtNumber: {
          type: 'integer',
          description: 'Current thought number (1, 2, 3, ...)',
          minimum: 1,
        },
        totalThoughts: {
          type: 'integer',
          description: 'Estimated total thoughts needed',
          minimum: 1,
        },
        nextThoughtNeeded: {
          type: 'boolean',
          description: 'Whether another thought step is needed',
        },
        isRevision: {
          type: 'boolean',
          description: 'Whether this revises previous thinking',
        },
        revisesThought: {
          type: 'integer',
          description: 'Which thought number is being reconsidered',
          minimum: 1,
        },
        branchFromThought: {
          type: 'integer',
          description: 'Branching point thought number',
          minimum: 1,
        },
        branchId: {
          type: 'string',
          description: 'Branch identifier',
        },
        needsMoreThoughts: {
          type: 'boolean',
          description: 'If more thoughts are needed beyond initial estimate',
        },
      },
      required: ['session_id', 'thought', 'thoughtNumber', 'totalThoughts', 'nextThoughtNeeded'],
    },
  },
  {
    name: 'get_thought_context',
    description: 'Retrieve thought history for a session. Returns all thoughts with optional Vodou context enrichment.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to retrieve context for',
        },
        from_thought: {
          type: 'integer',
          description: 'Start from thought number (optional)',
          minimum: 1,
        },
        to_thought: {
          type: 'integer',
          description: 'End at thought number (optional)',
          minimum: 1,
        },
        include_branches: {
          type: 'boolean',
          description: 'Include branch thoughts (default: true)',
        },
        include_oi_context: {
          type: 'boolean',
          description: 'Include Vodou context enrichment (default: true)',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'analyze_thinking',
    description: 'Analyze the thinking process for a session. Returns gaps, assumptions, suggestions, and quality score.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to analyze',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'complete_thinking_session',
    description: 'Mark a thinking session as complete. Optionally provide final synthesis.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to complete',
        },
        final_synthesis: {
          type: 'string',
          description: 'Optional final summary/synthesis',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_thinking_sessions',
    description: 'List thinking sessions. Filter by status (active, completed, paused) and limit results.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'completed', 'paused'],
          description: 'Filter by status (optional)',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results (default: 10)',
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
];

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (!args) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'No arguments provided' }),
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'start_thinking_session':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                thinkingServer.startSession(
                  args.topic as string,
                  args.estimated_steps as number | undefined,
                  args.metadata as any,
                  args.oi_session_id as string | undefined,
                  args.oi_agent_id as string | undefined
                ),
                null,
                2
              ),
            },
          ],
        };

      case 'add_thought':
        // Accept both camelCase and snake_case (Claude sometimes snake-cases params)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                thinkingServer.addThought(args.session_id as string, {
                  thought: args.thought as string,
                  thoughtNumber: (args.thoughtNumber ?? args.thought_number) as number,
                  totalThoughts: (args.totalThoughts ?? args.total_thoughts) as number,
                  nextThoughtNeeded: (args.nextThoughtNeeded ?? args.next_thought_needed) as boolean,
                  isRevision: (args.isRevision ?? args.is_revision) as boolean | undefined,
                  revisesThought: (args.revisesThought ?? args.revises_thought) as number | undefined,
                  branchFromThought: (args.branchFromThought ?? args.branch_from_thought) as number | undefined,
                  branchId: (args.branchId ?? args.branch_id) as string | undefined,
                  needsMoreThoughts: (args.needsMoreThoughts ?? args.needs_more_thoughts) as boolean | undefined,
                }),
                null,
                2
              ),
            },
          ],
        };

      case 'get_thought_context':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                thinkingServer.getThoughtContext(
                  args.session_id as string,
                  args.from_thought as number | undefined,
                  args.to_thought as number | undefined,
                  args.include_branches !== false,
                  args.include_oi_context !== false
                ),
                null,
                2
              ),
            },
          ],
        };

      case 'analyze_thinking':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                thinkingServer.analyzeThinking(args.session_id as string),
                null,
                2
              ),
            },
          ],
        };

      case 'complete_thinking_session':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                thinkingServer.completeSession(
                  args.session_id as string,
                  args.final_synthesis as string | undefined
                ),
                null,
                2
              ),
            },
          ],
        };

      case 'list_thinking_sessions':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                thinkingServer.listSessions(
                  args.status as 'active' | 'completed' | 'paused' | undefined,
                  args.limit as number | undefined
                ),
                null,
                2
              ),
            },
          ],
        };

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Unknown tool: ${name}`,
              }),
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

// Cleanup on exit
// Shutdown handlers — thinkingServer.close() → ThinkingDatabase.close()
// which runs WAL checkpoint before close (Safe Update System Phase 1).
process.on('SIGINT', () => {
  thinkingServer.close();
  process.exit(130); // 128 + SIGINT(2)
});

process.on('SIGTERM', () => {
  thinkingServer.close();
  process.exit(143); // 128 + SIGTERM(15)
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🧠 Vodou-Enhanced-Thinking MCP Server running on stdio');
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});

