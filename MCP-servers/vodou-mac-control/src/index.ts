#!/usr/bin/env node

/**
 * Vodou Mac Control — MCP Server
 *
 * 13 tools for macOS accessibility automation.
 * Action+traverse pattern: every mutation returns the new UI tree + diff.
 * MIT licensed. Vodou-owned.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { callVodouAx } from './ax-bridge.js';
import { isBlocked } from './blocklist.js';
import { tryConsume } from './rate-limiter.js';
import { logAction } from './audit-log.js';

const server = new Server(
  { name: 'vodou-mac-control', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // Core: action + traverse
  {
    name: 'traverse',
    description: 'Read the accessibility tree for a running macOS app. Returns all UI elements with roles, titles, values, positions, and available actions. Use this to understand what is on screen before taking any action.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name (e.g. "Safari", "Finder", "Slack")' },
        max_depth: { type: 'integer', description: 'Max tree depth (default 100)', minimum: 1, maximum: 100 },
        max_elements: { type: 'integer', description: 'Max elements (default 2000)', minimum: 1, maximum: 5000 },
      },
      required: ['app'],
    },
  },
  {
    name: 'click_and_traverse',
    description: 'Click at screen coordinates in a macOS app and return the new UI tree with a diff showing what changed. Always use traverse first to find the correct coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name' },
        x: { type: 'number', description: 'X coordinate (screen pixels)' },
        y: { type: 'number', description: 'Y coordinate (screen pixels)' },
        button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Mouse button (default left)' },
        guard: { type: 'boolean', description: 'Block user input during action (default true)' },
      },
      required: ['app', 'x', 'y'],
    },
  },
  {
    name: 'click_element_and_traverse',
    description: 'Find a UI element by its text content and click it. More reliable than coordinates — works even if the window moves. Returns the new UI tree with diff.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name' },
        element: { type: 'string', description: 'Text to search for (e.g. "Send", "OK", "Submit")' },
        role: { type: 'string', description: 'Optional AX role filter (e.g. "AXButton", "AXTextField")' },
        guard: { type: 'boolean', description: 'Block user input during action (default true)' },
      },
      required: ['app', 'element'],
    },
  },
  {
    name: 'type_and_traverse',
    description: 'Type text into the focused element in a macOS app. Returns the new UI tree with diff showing what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name' },
        text: { type: 'string', description: 'Text to type' },
        guard: { type: 'boolean', description: 'Block user input during action (default true)' },
      },
      required: ['app', 'text'],
    },
  },
  {
    name: 'press_key_and_traverse',
    description: 'Press a key or key combination in a macOS app. Returns the new UI tree with diff. Supports modifiers: command, shift, option, control.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name' },
        key: { type: 'string', description: 'Key name: return, tab, escape, space, delete, a-z, 0-9, f1-f12, up/down/left/right' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'shift', 'option', 'control'] } },
        guard: { type: 'boolean', description: 'Block user input during action (default true)' },
      },
      required: ['app', 'key'],
    },
  },
  {
    name: 'scroll_and_traverse',
    description: 'Scroll at a position in a macOS app. Returns the new UI tree with diff.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name' },
        x: { type: 'number', description: 'X coordinate to scroll at' },
        y: { type: 'number', description: 'Y coordinate to scroll at' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default down)' },
        amount: { type: 'integer', description: 'Number of scroll events (default 5)' },
        guard: { type: 'boolean', description: 'Block user input during action (default true)' },
      },
      required: ['app', 'x', 'y'],
    },
  },
  {
    name: 'open_and_traverse',
    description: 'Open or activate a macOS app and return its accessibility tree. Launches the app if not running.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name (e.g. "TextEdit", "Safari", "Notes")' },
        url: { type: 'string', description: 'Optional URL to open in the app' },
        wait_seconds: { type: 'integer', description: 'Seconds to wait for app launch (default 3)', minimum: 1, maximum: 10 },
      },
      required: ['app'],
    },
  },

  // Utility tools
  {
    name: 'screenshot',
    description: 'Capture a screenshot of a window or the full screen. Returns the file path to the PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name (omit for full screen)' },
        annotate_click_x: { type: 'number', description: 'Optional: draw crosshair at this X coordinate' },
        annotate_click_y: { type: 'number', description: 'Optional: draw crosshair at this Y coordinate' },
      },
    },
  },
  {
    name: 'clipboard_read',
    description: 'Read the current contents of the system clipboard.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write',
    description: 'Write text to the system clipboard.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to write to clipboard' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_windows',
    description: 'List all visible windows on screen with their app name, title, position, and size.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'manage_window',
    description: 'Focus, resize, move, or minimize a window.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name' },
        action: { type: 'string', enum: ['focus', 'resize', 'move', 'minimize'], description: 'What to do with the window' },
        width: { type: 'integer', description: 'New width (for resize)' },
        height: { type: 'integer', description: 'New height (for resize)' },
        x: { type: 'integer', description: 'New X position (for move)' },
        y: { type: 'integer', description: 'New Y position (for move)' },
      },
      required: ['app', 'action'],
    },
  },
  {
    name: 'check_permission',
    description: 'Check if macOS Accessibility permission has been granted. Must be granted before any other tool will work.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();
  const appName = (args as Record<string, unknown>)?.app as string | undefined;

  try {
    // Blocklist check (for tools that target an app)
    if (appName && name !== 'check_permission') {
      const blocked = isBlocked(appName);
      if (blocked) {
        throw new Error(`App '${appName}' is blocked (matches '${blocked}'). Blocked apps: Terminal, System Settings, Keychain. Override via blocklist.json.`);
      }
    }

    // Rate limit check
    if (!tryConsume(name)) {
      throw new Error('Rate limited — too many actions per second. Wait and retry.');
    }

    let result: unknown;

    switch (name) {
      case 'traverse':
        result = await callVodouAx('traverse', {
          app: appName,
          max_depth: (args as any)?.max_depth,
          max_elements: (args as any)?.max_elements,
        });
        break;

      case 'click_and_traverse':
        result = await callVodouAx('click', {
          app: appName,
          x: (args as any)?.x,
          y: (args as any)?.y,
          button: (args as any)?.button,
          guard: (args as any)?.guard !== false ? '' : undefined,
        });
        break;

      case 'click_element_and_traverse':
        result = await callVodouAx('click', {
          app: appName,
          element: (args as any)?.element,
          role: (args as any)?.role,
          guard: (args as any)?.guard !== false ? '' : undefined,
        });
        break;

      case 'type_and_traverse':
        result = await callVodouAx('type', {
          app: appName,
          text: (args as any)?.text,
          guard: (args as any)?.guard !== false ? '' : undefined,
        });
        break;

      case 'press_key_and_traverse':
        result = await callVodouAx('press-key', {
          app: appName,
          key: (args as any)?.key,
          modifiers: (args as any)?.modifiers,
          guard: (args as any)?.guard !== false ? '' : undefined,
        });
        break;

      case 'scroll_and_traverse':
        result = await callVodouAx('scroll', {
          app: appName,
          x: (args as any)?.x,
          y: (args as any)?.y,
          direction: (args as any)?.direction,
          amount: (args as any)?.amount,
          guard: (args as any)?.guard !== false ? '' : undefined,
        });
        break;

      case 'open_and_traverse':
        result = await callVodouAx('open', {
          app: appName,
          url: (args as any)?.url,
          wait_seconds: (args as any)?.wait_seconds,
        });
        break;

      case 'screenshot': {
        const axArgs: Record<string, unknown> = {};
        if (appName) axArgs.app = appName;
        const cx = (args as any)?.annotate_click_x;
        const cy = (args as any)?.annotate_click_y;
        if (cx !== undefined && cy !== undefined) {
          axArgs.annotate_click = `${cx} ${cy}`;
        }
        result = await callVodouAx('screenshot', axArgs);
        break;
      }

      case 'clipboard_read':
        result = await callVodouAx('clipboard', { read: true });
        break;

      case 'clipboard_write':
        result = await callVodouAx('clipboard', { write: (args as any)?.text });
        break;

      case 'list_windows':
        result = await callVodouAx('windows', { list: true });
        break;

      case 'manage_window': {
        const action = (args as any)?.action as string;
        const windowArgs: Record<string, unknown> = {};
        switch (action) {
          case 'focus': windowArgs.focus = appName; break;
          case 'resize':
            windowArgs.resize = appName;
            windowArgs.width = (args as any)?.width;
            windowArgs.height = (args as any)?.height;
            break;
          case 'move':
            windowArgs.move = appName;
            windowArgs.x = (args as any)?.x;
            windowArgs.y = (args as any)?.y;
            break;
          case 'minimize': windowArgs.minimize = appName; break;
          default: throw new Error(`Unknown window action: ${action}`);
        }
        result = await callVodouAx('windows', windowArgs);
        break;
      }

      case 'check_permission':
        result = await callVodouAx('check-permission');
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const duration = Date.now() - startTime;
    logAction({ tool: name, app: appName, args: args as Record<string, unknown>, ok: true, duration_ms: duration });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    logAction({ tool: name, app: appName, ok: false, duration_ms: duration, error: message });

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }],
      isError: true,
    };
  }
});

// ─── Start Server ────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[vodou-mac-control] MCP server running on stdio (13 tools)');
