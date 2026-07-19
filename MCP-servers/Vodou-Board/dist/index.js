#!/usr/bin/env node
/**
 * Vodou-Board MCP server entrypoint.
 *
 * 14 board_* tools. Gated on VODOU_BOARD_TASK env var — visible only in
 * worker sessions. Workers spawned by the dispatcher have it set; chat
 * sessions don't.
 *
 * Reads route directly through src/db.ts (board.db + ATTACHed core + mem).
 * Writes route through src/gateway-client.ts (POST /api/board/* with
 * VODOU_BOARD_WRITE_TOKEN bearer auth, offline orphan-event fallback).
 *
 * Mirrors MCP-servers/Vodou-Enhanced-Thinking/src/index.ts shape.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { isWorkerSession, toolsExposed } from './gating.js';
// Tool handlers
import { handleShow } from './tools/show.js';
import { handleList } from './tools/list.js';
import { handleSearch } from './tools/search.js';
import { handleAssignees } from './tools/assignees.js';
import { handleComplete } from './tools/complete.js';
import { handleBlock } from './tools/block.js';
import { handleHeartbeat } from './tools/heartbeat.js';
import { handleComment } from './tools/comment.js';
import { handleCreate } from './tools/create.js';
import { handleLink } from './tools/link.js';
import { handleUnblock } from './tools/unblock.js';
import { handleArtifact } from './tools/artifact.js';
import { handleRequestApproval } from './tools/request_approval.js';
import { handleAsk } from './tools/ask.js';
// ─────────────────────── tool registry ──────────────────────────
const TOOL_REGISTRY = [
    {
        name: 'board_show',
        description: 'Read the current task — title, body, prior attempts, parent handoffs, comments, memory chunks, full pre-formatted worker_context. Defaults to env\'s task id when called inside a worker.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Optional override; defaults to VODOU_BOARD_TASK env var.' },
            },
        },
    },
    {
        name: 'board_list',
        description: 'List task summaries with optional filters (assignee, status, tenant, board, archived, limit). Read-only direct DB query.',
        inputSchema: {
            type: 'object',
            properties: {
                board_id: { type: 'string' },
                status: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                assignee: { type: 'string' },
                tenant_id: { type: 'string' },
                archived: { type: 'boolean' },
                limit: { type: 'integer', minimum: 1, maximum: 200 },
            },
        },
    },
    {
        name: 'board_search',
        description: 'FTS5 search across tasks on this board. Returns ranked matches with title/body snippets.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                board_id: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 50 },
            },
            required: ['query'],
        },
    },
    {
        name: 'board_assignees',
        description: 'Step-0 orchestrator discovery. Returns active subagent names + per-assignee in-flight task counts. Call this FIRST before any board_create to avoid silent-fail-on-unknown-assignee.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'board_complete',
        description: 'Close the current task as completed. Provide a summary (≤4KB) + optional structured metadata (changed_files, pr_url, tests_run, etc.).',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string' },
                metadata: { type: 'object' },
                task_id: { type: 'string' },
            },
            required: ['summary'],
        },
    },
    {
        name: 'board_block',
        description: 'Escalate the current task for human input. Reason should be specific (not just "stuck").',
        inputSchema: {
            type: 'object',
            properties: {
                reason: { type: 'string' },
                task_id: { type: 'string' },
            },
            required: ['reason'],
        },
    },
    {
        name: 'board_heartbeat',
        description: 'Signal liveness during long-running work. Call every few minutes during ops >2min. Stale heartbeats trigger reclaim.',
        inputSchema: {
            type: 'object',
            properties: {
                note: { type: 'string' },
                task_id: { type: 'string' },
            },
        },
    },
    {
        name: 'board_comment',
        description: 'Append a comment to a task\'s thread. Author is resolved server-side from the JWT.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string' },
                body: { type: 'string' },
                in_reply_to: { type: 'integer' },
            },
            required: ['task_id', 'body'],
        },
    },
    {
        name: 'board_create',
        description: 'Orchestrator-only. Create a child task with optional parents=[…] for dependency tracking. Cycles rejected server-side.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                body: { type: 'string' },
                assignee: { type: 'string' },
                parents: { type: 'array', items: { type: 'string' } },
                priority: { type: 'integer', minimum: 0, maximum: 100 },
                workspace: { type: 'string' },
                skills: { type: 'array', items: { type: 'string' } },
                max_runtime_seconds: { type: 'integer' },
                budget_usd_cap: { type: 'number' },
                idempotency_key: { type: 'string' },
                board_id: { type: 'string' },
                tenant_id: { type: 'string' },
                workflow_template_id: { type: 'string' },
                requires_approval_on: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
        },
    },
    {
        name: 'board_link',
        description: 'Orchestrator-only. Add a parent→child dependency. Self-links and cycles rejected.',
        inputSchema: {
            type: 'object',
            properties: {
                parent_id: { type: 'string' },
                child_id: { type: 'string' },
            },
            required: ['parent_id', 'child_id'],
        },
    },
    {
        name: 'board_unblock',
        description: 'Orchestrator-only. Move a blocked task back to ready. Optional note becomes a comment.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string' },
                note: { type: 'string' },
            },
            required: ['task_id'],
        },
    },
    {
        name: 'board_artifact',
        description: 'Attach a file path, screenshot, URL, or other artifact reference to the current run\'s metadata.',
        inputSchema: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['file', 'screenshot', 'pr_url', 'deploy_url', 'other'] },
                value: { type: 'string' },
                label: { type: 'string' },
                task_id: { type: 'string' },
            },
            required: ['kind', 'value'],
        },
    },
    {
        name: 'board_request_approval',
        description: 'Request human approval mid-run (instead of fully blocking). Task moves to pending_approval; dispatcher waits for decision.',
        inputSchema: {
            type: 'object',
            properties: {
                reason: { type: 'string' },
                decision_required_by: { type: 'string', description: 'ISO 8601 datetime' },
                task_id: { type: 'string' },
            },
            required: ['reason'],
        },
    },
    {
        name: 'board_ask',
        description: 'Natural-language Q&A over board state. Returns { answer, cited_task_ids[], confidence, cost_usd }. Use for "what\'s blocked?" / "which assignee has the highest backlog?" type queries.',
        inputSchema: {
            type: 'object',
            properties: {
                question: { type: 'string' },
                board_id: { type: 'string' },
                budget_usd_cap: { type: 'number', maximum: 1 },
            },
            required: ['question'],
        },
    },
];
const HANDLERS = {
    board_show: handleShow,
    board_list: handleList,
    board_search: handleSearch,
    board_assignees: handleAssignees,
    board_complete: handleComplete,
    board_block: handleBlock,
    board_heartbeat: handleHeartbeat,
    board_comment: handleComment,
    board_create: handleCreate,
    board_link: handleLink,
    board_unblock: handleUnblock,
    board_artifact: handleArtifact,
    board_request_approval: handleRequestApproval,
    board_ask: handleAsk,
};
// ─────────────────────── server boilerplate ──────────────────────
const server = new Server({ name: 'Vodou-Board', version: '1.0.0-phase1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!toolsExposed()) {
        return { tools: [] };
    }
    return { tools: TOOL_REGISTRY };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // ── Gate-exempt introspection ───────────────────────────────────────────────
    // `list_tools` returns the board catalog (names + descriptions) in ANY session,
    // READ-ONLY. It is deliberately NOT in TOOL_REGISTRY, so it never appears in
    // tools/list and the chat LLM never sees it — only an explicit
    // `call Vodou-Board list_tools` reaches it. Real board_* execution stays gated
    // below, so this exposes a catalog, never a capability.
    if (name === 'list_tools' || name === 'board_list_tools') {
        const worker = isWorkerSession();
        const exposed = toolsExposed();
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        server: 'Vodou-Board',
                        worker_session: worker,
                        callable_here: exposed,
                        hint: exposed
                            ? (worker
                                ? 'Worker session — every tool below is callable.'
                                : 'Exposed via VODOU_BOARD_TOOLS_ALWAYS_ON — callable; task-scoped tools need an explicit task_id.')
                            : 'Catalog only — set VODOU_BOARD_TOOLS_ALWAYS_ON=1 (always-on) or VODOU_BOARD_TASK=<task_id> (worker) to make these callable.',
                        count: TOOL_REGISTRY.length,
                        tools: TOOL_REGISTRY.map((t) => ({ name: t.name, description: t.description })),
                    }, null, 2),
                }],
        };
    }
    if (!toolsExposed()) {
        return {
            content: [{
                    type: 'text',
                    text: 'Error: board_* tools are not exposed in this session. Set VODOU_BOARD_TOOLS_ALWAYS_ON=1 (always-on, like any other Vodou server) or VODOU_BOARD_TASK=<task_id> (worker spawn).',
                }],
            isError: true,
        };
    }
    const handler = HANDLERS[name];
    if (!handler) {
        return {
            content: [{
                    type: 'text',
                    text: `Error: unknown tool '${name}'. Available: ${Object.keys(HANDLERS).join(', ')}`,
                }],
            isError: true,
        };
    }
    try {
        return await handler(args);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Vodou-Board] tool '${name}' error: ${msg}`);
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({ tool: name, error: msg }, null, 2),
                }],
            isError: true,
        };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[Vodou-Board] MCP server connected via stdio. Gating: ' +
    (isWorkerSession() ? `WORKER (task=${process.env.VODOU_BOARD_TASK}, ${TOOL_REGISTRY.length} tools visible)` : 'CHAT (tools hidden)'));
