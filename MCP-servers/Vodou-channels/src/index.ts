#!/usr/bin/env node

/**
 * Vodou-Channels MCP Server
 *
 * Frontend surface area for Vodou: Telegram, Slack, Discord, Voice, Web
 * Receives messages from any channel, processes through Vodou, sends responses back.
 */

// Self-load .env file (so vodou-core doesn't need --env-file or env config)
import { readFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __indexFilename = fileURLToPath(import.meta.url);
const __indexDirname = dirname(__indexFilename);
const envPath = resolve(__indexDirname, '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't override existing env vars
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env file is optional
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { ChannelManager } from './channel-manager.js';
import type { ChannelStatus } from './types.js';
import type { VoiceChannel } from './channels/voice.js';
import { uploadFileViaSession, readLastSlackChannel } from './channels/slack-session-upload.js';

// ── Standalone-liveness overlay ─────────────────────────────────────────────
// The pooled MCP instance that answers `channel_status` is NOT the process that
// holds a live socket. The gateway spawns a *standalone* bridge per channel
// (VODOU_CHANNELS_STANDALONE=<ch>) that owns the real connection and records its
// PID in .vodou/workspace/channels-standalone.json. So this pooled instance's own
// `connected` flag is always false for those channels even when they're live —
// producing a false "connected: false" (the exact bug: Slack answering inbound
// while status reported offline). Overlay the standalone PID's liveness so the
// reported status matches reality regardless of which instance answers.
function readLiveStandaloneChannels(): Set<string> {
  const alive = new Set<string>();
  try {
    const root = process.env.VODOU_PROJECT_PATH || process.cwd();
    const stateFile = resolve(root, '.vodou', 'workspace', 'channels-standalone.json');
    if (!existsSync(stateFile)) return alive;
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, { pid?: number }>;
    for (const [ch, info] of Object.entries(state)) {
      const pid = info?.pid;
      if (!pid) continue;
      try {
        process.kill(pid, 0); // signal 0 = liveness probe, no-op if the process exists
        alive.add(ch);
      } catch (e) {
        // ESRCH = process gone (dead); EPERM = alive but owned by another user (still live)
        if ((e as NodeJS.ErrnoException).code === 'EPERM') alive.add(ch);
      }
    }
  } catch {
    // Best-effort overlay — on any read/parse failure, fall back to pooled status.
  }
  return alive;
}

/** Overlay live standalone connection state onto a pooled ChannelStatus. */
function overlayStandalone(status: ChannelStatus | undefined, alive: Set<string>): ChannelStatus | undefined {
  if (!status || status.connected || !alive.has(status.channel)) return status;
  return {
    ...status,
    connected: true,
    metadata: { ...(status.metadata || {}), via: 'standalone', reportedBy: 'standalone-overlay' },
  };
}

// Vendored-dep self-heal (alpha-tester incident 2026-06-10): @vodou/channel-sdk
// is a file: link into packages/sdk and was never published to npm, so an errant
// `npm install @vodou/channel-sdk` 404s and can prune the link from node_modules.
// The SDK source ships inside this server — restore the link instead of dying
// with ERR_MODULE_NOT_FOUND when the channel stack loads below.
const sdkLinkDir = resolve(__indexDirname, '..', 'node_modules', '@vodou');
const sdkLink = resolve(sdkLinkDir, 'channel-sdk');
const sdkSource = resolve(__indexDirname, '..', 'packages', 'sdk');
try {
  if (
    !existsSync(resolve(sdkLink, 'package.json')) &&
    existsSync(resolve(sdkSource, 'dist', 'index.js'))
  ) {
    rmSync(sdkLink, { force: true }); // clear a dangling symlink if one is left behind
    mkdirSync(sdkLinkDir, { recursive: true });
    symlinkSync('../../packages/sdk', sdkLink, 'dir');
    console.error('[Vodou-Channels] Restored node_modules/@vodou/channel-sdk → packages/sdk');
  }
} catch (error) {
  console.error('[Vodou-Channels] channel-sdk self-heal failed:', error);
}

// Public deps (node-telegram-bot-api, discord.js, …) can't be restored offline.
// Load the channel stack dynamically so a missing module prints the repair
// command instead of an unhandled ERR_MODULE_NOT_FOUND stack trace.
let getChannelManager: (typeof import('./channel-manager.js'))['getChannelManager'];
try {
  ({ getChannelManager } = await import('./channel-manager.js'));
} catch (error) {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    console.error(
      '[Vodou-Channels] FATAL: dependency missing —',
      (error as Error).message.split('\n')[0]
    );
    console.error('[Vodou-Channels] Repair: cd MCP-servers/Vodou-channels && npm install');
    console.error(
      '[Vodou-Channels] Note: @vodou/* packages are vendored in packages/ (NOT on npm). A plain `npm install` relinks them — never run `npm install @vodou/<name>` by name.'
    );
    process.exit(1);
  }
  throw error;
}

/** True when standalone was requested via env (VODOU or legacy OI name). */
function envStandaloneRequested(): boolean {
  const v =
    process.env.VODOU_CHANNELS_STANDALONE?.trim() || process.env.OI_CHANNELS_STANDALONE?.trim();
  return Boolean(v);
}

/**
 * True if this process should run as a standalone bridge (no MCP stdio).
 *
 * Standalone is requested via `VODOU_CHANNELS_STANDALONE`. We still need a way
 * to distinguish two scenarios that BOTH lack a TTY:
 *   1. Detached background spawn from the gateway's `spawnChannel()` — stdio
 *      is `['ignore', logFd, logFd]`. Standalone is intentional. → standalone mode.
 *   2. MCP-stdio child spawned by vodou-core's connection pool — stdin is a
 *      JSON-RPC pipe. The env var may have leaked in inherited env. → MCP mode.
 *
 * The gateway's `spawnChannel()` sets `VODOU_CHANNELS_DETACHED=1` so we can
 * tell case 1 apart from case 2. PLAN-SILENT-ISSUES-AUDIT.md follow-up:
 * "channel toggling drops other channels" regression introduced by Sprint C
 * Phase 4 (commit b1f0894) that gated standalone on TTY only.
 */
function isEffectiveStandaloneMode(): boolean {
  if (!envStandaloneRequested()) return false;
  if (process.stdin.isTTY) return true;
  return process.env.VODOU_CHANNELS_DETACHED === '1';
}

const server = new Server(
  {
    name: 'Vodou-channels',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let channelManager: ChannelManager;

// Define tools
const TOOLS: Tool[] = [
  {
    name: 'channel_connect',
    description: 'Connect to one or more messaging channels to start receiving messages. Available channels: telegram, slack, discord, voice, web, whatsapp, imessage, teams, googlechat, signal',
    inputSchema: {
      type: 'object',
      properties: {
        channels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['telegram', 'slack', 'discord', 'voice', 'web', 'whatsapp', 'imessage', 'teams', 'googlechat', 'signal'],
          },
          description: 'Channels to connect (default: ["web"])',
        },
      },
    },
  },
  {
    name: 'channel_disconnect',
    description: 'Disconnect from one or more messaging channels',
    inputSchema: {
      type: 'object',
      properties: {
        channels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['telegram', 'slack', 'discord', 'voice', 'web', 'whatsapp', 'imessage', 'teams', 'googlechat', 'signal'],
          },
          description: 'Channels to disconnect (default: all)',
        },
      },
    },
  },
  {
    name: 'channel_send',
    description: 'Send a message to a specific channel and recipient. For Slack, use the `slack` MCP server\'s `slack_send_message` tool instead — it has better permissions and token support.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['telegram', 'discord', 'voice', 'web', 'whatsapp', 'imessage', 'teams', 'googlechat', 'signal'],
          description: 'Channel to send to. For Slack outbound, use the `slack` MCP server instead.',
        },
        recipient: {
          type: 'string',
          description: 'Recipient ID (chat ID, channel ID, user ID, or "all" for broadcast)',
        },
        message: {
          type: 'string',
          description: 'Message content to send',
        },
        media_path: {
          type: 'string',
          description: 'Optional local file path for WhatsApp outbound media (bridge /api/send). Use caption in message.',
        },
      },
      required: ['channel'],
    },
  },
  {
    name: 'channel_broadcast',
    description: 'Broadcast a message to all connected channels',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to broadcast',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'channel_status',
    description: 'Get status of all channels or a specific channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['telegram', 'slack', 'discord', 'voice', 'web', 'whatsapp', 'imessage', 'teams', 'googlechat', 'signal'],
          description: 'Specific channel to check (optional, returns all if not specified)',
        },
      },
    },
  },
  {
    name: 'slack_upload_file',
    description: 'Upload a local file to a Slack channel or DM using the live session tokens (xoxc/xoxd from ~/.slack-mcp-tokens.json, auto-refreshed by the slack MCP server). This is the working upload path — the bot-token path is dead.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the local file to upload',
        },
        channel: {
          type: 'string',
          description: 'Slack channel or DM id (C…/D…/G…) to post the file into. Optional — if omitted, auto-resolves to the current conversation (the last channel that messaged Vodou).',
        },
        title: {
          type: 'string',
          description: 'Optional title shown for the file in Slack (defaults to filename)',
        },
        comment: {
          type: 'string',
          description: 'Optional message posted alongside the file',
        },
        thread_ts: {
          type: 'string',
          description: 'Optional thread timestamp to upload into a thread',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'voice_speak',
    description: 'Convert text to speech and play it through system speakers',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to speak',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'voice_stop',
    description: 'Stop current speech output',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'voice_list_voices',
    description: 'List available system voices for text-to-speech',
    inputSchema: {
      type: 'object',
      properties: {},
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
      case 'channel_connect': {
        let channels = (args.channels as string[]) || ['web'];
        const isStandalone = isEffectiveStandaloneMode();
        if (!isStandalone && channels.includes('telegram')) {
          channels = channels.filter((c) => c !== 'telegram');
          const msg = channels.length > 0
            ? { connected: channels, statuses: channels.map(ch => channelManager.getChannelStatus(ch)), telegram_skipped: 'Use standalone for Telegram to avoid 409: VODOU_CHANNELS_STANDALONE=telegram node --env-file=.env dist/index.js' }
            : { error: 'Telegram cannot be used from Vodou MCP (causes 409). Run standalone: VODOU_CHANNELS_STANDALONE=telegram node --env-file=.env dist/index.js' };
          await channelManager.connect(channels);
          return { content: [{ type: 'text', text: JSON.stringify(msg, null, 2) }] };
        }
        const report = await channelManager.connect(channels);
        const statuses = channels.map(ch => channelManager.getChannelStatus(ch));
        const failures = report.filter(r => !r.ok);
        return {
          content: [
            { type: 'text', text: JSON.stringify({
              connected: report.filter(r => r.ok).map(r => r.name),
              failed: failures.length ? failures : undefined,
              statuses,
            }, null, 2) },
          ],
        };
      }

      case 'channel_disconnect': {
        const channels = args.channels as string[] | undefined;
        await channelManager.disconnect(channels);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                disconnected: channels || 'all',
                message: 'Channels disconnected successfully',
              }, null, 2),
            },
          ],
        };
      }

      case 'channel_send': {
        const channel = args.channel as string;
        const recipient = (args.recipient as string) || 'all';
        const message = typeof args.message === 'string' ? args.message : '';
        const mediaPath = typeof args.media_path === 'string' ? args.media_path : undefined;

        if (!message.trim() && !mediaPath) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Provide message and/or media_path' }, null, 2) }],
            isError: true,
          };
        }

        const success = await channelManager.send({
          channel,
          recipient,
          content: message,
          ...(mediaPath ? { mediaPath } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success,
                channel,
                recipient,
                message: success ? 'Message sent' : 'Failed to send message',
              }, null, 2),
            },
          ],
        };
      }

      case 'channel_broadcast': {
        const message = args.message as string;
        const results = await channelManager.broadcast(message);

        const resultsObj: Record<string, boolean> = {};
        for (const [ch, success] of results) {
          resultsObj[ch] = success;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                broadcast: true,
                results: resultsObj,
              }, null, 2),
            },
          ],
        };
      }

      case 'channel_status': {
        const channel = args.channel as string | undefined;
        const alive = readLiveStandaloneChannels();

        if (channel) {
          const status = overlayStandalone(channelManager.getChannelStatus(channel), alive);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        }

        const statuses = channelManager.getStatus().map(s => overlayStandalone(s, alive));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(statuses, null, 2),
            },
          ],
        };
      }

      case 'slack_upload_file': {
        const filePath = args.file_path as string;
        if (!filePath) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'file_path is required' }) }],
            isError: true,
          };
        }
        // Auto-resolve the channel to the current conversation when not given.
        const channel = (args.channel as string) || readLastSlackChannel() || '';
        if (!channel) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'No channel provided and none could be auto-resolved (no recent inbound Slack message on record). Pass an explicit channel id (C…/D…/G…).' }) }],
            isError: true,
          };
        }
        const result = await uploadFileViaSession({
          channelId: channel,
          filePath,
          title: args.title as string | undefined,
          initialComment: args.comment as string | undefined,
          threadTs: args.thread_ts as string | undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      }

      case 'voice_speak': {
        const text = args.text as string;

        // Ensure voice channel is connected
        const voiceStatus = channelManager.getChannelStatus('voice');
        if (!voiceStatus?.connected) {
          await channelManager.connect(['voice']);
        }

        const success = await channelManager.send({
          channel: 'voice',
          recipient: 'local',
          content: text,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success,
                message: success ? 'Speaking...' : 'Failed to speak',
              }, null, 2),
            },
          ],
        };
      }

      case 'voice_stop': {
        const voiceChannel = channelManager.getChannel('voice') as VoiceChannel;
        if (voiceChannel) {
          voiceChannel.stop();
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ message: 'Speech stopped' }, null, 2),
            },
          ],
        };
      }

      case 'voice_list_voices': {
        const voiceChannel = channelManager.getChannel('voice') as VoiceChannel;

        // Ensure voice is connected
        const voiceStatus = channelManager.getChannelStatus('voice');
        if (!voiceStatus?.connected) {
          await channelManager.connect(['voice']);
        }

        const voices = await voiceChannel.getVoices();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                voices,
                count: voices.length,
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

// Cleanup on exit
process.on('SIGINT', async () => {
  console.error('[Vodou-Channels] Shutting down...');
  await channelManager.disconnectAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('[Vodou-Channels] Shutting down...');
  await channelManager.disconnectAll();
  process.exit(0);
});

// Standalone mode: connect channels and keep process alive (no MCP). Use when Telegram
// must keep polling after you close the terminal that ran "channel_connect". Example:
//   VODOU_CHANNELS_STANDALONE=telegram TELEGRAM_BOT_TOKEN=xxx node dist/index.js
async function runStandalone() {
  if (!envStandaloneRequested()) return false;
  // PLAN-SILENT-ISSUES-AUDIT.md follow-up: also honor VODOU_CHANNELS_DETACHED=1
  // for gateway-spawned detached bridges (stdio=['ignore', ...]). Without this,
  // every gateway "Start channel" toggle fell through to MCP mode and exited
  // immediately on EOF, breaking multi-channel concurrency.
  const detached = process.env.VODOU_CHANNELS_DETACHED === '1';
  if (!process.stdin.isTTY && !detached) {
    console.error(
      '[Vodou-Channels] VODOU_CHANNELS_STANDALONE / OI_CHANNELS_STANDALONE is set but stdin is not a TTY and VODOU_CHANNELS_DETACHED!=1; running MCP stdio (vodou-core) instead of standalone.'
    );
    return false;
  }
  const raw =
    process.env.VODOU_CHANNELS_STANDALONE?.trim() || process.env.OI_CHANNELS_STANDALONE?.trim() || '';
  const channels = raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean) as string[];
  if (channels.length === 0) return false;

  channelManager = getChannelManager();
  await channelManager.init();
  console.error('📱 Vodou-Channels standalone: connecting', channels.join(', '));
  await channelManager.connect(channels);
  console.error('   Process stays alive; messages will be processed through Vodou. Ctrl+C to stop.');
  return true;
}

// Start server
async function runServer() {
  channelManager = getChannelManager();
  await channelManager.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('📱 Vodou-Channels MCP Server running on stdio');
  console.error('   Available channels: telegram, slack, discord, voice, web, whatsapp, imessage, teams, googlechat, signal');
  console.error('   Use channel_connect to start listening');
}

async function main() {
  if (await runStandalone()) return;
  await runServer();
}

main().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
