#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { executeScript, getScriptStatus, getScriptOutput, cancelScript } from './script-runner.js';
import { open as openDb } from './db.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get database path (assumes vodou-core.db is in project root)
function getDatabasePath(): string {
  // Go up from MCP-servers/Vodou-script-executor/dist/index.js to project root
  const projectRoot = join(__dirname, '../../..');
  return join(projectRoot, 'vodou-core.db');
}

const server = new Server(
  {
    name: 'Vodou-script-executor',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute_script',
        description: 'Execute a registered script (synchronously or in background)',
        inputSchema: {
          type: 'object',
          properties: {
            server_name: {
              type: 'string',
              description: 'The server name that owns the script',
            },
            script_name: {
              type: 'string',
              description: 'The script name to execute',
            },
            params: {
              type: 'object',
              description: 'Parameters to pass to the script',
              additionalProperties: true,
            },
          },
          required: ['server_name', 'script_name'],
        },
      },
      {
        name: 'script_status',
        description: 'Get the status of a background script job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID returned from execute_script',
            },
          },
          required: ['job_id'],
        },
      },
      {
        name: 'script_output',
        description: 'Get the output from a script job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID returned from execute_script',
            },
            tail_lines: {
              type: 'number',
              description: 'Number of lines to return (default: 100)',
            },
          },
          required: ['job_id'],
        },
      },
      {
        name: 'cancel_script',
        description: 'Cancel a running background script job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID to cancel',
            },
          },
          required: ['job_id'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const dbPath = getDatabasePath();

  try {
    switch (name) {
      case 'execute_script': {
        const { server_name, script_name, params = {} } = args as {
          server_name: string;
          script_name: string;
          params?: Record<string, any>;
        };

        // Both are `required` in the input schema, but an auto-routed caller (the
        // intent router matching a keyword inside unrelated prose) can still arrive
        // with `{}`. Without this guard the undefined flows into `.get(?)` and
        // node:sqlite raises "Provided value cannot be bound to SQLite parameter 1" —
        // an opaque message that names a placeholder index and blames the DB for what
        // is really a missing argument. Say what is actually wrong.
        if (typeof server_name !== 'string' || !server_name.trim()) {
          throw new Error(
            `execute_script requires 'server_name' (string). Received: ${JSON.stringify(args ?? {})}`
          );
        }
        if (typeof script_name !== 'string' || !script_name.trim()) {
          throw new Error(
            `execute_script requires 'script_name' (string). Received: ${JSON.stringify(args ?? {})}`
          );
        }

        // Check if server_name is actually a keyword (from intent mapping)
        // Only do keyword lookup if script_name is 'execute_script' (default from parameter extraction)
        // If both server_name and script_name are provided explicitly, use them directly
        let actualServerName = server_name;
        let actualScriptName = script_name;
        
        const db = openDb(dbPath);
        
        // Only do keyword lookup if script_name is the default 'execute_script'
        // This means it came from natural language query with parameter extraction issues
        if (script_name === 'execute_script' || script_name === 'default') {
          // Try to find metadata by keyword (server_name might be the keyword from intent)
          let metadata = db.prepare(`
            SELECT target_server, target_script 
            FROM script_intent_metadata 
            WHERE keyword = ?
          `).get(server_name) as { target_server: string; target_script: string } | undefined;
          
          // If not found, try partial keyword match (query may be truncated or paraphrased)
          if (!metadata) {
            const keywords = db.prepare(`
              SELECT keyword, target_server, target_script 
              FROM script_intent_metadata 
              WHERE keyword LIKE ?
            `).all(`%${server_name}%`) as Array<{ keyword: string; target_server: string; target_script: string }>;
            if (keywords.length > 0) {
              const bestMatch = keywords.sort((a, b) => b.keyword.length - a.keyword.length)[0];
              metadata = { target_server: bestMatch.target_server, target_script: bestMatch.target_script };
            }
          }
          
          if (metadata) {
            actualServerName = metadata.target_server;
            actualScriptName = metadata.target_script;
          }
        }
        // Otherwise, use the provided server_name and script_name directly
        db.close();

        const result = await executeScript(dbPath, actualServerName, actualScriptName, params);
        
        if (result.jobId) {
          // Background job
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  jobId: result.jobId,
                  status: result.status,
                  message: result.message || `Background job started: ${result.jobId}`,
                  checkStatus: `oi "script status ${result.jobId}"`,
                  viewOutput: `oi "script output ${result.jobId}"`,
                }, null, 2),
              },
            ],
          };
        } else {
          // Synchronous execution
          return {
            content: [
              {
                type: 'text',
                text: result.output || 'Script executed successfully',
              },
            ],
          };
        }
      }

      case 'script_status': {
        const { job_id } = args as { job_id: string };
        if (typeof job_id !== 'string' || !job_id.trim()) {
          throw new Error(`script_status requires 'job_id' (string). Received: ${JSON.stringify(args ?? {})}`);
        }
        const status = await getScriptStatus(dbPath, job_id);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      case 'script_output': {
        const { job_id, tail_lines = 100 } = args as { job_id: string; tail_lines?: number };
        if (typeof job_id !== 'string' || !job_id.trim()) {
          throw new Error(`script_output requires 'job_id' (string). Received: ${JSON.stringify(args ?? {})}`);
        }
        const output = await getScriptOutput(dbPath, job_id, tail_lines);
        
        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      }

      case 'cancel_script': {
        const { job_id } = args as { job_id: string };
        if (typeof job_id !== 'string' || !job_id.trim()) {
          throw new Error(`cancel_script requires 'job_id' (string). Received: ${JSON.stringify(args ?? {})}`);
        }
        const result = await cancelScript(dbPath, job_id);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Vodou-script-executor MCP server running on stdio');
}

main().catch(console.error);

