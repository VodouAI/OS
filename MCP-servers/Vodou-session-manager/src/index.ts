#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from './session-manager.js';

const server = new Server(
  {
    name: 'Vodou-session-manager',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const sessionManager = new SessionManager();

// Cleanup on shutdown
process.on('SIGINT', () => {
  sessionManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sessionManager.shutdown();
  process.exit(0);
});

// Periodic cleanup (every 5 minutes)
const cleanupInterval = setInterval(async () => {
  try {
    const closed = await sessionManager.cleanupIdleSessions();
    if (closed > 0) {
      console.error(`[Vodou-session-manager] Cleaned up ${closed} idle sessions`);
    }
  } catch (error) {
    console.error('[Vodou-session-manager] Cleanup error:', error);
  }
}, 5 * 60 * 1000);

// Self-terminate when parent disconnects stdio (only if no active sessions)
function gracefulShutdown(reason: string) {
  console.error(`[Vodou-session-manager] Shutting down: ${reason}`);
  clearInterval(cleanupInterval);
  sessionManager.shutdown();
  process.exit(0);
}

function onStdinEnd(reason: string) {
  const active = sessionManager.listSessions().filter(s => s.status === 'active');
  if (active.length > 0) {
    console.error(`[Vodou-session-manager] Parent disconnected (${reason}) but ${active.length} active session(s) - keeping process and browser(s) open. Close with: oi "close session" or kill this process.`);
    return;
  }
  gracefulShutdown(reason);
}

process.stdin.on('end', () => onStdinEnd('stdin end'));
process.stdin.on('close', () => onStdinEnd('stdin close'));
process.stdin.on('error', () => onStdinEnd('stdin error'));

// Watchdog: only shutdown if no active sessions
const watchdog = setInterval(() => {
  if (process.stdin.destroyed || !process.stdin.readable) {
    clearInterval(watchdog);
    onStdinEnd('stdin no longer readable (watchdog)');
  }
}, 30_000);
watchdog.unref();

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_session',
        description: 'Create a new MCP server session for long-running operations',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: {
              type: 'string',
              description: 'Name of the MCP server to create a session for (e.g., "chrome-devtools")',
            },
            timeout: {
              type: 'number',
              description: 'Session timeout in seconds (default: 3600)',
              default: 3600,
            },
            metadata: {
              type: 'object',
              description: 'Optional metadata to store with the session',
            },
          },
          required: ['server_name'],
        },
      },
      {
        name: 'call_with_session',
        description: 'Call a tool on an existing MCP server session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session ID from create_session',
            },
            tool_name: {
              type: 'string',
              description: 'Name of the tool to call on the MCP server',
            },
            arguments: {
              type: 'object',
              description: 'Arguments to pass to the tool',
            },
            timeout_ms: {
              type: 'number',
              description: 'Optional timeout in milliseconds for this tool call (default: 60000)',
            },
          },
          required: ['session_id', 'tool_name'],
        },
      },
      {
        name: 'list_sessions',
        description: 'List all active MCP server sessions',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: {
              type: 'string',
              description: 'Optional: Filter by server name',
            },
          },
        },
      },
      {
        name: 'close_session',
        description: 'Close an MCP server session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session ID to close',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'session_status',
        description: 'Get status of an MCP server session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session ID to check',
            },
          },
          required: ['session_id'],
        },
      },
    ] as Tool[],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'create_session': {
        const { server_name, timeout, metadata } = args as {
          server_name: string;
          timeout?: number;
          metadata?: Record<string, any>;
        };

        const result = await sessionManager.createSession({
          server_name,
          timeout,
          metadata,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                session_id: result.session_id,
                status: result.status,
                message: result.status === 'reused'
                  ? `Reusing existing session: ${result.session_id}`
                  : `Created new session: ${result.session_id}`,
              }, null, 2),
            },
          ],
        };
      }

      case 'call_with_session': {
        const { session_id, tool_name, arguments: toolArgs, timeout_ms } = args as {
          session_id: string;
          tool_name: string;
          arguments: Record<string, any>;
          timeout_ms?: number;
        };

        const result = await sessionManager.callWithSession({
          session_id,
          tool_name,
          arguments: toolArgs || {},
          timeout_ms,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'list_sessions': {
        const { server_name } = args as { server_name?: string };
        const sessions = sessionManager.listSessions(server_name);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                sessions.map(s => ({
                  session_id: s.session_id,
                  server_name: s.server_name,
                  status: s.status,
                  created_at: s.created_at,
                  last_used_at: s.last_used_at,
                  expires_at: s.expires_at,
                })),
                null,
                2
              ),
            },
          ],
        };
      }

      case 'close_session': {
        const { session_id } = args as { session_id: string };
        await sessionManager.closeSession(session_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                session_id,
                status: 'closed',
                message: `Session ${session_id} closed successfully`,
              }, null, 2),
            },
          ],
        };
      }

      case 'session_status': {
        const { session_id } = args as { session_id: string };
        const session = sessionManager.getSessionStatus(session_id);

        if (!session) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Session not found',
                  session_id,
                }, null, 2),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                session_id: session.session_id,
                server_name: session.server_name,
                status: session.status,
                created_at: session.created_at,
                last_used_at: session.last_used_at,
                expires_at: session.expires_at,
                metadata: session.metadata ? JSON.parse(session.metadata) : null,
              }, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.message || 'Unknown error',
            tool: name,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Vodou-session-manager MCP server running on stdio');
}

main().catch(console.error);

