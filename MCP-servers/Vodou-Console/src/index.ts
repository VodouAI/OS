#!/usr/bin/env node

/**
 * Vodou-Console - Direct vodou-core Integration
 *
 * Version: 0.5.33.6 - Simplified single generic tool architecture
 *
 * AI gateway service that connects web clients to Claude with vodou-core MCP tools.
 * Features:
 * - WebSocket streaming for real-time responses
 * - Claude API with ONE generic tool (vodou_core_call) for full MCP access
 * - Direct vodou-core CLI integration for all tool calls
 * - Conversation state management
 * - HTTP API for REST-style interactions
 */

import './windows-spawn-hide.js'; // MUST be first: hide phantom console windows on Windows before any spawn
import { sockConnectTarget } from './cli-portability.js'; // win32: .sock path -> named-pipe target (matches ipc.rs)
import express, { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { spawn, exec, execSync, execFile, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { chat, chatWithSkill, simpleChat, clearConversation, getStats, isConfigured, initAuth, reinitAuth, triggerMemoryFlush, getActiveModelLabel, getLastMemoryUsed, getLastMemoryDebug, getTotalMemoryCount, markHeartbeatConversation, setConversationMaxTokens, setConversationMaxToolIterations, warmupCliSession, kickstartWarmCliPool, shutdownCliPool, abortConversationCliTurn, abortConversationTurn, getCliPoolStats, getMemoryReliabilityStats, getAuthType, getClaudeCliAuthState, type ChannelAttachmentMeta } from './llm.js';
import { backfillUserSignal } from './trajectory-capture.js';
import { appendChannelAttachmentHints } from './channelAttachments.js';
import { getConversationManager, setFlushCallback } from './conversation.js';
import { checkExecutorHealth, cleanStaleToolResults, executeOITool } from './executor.js';
import { consumeApproval } from './approvals.js';
import { getToolNames } from './tools.js';
import { closeDb, getDb, getGatewayDb, getProjectRoot, getSetting, getThinkingDb, saveUsage } from './db.js';
import {
  lookupSkillBinding,
  disableEphemeralSkill,
  parseDeliveryTarget,
  handleSlashCommand,
  runSkillConsoleCompletionHook,
} from './api/skill-console-handler.js';
import { prepareSkillConsoleForLlm } from './api/skill-console-chat-pipeline.js';
import { parseRunCommand } from './api/skill-template-expand.js';
import fs from 'fs';
import { createTerminal, writeTerminal, resizeTerminal, destroyTerminal, destroyAllTerminals, getTerminalCount } from './terminal.js';
import { withLedgerLock } from './task_ledger_lock.js';
import { systemRouter } from './api/system.js';
import { serversRouter } from './api/servers.js';
import { skillsRouter, syncSkillsFromFilesystem } from './api/skills.js';
import { execRouter } from './api/exec.js';
import { intentsRouter } from './api/intents.js';
import { schedulerRouter } from './api/scheduler.js';
import { skillConsoleMetaRouter } from './api/skill-console-meta.js';
import { automationsRouter } from './api/automations.js';
import { scriptsRouter } from './api/scripts.js';
import { logsRouter } from './api/logs.js';
import { memoryRouter } from './api/memory.js';
import memoryExtractorRouter from './api/memory-extractor.js';
import { memoryImportRouter } from './api/memory-import.js';
import { memoryCaptureRouter } from './api/memory-capture.js';
import { memoryVaultsRouter } from './api/memory-vaults.js';
import { conversationsRouter } from './api/conversations.js';
import { filesRouter } from './api/files.js';
import { linkPreviewRouter } from './api/link-preview.js';
import { onboardingRouter } from './api/onboarding.js';
import { onboardingProgressRouter } from './api/onboarding-progress.js';
import { channelsRouter } from './api/channels.js';
import { cascadeReadinessRouter } from './api/cascadeReadiness.js';
import {
  decodeTeamsRecipient,
  getBotFrameworkAccessToken,
  sendTeamsActivity,
  updateTeamsActivity,
} from './api/teams-outbound.js';
import { sendGoogleChatMessage } from './api/googlechat-outbound.js';
import { sendSignalCliMessage } from './api/signal-outbound.js';
import { settingsRouter } from './api/settings.js';
import { toolsRouter } from './api/tools.js';
import { routeRouter } from './api/route.js';
import { workflowsRouter } from './api/workflows.js';
import {
  boardRouter, getTaskPinnedSkill, getTaskTopic, pauseTaskForSkillChoice,
  loadBoardWorkflowState, completeBoardSkillTask, getTaskCurrentRunId, resolveIncompleteBoardTask,
  emitTaskEvent,
} from './api/board.js';
import { setBoardSurfaceImpl } from './api/board-surface.js';
import {
  findActionsFile as wfFindActionsFile,
  parseWorkflowStoppingPointsJson as wfParseStoppingPoints,
  formatStoppingPointMenu as wfFormatMenu,
  executeSteps as wfExecuteSteps,
  advanceBoardWorkflow as wfAdvance,
} from './workflow-driver.js';
import { webhooksRouter } from './api/webhooks.js';
import { openaiCompatRouter } from './api/openai-compat.js';
import { usageRouter } from './api/usage.js';
import { docsRouter } from './api/docs.js';
import { oauthRouter } from './api/oauth.js';
import { mcpRegistryRouter } from './api/mcp-registry.js';
import { profileRouter } from './api/profile.js';
import { workbenchRouter } from './api/workbench.js';
// PLAN-LENSES-MVP — pluggable visual cards in chat
import { lensesRouter } from './api/lenses.js';
import { mountBridgeWss } from './vbb/ws.js';
import { pruneExpired as pruneLensCache } from './lenses/_lib/cache.js';
import { ensureRegistryLoaded } from './lenses/registry.js';
import {
  saveMessage,
  loadRecentMessages,
  loadMessagesOlderThan,
  hasMessagesOlderThan,
  ensureConversation,
  getConversation,
  updateConversationTitle,
  loadConversations,
  getMessageCount,
  deleteConversation as deleteGatewayConversation,
  restoreConversation as restoreGatewayConversation,
  listRecentlyClosedConversations,
  loadConversationsByProject,
  type StoredMessage,
} from './conversation-store.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  resolveProjectInstructions,
  detectProjectDoc,
  saveInstructionsToDisk,
  listProjectSkills,
  setProjectSkills,
} from './projects-store.js';
import { resolveScope } from './scope.js';
import { channelOutboundText } from './lenses-policy.js';
import { hydrateLlmConversationFromDb } from './conversation-hydrate.js';
import { recordStreamNoClients, recordChatFailure, clearChatFailure } from './gateway-debug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = parseInt(process.env.WEB_PORT || '8765', 10);

/** When true, show raw <oi_results> tags in chat history instead of stripping them. */
function showRawResults(): boolean {
  // Re-read from .env on disk so edits take effect without gateway restart
  try {
    const envPath = path.resolve(process.env.VODOU_PROJECT_PATH || process.cwd(), '.env');
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('VODOU_SHOW_RAW_RESULTS=')) {
        return trimmed.split('=')[1]?.trim() === '1';
      }
    }
  } catch {}
  return false;
}

/** Web UI initial / “Load earlier” page size — not the LLM seed path (see conversation-hydrate.ts → loadMessages). */
const UI_CHAT_HISTORY_PAGE_SIZE = Math.min(
  Math.max(parseInt(process.env.VODOU_UI_CHAT_HISTORY_LIMIT || '20', 10) || 20, 10),
  200
);

/**
 * Turn raw gateway_messages rows into the shape the web UI replays over WS / REST.
 * Mirrors WebSocket `history` / `switch_conversation` processing (heartbeat HEARTBEAT_OK filter, etc.).
 */
function formatGatewayHistoryForWebUi(
  conversationId: string,
  dbMessages: StoredMessage[]
): Array<{ role: string; text: string; timestamp?: string; id?: number; senderLabel?: string }> {
  const isHeartbeat = conversationId === 'vodou-heartbeat';
  let historyMessages: Array<{ role: string; text: string; timestamp?: string; id?: number; senderLabel?: string }> = [];

  for (const m of dbMessages) {
    if (m.role === 'user') {
      const clean = showRawResults() ? m.content.trim() : m.content
        .replace(/<oi_results>[\s\S]*?<\/oi_results>\s*Interpret these Vodou results[^]*/s, '')
        .replace(/<conversation_history>[\s\S]*?<\/conversation_history>\s*User's new message:\s*/s, '')
        .trim();
      if (clean) {
        historyMessages.push({
          role: 'user',
          text: clean,
          timestamp: m.created_at.replace(' ', 'T') + 'Z',
          id: m.id,
          ...(m.sender_label ? { senderLabel: m.sender_label } : {}),
        });
      }
    } else if (m.role === 'assistant') {
      if (m.content.trim()) {
        historyMessages.push({
          role: 'assistant',
          text: m.content,
          timestamp: m.created_at.replace(' ', 'T') + 'Z',
          id: m.id,
        });
      }
    }
  }

  if (isHeartbeat) {
    const skipIds = new Set<number>();
    for (let i = 0; i < historyMessages.length; i++) {
      if (historyMessages[i].role === 'assistant' && historyMessages[i].text.trim() === 'HEARTBEAT_OK') {
        if (historyMessages[i].id) skipIds.add(historyMessages[i].id!);
        if (i > 0 && historyMessages[i - 1].role === 'user' && historyMessages[i - 1].id) {
          skipIds.add(historyMessages[i - 1].id!);
        }
      }
    }
    historyMessages = historyMessages.filter(m => !m.id || !skipIds.has(m.id));
    for (const m of historyMessages) {
      if (m.role === 'user' && m.text.startsWith('[Heartbeat')) {
        m.text = m.text.split('\n')[0];
      }
    }
  }

  return historyMessages;
}

function historyPageHasOlder(conversationId: string, dbRows: StoredMessage[]): boolean {
  if (dbRows.length === 0) return false;
  const minId = dbRows.reduce((acc, r) => Math.min(acc, r.id), dbRows[0].id);
  return hasMessagesOlderThan(conversationId, minId);
}

/**
 * Forward a gateway response to an external channel (Slack, Telegram, etc.)
 * Reads tokens from Vodou-channels .env and calls the platform API directly.
 * Fire-and-forget — errors are logged but don't block the gateway.
 */
function getChannelEnv(): Record<string, string> {
  const envVars: Record<string, string> = {};
  // Layer 1: Vodou-channels/.env — the original source. Ports, feature flags,
  // and any credential the user never touched through the UI live here.
  const channelsEnvPath = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-channels', '.env');
  try {
    const raw = fs.readFileSync(channelsEnvPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  } catch {}
  // Layer 2: DB credentials written by the Messaging → Credentials UI override
  // the .env values. Without this, saving a new Bot Token through the UI went
  // to the DB but the send path kept using the stale .env value — exactly the
  // "why isn't my saved token working" class of bug.
  const CRED_PREFIX = 'channel_';
  for (const key of [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID',
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET',
    // Messaging UI persists SLACK_DEFAULT_CHANNEL; older paths referenced SLACK_CHANNEL_ID.
    'SLACK_DEFAULT_CHANNEL', 'SLACK_CHANNEL_ID',
    'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
    'TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID', 'TEAMS_PORT',
    'GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_PORT',
    'SIGNAL_CLI_PATH', 'SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_CONFIG',
  ]) {
    const dbVal = getSetting(CRED_PREFIX + key.toLowerCase());
    if (dbVal) envVars[key] = dbVal;
  }
  if (!envVars.SLACK_CHANNEL_ID?.trim() && envVars.SLACK_DEFAULT_CHANNEL?.trim()) {
    envVars.SLACK_CHANNEL_ID = envVars.SLACK_DEFAULT_CHANNEL.trim();
  }
  // Layer 3: project root `.env` (loaded into process.env via db.ts dotenv) and
  // the shell environment. Vodou-channels standalone reads MCP-servers/Vodou-channels/.env
  // for Bolt — users often put SLACK_* only there OR only in root .env. Gateway send
  // must see a token somewhere or chat.postMessage never runs.
  const envFallbackKeys = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID',
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET',
    'SLACK_DEFAULT_CHANNEL', 'SLACK_CHANNEL_ID',
    'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
    'TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID', 'TEAMS_PORT',
    'GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_PORT',
    'SIGNAL_CLI_PATH', 'SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_CONFIG',
    'WHATSAPP_BRIDGE_PORT',
  ] as const;
  for (const key of envFallbackKeys) {
    const v = process.env[key];
    if (v && !String(envVars[key] || '').trim()) envVars[key] = v;
  }
  return envVars;
}

/** WhatsApp text limit per message; longer replies are split into sequential sends. */
const WHATSAPP_TEXT_CHUNK = 4096;

function chunkTextForWhatsApp(full: string, maxLen: number): string[] {
  const t = full.trimEnd();
  if (t.length <= maxLen) return [t.length ? t : ''];
  const parts: string[] = [];
  let rest = t;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < Math.floor(maxLen / 2)) cut = rest.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen / 2)) cut = maxLen;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return parts.length ? parts : [''];
}

async function sendWhatsAppViaBridge(
  envVars: Record<string, string>,
  recipient: string,
  text: string,
  mediaPath?: string
): Promise<boolean> {
  const port = envVars.WHATSAPP_BRIDGE_PORT || process.env.WHATSAPP_BRIDGE_PORT || '8081';
  const chunks = chunkTextForWhatsApp(text, WHATSAPP_TEXT_CHUNK);
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, string> = { recipient, message: chunks[i] };
    if (i === 0 && mediaPath) body.media_path = mediaPath;
    const r = await fetch(`http://127.0.0.1:${port}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = (await r.json().catch(() => ({}))) as { success?: boolean };
    if (!r.ok || d.success === false) {
      console.error('[Gateway] WhatsApp send failed:', r.status, d);
      return false;
    }
  }
  console.error(`[Gateway DIAG] sendWhatsAppViaBridge OK chunks=${chunks.length}`);
  return true;
}

/** Send the full response to a channel (final message or single-shot) */
function forwardToChannel(source: string, recipient: string, text: string): void {
  const envVars = getChannelEnv();
  sendChannelMessage(source, recipient, channelOutboundText(text), envVars);
}

/** Send a message to a channel — returns the message ID for later editing */
async function sendChannelMessage(source: string, recipient: string, text: string, envVars: Record<string, string>): Promise<string | null> {
  // [DIAG] Log every send so duplicate-message bugs are visible in stderr.
  // The full call stack hint helps locate the call site (feedChannelStream timer,
  // finishChannelStream fallback, or forwardToChannel single-shot).
  console.error(`[Gateway DIAG] sendChannelMessage source=${source} recipient=${recipient} text_len=${text.length} preview=${JSON.stringify(text.substring(0, 80))}`);
  console.error(`[Gateway DIAG] sendChannelMessage stack: ${new Error().stack?.split('\n').slice(2, 5).join(' | ')}`);
  try {
    if (source === 'slack') {
      const token = envVars.SLACK_BOT_TOKEN;
      if (!token) {
        console.error(
          '[Gateway] Slack send skipped: SLACK_BOT_TOKEN missing. Put it in MCP-servers/Vodou-channels/.env, project root .env, or save via Messaging UI (gateway DB).',
        );
        return null;
      }
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: recipient, text }),
      });
      const d = await r.json() as any;
      if (!d.ok) { console.error('[Gateway] Slack send failed:', d.error); return null; }
      console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=slack ts=${d.ts}`);
      return d.ts; // Slack message ID for editing
    } else if (source === 'telegram') {
      const token = envVars.TELEGRAM_BOT_TOKEN;
      if (!token) return null;
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: recipient, text }),
      });
      const d = await r.json() as any;
      if (!r.ok || !d.ok) {
        console.error(`[Gateway] Telegram send failed (HTTP ${r.status}): ${d.description || JSON.stringify(d).slice(0, 200)}`);
        return null;
      }
      return d.result?.message_id ? String(d.result.message_id) : null;
    } else if (source === 'discord') {
      const token = envVars.DISCORD_BOT_TOKEN;
      if (!token) {
        console.error('[Gateway] Discord send: DISCORD_BOT_TOKEN missing in envVars — check the Discord credentials card');
        return null;
      }
      const r = await fetch('https://discord.com/api/v10/channels/' + recipient + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const d = await r.json() as any;
      if (!r.ok) {
        // Discord error shape: { message: "...", code: N, errors?: {...} }
        console.error(`[Gateway] Discord send failed (HTTP ${r.status}): ${d.message || JSON.stringify(d)} (code=${d.code})`);
        return null;
      }
      if (!d.id) {
        console.error(`[Gateway] Discord send returned no message id: ${JSON.stringify(d).slice(0, 200)}`);
        return null;
      }
      console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=discord id=${d.id}`);
      return d.id;
    } else if (source === 'whatsapp') {
      await sendWhatsAppViaBridge(envVars, recipient, text);
      return null;
    } else if (source === 'imessage') {
      // iMessage: spawn osascript directly from the gateway. The Gateway Node
      // runs on the user's Mac (same machine as Messages.app) and has the
      // same TCC-grant envelope as the Vodou-channels standalone (same binary).
      // First send triggers macOS Automation → Messages prompt (one-time).
      await sendImessageViaAppleScript(recipient, text);
      return null;
    } else if (source === 'teams') {
      const appId = envVars.TEAMS_APP_ID;
      const secret = envVars.TEAMS_APP_PASSWORD;
      const tenant = envVars.TEAMS_TENANT_ID;
      if (!appId || !secret) {
        console.error('[Gateway] Teams send: TEAMS_APP_ID / TEAMS_APP_PASSWORD missing');
        return null;
      }
      const routing = decodeTeamsRecipient(recipient);
      if (!routing) {
        console.error('[Gateway] Teams send: invalid recipient (expected base64url routing ref)');
        return null;
      }
      const token = await getBotFrameworkAccessToken(appId, secret, tenant || undefined);
      if (!token) return null;
      const id = await sendTeamsActivity({ token, routing, text, botAppId: appId });
      console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=teams activityId=${id}`);
      return id;
    } else if (source === 'googlechat') {
      const creds = envVars.GOOGLE_CHAT_CREDENTIALS;
      if (!creds) {
        console.error('[Gateway] Google Chat send: GOOGLE_CHAT_CREDENTIALS missing');
        return null;
      }
      const id = await sendGoogleChatMessage(creds, recipient, text);
      console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=googlechat name=${id}`);
      return id;
    } else if (source === 'signal') {
      const account = (envVars.SIGNAL_PHONE_NUMBER || '').trim();
      if (!account) {
        console.error('[Gateway] Signal send: SIGNAL_PHONE_NUMBER missing');
        return null;
      }
      const cli = (envVars.SIGNAL_CLI_PATH || 'signal-cli').trim();
      const config = (envVars.SIGNAL_CLI_CONFIG || '').trim() || undefined;
      const ok = await sendSignalCliMessage(cli, account, config, recipient, text);
      if (ok) console.error('[Gateway DIAG] sendChannelMessage SUCCESS source=signal');
      else console.error('[Gateway] Signal send failed');
      return null;
    }
  } catch (e) { console.error(`[Gateway] ${source} send error:`, (e as Error).message); }
  return null;
}

/** Send an iMessage by spawning `osascript` to drive Messages.app. macOS-only.
 *  Returns true on exit=0 (usually means the send was handed to Messages,
 *  though actual delivery is asynchronous on Apple's side). */
async function sendImessageViaAppleScript(recipient: string, text: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    console.error('[Gateway] iMessage send requires macOS');
    return false;
  }
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  // Choose AppleScript form based on recipient shape.
  //   - If recipient looks like a chat GUID ("iMessage;-;<handle>" or
  //     "SMS;-;<handle>" or "iMessage;+;<groupid>"), use `send ... to chat
  //     id "<guid>"`. This pins to the EXACT thread the message came from
  //     and bypasses Contacts-level handle merging (which can swap
  //     email↔phone for linked contacts, routing replies to the wrong thread).
  //   - Otherwise fall back to the buddy form — the legacy path for
  //     environments where chat_guid wasn't available.
  const isChatGuid = /^[A-Za-z]+;[+-];/.test(recipient);
  const scriptEscapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = isChatGuid
    ? `
      tell application "Messages"
        send "${escaped}" to chat id "${scriptEscapedRecipient}"
      end tell
    `
    : `
      tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy "${scriptEscapedRecipient}" of targetService
        send "${escaped}" to targetBuddy
      end tell
    `;
  return new Promise<boolean>((resolve) => {
    const proc = spawn('osascript', ['-e', script]);
    let stderr = '';
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    proc.on('close', (code: number) => {
      if (code !== 0) {
        console.error(`[Gateway] iMessage send failed (exit ${code}): ${stderr.trim()}`);
      } else {
        console.error(`[Gateway DIAG] sendImessage SUCCESS recipient=${recipient} len=${text.length}`);
      }
      resolve(code === 0);
    });
    proc.on('error', (e: Error) => {
      console.error('[Gateway] osascript spawn error:', e.message);
      resolve(false);
    });
  });
}

/** Edit an existing channel message (for progressive streaming updates) */
async function editChannelMessage(source: string, recipient: string, messageId: string, text: string, envVars: Record<string, string>): Promise<void> {
  console.error(`[Gateway DIAG] editChannelMessage source=${source} recipient=${recipient} messageId=${messageId} text_len=${text.length}`);
  try {
    if (source === 'slack') {
      const token = envVars.SLACK_BOT_TOKEN;
      if (!token) return;
      await fetch('https://slack.com/api/chat.update', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: recipient, ts: messageId, text }),
      });
    } else if (source === 'telegram') {
      const token = envVars.TELEGRAM_BOT_TOKEN;
      if (!token) return;
      await fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: recipient, message_id: parseInt(messageId, 10), text }),
      });
    } else if (source === 'discord') {
      const token = envVars.DISCORD_BOT_TOKEN;
      if (!token) return;
      await fetch('https://discord.com/api/v10/channels/' + recipient + '/messages/' + messageId, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
    } else if (source === 'whatsapp') {
      // No edit API on the bridge; finishChannelStream sends the full text once.
    } else if (source === 'teams') {
      const appId = envVars.TEAMS_APP_ID;
      const secret = envVars.TEAMS_APP_PASSWORD;
      const tenant = envVars.TEAMS_TENANT_ID;
      if (!appId || !secret) return;
      const routing = decodeTeamsRecipient(recipient);
      if (!routing) return;
      const token = await getBotFrameworkAccessToken(appId, secret, tenant || undefined);
      if (!token) return;
      await updateTeamsActivity({ token, routing, activityId: messageId, text, botAppId: appId });
    }
  } catch {}
}

/** Track active channel streams for progressive forwarding */
const _channelStreams = new Map<string, {
  source: string;
  recipient: string;
  messageId: string | null;
  envVars: Record<string, string>;
  lastUpdate: number;
  text: string;
  timer: NodeJS.Timeout | null;
  sendPromise: Promise<void> | null;
}>();

/** Start progressive channel streaming — call on first text chunk for channel conversations */
function startChannelStream(convId: string, source: string, recipient: string): void {
  if (_channelStreams.has(convId)) return;
  _channelStreams.set(convId, {
    source, recipient, messageId: null,
    envVars: getChannelEnv(), lastUpdate: 0, text: '',
    timer: null, sendPromise: null,
  });
}

/** Feed a text chunk to the channel stream — edits the message every 3s */
function feedChannelStream(convId: string, chunk: string): void {
  const stream = _channelStreams.get(convId);
  if (!stream) return;
  stream.text += chunk;

  // Throttle edits to every 3 seconds
  if (stream.timer) return;
  stream.timer = setTimeout(async () => {
    stream.timer = null;
    const now = Date.now();
    if (now - stream.lastUpdate < 2500) return;

    // RACE FIX: if a previous send is still in flight, await it before starting another.
    // Without this guard, the timer can fire (and clear stream.timer above) while the
    // first send is still on the wire — when chunks arrive in that window they set a
    // NEW timer, which fires while messageId is still null and starts a SECOND parallel
    // sendChannelMessage. Each parallel send creates a new Slack message instead of
    // editing the original. Symptom: 2-5 separate Slack messages from a single LLM
    // stream when Slack API latency exceeds the 1.5s throttle window.
    if (stream.sendPromise) {
      try { await stream.sendPromise; } catch {}
    }

    stream.lastUpdate = Date.now();
    // WhatsApp + iMessage: no in-place edits — only send final text in
    // finishChannelStream. Without this, feedChannelStream would spam a new
    // message every ~2.5s with partial text (because sendChannelMessage
    // for these channels returns null, so messageId stays null and the
    // first-send branch fires on every tick).
    if (stream.source === 'whatsapp' || stream.source === 'imessage' || stream.source === 'googlechat' || stream.source === 'signal') {
      return;
    }
    const outbound = channelOutboundText(stream.text);
    const preview = outbound.substring(0, 4000) + (outbound.length > 4000 ? '...' : ' ...');
    // Track the in-flight send so finishChannelStream and the next timer iteration can await it
    stream.sendPromise = (async () => {
      try {
        if (!stream.messageId) {
          // First update — send initial message
          stream.messageId = await sendChannelMessage(stream.source, stream.recipient, preview, stream.envVars);
        } else {
          // Edit existing message
          await editChannelMessage(stream.source, stream.recipient, stream.messageId, preview, stream.envVars);
        }
      } finally {
        // Clear the in-flight marker so finishChannelStream's await is a no-op once we're done
        // (we can't null sendPromise itself or the await above breaks; finishChannelStream
        // already awaits whatever's there before its own send)
      }
    })();
  }, 1500);
}

/** Optional Slack/Telegram/… routing when no progressive stream was started (edge cases). */
type ChannelStreamRescue = { source: string; recipient: string };

/** Finish the channel stream — final edit with complete text */
async function finishChannelStream(
  convId: string,
  finalText: string,
  rescue?: ChannelStreamRescue,
): Promise<void> {
  const stream = _channelStreams.get(convId);
  _channelStreams.delete(convId);
  if (!stream) {
    if (rescue?.recipient?.trim() && rescue.source && finalText.trim()) {
      const envVars = getChannelEnv();
      await sendChannelMessage(
        rescue.source,
        rescue.recipient.trim(),
        channelOutboundText(finalText).substring(0, 4000),
        envVars,
      );
    }
    return;
  }
  if (stream.timer) clearTimeout(stream.timer);

  // Wait for any in-flight send from the timer to complete (prevents race where
  // messageId hasn't been set yet, causing a duplicate sendChannelMessage)
  if (stream.sendPromise) await stream.sendPromise;

  const outbound = channelOutboundText(finalText);
  if (stream.messageId) {
    // Edit with final text
    await editChannelMessage(stream.source, stream.recipient, stream.messageId, outbound.substring(0, 4000), stream.envVars);
  } else if (stream.source === 'whatsapp') {
    await sendWhatsAppViaBridge(stream.envVars, stream.recipient, outbound);
  } else {
    // Never sent — send the full message (Signal, iMessage, Google Chat, Slack, etc.)
    await sendChannelMessage(stream.source, stream.recipient, outbound.substring(0, 4000), stream.envVars);
  }
}

// Express app and HTTP server
let app: Express;
let server: HttpServer;
let wss: WebSocketServer;

// Active WebSocket clients
interface Client {
  id: string;
  ws: WebSocket;
  conversationId: string;
  connectedAt: Date;
  activeConvId?: string;  // conversation currently streaming a response
  aborted?: boolean;      // set to true when user hits stop
}

const clients: Map<string, Client> = new Map();

// ─── WS streaming buffer + keepalive ────────────────────────────────────────
// Per-conversation ring buffer of streaming events. Lets the client resume a
// stream after a transient WS disconnect (idle drop, network blip) without
// losing the in-flight tool result. Buffers are bounded by count and TTL so
// memory doesn't grow unbounded.
interface BufferedEvent { seq: number; ts: number; payload: any; }
const _convBuffers: Map<string, BufferedEvent[]> = new Map();
const _convSeq: Map<string, number> = new Map();
const STREAM_BUFFER_PER_CONV = 200;
const STREAM_BUFFER_TTL_MS = 10 * 60 * 1000; // 10 min — covers long Canva/image-gen tool calls

// Persisted-buffer support: events are also written to gateway.db's
// chat_event_buffer table so a gateway restart doesn't lose in-flight chat
// state. The in-memory map above remains the fast path; DB queries only
// happen on resume when an event isn't in memory (typical post-restart case).
let _persistedSeqHydrated = false;
let _lastPersistErrorAt = 0;
function _hydrateSeqFromDb(): void {
  if (_persistedSeqHydrated) return;
  _persistedSeqHydrated = true;
  try {
    const db = getGatewayDb();
    const rows = db.prepare(
      `SELECT conversation_id, MAX(seq) AS max_seq FROM chat_event_buffer GROUP BY conversation_id`,
    ).all() as { conversation_id: string; max_seq: number }[];
    for (const r of rows) {
      _convSeq.set(r.conversation_id, r.max_seq);
    }
    if (rows.length) {
      console.error(`[Gateway] Hydrated seq counters for ${rows.length} conversation(s) from chat_event_buffer`);
    }
  } catch (err) {
    console.error('[Gateway] chat_event_buffer hydrate failed (continuing with in-memory only):', err);
  }
}

/**
 * Send a streaming event to all clients listening on `convId`, AND buffer it
 * for later resume. Stamps a monotonic `seq` per conversation. Use this for
 * any payload that's part of the reconnect-replay-able stream (chat chunks,
 * tool_use, tool_result, done, error). Per-client snapshots like `connected`,
 * `history`, `conversations_list` should still go through `ws.send` directly.
 */
function streamToConversation(convId: string, payload: any): void {
  _hydrateSeqFromDb();
  const seq = (_convSeq.get(convId) || 0) + 1;
  _convSeq.set(convId, seq);
  const stamped = { ...payload, conversationId: convId, seq };
  const now = Date.now();

  // In-memory buffer (fast-path for resume within the same process)
  let buf = _convBuffers.get(convId);
  if (!buf) { buf = []; _convBuffers.set(convId, buf); }
  buf.push({ seq, ts: now, payload: stamped });
  const cutoff = now - STREAM_BUFFER_TTL_MS;
  while (buf.length > STREAM_BUFFER_PER_CONV || (buf.length && buf[0].ts < cutoff)) {
    buf.shift();
  }

  // Persist to gateway.db so a gateway restart can still serve a resume.
  // Best-effort: failures here log but don't break the broadcast.
  try {
    const db = getGatewayDb();
    db.prepare(
      `INSERT OR REPLACE INTO chat_event_buffer (conversation_id, seq, ts, payload) VALUES (?, ?, ?, ?)`,
    ).run(convId, seq, now, JSON.stringify(stamped));
  } catch (err) {
    // Don't spam logs on every event — only log first failure per minute.
    if (now - _lastPersistErrorAt > 60_000) {
      _lastPersistErrorAt = now;
      console.error('[Gateway] chat_event_buffer persist failed:', err);
    }
  }

  // Broadcast to all live clients matching this conversation
  let sent = 0;
  const clientConvIds: string[] = [];
  for (const c of clients.values()) {
    clientConvIds.push(c.conversationId);
    // Match on either the client's registered conversationId (set via
    // switch_conversation) OR its activeConvId (set when this client just
    // submitted a chat message with an explicit conversationId — e.g. a
    // workbench panel submitting against `workbench:integration:exa` while
    // the WS itself is still registered to the main chat). Without the
    // activeConvId fallback, the client driving the stream never receives
    // its own response.
    if ((c.conversationId === convId || c.activeConvId === convId) && c.ws.readyState === 1) {
      try {
        c.ws.send(JSON.stringify(stamped));
        sent++;
      } catch { /* socket dying */ }
    }
  }
  if (sent === 0 && clients.size > 0) {
    const ptype = typeof payload?.type === 'string' ? payload.type : '?';
    console.error(
      `[Gateway DIAG] streamToConversation: no WS client matched convId=${convId} seq=${seq} type=${ptype} (have ${clients.size} client(s); their conversationIds: ${JSON.stringify(clientConvIds)})`,
    );
    recordStreamNoClients({
      convId,
      seq,
      payloadType: ptype,
      at: new Date().toISOString(),
      clientCount: clients.size,
      clientConversationIds: [...new Set(clientConvIds)],
    });
  }
}

/**
 * Tell all live clients the Board window has activity → auto-create/reopen its
 * tab (with an unread dot) and replay its history. Both the dispatch path and
 * the skill-choice resume path must call this, else resumed-task output streams
 * server-side but never surfaces in the UI.
 */
function broadcastBoardActivity(taskId: string, runId?: string | null): void {
  for (const c of clients.values()) {
    if (c.ws.readyState === 1) {
      try {
        c.ws.send(JSON.stringify({ type: 'board_task_activity', conversationId: 'board-chat', taskId, runId: runId ?? null }));
      } catch { /* socket dying */ }
    }
  }
}

// Wire the boardRouter's result-surfacing (api/board.ts can't import index.ts).
// A finished task (done/blocked) gets its result pushed into the Board chat tab:
//   - saveMessage  → persisted, so a reloaded/late tab shows it in history
//   - streamToConversation → live, so an ALREADY-OPEN Board tab updates now
//   - broadcastBoardActivity → opens/flags the tab if it's closed/unfocused
setBoardSurfaceImpl((taskId, title, body, kind) => {
  const conv = 'board-chat';
  ensureConversation(conv, 'Board', 'board', 'Board Worker');
  const icon = kind === 'done' ? '✅' : '⛔';
  const text = `${icon} **${title}** \`${taskId}\` — ${kind}\n\n${body}`;
  try { saveMessage(conv, 'assistant', text, 'Board Worker'); } catch { /* persisted best-effort */ }
  streamToConversation(conv, { type: 'chunk', conversationId: conv, content: `\n\n${text}\n` });
  streamToConversation(conv, { type: 'done', conversationId: conv, source: 'board-task' });
  broadcastBoardActivity(taskId, null);
});

/**
 * Resolve `{{VAR}}` placeholders in a string against a variables map. Used so
 * the approval event payload (which the board drawer renders as button text)
 * stores RESOLVED titles/labels — e.g. "You picked Blue", not "{{COLOR}}".
 */
function resolveBoardVars(str: string, vars: Record<string, string>): string {
  return String(str ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

/** Resolve every option label in a stopping point against the variables map. */
function resolveStoppingPointOptions(
  options: Record<string, { label?: string }> | undefined,
  vars: Record<string, string>,
): Record<string, { label: string }> {
  const out: Record<string, { label: string }> = {};
  for (const [k, opt] of Object.entries(options ?? {})) {
    out[k] = { label: resolveBoardVars(opt?.label ?? '', vars) };
  }
  return out;
}

/**
 * Layer 1 — run a skill-bound board task through the WORKFLOW ENGINE.
 *
 * Unlike the freehand LLM path, the engine ENFORCES stopping points: it runs the
 * skill's `initial_steps` (if any), then parks the task at the first stopping
 * point as `pending_approval` with the numbered menu — it does NOT let the LLM
 * fabricate a choice and march on. Resume happens later via the /approvals path.
 *
 * Streams all output to the shared Board chat window (BOARD_CHAT_CONV).
 */
async function runBoardSkillTask(
  taskId: string,
  runId: string | undefined,
  skillName: string,
  parsed: { stoppingPoints: any[]; initialSteps?: any[] },
  boardConv: string,
): Promise<void> {
  const onEvent = (event: any): void => {
    if (event.type === 'text' && event.content) {
      streamToConversation(boardConv, { type: 'chunk', conversationId: boardConv, content: event.content });
    } else if (event.type === 'tool_call_start') {
      streamToConversation(boardConv, {
        type: 'tool_start', conversationId: boardConv,
        tool: event.toolName, toolId: event.toolId, args: event.toolArgs,
      });
    } else if (event.type === 'tool_call_end') {
      streamToConversation(boardConv, {
        type: 'tool_result', conversationId: boardConv,
        toolId: event.toolId, result: event.toolResult,
      });
    }
  };

  // Build the phase-0 workflow state. `options` MUST mirror the active stopping
  // point's options — that's what advanceBoardWorkflow matches the choice against.
  // Bind TOPIC from the task (title/body) so skill templates like
  // "{{LLM:...on the topic: {{TOPIC}}...}}" resolve — otherwise the literal
  // {{TOPIC}} reaches the model. This survives stopping-point resumes because the
  // whole `workflow` (incl. variables) is persisted in state_json.
  const topic = getTaskTopic(taskId);
  const workflow: any = {
    skillName,
    topic,
    options: parsed.stoppingPoints[0]?.options ?? {},
    stoppingPoints: parsed.stoppingPoints,
    initialSteps: parsed.initialSteps,
    initialStepsRan: false,
    currentPhase: 0,
    variables: { TOPIC: topic },
    step: 'menu',
  };

  try {
    // 1) Auto-run any initial steps (data gathering before the first menu).
    if (parsed.initialSteps?.length) {
      await wfExecuteSteps(parsed.initialSteps, workflow.variables, onEvent, boardConv);
      workflow.initialStepsRan = true;
    }

    // 2) Format the first stopping point's menu and PARK the task. No LLM choice.
    const sp0 = parsed.stoppingPoints[0];
    const menu = wfFormatMenu(workflow);
    streamToConversation(boardConv, { type: 'chunk', conversationId: boardConv, content: `\n\n${menu}\n` });
    saveMessage(boardConv, 'assistant', `**▶ ${taskId}** _(skill: ${skillName})_\n\n${menu}`);

    pauseTaskForSkillChoice({
      taskId,
      runId,
      skillName,
      phase: 0,
      title: resolveBoardVars(sp0?.title ?? 'Choose an option', workflow.variables),
      options: resolveStoppingPointOptions(sp0?.options, workflow.variables),
      menuMarkdown: menu,
      stateJson: JSON.stringify(workflow),
    });

    streamToConversation(boardConv, { type: 'done', conversationId: boardConv, source: 'board-task' });
    console.error(`[board-skill] ${taskId} parked at stopping point "${sp0?.title ?? '?'}" (pending_approval)`);
  } catch (err: any) {
    console.error(`[board-skill] ${taskId} runner failed:`, err?.message ?? err);
    streamToConversation(boardConv, {
      type: 'chunk', conversationId: boardConv,
      content: `\n\n⚠️ Skill \`${skillName}\` failed to run: ${err?.message ?? err}\n`,
    });
    streamToConversation(boardConv, { type: 'done', conversationId: boardConv, source: 'board-task' });
  }
}

/** Replay buffered events for a conversation that the client missed.
 *  Tries in-memory first (fast path within the same process). On miss
 *  (typical after a gateway restart), falls back to the persisted DB buffer. */
function replayConversation(ws: WebSocket, convId: string, lastSeq: number): number {
  const buf = _convBuffers.get(convId) || [];
  let replayed = 0;
  let maxMemSeq = lastSeq; // highest seq we actually pushed from memory
  // In-memory path
  for (const ev of buf) {
    if (ev.seq > lastSeq) {
      try {
        ws.send(JSON.stringify(ev.payload));
        replayed++;
        if (ev.seq > maxMemSeq) maxMemSeq = ev.seq;
      } catch { break; }
    }
  }
  // If the in-memory buffer either was empty OR doesn't contain lastSeq+1 (the
  // first event the client missed), the gateway likely restarted. Query the
  // persisted buffer for anything we don't have in memory — floored at
  // maxMemSeq so we never re-send an event the loop above already delivered.
  const memHasFromSeq = buf.length > 0 && buf[0].seq <= lastSeq + 1;
  if (!memHasFromSeq) {
    try {
      const db = getGatewayDb();
      const rows = db.prepare(
        `SELECT payload FROM chat_event_buffer WHERE conversation_id = ? AND seq > ? ORDER BY seq`,
      ).all(convId, maxMemSeq) as { payload: string }[];
      for (const r of rows) {
        try { ws.send(r.payload); replayed++; } catch { break; }
      }
      if (rows.length) {
        console.error(`[Gateway] Replayed ${rows.length} event(s) from persisted buffer (conv ${convId}, fromSeq=${maxMemSeq})`);
      }
    } catch (err) {
      console.error('[Gateway] chat_event_buffer replay failed:', err);
    }
  }
  return replayed;
}

/** Periodic janitor: drop empty/stale conversation buffers (memory + DB). */
setInterval(() => {
  const now = Date.now();
  for (const [convId, buf] of _convBuffers) {
    while (buf.length && buf[0].ts < now - STREAM_BUFFER_TTL_MS) buf.shift();
    if (buf.length === 0) _convBuffers.delete(convId);
  }
  // Also prune the persisted buffer (same 10-min TTL).
  try {
    const db = getGatewayDb();
    db.prepare(`DELETE FROM chat_event_buffer WHERE ts < ?`).run(now - STREAM_BUFFER_TTL_MS);
  } catch (err) {
    // Silent — janitor failures aren't worth spamming the log over.
  }
}, 60_000).unref?.();

// Single persistent conversation for the gateway (local single-user app)
// On startup, resume the most recent web conversation instead of generating a new UUID.
// This preserves LLM context across server restarts / walk-away sessions.
function loadLastConversationId(): string | null {
  try {
    const convs = loadConversations();
    const last = convs.find(c => !c.source || c.source === 'web');
    return last?.id ?? null;
  } catch {
    return null;
  }
}
let persistentConversationId: string = loadLastConversationId() ?? randomUUID();

// Skill Runner — stores SKILL.md content per skill conversation
const skillConversations: Map<string, string> = new Map();

/**
 * Initialize Express app with routes
 */
function setupExpress(): Express {
  const app = express();

  // ── DNS-rebinding guard (MUST be first — before body parsing/work) ──────────
  // The gateway binds to 127.0.0.1, and the CORS middleware below locks
  // cross-origin *reads* to localhost. Neither stops DNS rebinding: a site
  // whose DNS re-resolves to 127.0.0.1 becomes "same-origin" to the browser,
  // bypassing CORS entirely — at which point it can READ settings, chat
  // history, etc. The one tell is the Host header, which still carries the
  // attacker's domain: browsers set Host from the request URL and page JS
  // cannot forge it (it's a forbidden header). So reject any request whose
  // Host isn't a known-local name. Missing Host is allowed — HTTP/1.0 / local
  // non-browser tools omit it, and its absence is never a rebinding vector
  // (browsers always send Host). Front the gateway with a trusted reverse
  // proxy? Add that hostname via VODOU_GATEWAY_ALLOWED_HOSTS (comma-separated).
  // NOTE: this defends READS via rebinding. It does NOT by itself stop
  // CSRF-style side effects from a no-cors POST that carries a real localhost
  // Host — that hardening is tracked in
  // PLANS/0.6.9/PLAN-GATEWAY-CSRF-HARDENING.md.
  const HTTP_ALLOWED_HOSTS = new Set<string>([
    'localhost', '127.0.0.1', '[::1]',
    ...(process.env.VODOU_GATEWAY_ALLOWED_HOSTS || '')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  ]);
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (host) {
      let hostname: string | null = null;
      try { hostname = new URL('http://' + host).hostname.toLowerCase(); } catch { hostname = null; }
      if (!hostname || !HTTP_ALLOWED_HOSTS.has(hostname)) {
        console.warn(`[security] rejected non-local Host header: "${host}" ${req.method} ${req.url}`);
        res.status(403).json({ error: 'Forbidden: invalid Host header' });
        return;
      }
    }
    next();
  });

  // Capture raw body on JSON requests so /api/board/channel-action can
  // verify Discord Ed25519 signatures (which sign over the exact bytes).
  app.use(express.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));
  // Slack interactive components POST as application/x-www-form-urlencoded
  // with payload=<json>; needed by /api/board/channel-action.
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // CORS headers — restrict to localhost only. The gateway binds to 127.0.0.1,
  // but a wildcard `*` lets any website the user visits make cross-origin
  // requests to localhost:8765 and read responses (settings, conversation
  // history, etc.). Lock to same-machine origins.
  const ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  function isLocalhostOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      return ALLOWED_ORIGIN_HOSTS.has(u.hostname);
    } catch {
      return false;
    }
  }
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    if (isLocalhostOrigin(origin)) {
      res.header('Access-Control-Allow-Origin', origin!);
      res.header('Vary', 'Origin');
    }
    // If origin is missing (same-origin browser nav, curl, server-to-server),
    // we don't set ACAO at all — same-origin requests don't need CORS.
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // ── CSRF / cross-site write guard (PLANS/0.6.9/PLAN-GATEWAY-CSRF-HARDENING.md) ─
  // CORS stops cross-origin *reads*, the Host guard stops rebinding *reads* —
  // neither stops a malicious page you visit from FIRING a state-changing
  // request it can't read. Because the gateway mounts express.urlencoded, a
  // `no-cors` POST with a CORS-"simple" content type skips preflight and
  // executes (an LLM turn runs, tools fire) — same risk class as the v0.6.8
  // mutation gate, at the HTTP boundary. Block it on mutating methods:
  //   • Origin present & not localhost  → reject (cross-site browser request)
  //   • Sec-Fetch-Site is cross-site/same-site → reject (browser-set, JS can't forge)
  //   • Origin absent + no/same-origin Sec-Fetch → allow (the gateway's own
  //     same-origin UI, and Origin-less local callers: curl, channel relays,
  //     scheduler/heartbeat, webhook receivers, /v1 SDK clients)
  // This also covers the otherwise-open /v1 OpenAI-compat API (POST) against
  // the browser vector. Local-process access is unchanged (consistent with the
  // rest of the 127.0.0.1 gateway); bearer auth via VODOU_OPENAI_COMPAT_TOKEN
  // still layers on top of /v1 when set.
  const CSRF_GUARDED_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
  app.use((req, res, next) => {
    if (!CSRF_GUARDED_METHODS.has(req.method)) { next(); return; }
    const origin = req.headers.origin as string | undefined;
    const secFetchSite = req.headers['sec-fetch-site'] as string | undefined;
    const crossSiteFetch = secFetchSite === 'cross-site' || secFetchSite === 'same-site';
    // A browser-attested localhost Origin overrides the Sec-Fetch-Site leg:
    // Origin is a forbidden header (page JS cannot set or forge it), so
    // `Origin: http://127.0.0.1:<port>` genuinely means a page served by a
    // same-machine service — e.g. the brain console (:8767) writing to
    // /api/vaults, which the browser labels `Sec-Fetch-Site: same-site`
    // (ports are excluded from "site"). DNS-rebinding pages carry the
    // attacker's hostname in Origin and stay blocked; Origin-less cross-site
    // form posts still trip the Sec-Fetch leg. (PLAN-MEMORY-VAULTS V2.)
    const trustedLocalOrigin = isLocalhostOrigin(origin);
    if (!trustedLocalOrigin && ((origin && !isLocalhostOrigin(origin)) || crossSiteFetch)) {
      console.warn(`[security] rejected cross-site ${req.method} ${req.url} (origin="${origin ?? ''}" sec-fetch-site="${secFetchSite ?? ''}")`);
      res.status(403).json({ error: 'Forbidden: cross-site request blocked' });
      return;
    }
    next();
  });

  // Health check
  app.get('/health', async (req: Request, res: Response) => {
    const executorHealth = await checkExecutorHealth();
    const stats = getStats();
    const pool = getCliPoolStats();

    res.json({
      status: 'ok',
      configured: isConfigured(),
      executor: executorHealth,
      stats,
      clients: clients.size,
      terminals: getTerminalCount(),
      tools: getToolNames(),
      // CLI pool visibility — watch activeSessions for runaway accumulation
      cliPool: {
        activeSessions: pool.activeSessions,
        pendingSessions: pool.pendingSessions,
        queuedTurns: pool.queuedTurns,
        spawned: pool.pool_spawned,
        crashed: pool.pool_crash_kills,
      },
      // Memory-injection reliability (PLAN-MEMORY-INJECTION-RELIABILITY P0-C):
      // nonzero + recent lastDegradedAt = turns are running without injected
      // memory/context. Distinguishes "memory layer down" from "no matches".
      memoryReliability: getMemoryReliabilityStats(),
    });
  });

  // Chat endpoint (REST API) — used by gateway web UI and channel-manager (Telegram/Slack/Discord)
  app.post('/chat', async (req: Request, res: Response) => {
    const { conversationId, source, senderName, attachments, recipient: explicitRecipient, project_id } = req.body;
    const userText = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const attachmentList: ChannelAttachmentMeta[] = Array.isArray(attachments)
      ? (attachments as ChannelAttachmentMeta[]).filter((a) => a && typeof a.url === 'string' && a.url.trim())
      : [];
    const displayMessage =
      attachmentList.length > 0 ? appendChannelAttachmentHints(userText, attachmentList) : userText;
    const messageForLlm = userText || (attachmentList.length ? ' ' : '');

    if (!displayMessage.trim()) {
      res.status(400).json({ error: 'Message or attachment with url is required' });
      return;
    }

    if (!isConfigured()) {
      res.status(500).json({ error: 'API not configured. Add your credentials at /settings.' });
      return;
    }

    const convId = conversationId || randomUUID();
    // PLAN-GATEWAY-PROJECTS — resolve the active project for this turn. Web chats
    // carry project_id in the body; channels/skills stay on Default (NULL). Create
    // the web conversation row up front so the project is bound at creation time.
    const projIdRaw = typeof project_id === 'string' ? project_id.trim() : '';
    const projForTurn = projIdRaw ? getProject(projIdRaw) : null;
    if (!source || source === 'web') {
      try { ensureConversation(convId, undefined, 'web', undefined, projForTurn?.id ?? null); } catch { /* best-effort */ }
    }
    const chunks: string[] = [];
    const toolCalls: Array<{ name: string; result: string }> = [];

    // PLAN-SKILL-LEARNING-LOOP Phase 1A — this incoming user message is the
    // signal about the PREVIOUS turn's tool trajectory (accepted/refined/
    // corrected). Backfill it before processing the new turn. No-op when there's
    // no prior trajectory. Best-effort; never blocks the turn.
    if (userText) { try { backfillUserSignal(convId, userText); } catch { /* ignore */ } }

    // Tag conversation with channel source if provided (Telegram, Slack, etc.)
    if (source && source !== 'web') {
      ensureConversation(convId, senderName || source, source, senderName);
      // Broadcast to all connected UI clients so channel tabs auto-appear
      const clientCount = clients.size;
      console.error(`[Gateway] Channel activity: ${source}/${senderName} conv=${convId}, broadcasting to ${clientCount} clients`);
      for (const client of clients.values()) {
        if (client.ws.readyState === 1) { // WebSocket.OPEN
          client.ws.send(JSON.stringify({
            type: 'channel_activity',
            conversationId: convId,
            source,
            senderName: senderName || source,
          }));
          console.error(`[Gateway] Sent channel_activity to ${client.id}`);
        }
      }
    }

    // For channel conversations, broadcast events to WebSocket clients so tabs update live.
    // streamToConversation buffers per-conversation so a transient WS drop can be replayed.
    const isChannel = !!(source && source !== 'web');
    /** Slack C…/D… id (etc.) for gateway → platform send; must come from Vodou-channels POST body for unified conv ids. */
    let channelRecipientForReply = '';
    const broadcast = (msg: Record<string, unknown>) => {
      if (!isChannel) return;
      streamToConversation((msg as any).conversationId || '', msg);
    };

    // Broadcast the incoming user message so channel tabs show it
    if (isChannel) {
      const slackLabel =
        source === 'slack' && typeof senderName === 'string' && senderName.trim()
          ? senderName.trim().substring(0, 200)
          : undefined;
      try {
        saveMessage(convId, 'user', displayMessage.substring(0, 10000), slackLabel ?? null);
      } catch {}
      broadcast({ type: 'channel_user_message', conversationId: convId, content: displayMessage, source, senderName });
      // Start progressive channel streaming (edits message as response builds).
      // Prefer the explicit `recipient` field from the request body (channel-manager
      // uses unified convId `workbench:channel:<type>` and passes Slack channel id
      // separately). Do NOT parse `workbench:channel:slack` as recipient — that
      // used to yield the bogus string `channel:slack`, which Slack API rejects.
      const parts = convId.split(':');
      const legacyFallbackRecipient = parts.length > 1 ? parts.slice(1).join(':') : '';
      const explicit = typeof explicitRecipient === 'string' ? explicitRecipient.trim() : '';
      const unifiedSurfaceOnly =
        /^workbench:channel:(slack|telegram|discord|voice|web|whatsapp|imessage|teams|googlechat|signal)$/i.test(
          convId,
        );
      channelRecipientForReply = explicit || (unifiedSurfaceOnly ? '' : legacyFallbackRecipient);
      if (!channelRecipientForReply && unifiedSurfaceOnly) {
        console.error(
          '[Gateway] /chat missing body.recipient for unified channel workspace — cannot post back to Slack/Telegram/etc. Vodou-channels must send the platform channel id (e.g. Slack C…) in JSON recipient.',
        );
      } else if (!channelRecipientForReply) {
        console.error(`[Gateway] /chat could not resolve recipient (convId=${convId}) — external reply skipped`);
      }
      if (channelRecipientForReply) {
        startChannelStream(convId, source, channelRecipientForReply);
      }
    }

    // PLAN-SKILL-CONSOLE-LOOP §15 spike + §31 Phase 2 — skill console routing.
    // If this conversation is bound to an LLM-created skill, render the skill's
    // prompt_template with {{user_message}}, {{history}}, etc. and pass any
    // skill-bound prefer_model through to chat(). After the assistant turn
    // completes we also: (1) flip is_active=0 if ephemeral, (2) fan-out the
    // assistant text to a channel if delivery_mode='channel'|'broadcast'.
    // lookupSkillBinding returns disabled bindings too so slash commands like
    // /enable still work after a /disable. Only message-routing is gated on
    // is_active below (skillActive flag).
    const skillBinding = lookupSkillBinding(getGatewayDb(), convId);
    const skillActive = !!(skillBinding && skillBinding.is_active === 1);
    let renderedPrompt: string = messageForLlm;
    let preferModel: string | null = null;
    let slashRunInput = messageForLlm.trim();
    let runParamOverrides: Record<string, string> = {};
    if (skillBinding && skillActive) {
      const rp = parseRunCommand(slashRunInput);
      if (rp) {
        runParamOverrides = rp.overrides;
        slashRunInput = rp.rest;
      }
    }
    if (skillBinding) {
      // PLAN-SKILL-CONSOLE-LOOP §32 Tier 2 — slash command intercept.
      // Slash commands run synchronously, never hit the LLM, never burn tokens.
      // Persisted as a normal user/assistant pair so the conversation history is intact.
      // Slash commands work whether or not the skill is active (so /enable can re-arm).
      const slash = await handleSlashCommand(
        getGatewayDb(),
        skillBinding,
        convId,
        skillActive ? slashRunInput : messageForLlm.trim(),
      );
      if (slash) {
        try { saveMessage(convId, 'user', messageForLlm.substring(0, 10000)); } catch {}
        try { saveMessage(convId, 'assistant', slash.response.substring(0, 200000)); } catch {}
        if (slash.skillRefreshed) {
          // Notify all WS clients that a skill changed so the sidebar can re-fetch.
          for (const c of clients.values()) {
            if (c.ws.readyState === 1) {
              try {
                c.ws.send(JSON.stringify({
                  type: 'skill_console_updated',
                  conversationId: convId,
                  skillId: skillBinding.id,
                  skillName: skillBinding.name,
                }));
              } catch { /* socket dying */ }
            }
          }
        }
        res.json({
          conversationId: convId,
          response: slash.response,
          toolCalls: [],
          memory: { used: 0, total: 0, items: [] },
        });
        return;
      }
      const prepared = await prepareSkillConsoleForLlm(
        getGatewayDb(),
        convId,
        skillBinding,
        skillActive,
        slashRunInput,
        runParamOverrides,
        messageForLlm,
      );
      renderedPrompt = prepared.renderedPrompt;
      preferModel = prepared.preferModel;
    }

    // Unified channel threads (Slack, etc.): tell the model who spoke — same convId for all members.
    if (isChannel && senderName && String(senderName).trim()) {
      const who = String(senderName).trim();
      if (source === 'slack') {
        renderedPrompt = `[Slack teammate: ${who}]\n\n${renderedPrompt}`;
      } else {
        renderedPrompt = `[Message from ${source} sender ${who}]\n\n${renderedPrompt}`;
      }
    }

    const restTurnId = randomUUID();
    if (isChannel) {
      hydrateLlmConversationFromDb(convId, displayMessage.trim());
    } else {
      hydrateLlmConversationFromDb(convId);
    }

    try {
      await chat(
        convId,
        renderedPrompt,
        (event) => {
        if (event.type === 'text' && event.content) {
          chunks.push(event.content);
          broadcast({ type: 'chunk', conversationId: convId, content: event.content });
          // Feed chunks to channel stream for progressive updates
          if (isChannel) feedChannelStream(convId, event.content);
        }
        if (event.type === 'tool_call_end' && event.toolName) {
          toolCalls.push({
            name: event.toolName,
            result: event.toolResult || ''
          });
        }
        if (event.type === 'done') {
          // Save assistant response to DB. Even when empty (stream aborted /
          // upstream error), record a marker so the gateway memory extractor
          // can pair it with the user prompt instead of leaving an orphan.
          const fullResponse = chunks.join('');
          const rawSave = fullResponse.trim() || '[stream-aborted: no content]';
          const toSave = isChannel ? channelOutboundText(rawSave) : rawSave;
          try { saveMessage(convId, 'assistant', toSave.substring(0, 200000)); } catch {}
          // Track API usage/cost
          if (event.usage) {
            saveUsage(convId, source || 'web', event.usage.model || '', event.usage);
          }
          // Finish channel stream with final text (replaces progressive updates)
          if (isChannel) {
            const rescue =
              source && channelRecipientForReply
                ? { source, recipient: channelRecipientForReply }
                : undefined;
            finishChannelStream(convId, rawSave, rescue).catch((err: unknown) => {
              console.error('[finishChannelStream] delivery error:', err instanceof Error ? err.message : String(err));
            });
          }
          // PLAN-SKILL-CONSOLE-LOOP §31 — skill console post-reply hooks.
          // Only fire when the skill is active — disabled skills route through
          // generic chat, so post-reply hooks shouldn't apply.
          if (skillBinding && skillActive) {
            const finalText = fullResponse.trim();
            // (a) delivery_mode='channel' or 'broadcast' → fan out to a channel
            if (finalText && (skillBinding.delivery_mode === 'channel' || skillBinding.delivery_mode === 'broadcast')) {
              const target = parseDeliveryTarget(skillBinding.delivery_target);
              if (target) {
                console.error(`[SkillConsole] delivery_mode=${skillBinding.delivery_mode} → ${target.source}:${target.recipient}`);
                forwardToChannel(target.source, target.recipient, finalText);
              } else {
                console.error(`[SkillConsole] WARN delivery_mode=${skillBinding.delivery_mode} but delivery_target malformed: ${skillBinding.delivery_target}`);
              }
            }
            // (b) ephemeral=1 → flip is_active=0 so the skill runs once and stops
            if (skillBinding.ephemeral === 1) {
              const ok = disableEphemeralSkill(getGatewayDb(), skillBinding.id);
              console.error(`[SkillConsole] ephemeral cleanup skill_id=${skillBinding.id} disabled=${ok}`);
            }
            // (c) §20.4 completion hook — fire-and-forget follow-up skill
            if (skillBinding.on_complete_hook?.trim() && fullResponse.trim()) {
              const parent = skillBinding;
              const prior = fullResponse;
              void (async () => {
                try {
                  const hookChunks: string[] = [];
                  await runSkillConsoleCompletionHook(
                    getGatewayDb(),
                    convId,
                    parent,
                    prior,
                    (ev) => {
                      if (ev.type === 'text' && ev.content) {
                        hookChunks.push(ev.content);
                        // streamToConversation only — `broadcast` would duplicate for
                        // channel tabs (it also calls streamToConversation with convId).
                        streamToConversation(convId, { type: 'chunk', content: ev.content });
                      }
                      if (ev.type === 'done') {
                        const txt = hookChunks.join('').trim() || '[stream-aborted: no content]';
                        try { saveMessage(convId, 'assistant', txt.substring(0, 200000)); } catch {}
                        if (ev.usage) {
                          saveUsage(convId, source || 'web', ev.usage.model || '', ev.usage);
                        }
                        streamToConversation(convId, {
                          type: 'done',
                          conversationId: convId,
                          activeModel: getActiveModelLabel(),
                          usage: ev.usage,
                          memory: {
                            used: getLastMemoryUsed(convId).length,
                            total: getTotalMemoryCount(),
                            items: getLastMemoryUsed(convId).slice(0, 5),
                            debug: getLastMemoryDebug(convId),
                          },
                        });
                      }
                    },
                    {
                      beforeChat: (childName) => {
                        try {
                          saveMessage(
                            convId,
                            'user',
                            `[completion hook → ${childName}]`.substring(0, 10000),
                          );
                        } catch { /* */ }
                      },
                    },
                  );
                } catch (e) {
                  console.error('[SkillConsole] completion hook failed:', (e as Error).message);
                }
              })();
            }
          }
          broadcast({ type: 'done', conversationId: convId });
        }
        },
        {
          ...(attachmentList.length ? { channelAttachments: attachmentList } : {}),
          ...(preferModel ? { preferModel } : {}),
          turnId: restTurnId,
          ...(projForTurn ? {
            projectId: projForTurn.id,
            projectRoot: projForTurn.rootPath,
            projectName: projForTurn.name,
            projectInstructions: resolveProjectInstructions(projForTurn.id),
          } : {}),
        }
      );
      clearChatFailure();

      const memoriesUsed = getLastMemoryUsed(convId);
      res.json({
        conversationId: convId,
        response: chunks.join(''),
        toolCalls,
        memory: {
          used: memoriesUsed.length,
          total: getTotalMemoryCount(),
          items: memoriesUsed.slice(0, 5), // Top 5 for the UI
          // PLAN-MEMORY-VISIBILITY-UI Phase B.2 — structured per-chunk debug for the UI.
          debug: getLastMemoryDebug(convId),
        }
      });
    } catch (error) {
      recordChatFailure({
        convId,
        turnId: restTurnId,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // POST /chat/approve — Bet #2 Phase 2 out-of-band approval resume. The client POSTs
  // the token it received via an `approval_requested` event; we run the parked tool
  // (bypassing the permission ask-check; the FS enablement gate still applies) and
  // return the result. The token is the single-use capability (unguessable UUID).
  app.post('/chat/approve', async (req: Request, res: Response) => {
    const { conversationId, token, decision } = req.body || {};
    if (!conversationId || !token) { res.status(400).json({ error: 'conversationId and token required' }); return; }
    const pending = consumeApproval(String(conversationId), String(token));
    if (!pending) { res.status(404).json({ error: 'No pending approval for that token (expired, already handled, or gateway restarted).' }); return; }
    if (decision === 'deny') {
      try { getConversationManager().addAssistantMessage(conversationId, [{ type: 'text', text: `[The user DENIED running ${pending.toolName}.]` } as any]); } catch {}
      res.json({ ok: true, decision: 'deny', toolName: pending.toolName });
      return;
    }
    try {
      const result = await executeOITool(pending.toolName, pending.input, { conversationId, approved: true });
      const note = result.success ? `[Approved by the user — ran ${pending.toolName}: ${(result.output || 'done').slice(0, 500)}]` : `[Approved, but ${pending.toolName} failed: ${result.error}]`;
      try { getConversationManager().addAssistantMessage(conversationId, [{ type: 'text', text: note } as any]); } catch {}
      res.json({ ok: true, decision: 'approve', toolName: pending.toolName, success: result.success, output: result.output, error: result.error });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /chat/automation-emit — scheduled automation run from Rust engine
  // injects a synthetic user message into a scoped workbench:automation:<id>
  // conversation and runs the LLM against it. The LLM response streams back
  // to any WS client subscribed to that conversation (pinned tab) and is
  // persisted to conversation history either way. Triggered only when the
  // automation has `post_to_chat=1` AND `events_matched > 0` server-side.
  app.post('/chat/automation-emit', async (req: Request, res: Response) => {
    const { message, conversationId, system_only, role } = req.body || {};
    if (!message || !conversationId) {
      res.status(400).json({ error: 'message + conversationId required' });
      return;
    }
    // Auth — same shared secret as the heartbeat path
    const expectedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    if (expectedSecret) {
      const provided = req.headers['x-scheduler-secret'] as string;
      if (provided !== expectedSecret) { res.status(403).json({ error: 'Invalid scheduler secret' }); return; }
    }
    // Safety: only allow workbench:automation:* conversations
    if (!/^workbench:automation:\d+$/.test(conversationId)) {
      res.status(400).json({ error: 'conversationId must be workbench:automation:<id>' });
      return;
    }

    ensureConversation(conversationId, `Automation`, conversationId, 'Automation');

    // system_only mode: no-op tick notification — write a cheap system bubble
    // and broadcast it, skip the LLM entirely. Used when events_matched === 0
    // so users see activity in their pinned tab without token burn.
    if (system_only) {
      const msgRole = (role === 'system' || role === 'assistant') ? role : 'system';
      try { saveMessage(conversationId, msgRole, String(message).substring(0, 2000)); } catch {}
      streamToConversation(conversationId, { type: 'chunk', conversationId, content: String(message), role: msgRole });
      streamToConversation(conversationId, { type: 'done', conversationId });
      return res.json({ ok: true, conversationId, systemOnly: true });
    }

    if (!isConfigured()) { res.status(500).json({ error: 'LLM not configured' }); return; }

    const autoSavedUser = String(message).substring(0, 10000).trim();
    try { saveMessage(conversationId, 'user', autoSavedUser); } catch {}

    const autoTurnId = randomUUID();
    hydrateLlmConversationFromDb(conversationId, autoSavedUser);

    let assistantFullText = '';
    try {
      await chat(conversationId, message, (event) => {
        // Broadcast every event to ALL connected WS clients — clients on the
        // frontend filter by conversationId so only the right tab reacts.
        const broadcast = (payload: Record<string, unknown>) => {
          streamToConversation(conversationId, payload);
        };
        if (event.type === 'text' && event.content) {
          assistantFullText += event.content;
          broadcast({ type: 'chunk', content: event.content });
        } else if (event.type === 'tool_call_start') {
          broadcast({
            type: 'tool_start',
            tool: event.toolName,
            toolId: event.toolId,
            server: (event.toolArgs as any)?.server,
            args: event.toolArgs,
          });
        } else if (event.type === 'tool_call_end') {
          broadcast({
            type: 'tool_end',
            tool: event.toolName,
            toolId: event.toolId,
            result: event.toolResult,
            executionTime: (event as any).executionTime,
            success: (event as any).success,
          });
        } else if (event.type === 'approval_requested') {
          // Bet #2 Phase 2b — a gated tool ('ask') was parked. Surface an
          // approve/deny card; the buttons POST the single-use token to
          // /chat/approve. Only fires on the interactive web-chat path.
          broadcast({
            type: 'approval_requested',
            tool: event.toolName,
            category: event.category,
            token: event.approvalToken,
            args: event.toolArgs,
          });
        }
      }, { turnId: autoTurnId });
      clearChatFailure();
      // Always record an assistant turn — empty means upstream aborted; mark
      // so the extractor can pair with the user prompt.
      try {
        const txt = assistantFullText.trim() || '[stream-aborted: no content]';
        saveMessage(conversationId, 'assistant', txt.substring(0, 200000));
      } catch {}
      streamToConversation(conversationId, { type: 'done', conversationId });
      res.json({ ok: true, conversationId, responseChars: assistantFullText.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordChatFailure({
        convId: conversationId,
        turnId: autoTurnId,
        error: msg,
        at: new Date().toISOString(),
      });
      for (const c of clients.values()) {
        if (c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({ type: 'error', conversationId, message: msg }));
        }
      }
      res.status(500).json({ error: msg });
    }
  });

  // POST /chat/heartbeat — scheduled fire from the Rust scheduler. Shared by the
  // heartbeat AND the skill-curriculum practice runner (which mirrors the same
  // fire helper to capture tool trajectories). Honor the payload's source/
  // senderName so non-heartbeat callers (e.g. source='curriculum') don't get
  // stamped as a second "Vodou Heartbeat" dock tab.
  app.post('/chat/heartbeat', async (req: Request, res: Response) => {
    const { message, conversationId, maxTokens, maxToolRounds, runCount, source, senderName } = req.body;

    if (!message) { res.status(400).json({ error: 'message required' }); return; }

    // Auth check
    const expectedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    if (expectedSecret) {
      const provided = req.headers['x-scheduler-secret'] as string;
      if (provided !== expectedSecret) { res.status(403).json({ error: 'Invalid scheduler secret' }); return; }
    }

    if (!isConfigured()) { res.status(500).json({ error: 'LLM not configured' }); return; }

    const convId = conversationId || 'vodou-heartbeat';
    const convSource = (typeof source === 'string' && source.trim()) ? source.trim() : 'heartbeat';
    const convTitle = (typeof senderName === 'string' && senderName.trim()) ? senderName.trim() : 'Vodou Heartbeat';
    const isHeartbeat = convSource === 'heartbeat';
    ensureConversation(convId, convTitle, convSource, 'Vodou');

    // A3a: isPulse — lightweight status push, no LLM call
    if (req.body.isPulse) {
      for (const c of clients.values()) {
        if (c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({
            type: 'heartbeat_pulse',
            conversationId: convId,
            message: req.body.message,
            timestamp: new Date().toISOString(),
          }));
        }
      }
      return res.json({ conversationId: convId, response: req.body.message, isPulse: true });
    }

    markHeartbeatConversation(convId);
    if (maxTokens) setConversationMaxTokens(convId, maxTokens);
    if (maxToolRounds) setConversationMaxToolIterations(convId, maxToolRounds);

    // Broadcast heartbeat_activity so the Vodou heartbeat tab appears/activates.
    // Only for real heartbeats — a curriculum practice run must not pop or animate
    // the heartbeat tab.
    if (isHeartbeat) {
      for (const c of clients.values()) {
        if (c.ws.readyState === 1) {
          c.ws.send(JSON.stringify({ type: 'heartbeat_activity', conversationId: convId, runCount }));
        }
      }
    }

    const hbSavedUser = message.substring(0, 10000).trim();
    try { saveMessage(convId, 'user', hbSavedUser); } catch {}

    // When the Rust scheduler's reqwest timeout fires (600s), the HTTP connection closes.
    // Abort the CLI session immediately so it doesn't idle for the full 15-min turn timeout.
    req.on('close', () => {
      if (!res.writableEnded) {
        console.error(`[heartbeat] HTTP client disconnected for ${convId} — aborting CLI turn`);
        abortConversationCliTurn(convId);
      }
    });

    const hbTurnId = randomUUID();
    hydrateLlmConversationFromDb(convId, hbSavedUser);

    // Track thinking session for this heartbeat run
    let activeThinkingSessionId: string | null = null;
    let activeThinkingSynthesis: string = '';
    const pendingToolArgs = new Map<string, Record<string, unknown>>();

    const chunks: string[] = [];
    try {
      await chat(convId, message, (event) => {
        if (event.type === 'text' && event.content) {
          chunks.push(event.content);
          streamToConversation(convId, { type: 'chunk', conversationId: convId, content: event.content });
        }

        // --- Tool call broadcasting + thinking interception ---
        if (event.type === 'tool_call_start') {
          if (event.toolId && event.toolArgs) pendingToolArgs.set(event.toolId, event.toolArgs);
          streamToConversation(convId, {
            type: 'tool_start', conversationId: convId,
            tool: event.toolName, toolId: event.toolId,
            server: (event.toolArgs as any)?.server, args: event.toolArgs,
          });
        }

        if (event.type === 'tool_call_end') {
          const args = event.toolArgs || pendingToolArgs.get(event.toolId || '');
          if (event.toolId) pendingToolArgs.delete(event.toolId);

          streamToConversation(convId, {
            type: 'tool_end', conversationId: convId,
            tool: event.toolName, toolId: event.toolId,
            result: event.toolResult, executionTime: (event as any).executionTime, success: (event as any).success,
          });

          // Detect vodou_core_call targeting Vodou-Enhanced-Thinking
          const server = (args as any)?.server as string | undefined;
          const tool = (args as any)?.tool as string | undefined;
          const isBt4Call = event.toolName === 'vodou_core_call';
          // CLI path: Bash command containing "vodou-core call Vodou-Enhanced-Thinking"
          const isBashThinking = event.toolName === 'Bash' &&
            typeof (args as any)?.command === 'string' &&
            (args as any).command.includes('Vodou-Enhanced-Thinking');

          if ((isBt4Call && server === 'Vodou-Enhanced-Thinking') || isBashThinking) {
            try {
              let result: any;
              if (event.toolResult) {
                // toolResult may be JSON or may have non-JSON wrapper text
                const jsonMatch = event.toolResult.match(/\{[\s\S]*\}/);
                if (jsonMatch) result = JSON.parse(jsonMatch[0]);
              }
              if (!result) throw new Error('no result');

              // Extract tool name from Bash command like: vodou-core call Vodou-Enhanced-Thinking add_thought '{...}'
              const detectedTool = tool || (isBashThinking
                ? ((args as any)?.command?.match(/Vodou-Enhanced-Thinking\s+(\w+)/)?.[1] || '')
                : '');

              if ((detectedTool === 'start_thinking_session' || result.session_id) && !activeThinkingSessionId && result.topic) {
                activeThinkingSessionId = result.session_id;
                streamToConversation(convId, {
                  type: 'thinking_start', conversationId: convId,
                  sessionId: result.session_id, topic: result.topic || '',
                  estimatedSteps: result.estimated_steps || 0,
                });
              }

              if ((detectedTool === 'add_thought' || result.currentThought) && result.currentThought) {
                streamToConversation(convId, {
                  type: 'thinking_step', conversationId: convId,
                  sessionId: activeThinkingSessionId,
                  thoughtNumber: result.thoughtNumber, totalThoughts: result.totalThoughts,
                  thought: result.currentThought, nextThoughtNeeded: result.nextThoughtNeeded,
                });
              }

              // A3d: capture synthesis from complete_thinking_session
              if ((detectedTool === 'complete_thinking_session' || detectedTool?.includes('complete_thinking')) && result.synthesis) {
                activeThinkingSynthesis = result.synthesis;
              }

              if (detectedTool === 'complete_thinking_session' || (result.status === 'completed' && result.totalThoughts)) {
                streamToConversation(convId, {
                  type: 'thinking_complete', conversationId: convId,
                  sessionId: activeThinkingSessionId || result.session_id,
                  totalThoughts: result.totalThoughts || 0,
                  synthesis: activeThinkingSynthesis || '',
                });
              }
            } catch {
              // Result wasn't valid JSON or didn't match — ignore
            }
          }
        }

        if (event.type === 'done') {
          const fullResponse = chunks.join('');
          // Save even on abort so the extractor sees a paired turn (with marker).
          {
            const txt = fullResponse.trim() || '[stream-aborted: no content]';
            try { saveMessage(convId, 'assistant', txt.substring(0, 200000)); } catch {}
          }

          // HEARTBEAT_OK suppression
          const suppressOk = process.env.VODOU_HEARTBEAT_SUPPRESS_OK === '1';
          if (suppressOk && fullResponse.trim() === 'HEARTBEAT_OK') return;

          streamToConversation(convId, {
            type: 'done', conversationId: convId, source: convSource,
            thinkingSessionId: activeThinkingSessionId,
          });

          // A3g: Channel delivery
          const deliveryChannel = process.env.VODOU_HEARTBEAT_DELIVERY_CHANNEL;
          const deliveryTarget = process.env.VODOU_HEARTBEAT_DELIVERY_TARGET;
          const deliveryFreq = process.env.VODOU_HEARTBEAT_DELIVERY_FREQUENCY || 'daily';
          if (deliveryChannel && deliveryTarget && fullResponse.trim() !== 'HEARTBEAT_OK') {
            const lastDeliveryPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'heartbeat_last_delivery.json');
            let shouldDeliver = true;
            try {
              const last = JSON.parse(fs.readFileSync(lastDeliveryPath, 'utf8'));
              const elapsed = Date.now() - new Date(last.timestamp).getTime();
              if (deliveryFreq === 'daily' && elapsed < 86400000) shouldDeliver = false;
              if (deliveryFreq === 'every_4h' && elapsed < 14400000) shouldDeliver = false;
            } catch {} // No file = first delivery
            if (shouldDeliver) {
              const headlineMatch = fullResponse.match(/## Headline\s*\n([\s\S]*?)(?=\n## |$)/i);
              const headline = headlineMatch ? headlineMatch[1].trim() : fullResponse.slice(0, 100);
              const taskCount = (fullResponse.match(/- \[ \]/g) || []).length;
              const lens = ''; // extracted from prompt if needed
              const condensed = `*Vodou Briefing* (#${runCount || 0})\n${headline}${taskCount ? '\n' + taskCount + ' task(s) on your plate.' : ''}`;
              try {
                const toolName = deliveryChannel === 'slack' ? 'send_message'
                  : deliveryChannel === 'telegram' ? 'send_telegram_message'
                  : deliveryChannel === 'discord' ? 'send_discord_message' : null;
                if (toolName) {
                  // execFileSync (array args, no shell). `condensed` embeds raw
                  // LLM output and was previously interpolated into a single-
                  // quoted shell string — JSON.stringify does NOT escape ' , so
                  // a model-emitted apostrophe could break out and inject shell
                  // commands. Array args remove the shell entirely.
                  execFileSync(path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core'),
                    ['call', 'Vodou-channels', toolName, JSON.stringify({ channel: deliveryTarget, text: condensed })],
                    { timeout: 10000, cwd: getProjectRoot() });
                  fs.writeFileSync(lastDeliveryPath, JSON.stringify({ timestamp: new Date().toISOString() }));
                }
              } catch (e: any) {
                console.error('[heartbeat] Channel delivery failed:', e.message);
              }
            }
          }
        }
      }, { turnId: hbTurnId });
      clearChatFailure();
      res.json({ conversationId: convId, response: chunks.join(''), thinkingSessionId: activeThinkingSessionId });
    } catch (error) {
      recordChatFailure({
        convId,
        turnId: hbTurnId,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /chat/board-task — execute a board task via the configured LLM.
  // Called by the Rust dispatcher when VODOU_BOARD_BACKEND=gateway (or auto,
  // when the Claude CLI is not available). The LLM receives the board worker
  // operating manual + task context, and uses board_show/board_complete/
  // board_block tools (native gateway tools, no Vodou-Board MCP server needed).
  // Auth: same VODOU_GATEWAY_SCHEDULER_SECRET shared secret as /chat/heartbeat.
  app.post('/chat/board-task', async (req: Request, res: Response) => {
    const { taskId, runId, maxTokens, maxToolRounds } = req.body as {
      taskId?: string; runId?: string; maxTokens?: number; maxToolRounds?: number;
    };

    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return; }

    const expectedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    if (expectedSecret) {
      const provided = req.headers['x-scheduler-secret'] as string;
      if (provided !== expectedSecret) { res.status(403).json({ error: 'Invalid scheduler secret' }); return; }
    }

    if (!isConfigured()) { res.status(500).json({ error: 'LLM not configured' }); return; }

    // Per-task conversation = the worker's ISOLATED LLM context (so concurrent
    // workers never see each other's history).
    const convId = `board-task-${taskId}`;
    ensureConversation(convId, `Board Task ${taskId}`, 'board', 'Board Worker');
    if (maxTokens) setConversationMaxTokens(convId, maxTokens);
    if (maxToolRounds) setConversationMaxToolIterations(convId, maxToolRounds ?? 20);

    // All board worker DISPLAY output streams to ONE dedicated "Board" window —
    // a single conversation surfaced as a persistent main-strip tab (like a
    // channel). Output never proliferates into per-task windows, and the frontend
    // auto-reopens this tab (with an unread dot) on activity.
    const BOARD_CHAT_CONV = 'board-chat';
    ensureConversation(BOARD_CHAT_CONV, 'Board', 'board', 'Board Worker');

    // Tell clients the Board window has activity → auto-create/reopen its tab.
    broadcastBoardActivity(taskId, runId);

    // Bootstrap message: board worker operating manual + task assignment.
    // The LLM is expected to call board_show(taskId) first, do the work,
    // then close with board_complete or board_block.
    const bootstrap = [
      '# Board Worker',
      '',
      'You are a Vodou Board worker. You have been assigned ONE task.',
      '',
      '## Operating loop',
      `1. Call board_show("${taskId}") — read your task fully before acting.`,
      '2. Do the work described in the task body. Keep it tight — do the minimum that',
      '   satisfies the task, then close it. Do not over-explore.',
      '3. When done: call board_complete(task_id, summary) — put your actual output/result',
      '   in the summary. This IS where your output goes.',
      '4. If stuck or need human input: call board_block(task_id, reason) — be specific.',
      '5. Call board_heartbeat(task_id) every few minutes for long-running work.',
      '',
      '## Rules',
      '- Do not exit without calling board_complete or board_block.',
      '- board_heartbeat does NOT count as closing the task — always complete or block.',
      '- **board_show, board_complete, board_block, board_heartbeat are DIRECT tools** in your',
      '  toolset — call each by its exact name with the task_id. Do NOT route them through',
      "  vodou_core_call, and do NOT assume a 'Vodou-Board' MCP server exists (it does not).",
      '- **OUTPUT DESTINATION: everything you produce belongs to THIS board task.** Your',
      '  streamed text already shows in the board chat for this task, and your final result',
      '  goes in the board_complete summary. Do NOT send to external channels (Slack, email,',
      '  SMS, etc.) or use any messaging/channel tool UNLESS the task text explicitly names a',
      '  channel or recipient. E.g. for "say hello to chad", just put the greeting in your',
      '  board_complete summary and finish — do not hunt for a way to deliver it.',
      '- Use vodou_core_call ONLY for OTHER MCP tools the task explicitly requires.',
      '- **NEVER fabricate a skill run or a human decision.** You may not claim to have run',
      '  a skill, completed a workflow, passed a "stopping point", or "chose" an option on a',
      "  user's behalf. Skills with stopping points are run by the engine, NOT by you — if the",
      '  task needs a skill or any human choice you cannot make, call board_block(task_id,',
      '  reason) explaining what input is needed. Do NOT summarize steps or choices that did',
      '  not actually happen — a fabricated "all checkpoints passed" summary will be rejected.',
      `- Your task ID: **${taskId}**`,
    ].join('\n');

    try { saveMessage(convId, 'user', bootstrap.substring(0, 10000)); } catch {}

    // IMPORTANT: the board dispatcher is a one-shot CLI. It POSTs here and then
    // exits as soon as it gets an ack — which closes this HTTP connection. So we
    // must NOT abort on client disconnect (that was the bug that made the gateway
    // backend unusable), and we must NOT block this response on the full LLM run.
    // Instead: kick off the task in the BACKGROUND, decoupled from the request
    // lifecycle, and ack 202 immediately. The task completes server-side and
    // closes itself via the native board_complete/board_block tools.
    hydrateLlmConversationFromDb(convId, bootstrap);
    const btTurnId = randomUUID();

    // Per-task header in the shared Board window so output from back-to-back
    // tasks is visually separated and attributable.
    streamToConversation(BOARD_CHAT_CONV, {
      type: 'chunk', conversationId: BOARD_CHAT_CONV,
      content: `\n\n──────────\n**▶ Board task \`${taskId}\`**${runId ? ` _(run ${runId})_` : ''}\n\n`,
    });

    // ── Layer 1: a skill-bound board task runs via the WORKFLOW ENGINE, not the
    // freehand LLM — so the skill's stopping points are enforced (park into
    // pending_approval) instead of fabricated. Pinned via task.skills_json.
    const pinnedSkill = getTaskPinnedSkill(taskId);
    if (pinnedSkill) {
      const actionsPath = wfFindActionsFile(pinnedSkill);
      let parsedSkill: { stoppingPoints: any[]; initialSteps?: any[] } | null = null;
      if (actionsPath) {
        try { parsedSkill = wfParseStoppingPoints(fs.readFileSync(actionsPath, 'utf8')); }
        catch (e) { console.error(`[board-skill] read ${actionsPath} failed: ${(e as any)?.message ?? e}`); }
      }
      if (parsedSkill && parsedSkill.stoppingPoints?.length) {
        void runBoardSkillTask(taskId, runId, pinnedSkill, parsedSkill, BOARD_CHAT_CONV)
          .catch((e) => console.error(`[board-skill] ${taskId} runner error:`, e?.message ?? e));
        res.status(202).json({ taskId, runId, conversationId: BOARD_CHAT_CONV, accepted: true, mode: 'skill' });
        return;
      }
      console.error(`[board-skill] task ${taskId} pins "${pinnedSkill}" but no stopping-point actions found — running freehand`);
    }

    void (async () => {
      const chunks: string[] = [];
      try {
        await chat(convId, bootstrap, (event) => {
          if (event.type === 'text' && event.content) {
            chunks.push(event.content);
            streamToConversation(BOARD_CHAT_CONV, { type: 'chunk', conversationId: BOARD_CHAT_CONV, content: event.content });
          }
          if (event.type === 'tool_call_start') {
            streamToConversation(BOARD_CHAT_CONV, {
              type: 'tool_start', conversationId: BOARD_CHAT_CONV,
              tool: event.toolName, toolId: event.toolId, args: event.toolArgs,
            });
          }
          if (event.type === 'tool_call_end') {
            streamToConversation(BOARD_CHAT_CONV, {
              type: 'tool_result', conversationId: BOARD_CHAT_CONV,
              toolId: event.toolId, result: event.toolResult,
            });
          }
        }, { turnId: btTurnId });

        const fullResponse = chunks.join('');
        saveMessage(convId, 'assistant', fullResponse);                                  // isolated LLM context
        saveMessage(BOARD_CHAT_CONV, 'assistant', `**▶ ${taskId}**\n\n${fullResponse}`);  // shared Board window history
        streamToConversation(BOARD_CHAT_CONV, { type: 'done', conversationId: BOARD_CHAT_CONV, source: 'board-task' });
        console.error(`[board-task] ${taskId} complete (${fullResponse.length} chars)`);

        // Completion enforcement: the worker is expected to close itself via
        // board_complete/board_block. If the turn ended with the task still `running`
        // (no completion call, an empty/0-char response, or a board_complete that
        // failed), requeue (bounded) or block it — never leave a zombie that stalls
        // every child behind it. No-op if the task already resolved itself.
        try {
          const outcome = resolveIncompleteBoardTask(taskId, runId, fullResponse);
          if (outcome !== 'noop') {
            console.error(`[board-task] ${taskId} did not self-complete → ${outcome}`);
            streamToConversation(BOARD_CHAT_CONV, {
              type: 'chunk', conversationId: BOARD_CHAT_CONV,
              content: `\n\n⚠️ _Task \`${taskId}\` ended without completing — ${outcome === 'requeued' ? 'requeued for retry' : 'blocked for review'}._\n`,
            });
          }
        } catch (e) { console.error(`[board-task] ${taskId} completion-enforcement error:`, (e as any)?.message ?? e); }
      } catch (err: any) {
        console.error(`[board-task] ${taskId} background error:`, err?.message ?? err);
        streamToConversation(BOARD_CHAT_CONV, { type: 'done', conversationId: BOARD_CHAT_CONV, source: 'board-task' });
        // A hard error also leaves the task `running` — resolve it (requeue/block) so it doesn't zombie.
        try { resolveIncompleteBoardTask(taskId, runId, ''); } catch (e) { console.error(`[board-task] ${taskId} post-error resolve failed:`, (e as any)?.message ?? e); }
      }
    })();

    // Ack immediately. The Rust dispatcher only waits for this 202, then exits;
    // the run stays open until the LLM calls board_complete/board_block.
    res.status(202).json({ taskId, runId, conversationId: convId, accepted: true });
    return;
  });

  // ── Layer 2: POST /api/board/tasks/:id/skill-choice ──────────────────────
  // Resume a skill-driven board task that's parked in `pending_approval`. The
  // body carries the user's choice ({ choice: "2" } or free text for a
  // text_input stopping point). The engine runs the chosen branch's steps and
  // then either re-parks at the next stopping point or completes the task.
  // Output streams to the shared Board chat window. Registered here (not on
  // boardRouter) because it needs streamToConversation + the workflow engine.
  app.post('/api/board/tasks/:id/skill-choice', async (req: Request, res: Response) => {
    const taskId = req.params.id;
    const choice = (req.body?.choice ?? '').toString();
    const BOARD_CHAT_CONV = 'board-chat';

    const state = loadBoardWorkflowState(taskId);
    if (!state) {
      res.status(404).json({ error: 'no parked skill workflow for this task' });
      return;
    }
    let workflow: any;
    try { workflow = JSON.parse(state.state_json); }
    catch { res.status(500).json({ error: 'corrupt workflow state' }); return; }

    if (!choice.trim()) {
      res.status(400).json({ error: 'choice is required' });
      return;
    }

    ensureConversation(BOARD_CHAT_CONV, 'Board', 'board', 'Board Worker');
    const runId = getTaskCurrentRunId(taskId);

    // Surface the Board window in the UI (open/flag its tab + replay) — without
    // this, a resumed task's output streams server-side but never appears.
    broadcastBoardActivity(taskId, runId);

    // Capture WHERE the choice was made (current parked phase) before advancing,
    // so the recorded skill_choice event pins to the right stopping point.
    const choicePhase = workflow.currentPhase;
    const choiceTitle = resolveBoardVars(
      workflow.stoppingPoints?.[workflow.currentPhase]?.title ?? '', workflow.variables);

    // Echo the user's pick into the Board window so the transcript reads naturally.
    const pickedLabel = workflow.options?.[choice.trim()]?.label;
    streamToConversation(BOARD_CHAT_CONV, {
      type: 'chunk', conversationId: BOARD_CHAT_CONV,
      content: `\n\n**▶ ${taskId}** — selected: \`${choice.trim()}\`${pickedLabel ? ` (${pickedLabel})` : ''}\n`,
    });

    const onEvent = (event: any): void => {
      if (event.type === 'text' && event.content) {
        streamToConversation(BOARD_CHAT_CONV, { type: 'chunk', conversationId: BOARD_CHAT_CONV, content: event.content });
      } else if (event.type === 'tool_call_start') {
        streamToConversation(BOARD_CHAT_CONV, { type: 'tool_start', conversationId: BOARD_CHAT_CONV, tool: event.toolName, toolId: event.toolId, args: event.toolArgs });
      } else if (event.type === 'tool_call_end') {
        streamToConversation(BOARD_CHAT_CONV, { type: 'tool_result', conversationId: BOARD_CHAT_CONV, toolId: event.toolId, result: event.toolResult });
      }
    };

    try {
      const result = await wfAdvance(workflow, choice, onEvent, BOARD_CHAT_CONV);

      if (result.status === 'no_match') {
        // Re-show the current menu; leave the task parked.
        const menu = wfFormatMenu(workflow);
        streamToConversation(BOARD_CHAT_CONV, {
          type: 'chunk', conversationId: BOARD_CHAT_CONV,
          content: `\n\nThat didn't match an option. Reply with one of the numbers below.\n\n${menu}\n`,
        });
        streamToConversation(BOARD_CHAT_CONV, { type: 'done', conversationId: BOARD_CHAT_CONV, source: 'board-task' });
        res.status(409).json({ taskId, status: 'no_match', menu });
        return;
      }

      // Durably record the chosen option (so the run view can show the actual
      // path: "Welcome Gate → Start the test") and any tool/step output.
      emitTaskEvent(taskId, 'skill_choice', {
        skill: state.skill_name, phase: choicePhase, title: choiceTitle,
        choice: choice.trim(), label: pickedLabel ?? null,
      }, 'human');
      if (result.results?.trim()) {
        emitTaskEvent(taskId, 'skill_step', {
          skill: state.skill_name, phase: choicePhase, output: result.results.slice(0, 4000),
        });
      }

      if (result.results?.trim()) {
        streamToConversation(BOARD_CHAT_CONV, { type: 'chunk', conversationId: BOARD_CHAT_CONV, content: `\n${result.results}\n` });
      }

      if (result.status === 'parked') {
        // Re-park at the next stopping point: persist new state + re-emit approval.
        const menu = result.menu ?? wfFormatMenu(workflow);
        streamToConversation(BOARD_CHAT_CONV, { type: 'chunk', conversationId: BOARD_CHAT_CONV, content: `\n\n${menu}\n` });
        saveMessage(BOARD_CHAT_CONV, 'assistant', `**▶ ${taskId}** _(skill: ${state.skill_name})_\n\n${menu}`);
        pauseTaskForSkillChoice({
          taskId, runId: runId ?? undefined, skillName: state.skill_name,
          phase: result.phase ?? workflow.currentPhase,
          title: resolveBoardVars(result.stoppingPoint?.title ?? 'Choose an option', workflow.variables),
          options: resolveStoppingPointOptions(result.stoppingPoint?.options, workflow.variables),
          menuMarkdown: menu, stateJson: JSON.stringify(workflow),
        });
        streamToConversation(BOARD_CHAT_CONV, { type: 'done', conversationId: BOARD_CHAT_CONV, source: 'board-task' });
        console.error(`[board-skill] ${taskId} advanced → parked at phase ${result.phase} ("${result.stoppingPoint?.title ?? '?'}")`);
        res.json({ taskId, status: 'pending_approval', phase: result.phase, menu });
        return;
      }

      // Complete.
      const summary = (result.results?.trim() || `Skill "${state.skill_name}" completed.`);
      completeBoardSkillTask(taskId, runId, summary);
      saveMessage(BOARD_CHAT_CONV, 'assistant', `**▶ ${taskId}** _(skill: ${state.skill_name})_ — ✅ complete`);
      streamToConversation(BOARD_CHAT_CONV, { type: 'chunk', conversationId: BOARD_CHAT_CONV, content: `\n\n✅ **${taskId}** complete.\n` });
      streamToConversation(BOARD_CHAT_CONV, { type: 'done', conversationId: BOARD_CHAT_CONV, source: 'board-task' });
      console.error(`[board-skill] ${taskId} completed via skill workflow`);
      res.json({ taskId, status: 'done' });
    } catch (err: any) {
      console.error(`[board-skill] ${taskId} skill-choice error:`, err?.message ?? err);
      streamToConversation(BOARD_CHAT_CONV, { type: 'done', conversationId: BOARD_CHAT_CONV, source: 'board-task' });
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // In-memory cooldown: tracks the last completed fire time per conversation so
  // that rapid duplicate calls (UI "Run Now" double-clicks, race between scheduler
  // ticks and manual fires) are rejected instead of spawning concurrent LLM turns.
  // Key = conversationId, value = ms timestamp of last fire start.
  // A 60-second window covers the scheduler tick interval; adjust VODOU_SKILL_FIRE_COOLDOWN_MS
  // in .env to override (0 = disabled).
  const _skillFireLastAt = new Map<string, number>();
  const SKILL_FIRE_COOLDOWN_MS = parseInt(process.env.VODOU_SKILL_FIRE_COOLDOWN_MS ?? '60000', 10);

  // PLAN-SKILL-CONSOLE-LOOP §32 Phase 3 — POST /chat/skill-fire
  // Called by the Rust scheduler's `skill_run` payload_type branch to fire a
  // scheduled skill into its bound conversation. Renders the skill's prompt
  // template (with empty {{user_message}} since this is unprompted), runs it
  // through chat(), and persists+broadcasts the assistant turn just like a
  // normal /chat call would. Auth via VODOU_GATEWAY_SCHEDULER_SECRET (same
  // shared secret as /chat/heartbeat).
  app.post('/chat/skill-fire', async (req: Request, res: Response) => {
    const { skillId, conversationId } = req.body as { skillId?: number; conversationId?: string };

    if (!skillId || !conversationId) {
      res.status(400).json({ error: 'skillId and conversationId are required' });
      return;
    }

    const expectedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
    if (expectedSecret) {
      const provided = req.headers['x-scheduler-secret'] as string | undefined;
      if (provided !== expectedSecret) { res.status(403).json({ error: 'Invalid scheduler secret' }); return; }
    }

    // Cooldown guard: reject duplicate fires within SKILL_FIRE_COOLDOWN_MS of the
    // previous fire start for this conversation. This prevents UI double-clicks and
    // scheduler/UI races from spawning concurrent LLM turns.
    if (SKILL_FIRE_COOLDOWN_MS > 0) {
      const lastAt = _skillFireLastAt.get(conversationId);
      if (lastAt !== undefined && Date.now() - lastAt < SKILL_FIRE_COOLDOWN_MS) {
        const remaining = Math.ceil((SKILL_FIRE_COOLDOWN_MS - (Date.now() - lastAt)) / 1000);
        res.status(429).json({ error: `skill-fire cooldown: retry in ${remaining}s`, cooldownMs: SKILL_FIRE_COOLDOWN_MS });
        return;
      }
      _skillFireLastAt.set(conversationId, Date.now());
    }

    if (!isConfigured()) { res.status(500).json({ error: 'LLM not configured' }); return; }

    const skill = lookupSkillBinding(getGatewayDb(), conversationId);
    if (!skill || skill.id !== skillId) {
      res.status(404).json({ error: `no skill bound to ${conversationId} (or skillId mismatch)` });
      return;
    }
    if (!skill.is_active) {
      res.status(409).json({ error: `skill ${skill.name} is disabled` });
      return;
    }

    // Render the prompt template with empty user_message — scheduled fires are
    // unprompted, so {{user_message}} resolves to "" and the template's static
    // content drives the LLM turn. {{history}} still works if history_window>0.
    const built = await prepareSkillConsoleForLlm(
      getGatewayDb(),
      conversationId,
      skill,
      true,
      '',
      {},
      '',
    );
    const renderedPrompt = built.renderedPrompt;
    const preferModel = built.preferModel;

    // Persist a system marker so the conversation history shows what fired the
    // turn. Stored as role='user' with a [scheduled] prefix so the recall
    // pipeline still pairs it with the assistant reply downstream.
    try { saveMessage(conversationId, 'user', `[scheduled fire @ ${new Date().toISOString()}]`); } catch {}

    const sfTurnId = randomUUID();
    hydrateLlmConversationFromDb(conversationId);

    // Broadcast a fire start so the front-end can highlight the tab.
    for (const c of clients.values()) {
      if (c.ws.readyState === 1) {
        try { c.ws.send(JSON.stringify({ type: 'skill_console_firing', conversationId, skillId: skill.id, skillName: skill.name })); } catch {}
      }
    }

    const chunks: string[] = [];
    const toolCalls: Array<{ name: string; result: string }> = [];
    const gwSf = getGatewayDb();
    try {
      await chat(
        conversationId,
        renderedPrompt,
        (event) => {
          if (event.type === 'text' && event.content) {
            chunks.push(event.content);
            // streamToConversation alone — it already fans out to every WS client
            // with this conversationId (and buffers for replay). A second blind
            // broadcast to all clients duplicates every chunk for subscribers.
            streamToConversation(conversationId, { type: 'chunk', content: event.content });
          }
          if (event.type === 'tool_call_end' && event.toolName) {
            toolCalls.push({ name: event.toolName, result: event.toolResult || '' });
          }
          if (event.type === 'done') {
            const fullResponse = chunks.join('');
            const toSave = fullResponse.trim() || '[stream-aborted: no content]';
            try { saveMessage(conversationId, 'assistant', toSave.substring(0, 200000)); } catch {}
            if (event.usage) saveUsage(conversationId, 'scheduler', event.usage.model || '', event.usage);

            const finalText = fullResponse.trim();
            if (finalText && (skill.delivery_mode === 'channel' || skill.delivery_mode === 'broadcast')) {
              const target = parseDeliveryTarget(skill.delivery_target);
              if (target) forwardToChannel(target.source, target.recipient, finalText);
            }
            if (skill.ephemeral === 1) {
              disableEphemeralSkill(gwSf, skill.id);
            }
            streamToConversation(conversationId, { type: 'done', conversationId });

            if (skill.on_complete_hook?.trim() && finalText) {
              const parentSf = skill;
              const priorSf = finalText;
              void (async () => {
                try {
                  const hookChunks: string[] = [];
                  await runSkillConsoleCompletionHook(
                    gwSf,
                    conversationId,
                    parentSf,
                    priorSf,
                    (ev) => {
                      if (ev.type === 'text' && ev.content) {
                        hookChunks.push(ev.content);
                        streamToConversation(conversationId, { type: 'chunk', content: ev.content });
                      }
                      if (ev.type === 'done') {
                        const htxt = hookChunks.join('').trim() || '[stream-aborted: no content]';
                        try { saveMessage(conversationId, 'assistant', htxt.substring(0, 200000)); } catch {}
                        if (ev.usage) {
                          saveUsage(conversationId, 'scheduler', ev.usage.model || '', ev.usage);
                        }
                        streamToConversation(conversationId, { type: 'done', conversationId });
                      }
                    },
                    {
                      beforeChat: (childName) => {
                        try {
                          saveMessage(
                            conversationId,
                            'user',
                            `[completion hook → ${childName}]`.substring(0, 10000),
                          );
                        } catch { /* */ }
                      },
                    },
                  );
                } catch (e) {
                  console.error('[SkillConsole] skill-fire completion hook:', (e as Error).message);
                }
              })();
            }
          }
        },
        { ...(preferModel ? { preferModel } : {}), turnId: sfTurnId },
      );
      clearChatFailure();
      res.json({ conversationId, skillId: skill.id, response: chunks.join(''), toolCalls });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      recordChatFailure({
        convId: conversationId,
        turnId: sfTurnId,
        error: msg,
        at: new Date().toISOString(),
      });
      console.error(`[SkillConsole] skill-fire failed skill=${skill.name}:`, msg);
      res.status(500).json({ error: msg });
    }
  });

  // Clear conversation
  app.post('/clear', (req: Request, res: Response) => {
    const { conversationId } = req.body;

    if (!conversationId) {
      res.status(400).json({ error: 'conversationId is required' });
      return;
    }

    clearConversation(conversationId);
    res.json({ success: true, message: 'Conversation cleared' });
  });

  // Phase 6: cleanup poisoned conversation history after a skill uninstall.
  // POST body: { skill_name: string, content_pattern?: string }
  // Marks gateway_messages.excluded_from_context=1 for matching assistant turns
  // so they won't be replayed to the LLM as conversation context. Rows stay in
  // the DB for audit; only the LLM-context-load path is affected.
  app.post('/api/skills/cleanup-context', async (req: Request, res: Response) => {
    try {
      const { skill_name, content_pattern } = req.body || {};
      if (!skill_name || typeof skill_name !== 'string') {
        res.status(400).json({ error: 'skill_name (string) is required' });
        return;
      }
      const { excludeSkillMessagesFromContext } = await import('./conversation-store.js');
      const n = excludeSkillMessagesFromContext(skill_name, {
        contentPattern: typeof content_pattern === 'string' ? content_pattern : undefined,
      });
      res.json({ success: true, skill_name, rows_excluded: n });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Stats endpoint
  app.get('/stats', (req: Request, res: Response) => {
    const stats = getStats();
    res.json({
      ...stats,
      clients: clients.size,
      clientIds: Array.from(clients.keys())
    });
  });

  // API routes
  app.use('/api/system', systemRouter);
  // Lightweight liveness endpoint — alias for `/api/system` so external
  // monitors hitting the conventional `/api/health` URL don't get a 404.
  // Returns minimal JSON to keep the response cheap.
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
  });
  app.use('/api/servers', serversRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/exec', execRouter);
  app.use('/api/intents', intentsRouter);
  app.use('/api/scheduler', schedulerRouter);
  app.use('/api/skill-console', skillConsoleMetaRouter);
  app.use('/api/automations', automationsRouter);
  app.use('/api/scripts', scriptsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/memory/extractor', memoryExtractorRouter);
  app.use('/api/import', memoryImportRouter);
  app.use('/api/capture', memoryCaptureRouter);
  app.use('/api/vaults', memoryVaultsRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/link-preview', linkPreviewRouter);
  app.use('/api/onboarding/progress', onboardingProgressRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/cascade/readiness', cascadeReadinessRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/tools', toolsRouter);
  app.use('/api/route', routeRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/board', boardRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/docs', docsRouter);
  app.use('/api/oauth', oauthRouter);
  app.use('/api/mcp-registry', mcpRegistryRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/workbench', workbenchRouter);
  // PLAN-LENSES-MVP — visual lenses: fetch, action, manifests, status
  app.use('/api/lenses', lensesRouter);

  // PLAN-ROUTER-LLM Phase 4 — Bridge state for the router LLM's context.
  // Returns last-known active-tab URL/title (cached from `tab_changed` events
  // the extension pushes). Daemon polls this at decision time.
  app.get('/api/vbb/state', async (_req, res) => {
    try {
      const { bridgeStatus, bridgeActiveTab } = await import('./vbb/bridge.js');
      res.json({ ok: true, data: { status: bridgeStatus(), active_tab: bridgeActiveTab() } });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err?.message || 'failed' } });
    }
  });

  // OpenAI-compatible API — /v1/chat/completions, /v1/models
  app.use('/v1', openaiCompatRouter);
  console.error(`[Gateway] OpenAI-compatible API mounted at /v1${process.env.VODOU_OPENAI_COMPAT_TOKEN ? ' (bearer auth enabled)' : ' (open — set VODOU_OPENAI_COMPAT_TOKEN for auth)'}`);

  // --- Identity — serve user + AI names from workspace config ---
  app.get('/api/identity', (_req: Request, res: Response) => {
    try {
      const wsDir = path.join(getProjectRoot(), '.vodou', 'workspace');
      // Pre-onboarding defaults: VODOU brand on the assistant side,
      // generic placeholder on the user side. These are what fresh-install
      // chat renders until USER.md / IDENTITY.md get populated.
      let userName = 'User';
      let aiName = 'VODOU';
      let aiEmoji = '';

      try {
        const user = fs.readFileSync(path.join(wsDir, 'USER.md'), 'utf-8');
        const callMatch = user.match(/\*\*What to call them:\*\*\s*(.+)/);
        const nameMatch = user.match(/\*\*Name:\*\*\s*(.+)/);
        const raw = callMatch?.[1]?.trim() || nameMatch?.[1]?.trim();
        if (raw && !raw.startsWith('_')) userName = raw;
      } catch {}

      try {
        const identity = fs.readFileSync(path.join(wsDir, 'IDENTITY.md'), 'utf-8');
        const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
        const emojiMatch = identity.match(/\*\*Emoji:\*\*\s*(.+)/);
        if (nameMatch?.[1]?.trim()) aiName = nameMatch[1].trim();
        if (emojiMatch?.[1]?.trim()) aiEmoji = emojiMatch[1].trim();
      } catch {}

      const userAvatar = getSetting('user_avatar') || '';
      // Default to the bundled VODOU logo when nothing overrides it.
      // chat.js renders an <img> when avatarText starts with "/" or "http".
      const aiAvatar = getSetting('ai_avatar') || '/icons/vodou-icon.png';
      const aiAvatarColor = getSetting('ai_avatar_color') || '#6B7280';
      res.json({ userName, aiName, aiEmoji, aiAvatar, userAvatar, aiAvatarColor });
    } catch {
      res.json({ userName: 'User', aiName: 'VODOU', aiEmoji: '', aiAvatar: '/icons/vodou-icon.png', userAvatar: '', aiAvatarColor: '#6B7280' });
    }
  });

  // Paginated gateway chat history (main chat "Load earlier" — same transforms as WS `history`)
  app.get('/api/chat/history', (req: Request, res: Response) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
    const beforeRaw = typeof req.query.before === 'string' ? req.query.before : '';
    const beforeId = parseInt(beforeRaw, 10);
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : UI_CHAT_HISTORY_PAGE_SIZE;
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : UI_CHAT_HISTORY_PAGE_SIZE, 1), 200);
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    if (!Number.isFinite(beforeId) || beforeId <= 0) {
      res.status(400).json({ error: 'before (numeric message id) required' });
      return;
    }
    try {
      const dbRows = loadMessagesOlderThan(conversationId, beforeId, limit);
      const messages = formatGatewayHistoryForWebUi(conversationId, dbRows);
      const oldestRaw = dbRows[0]?.id;
      const hasMore = oldestRaw != null && hasMessagesOlderThan(conversationId, oldestRaw);
      res.json({ messages, hasMore });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- I5: Confirm-to-run — execute a heartbeat suggestion ---
  app.post('/api/heartbeat/run', async (req: Request, res: Response) => {
    const { suggestion } = req.body;
    if (!suggestion) { res.status(400).json({ error: 'suggestion text required' }); return; }
    if (!isConfigured()) { res.status(500).json({ error: 'LLM not configured' }); return; }

    const convId = 'vodou-heartbeat';
    ensureConversation(convId, 'Vodou Heartbeat', 'heartbeat', 'Vodou');

    const userMsg = `[User approved] Run this suggestion: ${suggestion}`;
    try { saveMessage(convId, 'user', userMsg); } catch {}

    const hrTurnId = randomUUID();
    hydrateLlmConversationFromDb(convId, userMsg.trim());

    const chunks: string[] = [];
    try {
      await chat(convId, userMsg, (event) => {
        if (event.type === 'text' && event.content) {
          chunks.push(event.content);
          streamToConversation(convId, { type: 'chunk', conversationId: convId, content: event.content });
        }
        if (event.type === 'done') {
          const full = chunks.join('');
          { const txt = full.trim() || '[stream-aborted: no content]'; try { saveMessage(convId, 'assistant', txt.substring(0, 200000)); } catch {} }
          streamToConversation(convId, { type: 'done', conversationId: convId, source: 'heartbeat' });
        }
      }, { turnId: hrTurnId });
      clearChatFailure();
      res.json({ conversationId: convId, response: chunks.join('') });
    } catch (error) {
      recordChatFailure({
        convId,
        turnId: hrTurnId,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // --- Heartbeat directive — read/write HEARTBEAT.md template ---
  app.get('/api/heartbeat/directive', (_req: Request, res: Response) => {
    try {
      const tplPath = path.join(getProjectRoot(), 'templates', 'HEARTBEAT.md');
      const content = fs.readFileSync(tplPath, 'utf-8');
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put('/api/heartbeat/directive', (req: Request, res: Response) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content (string) required' });
        return;
      }
      const tplPath = path.join(getProjectRoot(), 'templates', 'HEARTBEAT.md');
      fs.writeFileSync(tplPath, content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Heartbeat task helpers ---

  /**
   * Extract canonical title for dedup — mirrors src/task_ledger.rs::task_title().
   * Rules: first **bold**, first __underscore__, before " — ", before ":", whole line.
   * Then strip emoji/markdown, trim, lowercase.
   */
  function taskTitleForDedup(text: string): string {
    if (!text) return '';
    let s = text.trim().replace(/^-\s*\[[ xX]?\]\s*/, '');

    // Rule 1: **bold**
    const bold = s.match(/\*\*([^*]+)\*\*/);
    if (bold?.[1]?.trim()) return normalizeTaskTitle(bold[1]);

    // Rule 2: __underscore__
    const under = s.match(/__([^_]+)__/);
    if (under?.[1]?.trim()) return normalizeTaskTitle(under[1]);

    // Rule 3: before em-dash
    const dashIdx = s.indexOf(' \u2014 ');
    if (dashIdx > 0) return normalizeTaskTitle(s.slice(0, dashIdx));

    // Rule 4: before colon
    const colonIdx = s.indexOf(':');
    if (colonIdx > 0) return normalizeTaskTitle(s.slice(0, colonIdx));

    return normalizeTaskTitle(s);
  }

  function normalizeTaskTitle(s: string): string {
    return s
      .replace(/[*_`#]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // --- I6: Today strip — task list from latest heartbeat ---
  app.get('/api/heartbeat/tasks', (req: Request, res: Response) => {
    try {
      // Read task ledger if exists
      const ledgerPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'task_ledger.json');
      let tasks: any[] = [];
      try {
        const raw = fs.readFileSync(ledgerPath, 'utf-8');
        const ledger = JSON.parse(raw);
        tasks = (ledger.tasks || []).filter((t: any) => t.status === 'open');
      } catch {}

      // Fallback: parse from latest heartbeat message
      if (tasks.length === 0) {
        const gwDb = getGatewayDb();
        const lastMsg = gwDb.prepare(
          "SELECT content FROM gateway_messages WHERE conversation_id='vodou-heartbeat' AND role='assistant' ORDER BY id DESC LIMIT 1"
        ).get() as any;
        if (lastMsg?.content) {
          for (const line of lastMsg.content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- []')) {
              tasks.push({ text: trimmed.replace(/^- \[[ ]?\]\s*/, ''), status: 'open' });
            } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
              tasks.push({ text: trimmed.replace(/^- \[[xX]\]\s*/, ''), status: 'done' });
            }
          }
        }
      }

      // Deduplicate by title (mirrors task_title() from src/task_ledger.rs)
      const seen = new Set<string>();
      tasks = tasks.filter((t: any) => {
        const key = taskTitleForDedup(t.text || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // A3f: filter stale tasks + cap
      tasks = tasks.filter((t: any) => {
        const staleRuns = t.stale_runs ?? (t.stale === true ? 3 : 0);
        return staleRuns < 3;
      });
      tasks.sort((a: any, b: any) => (b.last_seen_run || 0) - (a.last_seen_run || 0));
      tasks = tasks.slice(0, 10);

      res.json(tasks);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/heartbeat/tasks/dismiss — remove a task from the ledger
  app.post('/api/heartbeat/tasks/dismiss', (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      if (!text) { res.status(400).json({ error: 'text required' }); return; }

      const ledgerPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'task_ledger.json');
      let remaining = 0;
      withLedgerLock(ledgerPath, (ledger) => {
        if (ledger.tasks) {
          ledger.tasks = ledger.tasks.filter((t: any) => t.text !== text);
          remaining = ledger.tasks.length;
        }
      });

      res.json({ success: true, remaining });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // A3e: GET /api/heartbeat/briefing — latest structured response
  app.get('/api/heartbeat/briefing', (_req: Request, res: Response) => {
    try {
      const messages = loadRecentMessages('vodou-heartbeat', 10) ?? [];
      const latest = [...messages].reverse().find(m =>
        m.role === 'assistant' && m.content.trim() !== 'HEARTBEAT_OK'
      );
      if (!latest) return res.json(null);
      res.json({ content: latest.content, timestamp: latest.created_at.replace(' ', 'T') + 'Z' });
    } catch { res.json(null); }
  });

  // A3e: PUT /api/heartbeat/tasks/complete
  app.put('/api/heartbeat/tasks/complete', (req: Request, res: Response) => {
    const { text } = req.body;
    const ledgerPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'task_ledger.json');
    try {
      const targetTitle = taskTitleForDedup(text || '');
      withLedgerLock(ledgerPath, (ledger) => {
        for (const task of ledger.tasks || []) {
          // Match by title so all duplicate entries get marked done
          if (taskTitleForDedup(task.text || '') === targetTitle) {
            task.status = 'done';
            task.stale_runs = 0;
          }
        }
      });
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });

  // A3e: POST /api/heartbeat/feedback
  app.post('/api/heartbeat/feedback', (req: Request, res: Response) => {
    const { run, reaction } = req.body;
    const fbPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'heartbeat_feedback.json');
    try {
      const data: any[] = fs.existsSync(fbPath) ? JSON.parse(fs.readFileSync(fbPath, 'utf8')) : [];
      data.push({ run, reaction, timestamp: new Date().toISOString() });
      while (data.length > 50) data.shift();
      fs.writeFileSync(fbPath, JSON.stringify(data, null, 2));
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });

  // --- H6: Heartbeat metrics ---
  app.get('/api/heartbeat/stats', (req: Request, res: Response) => {
    try {
      const db = getDb();
      const today = new Date().toISOString().slice(0, 10);

      // Runs today
      const runsToday = (db.prepare(
        "SELECT COUNT(*) as c FROM work_logs WHERE message LIKE '%heartbeat%' AND timestamp LIKE ?"
      ).get(`${today}%`) as any)?.c || 0;

      // Total runs
      const totalRuns = (db.prepare(
        "SELECT COUNT(*) as c FROM work_logs WHERE message LIKE '%heartbeat%'"
      ).get() as any)?.c || 0;

      // Failures today
      const failuresToday = (db.prepare(
        "SELECT COUNT(*) as c FROM work_logs WHERE message LIKE '%heartbeat%' AND (message LIKE '%fail%' OR message LIKE '%error%' OR message LIKE '%timeout%') AND timestamp LIKE ?"
      ).get(`${today}%`) as any)?.c || 0;

      // Last run
      const lastRun = db.prepare(
        "SELECT timestamp, message, metadata FROM work_logs WHERE message LIKE '%heartbeat%' ORDER BY timestamp DESC LIMIT 1"
      ).get() as any;

      // Avg response time from metadata
      const recentRuns = db.prepare(
        "SELECT metadata FROM work_logs WHERE message LIKE '%heartbeat%' AND metadata IS NOT NULL ORDER BY timestamp DESC LIMIT 20"
      ).all() as any[];
      let avgMs = 0;
      let avgChars = 0;
      let count = 0;
      for (const r of recentRuns) {
        try {
          const m = JSON.parse(r.metadata);
          if (m.elapsed_ms) { avgMs += m.elapsed_ms; count++; }
          if (m.response_chars) avgChars += m.response_chars;
        } catch {}
      }
      if (count > 0) { avgMs = Math.round(avgMs / count); avgChars = Math.round(avgChars / count); }

      // Consecutive failures
      let consecutiveFailures = 0;
      try {
        const fp = fs.readFileSync(
          path.join(getProjectRoot(), '.vodou', 'workspace', 'heartbeat_failures.json'), 'utf-8'
        );
        consecutiveFailures = JSON.parse(fp).consecutive_failures || 0;
      } catch {}

      // Task info
      const task = db.prepare(
        "SELECT run_count, next_run_at, last_run_at, enabled FROM scheduled_tasks WHERE name = 'vodou-heartbeat'"
      ).get() as any;

      res.json({
        runsToday,
        totalRuns,
        failuresToday,
        failureRate: totalRuns > 0 ? Math.round((failuresToday / runsToday) * 100) / 100 : 0,
        consecutiveFailures,
        avgResponseMs: avgMs,
        avgResponseChars: avgChars,
        lastRun: lastRun ? { timestamp: lastRun.timestamp, message: lastRun.message } : null,
        task: task ? { runCount: task.run_count, nextRunAt: task.next_run_at, lastRunAt: task.last_run_at, enabled: !!task.enabled } : null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Thinking session API ---

  // GET /api/thinking/recent — list recent thinking sessions
  app.get('/api/thinking/recent', (req: Request, res: Response) => {
    const tdb = getThinkingDb();
    if (!tdb) { res.status(503).json({ error: 'thinking.db not available' }); return; }

    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const sessions = tdb.prepare(
        `SELECT s.session_id, s.topic, s.status, s.created_at, s.completed_at,
                COUNT(t.id) as thought_count
         FROM thinking_sessions s
         LEFT JOIN thoughts t ON t.session_id = s.session_id
         GROUP BY s.session_id
         ORDER BY s.created_at DESC
         LIMIT ?`
      ).all(limit) as any[];

      res.json(sessions.map((s: any) => ({
        id: s.session_id,
        topic: s.topic,
        status: s.status,
        thoughtCount: s.thought_count,
        createdAt: s.created_at,
        completedAt: s.completed_at,
      })));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET /api/thinking/:sessionId — retrieve a completed thinking session
  app.get('/api/thinking/:sessionId', (req: Request, res: Response) => {
    const sessionId = decodeURIComponent(req.params.sessionId || '');
    if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }

    const tdb = getThinkingDb();
    if (!tdb) { res.status(503).json({ error: 'thinking.db not available' }); return; }

    try {
      const session = tdb.prepare(
        'SELECT session_id, topic, status, created_at, completed_at, metadata FROM thinking_sessions WHERE session_id = ?'
      ).get(sessionId) as any;

      if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

      const thoughts = tdb.prepare(
        `SELECT thought_number, thought_text, total_thoughts, is_revision, revises_thought,
                branch_from_thought, branch_id, next_thought_needed, created_at
         FROM thoughts WHERE session_id = ? ORDER BY thought_number ASC`
      ).all(sessionId) as any[];

      let metadata = null;
      try { metadata = session.metadata ? JSON.parse(session.metadata) : null; } catch {}

      res.json({
        session: {
          id: session.session_id,
          topic: session.topic,
          status: session.status,
          createdAt: session.created_at,
          completedAt: session.completed_at,
          metadata,
        },
        thoughts: thoughts.map((t: any) => ({
          number: t.thought_number,
          text: t.thought_text,
          totalThoughts: t.total_thoughts,
          isRevision: !!t.is_revision,
          revisesThought: t.revises_thought,
          branchFromThought: t.branch_from_thought,
          branchId: t.branch_id,
          nextThoughtNeeded: !!t.next_thought_needed,
          createdAt: t.created_at,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Delete a gateway chat tab conversation (SQLite + in-memory + workflow + skill cache)
  app.delete('/api/gateway/conversation/:conversationId', (req: Request, res: Response) => {
    const conversationId = decodeURIComponent(req.params.conversationId || '');
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    try {
      deleteGatewayConversation(conversationId);
    } catch (e) {
      console.error('[Gateway] deleteGatewayConversation:', e);
    }
    try {
      clearConversation(conversationId);
    } catch (e) {
      console.error('[Gateway] clearConversation:', e);
    }
    skillConversations.delete(conversationId);
    if (persistentConversationId === conversationId) {
      persistentConversationId = randomUUID();
    }
    res.json({ ok: true });
  });

  // Recently closed (soft-deleted) chats — powers the tab strip's restore menu.
  // Empty conversations are omitted (nothing to restore), and so are
  // conversations the tab UI never surfaces (mirrors the skip rules in
  // chat.js _hydrateTabsFromDb): workbench-scoped, per-task board workers,
  // and curriculum practice runs — the user never "closed" those as tabs.
  const neverATab = (c: { id: string; source?: string }): boolean => {
    const src = c.source || '';
    if ((src.startsWith('workbench:') || c.id.startsWith('workbench:')) && !c.id.startsWith('workbench:channel:')) return true;
    if (c.id.startsWith('board-task-') || c.id.startsWith('workbench:board-worker:')) return true;
    if (src === 'curriculum' || c.id.startsWith('curriculum-practice-')) return true;
    return false;
  };
  app.get('/api/gateway/conversations/recently-closed', (_req: Request, res: Response) => {
    try {
      const conversations = listRecentlyClosedConversations(20)
        .filter(c => !neverATab(c))
        .map(c => ({
          id: c.id,
          title: c.title,
          source: c.source || 'web',
          senderName: c.sender_name,
          deletedAt: c.deleted_at,
          messageCount: getMessageCount(c.id),
        }))
        .filter(c => c.messageCount > 0);
      res.json({ conversations });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Undo a tab close — clears deleted_at (messages were never deleted).
  // In-memory LLM context re-seeds from gateway.db on the next message via
  // hydrateLlmConversationFromDb, so the conversation resumes with history.
  app.post('/api/gateway/conversation/:conversationId/restore', (req: Request, res: Response) => {
    const conversationId = decodeURIComponent(req.params.conversationId || '');
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    try {
      restoreGatewayConversation(conversationId);
      const conv = getConversation(conversationId);
      if (!conv) {
        res.status(404).json({ error: 'conversation not found' });
        return;
      }
      res.json({
        ok: true,
        conversation: { id: conv.id, title: conv.title, source: conv.source || 'web' },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ─────────────── PLAN-GATEWAY-PROJECTS — Projects REST API ───────────────
  // A project = a pointer to a working directory. Adding one writes nothing into
  // that directory; the brain (servers/creds/daemon/memory) stays shared. Mutating
  // verbs are covered by the same CSRF/Host guards as /chat.

  app.get('/api/projects', (req: Request, res: Response) => {
    try {
      const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
      res.json({ projects: listProjects(includeArchived) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Validate a candidate directory + read an existing instructions doc (for the
  // create-form pre-fill). Read-only probe; creates nothing.
  app.get('/api/projects/detect', (req: Request, res: Response) => {
    const rootPath = typeof req.query.root_path === 'string' ? req.query.root_path.trim() : '';
    if (!rootPath) { res.status(400).json({ valid: false, error: 'root_path required' }); return; }
    try {
      const resolved = path.resolve(rootPath);
      let isDir = false;
      try { isDir = fs.statSync(resolved).isDirectory(); } catch { isDir = false; }
      if (!isDir) { res.json({ valid: false, isDir: false, resolved }); return; }
      const doc = detectProjectDoc(resolved);
      res.json({
        valid: true,
        isDir: true,
        resolved,
        instructionsSource: doc?.source,
        instructions: doc?.instructions,
      });
    } catch (e) {
      res.status(500).json({ valid: false, error: (e as Error).message });
    }
  });

  app.post('/api/projects', (req: Request, res: Response) => {
    const { name, root_path, instructions, color } = req.body || {};
    try {
      const proj = createProject({ name, rootPath: root_path, instructions, color });
      res.json({ project: proj });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.put('/api/projects/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const { name, root_path, instructions, color } = req.body || {};
    try {
      const patch: { name?: string; rootPath?: string; instructions?: string | null; color?: string | null } = {};
      if (name !== undefined) patch.name = name;
      if (root_path !== undefined) patch.rootPath = root_path;
      if (instructions !== undefined) patch.instructions = instructions;
      if (color !== undefined) patch.color = color;
      const proj = updateProject(id, patch);
      if (!proj) { res.status(404).json({ error: 'project not found' }); return; }
      res.json({ project: proj });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/projects/:id', (req: Request, res: Response) => {
    try {
      archiveProject(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get('/api/projects/:id/conversations', (req: Request, res: Response) => {
    try {
      res.json({ conversations: loadConversationsByProject(req.params.id) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Per-project skill set (PLAN-PROJECT-SCOPED-DOCK Phase 1). Curate-down: an
  // empty set = uncurated = the dock shows all skills for that project.
  app.get('/api/projects/:id/skills', (req: Request, res: Response) => {
    try {
      res.json({ skills: listProjectSkills(req.params.id) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  app.put('/api/projects/:id/skills', (req: Request, res: Response) => {
    try {
      const skills = setProjectSkills(req.params.id, (req.body || {}).skills);
      res.json({ skills });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Claude CLI auth status for the chat "Reconnect" banner
  // (PLAN-CLAUDE-RECONNECT-BANNER). `ok=false` only when the active provider is
  // claude-cli AND a real turn / warmup probe found it signed out.
  app.get('/api/claude-auth/status', (_req: Request, res: Response) => {
    try {
      const provider = getAuthType();
      if (provider !== 'claude-cli') {
        res.json({ provider, ok: true, message: null });
        return;
      }
      const st = getClaudeCliAuthState();
      res.json({ provider, ok: st.ok, message: st.ok ? null : (st.message || null) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Opt-in disk-sync (PLAN §4a.3) — writes instructions to the existing
  // CLAUDE.md/AGENTS.md/.vodou/project.md, else creates .vodou/project.md.
  app.post('/api/projects/:id/save-instructions', (req: Request, res: Response) => {
    try {
      const written = saveInstructionsToDisk(req.params.id);
      res.json({ written });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Static files (dashboard SPA)
  const publicDir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(publicDir)) {
    console.error(`[FATAL] Public directory not found: ${publicDir}`);
    console.error(`  Expected at: ${path.resolve(publicDir)}`);
    console.error(`  Gateway cannot serve the web UI without it.`);
    console.error(`  Fix: Re-extract the Vodou archive or check your installation.`);
  }
  app.use(
    express.static(publicDir, {
      // View scripts AND stylesheets are edited often; avoid stale Apps / SPA
      // chunks after deploy. Without no-cache on /public/css/, a ?v= bump only
      // helps after a hard reload (the cause of repeated "still looks the same"
      // on CSS-only changes) — now normal reloads revalidate CSS too.
      setHeaders(res, filePath) {
        const isViewAsset =
          (filePath.endsWith('.js') && filePath.includes(`${path.sep}public${path.sep}js${path.sep}`)) ||
          (filePath.endsWith('.css') && filePath.includes(`${path.sep}public${path.sep}css${path.sep}`));
        if (isViewAsset) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
      },
    }),
  );

  // Serve node_modules for xterm.js (browser ESM imports)
  const nodeModulesDir = path.join(__dirname, '..', 'node_modules');
  app.use('/node_modules', express.static(nodeModulesDir));

  // Fallback to index.html for SPA routing
  app.get('/', (req: Request, res: Response) => {
    const indexPath = path.resolve(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      // Force the browser to re-fetch index.html on every load. Without
      // this, browser HTTP caches keep serving a stale index.html that
      // references a stale chat.js?v=NN, and the `?v=NN` cache-bust we
      // use for chat.js never takes effect — users see a frozen UI
      // until they manually clear cache. The asset files (chat.js, css)
      // still cache normally; only the entry-point HTML is forced fresh.
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.sendFile(indexPath);
    } else {
      res.status(500).send(`<h1>Vodou Gateway</h1><p>Web UI not found at: ${indexPath}</p><p>Re-extract the Vodou archive or run <code>./start-vodou-services.sh</code> from the install directory.</p>`);
    }
  });

  return app;
}

/** Vitest / supertest — full route graph without listening (see tests/chat-post-http.test.ts). */
export function createGatewayApp(): Express {
  return setupExpress();
}

/**
 * Setup WebSocket server for streaming
 */
function setupWebSocket(server: HttpServer): WebSocketServer {
  // Origin allowlist mirrors the HTTP CORS check above. Without this, a
  // malicious website the user visits could open a WS to ws://localhost:8765
  // and pwn the chat session.
  const WS_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  // noServer:true so we can path-dispatch upgrades — `/api/vbb` is owned by
  // mountBridgeWss (with its own chrome-extension:// origin allowlist) and
  // everything else goes to this chat WSS. With `{ server }`, ws would attach
  // a global upgrade listener and its verifyClient (localhost-only) would 401
  // bridge connections before vbb ever saw them.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: any, socket: any, head: any) => {
    if (req.url === '/api/vbb') return; // handled by mountBridgeWss
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!WS_ALLOWED_HOSTS.has(u.hostname)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // WS keepalive — detect half-open / silently dropped sockets within 60s
  // (two missed pongs at the 30s tick) and force a real close so cleanup runs
  // and the client's auto-reconnect kicks in. Without this, idle TCP can sit
  // half-open for many minutes during long tool calls (Canva image gen, etc.)
  // and the user sees no response even though the gateway is fine.
  const _keepaliveInterval = setInterval(() => {
    for (const [, c] of clients) {
      const sock = c.ws as any;
      // Drive keepalive off the WebSocket instance — the same object the
      // 'pong' handler flips back to true. Earlier code read c.isAlive on the
      // map entry, which pong never touched, so every connection got
      // terminated on the second 30s tick (~60s after connect) and the
      // client reconnect+history replay looked like a periodic chat reload.
      if (sock.isAlive === false) {
        try { c.ws.terminate(); } catch {}
        // Don't delete here — `ws.on('close')` runs on terminate and cleans up
        continue;
      }
      sock.isAlive = false;
      try { c.ws.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(_keepaliveInterval));

  // Per-conversation chat queue: dedups repeat sends and serializes concurrent
  // turns on the SAME conversation. P0-7 (PLAN-QA-SWEEP-FINDINGS): this must
  // live at server scope, not inside the connection handler — declared
  // per-connection, two tabs on the same conversation each got their own
  // "queue" and ran chat() concurrently, interleaving ConversationManager
  // appends across awaits (corrupt tool_use/tool_result pairing). Keyed by
  // conversation id, so cross-conversation turns still run in parallel.
  const _chatQueue = new Map<string, { promise: Promise<void> | null; lastContent: string; lastTime: number }>();
  const CHAT_QUEUE_STALE_MS = 60 * 60 * 1000;
  const pruneChatQueue = () => {
    if (_chatQueue.size < 256) return;
    const cutoff = Date.now() - CHAT_QUEUE_STALE_MS;
    for (const [k, v] of _chatQueue) {
      if (!v.promise && v.lastTime < cutoff) _chatQueue.delete(k);
    }
  };

  wss.on('connection', (ws: WebSocket) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

    const client: Client = {
      id: clientId,
      ws,
      conversationId: persistentConversationId,
      connectedAt: new Date()
    };

    clients.set(clientId, client);
    console.error(`[Gateway] Client connected: ${clientId}`);

    ws.send(JSON.stringify({
      type: 'connected',
      clientId,
      conversationId: persistentConversationId,
      activeModel: getActiveModelLabel(),
      message: 'Connected to Vodou-Console'
    }));

    // Replay conversation history from DB — source of truth for all messages.
    // UI history only. LLM context is seeded via hydrateLlmConversationFromDb → loadMessages (not llm.ts).
    let historyMessages: Array<{ role: string; text: string; timestamp?: string; id?: number; senderLabel?: string }> = [];
    let hasMore = false;
    try {
      const dbMessages = loadRecentMessages(persistentConversationId, UI_CHAT_HISTORY_PAGE_SIZE);
      hasMore = historyPageHasOlder(persistentConversationId, dbMessages);
      historyMessages = formatGatewayHistoryForWebUi(persistentConversationId, dbMessages);
    } catch {}
    // Always send history event (empty array = no history = show welcome)
    ws.send(JSON.stringify({
      type: 'history',
      conversationId: persistentConversationId,
      messages: historyMessages,
      hasMore,
    }));

    // Send recent conversations from DB so client can hydrate tabs on fresh connect
    // Only last 7 days to prevent stale tabs from accumulating
    try {
      const allConversations = loadConversations()
        .filter(c => {
          if (!c.updated_at) return false;
          const age = Date.now() - new Date(c.updated_at.replace(' ', 'T') + 'Z').getTime();
          return age < 7 * 24 * 60 * 60 * 1000; // 7 days
        });
      ws.send(JSON.stringify({
        type: 'conversations_list',
        conversations: allConversations.map(c => ({
          id: c.id,
          title: c.title,
          source: c.source || 'web',
          senderName: c.sender_name,
          updatedAt: c.updated_at,
          messageCount: getMessageCount(c.id),
          project_id: c.project_id ?? null,
        })),
      }));
    } catch {}

    ws.on('message', async (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        // ─── Resume buffered stream after reconnect ──────────────────────────
        // Client sends `{type:'resume', conversationId, lastSeq}` after an
        // auto-reconnect. We replay any events with seq > lastSeq from the
        // per-conversation buffer so the user gets the in-flight tool result
        // they would otherwise have lost.
        if (parsed.type === 'resume' && typeof parsed.conversationId === 'string') {
          const lastSeq = Number(parsed.lastSeq) || 0;
          const replayed = replayConversation(ws, parsed.conversationId, lastSeq);
          if (replayed > 0) {
            console.error(`[Gateway] Replayed ${replayed} buffered events to ${clientId} (conv ${parsed.conversationId}, fromSeq=${lastSeq})`);
          }
          return;
        }

        if (parsed.type === 'message' && parsed.content) {
          // Check if configured
          if (!isConfigured()) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'API not configured. Add your credentials at /settings.'
            }));
            return;
          }

          // Use provided conversationId or client's default
          const convId = parsed.conversationId || client.conversationId;

          // Web file drops travel as `attachments: [{ url, filename, mimeType, type }]`
          // — same shape as the REST /chat endpoint already supports. The gateway
          // reads files at `url` (local /tmp path) and converts them into provider-
          // specific image_url/document content blocks. Without this, vision-capable
          // providers (Fireworks Kimi K2.6, Claude, GPT-4o, etc.) only see the
          // textual `[User dropped image: ... at /tmp/...]` reference and can't
          // actually see the image.
          const wsAttachmentList: ChannelAttachmentMeta[] = Array.isArray(parsed.attachments)
            ? (parsed.attachments as ChannelAttachmentMeta[]).filter(
                (a) => a && typeof a.url === 'string' && a.url.trim(),
              )
            : [];

          // --- Dedup + mutex: drop duplicate messages, serialize concurrent ones ---
          pruneChatQueue();
          let entry = _chatQueue.get(convId);
          if (!entry) {
            entry = { promise: null, lastContent: '', lastTime: 0 };
            _chatQueue.set(convId, entry);
          }
          const now = Date.now();
          if (parsed.content === entry.lastContent && (now - entry.lastTime) < 500) {
            console.error(`[Dedup] Dropping duplicate message for ${convId}: "${parsed.content.substring(0, 40)}"`);
            return;
          }
          entry.lastContent = parsed.content;
          entry.lastTime = now;

          // Wait for any in-flight chat to finish before starting this one
          const prev = entry.promise;
          const chatPromise = (async () => {
            if (prev) await prev.catch(() => {});

            client.activeConvId = convId;
            client.aborted = false;

            // PLAN-GATEWAY-PROJECTS — resolve the active project for this WS turn.
            // A stored project on the conversation wins; otherwise the client's
            // parsed.project_id binds a brand-new web conversation at first message.
            const storedProjId = getConversation(convId)?.project_id || null;
            const wsProjIdRaw = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
            const wsProj = getProject(storedProjId || wsProjIdRaw || '');
            if (wsProj && !storedProjId && !convId.startsWith('workbench:')) {
              try { ensureConversation(convId, undefined, 'web', undefined, wsProj.id); } catch { /* best-effort */ }
            }

            // Save user message to DB (clean version without Vodou tags, unless debug mode)
            const cleanContent = (showRawResults() ? parsed.content : parsed.content
              .replace(/<oi_results>[\s\S]*?<\/oi_results>[^]*/s, ''))
              .replace(/<file[^>]*>[\s\S]*?<\/file>/g, '[file attached]')
              .substring(0, 10000)
              .trim();
            if (cleanContent) {
              try { saveMessage(convId, 'user', cleanContent); } catch {}
            }

            // Track assistant response for DB save
            let assistantFullText = '';

            // Resolve scope from conversation.source — workbench tabs (integration,
            // channel, skill, …). Unified channel ids `workbench:channel:*` parse here too.
            const scope = resolveScope(getConversation(convId)?.source);

            const gwDb = getGatewayDb();
            const skillBindingWs = lookupSkillBinding(gwDb, convId);
            const skillActiveWs = !!(skillBindingWs && skillBindingWs.is_active === 1);
            let slashInputWs = parsed.content.trim();
            let runOverridesWs: Record<string, string> = {};
            if (skillBindingWs && skillActiveWs) {
              const rpWs = parseRunCommand(slashInputWs);
              if (rpWs) {
                runOverridesWs = rpWs.overrides;
                slashInputWs = rpWs.rest;
              }
            }
            let promptForLlm = parsed.content;
            let preferModelWs: string | null = null;
            if (skillBindingWs) {
              const slashWs = await handleSlashCommand(
                gwDb,
                skillBindingWs,
                convId,
                skillActiveWs ? slashInputWs : parsed.content.trim(),
              );
              if (slashWs) {
                try { saveMessage(convId, 'assistant', slashWs.response.substring(0, 200000)); } catch {}
                if (slashWs.skillRefreshed) {
                  for (const c of clients.values()) {
                    if (c.ws.readyState === 1) {
                      try {
                        c.ws.send(
                          JSON.stringify({
                            type: 'skill_console_updated',
                            conversationId: convId,
                            skillId: skillBindingWs.id,
                            skillName: skillBindingWs.name,
                          }),
                        );
                      } catch { /* */ }
                    }
                  }
                }
                streamToConversation(convId, { type: 'chunk', content: slashWs.response });
                const memoriesSlash = getLastMemoryUsed(convId);
                streamToConversation(convId, {
                  type: 'done',
                  activeModel: getActiveModelLabel(),
                  usage: undefined,
                  memory: {
                    used: memoriesSlash.length,
                    total: getTotalMemoryCount(),
                    items: memoriesSlash.slice(0, 5),
                    debug: getLastMemoryDebug(convId),
                  },
                });
                client.activeConvId = undefined;
                return;
              }
              const preparedWs = await prepareSkillConsoleForLlm(
                gwDb,
                convId,
                skillBindingWs,
                skillActiveWs,
                slashInputWs,
                runOverridesWs,
                parsed.content,
              );
              promptForLlm = preparedWs.renderedPrompt;
              preferModelWs = preparedWs.preferModel;
            }

            // Stream response — every event goes through streamToConversation so
            // it's buffered for resume after a transient WS drop (idle timeout
            // during long tool calls, network blips). Replay handler in
            // ws.on('message') for type='resume' replays from the buffer.
            const wsTurnId = randomUUID();
            hydrateLlmConversationFromDb(convId, cleanContent || undefined);
            // PLAN-SKILL-LEARNING-LOOP 1A — the web UI chats over WebSocket (not
            // POST /chat), so backfill the previous turn's trajectory signal from
            // this user message here too. Use the RAW user content (parsed.content),
            // not the rendered promptForLlm. Best-effort.
            if (parsed.content) { try { backfillUserSignal(convId, parsed.content); } catch { /* ignore */ } }
            try {
            await chat(convId, promptForLlm, (event) => {
            // If user hit stop, swallow remaining events
            if (client.aborted) return;

            switch (event.type) {
              case 'text':
                assistantFullText += event.content || '';
                streamToConversation(convId, { type: 'chunk', content: event.content });
                break;

              case 'tool_call_start':
                streamToConversation(convId, {
                  type: 'tool_start',
                  tool: event.toolName,
                  toolId: event.toolId,
                  server: event.serverName,
                  args: event.toolArgs,
                });
                break;

              case 'tool_call_end':
                streamToConversation(convId, {
                  type: 'tool_end',
                  tool: event.toolName,
                  toolId: event.toolId,
                  result: event.toolResult,
                  executionTime: event.executionTime,
                  success: event.success,
                });
                break;

              case 'usage':
                streamToConversation(convId, { type: 'usage', usage: event.usage });
                break;

              case 'status':
                streamToConversation(convId, { type: 'status', status: event.status });
                break;

              case 'error':
                streamToConversation(convId, { type: 'error', message: event.error });
                break;

              case 'done':
                // Save assistant response — even empty (stream-aborted marker)
                // so the extractor sees a paired turn.
                {
                  const txt = assistantFullText.trim() || '[stream-aborted: no content]';
                  try { saveMessage(convId, 'assistant', txt.substring(0, 200000)); } catch {}
                }
                // Track API usage/cost
                if (event.usage) {
                  saveUsage(convId, getActiveModelLabel(), event.usage.model || '', event.usage);
                }
                const memoriesUsed = getLastMemoryUsed(convId);
                streamToConversation(convId, {
                  type: 'done',
                  activeModel: getActiveModelLabel(),
                  usage: event.usage,
                  memory: {
                    used: memoriesUsed.length,
                    total: getTotalMemoryCount(),
                    items: memoriesUsed.slice(0, 5),
                    // PLAN-MEMORY-VISIBILITY-UI Phase B.2 — structured per-chunk debug.
                    debug: getLastMemoryDebug(convId),
                  },
                });
                if (skillBindingWs && skillActiveWs) {
                  const finalTxt = assistantFullText.trim();
                  if (finalTxt && (skillBindingWs.delivery_mode === 'channel' || skillBindingWs.delivery_mode === 'broadcast')) {
                    const target = parseDeliveryTarget(skillBindingWs.delivery_target);
                    if (target) forwardToChannel(target.source, target.recipient, finalTxt);
                  }
                  if (skillBindingWs.ephemeral === 1) {
                    disableEphemeralSkill(gwDb, skillBindingWs.id);
                  }
                  if (skillBindingWs.on_complete_hook?.trim() && finalTxt) {
                    const parent = skillBindingWs;
                    const prior = finalTxt;
                    void (async () => {
                      try {
                        const hookChunks: string[] = [];
                        await runSkillConsoleCompletionHook(
                          gwDb,
                          convId,
                          parent,
                          prior,
                          (ev) => {
                            if (ev.type === 'text' && ev.content) {
                              hookChunks.push(ev.content);
                              streamToConversation(convId, { type: 'chunk', content: ev.content });
                            }
                            if (ev.type === 'done') {
                              const htxt = hookChunks.join('').trim() || '[stream-aborted: no content]';
                              try { saveMessage(convId, 'assistant', htxt.substring(0, 200000)); } catch {}
                              if (ev.usage) {
                                saveUsage(convId, getActiveModelLabel(), ev.usage.model || '', ev.usage);
                              }
                              const memH = getLastMemoryUsed(convId);
                              streamToConversation(convId, {
                                type: 'done',
                                activeModel: getActiveModelLabel(),
                                usage: ev.usage,
                                memory: {
                                  used: memH.length,
                                  total: getTotalMemoryCount(),
                                  items: memH.slice(0, 5),
                                  debug: getLastMemoryDebug(convId),
                                },
                              });
                            }
                          },
                          {
                            beforeChat: (childName) => {
                              try {
                                saveMessage(
                                  convId,
                                  'user',
                                  `[completion hook → ${childName}]`.substring(0, 10000),
                                );
                              } catch { /* */ }
                            },
                          },
                        );
                      } catch (e) {
                        console.error('[SkillConsole] WS completion hook failed:', (e as Error).message);
                      }
                    })();
                  }
                }
                // Forward response to external channel if this is a channel conversation
                // Uses channel API tokens directly (reads from Vodou-channels .env)
                // Also forwards web chat messages to Slack default channel
                console.error(`[Gateway] Done event — assistantFullText length: ${assistantFullText.trim().length}, convId: ${convId}`);
                if (assistantFullText.trim()) {
                  try {
                    const conv = getConversation(convId);
                    console.error(`[Gateway] Forward check — conv source: ${conv?.source}, convId: ${convId}`);
                    if (conv?.source && conv.source !== 'web') {
                      // Channel conversation — forward back to originating channel.
                      // Skip auto-forward for ANY workbench:* convId — those are
                      // panels where the user is talking TO Vodou ABOUT the
                      // integration/channel/skill/etc., not broadcasting to it.
                      // The previous guard only caught `workbench:channel:*` and
                      // missed `workbench:integration:*`, which caused the chat
                      // response to be emitted twice (once via WS stream, once
                      // via the channel forwarder).
                      if (convId.startsWith('workbench:')) {
                        console.error(`[Gateway] Workbench conv (${convId.split(':').slice(0,2).join(':')}:*) — no auto-forward`);
                      } else {
                        const parts = convId.split(':');
                        const recipient = parts.length > 1 ? parts.slice(1).join(':') : '';
                        if (recipient) {
                          console.error(`[Gateway] Forwarding to ${conv.source} channel: ${recipient}`);
                          forwardToChannel(conv.source, recipient, assistantFullText.trim());
                        }
                      }
                    } else {
                      // Web conversation — standalone, no channel forwarding
                      console.error(`[Gateway] Web conv — standalone, skipping channel forward`);
                    }
                  } catch (e) { console.error(`[Gateway] Forward error:`, e); }
                }
                client.activeConvId = undefined;
                break;
            }
          }, { scope, ...(preferModelWs ? { preferModel: preferModelWs } : {}), ...(wsAttachmentList.length ? { channelAttachments: wsAttachmentList } : {}), turnId: wsTurnId, ...(wsProj ? { projectId: wsProj.id, projectRoot: wsProj.rootPath, projectName: wsProj.name, projectInstructions: resolveProjectInstructions(wsProj.id) } : {}) });
            clearChatFailure();
            } catch (chatErr) {
              recordChatFailure({
                convId,
                turnId: wsTurnId,
                error: chatErr instanceof Error ? chatErr.message : String(chatErr),
                at: new Date().toISOString(),
              });
              throw chatErr;
            }
          })(); // end chatPromise async wrapper
          entry.promise = chatPromise;
          // Release the slot once settled (only if a newer turn hasn't replaced
          // it) so pruneChatQueue can collect idle conversations.
          chatPromise.catch(() => {}).finally(() => {
            if (entry.promise === chatPromise) entry.promise = null;
          });
          await chatPromise;

        } else if (parsed.type === 'skill_message' && parsed.content) {
          // Skill Runner — guided skill execution. Two surfaces use this:
          //   1. Floating SkillRunner panel — convId = 'skill-<ts>' (ephemeral)
          //   2. Persona/skill TAB — convId = 'workbench:skill:<name>' (stable)
          const convId = parsed.conversationId || 'skill-' + randomUUID();
          client.activeConvId = convId;
          client.aborted = false;

          // Store skill content on first message, retrieve on follow-ups
          if (parsed.skillContent) {
            skillConversations.set(convId, parsed.skillContent);
          }
          let skillContent = skillConversations.get(convId);

          // Disk fallback for stable workbench:skill:<name> convIds — covers
          // server restart (in-memory map cleared) and tab reload (client may
          // not re-ship skillContent on every message). Looks up SKILL.md via
          // skills_registry and re-populates the in-memory map.
          if (!skillContent && convId.startsWith('workbench:skill:')) {
            const skillName = convId.slice('workbench:skill:'.length);
            try {
              const row = getDb()
                .prepare('SELECT file_path FROM skills_registry WHERE name = ?')
                .get(skillName) as { file_path: string } | undefined;
              if (row?.file_path) {
                const root = getProjectRoot();
                const isAbs = row.file_path.startsWith('/');
                const candidates = [
                  isAbs ? row.file_path : `${root}/skills/${row.file_path}`,
                  isAbs ? row.file_path : `${root}/${row.file_path}`,
                ];
                for (const p of candidates) {
                  try {
                    const fs = await import('fs');
                    skillContent = fs.readFileSync(p, 'utf-8');
                    skillConversations.set(convId, skillContent);
                    console.error(`[Gateway] skill_message: disk-loaded SKILL.md for ${convId} (${skillContent.length} chars)`);
                    break;
                  } catch {}
                }
              }
            } catch (err) {
              console.error('[Gateway] skill_message: disk fallback failed:', err);
            }
          }

          if (!skillContent) {
            streamToConversation(convId, { type: 'error', conversationId: convId, message: 'No skill content for this conversation' });
            return;
          }

          // Save user message to DB
          const cleanContent = parsed.content.substring(0, 10000).trim();
          if (cleanContent) {
            try { ensureConversation(convId, parsed.skillName || convId.replace(/^workbench:skill:/, '') || 'Skill'); } catch {}
            try { saveMessage(convId, 'user', cleanContent); } catch {}
          }

          let assistantFullText = '';

          const skTurnId = randomUUID();
          hydrateLlmConversationFromDb(convId, cleanContent || undefined);
          try {
            await chatWithSkill(convId, parsed.content, skillContent, (event) => {
            if (client.aborted) return;

            switch (event.type) {
              case 'text':
                assistantFullText += event.content || '';
                streamToConversation(convId, { type: 'chunk', conversationId: convId, content: event.content });
                break;
              case 'tool_call_start':
                streamToConversation(convId, { type: 'tool_start', conversationId: convId, tool: event.toolName, toolId: event.toolId, server: event.serverName, args: event.toolArgs });
                break;
              case 'tool_call_end':
                streamToConversation(convId, { type: 'tool_end', conversationId: convId, tool: event.toolName, toolId: event.toolId, result: event.toolResult, executionTime: event.executionTime, success: event.success });
                break;
              case 'usage':
                streamToConversation(convId, { type: 'usage', conversationId: convId, usage: event.usage });
                break;
              case 'error':
                streamToConversation(convId, { type: 'error', conversationId: convId, message: event.error });
                break;
              case 'done':
                {
                  const txt = assistantFullText.trim() || '[stream-aborted: no content]';
                  try { saveMessage(convId, 'assistant', txt.substring(0, 200000)); } catch {}
                }
                streamToConversation(convId, { type: 'done', conversationId: convId, usage: event.usage });
                client.activeConvId = undefined;
                break;
            }
          }, skTurnId);
            clearChatFailure();
          } catch (skErr) {
            recordChatFailure({
              convId,
              turnId: skTurnId,
              error: skErr instanceof Error ? skErr.message : String(skErr),
              at: new Date().toISOString(),
            });
            throw skErr;
          }

        } else if (parsed.type === 'switch_conversation') {
          // Switch to an existing or new conversation
          const targetId = parsed.conversationId || randomUUID();
          client.conversationId = targetId;

          // Always load from DB — it's the source of truth.
          // UI history only. LLM context is seeded via hydrateLlmConversationFromDb → loadMessages (not llm.ts).
          let switchMessages: Array<{ role: string; text: string; timestamp?: string; id?: number; senderLabel?: string }> = [];
          let switchHasMore = false;
          try {
            const dbMessages = loadRecentMessages(targetId, UI_CHAT_HISTORY_PAGE_SIZE);
            switchHasMore = historyPageHasOlder(targetId, dbMessages);
            switchMessages = formatGatewayHistoryForWebUi(targetId, dbMessages);
          } catch {}

          // Handle title updates from client
          if (parsed.title) {
            try { updateConversationTitle(targetId, parsed.title); } catch {}
          }

          ws.send(JSON.stringify({
            type: 'history',
            conversationId: targetId,
            messages: switchMessages,
            hasMore: switchHasMore,
          }));

          // Pre-warm Claude CLI session so first message has no cold start
          warmupCliSession(targetId);
          hydrateLlmConversationFromDb(targetId);

        } else if (parsed.type === 'update_title') {
          if (parsed.conversationId && parsed.title) {
            try { updateConversationTitle(parsed.conversationId, parsed.title); } catch {}
          }

        } else if (parsed.type === 'stop') {
          // User hit the stop button — abort current streaming
          client.aborted = true;
          // B2: actually cancel the provider call (SDK/OpenAI-compat/CLI), not
          // just swallow UI events — otherwise the provider streams to completion
          // and a full usage/cost record is written for a turn the user stopped.
          if (client.activeConvId) abortConversationTurn(client.activeConvId);
          else if (parsed.conversationId) abortConversationTurn(parsed.conversationId);
          client.activeConvId = undefined;
          ws.send(JSON.stringify({ type: 'stopped', conversationId: parsed.conversationId }));
          console.error(`[Gateway] Client ${clientId} stopped streaming`);

        } else if (parsed.type === 'clear') {
          clearConversation(client.conversationId);
          const newId = randomUUID();
          persistentConversationId = newId;
          client.conversationId = newId;
          ws.send(JSON.stringify({
            type: 'cleared',
            conversationId: newId,
            message: 'Conversation cleared'
          }));

        } else if (parsed.type === 'flush') {
          // Browser tab closing — flush memory (equivalent to CLI SessionEnd)
          triggerMemoryFlush();

        } else if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));

        // --- Terminal PTY messages ---
        } else if (parsed.type === 'terminal_start') {
          createTerminal(clientId, ws, undefined, parsed.cols, parsed.rows);

        } else if (parsed.type === 'terminal_input') {
          writeTerminal(clientId, parsed.data);

        } else if (parsed.type === 'terminal_resize') {
          resizeTerminal(clientId, parsed.cols, parsed.rows);
        }

      } catch (error) {
        console.error(`[Gateway] Error processing message:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
        }));
      }
    });

    ws.on('close', () => {
      destroyTerminal(clientId);
      clients.delete(clientId);
      console.error(`[Gateway] Client disconnected: ${clientId}`);
    });

    ws.on('error', (err) => {
      console.error(`[Gateway] WebSocket error for ${clientId}:`, err);
    });
  });

  return wss;
}


/** True when GET /health returns { status: "ok" } on loopback. */
async function probeHealthyGateway(port: number, timeoutMs = 8000): Promise<boolean> {
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    clearTimeout(tm);
    if (!r.ok) return false;
    const j = (await r.json()) as { status?: string };
    return j.status === 'ok';
  } catch {
    return false;
  }
}

function countActiveGatewayChats(): number {
  let n = 0;
  for (const c of clients.values()) {
    if (c.activeConvId) n++;
  }
  return n;
}

const GATEWAY_SHUTDOWN_GRACE_MS = parseInt(
  process.env.VODOU_GATEWAY_SHUTDOWN_GRACE_MS || '45000',
  10,
);

let shutdownScheduled = false;

/**
 * On SIGTERM/SIGINT, wait for in-flight chat turns before closing DB/WS so
 * restarts (start-vodou-services, lsof kill, launchd) don't drop mid-turn.
 * Set VODOU_GATEWAY_SHUTDOWN_GRACE_MS=0 for immediate exit (stack restarts).
 */
function scheduleCleanup(signal?: string) {
  if (shutdownScheduled) return;
  shutdownScheduled = true;
  const active = countActiveGatewayChats();
  const graceful =
    active > 0 &&
    GATEWAY_SHUTDOWN_GRACE_MS > 0 &&
    (signal === 'SIGTERM' || signal === 'SIGINT');
  if (graceful) {
    console.error(
      `[Gateway] ${signal} with ${active} active chat turn(s) — ` +
        `waiting up to ${GATEWAY_SHUTDOWN_GRACE_MS}ms before shutdown (set VODOU_GATEWAY_SHUTDOWN_GRACE_MS=0 to skip)`,
    );
    setTimeout(() => cleanup(signal), GATEWAY_SHUTDOWN_GRACE_MS);
    return;
  }
  cleanup(signal);
}

/**
 * Cleanup on shutdown
 */
function cleanup(signal?: string) {
  const active = countActiveGatewayChats();
  console.error(
    `[Gateway] Shutting down (${signal ?? 'unknown'})...` +
      (active > 0 ? ` (${active} chat turn(s) still marked active)` : ''),
  );

  // Close all WebSocket connections
  for (const client of clients.values()) {
    client.ws.close();
  }
  clients.clear();

  // Kill all terminal sessions
  destroyAllTerminals();

  // Kill all CLI pool sessions before exiting so they get proper poolKillReason='shutdown'
  // and their close handlers don't emit spurious "claude CLI exited with code 143" errors.
  // Required because claude CLI subprocesses are now spawned with detached:true — they
  // survive the gateway's process group signal and must be explicitly cleaned up.
  shutdownCliPool();

  // Close servers
  if (wss) wss.close();
  if (server) server.close();

  // Cleanup conversation manager
  getConversationManager().shutdown();

  // Close database connections — better-sqlite3 db.close() runs WAL checkpoint
  // automatically, ensuring all pending writes are captured in any snapshot taken
  // by the Safe Update System before service restart.
  closeDb();

  // Exit with correct signal code: SIGTERM=143, SIGINT=130
  const code = signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 0;
  process.exit(code);
}

/**
 * Gateway startup + periodic `daemon ensure` / `worker ensure`.
 * Set `VODOU_GATEWAY_AUTO_ENSURE=0` (or `OI_GATEWAY_AUTO_ENSURE`) while swapping
 * `vodou-core` so the gateway does not respawn daemon/worker every 60s.
 */
function gatewayAutoEnsureEnabled(): boolean {
  const v = process.env.VODOU_GATEWAY_AUTO_ENSURE ?? process.env.OI_GATEWAY_AUTO_ENSURE;
  if (v === undefined || v === '') return true;
  const s = String(v).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(s);
}

/**
 * Main entry point
 */
async function main() {
  console.error('=================================');
  console.error('   Vodou-Console Starting...');
  console.error('=================================');

  // Free the listen port before bind. If another **healthy** Vodou gateway
  // already owns it, exit instead of SIGTERM (mirrors start-vodou-services.sh
  // /health guard — see PLANS/joes debugging §F2: a second `node dist/index.js`
  // used to kill a busy first gateway mid-chat).
  try {
    const port = parseInt(process.env.WEB_PORT || '8765', 10);
    const { execSync: ex } = await import('child_process');
    // Find who owns the port, cross-platform. lsof is Unix-only; on Windows the
    // old `lsof … || true` string ran under cmd.exe, which printed "system cannot
    // find the path specified" (/dev/null) + "'true' is not recognized" every
    // startup. netstat is the portable equivalent.
    let stalePids = '';
    try {
      if (process.platform === 'win32') {
        const out = ex('netstat -ano -p tcp', { encoding: 'utf-8' });
        stalePids = out
          .split('\n')
          .filter((l) => l.includes(`:${port} `) && /LISTENING/i.test(l))
          .map((l) => l.trim().split(/\s+/).pop() || '')
          .filter(Boolean)
          .join('\n');
      } else {
        stalePids = ex(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
      }
    } catch {
      stalePids = '';
    }
    const others = stalePids
      ? stalePids
          .split('\n')
          .filter(Boolean)
          .map((p) => parseInt(p, 10))
          .filter((p) => Number.isFinite(p) && p > 0 && p !== process.pid)
      : [];
    if (others.length > 0) {
      const healthyPeer = await probeHealthyGateway(port, 8000);
      const force =
        process.env.VODOU_GATEWAY_FORCE_PORT_RECLAIM === '1' ||
        process.env.VODOU_GATEWAY_FORCE_PORT_RECLAIM === 'true';
      if (healthyPeer && !force) {
        console.error(
          `[Gateway] Port ${port} already has a healthy Vodou gateway (/health). ` +
            `Refusing to start a second instance (would SIGTERM active chats). ` +
            `Stop the other process first, or set VODOU_GATEWAY_FORCE_PORT_RECLAIM=1 to replace it.`,
        );
        // Exit 0 ("no-op success"), not 1. launchd plist uses
        // KeepAlive { SuccessfulExit = false }, so exit 1 here triggers an
        // infinite respawn loop every time a peer is healthy. A healthy peer
        // is not a crash — there's just nothing for us to do.
        process.exit(0);
      }
      for (const pid of others) {
        console.error(`[Gateway] Killing stale process on port ${port} (PID ${pid})`);
        try {
          process.kill(pid, 'SIGTERM');
        } catch { /* */ }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch { /* */ }

  // Initialize auth (detects API key or Claude CLI)
  await initAuth();

  // Wire up memory flush callback for conversation expiry
  setFlushCallback(triggerMemoryFlush);

  // Check configuration
  if (!isConfigured()) {
    console.error('');
    console.error('WARNING: No auth configured!');
    console.error('The gateway will start but chat will not work.');
    console.error('Either set ANTHROPIC_API_KEY or install Claude CLI (claude code max).');
    console.error('');
  }

  // Clean up stale tool result files from previous sessions
  cleanStaleToolResults();

  // Check executor health (v0.5.33.6 - direct vodou-core only)
  const health = await checkExecutorHealth();
  console.error('');
  console.error('Executor Status:');
  console.error(`  vodou-core: ${health.vcAvailable ? 'OK' : 'NOT FOUND'} (${health.vcPath})`);
  if (health.vcPath.includes('brain-trust4')) {
    console.error(
      '[Gateway] WARNING: executor points at brain-trust4 — set VC_PATH or use project-root vodou-core',
    );
  }

  try {
    const srcIndex = path.join(__dirname, '..', 'src', 'index.ts');
    const distIndex = path.join(__dirname, 'index.js');
    if (fs.existsSync(srcIndex) && fs.existsSync(distIndex)) {
      const srcM = fs.statSync(srcIndex).mtimeMs;
      const distM = fs.statSync(distIndex).mtimeMs;
      if (srcM > distM + 1000) {
        console.error(
          '[Gateway] WARNING: dist/ is older than src/ — run: cd MCP-servers/Vodou-Console && npm run build',
        );
      }
    }
  } catch { /* non-fatal */ }

  console.error('');

  // Setup Express and WebSocket
  app = setupExpress();
  server = createServer(app);
  wss = setupWebSocket(server);
  // PLAN-LENSES-MVP — Vodou Bridge extension WebSocket endpoint (/api/vbb)
  mountBridgeWss(server);
  // Card registry — scan src/cards/ + ~/.vodou/cards/ at boot.
  // AWAIT so the system prompt has cards before the first chat() invocation.
  await ensureRegistryLoaded().catch(err => console.warn('[lenses] registry load failed:', err));
  // Lens-cache hourly cleanup
  setInterval(() => {
    try {
      const n = pruneLensCache();
      if (n > 0) console.log(`[lenses] pruned ${n} expired cache entries`);
    } catch (e) { /* ignore */ }
  }, 60 * 60 * 1000);

  // PLAN-LENSES-MANAGEMENT §8 — daily health checks for community lenses.
  // Hits each enabled community lens with a sample URL from its url_patterns
  // and writes the health_status to its installed_lenses row. Banner UX in
  // public/js/views/lenses.js surfaces the result. First tick fires 60s
  // after boot so we don't pile load onto a cold start.
  const runLensHealthChecks = async () => {
    try {
      const { runDailyHealthChecks } = await import('./lenses/health.js');
      const r = await runDailyHealthChecks();
      if (r.checked > 0) console.log(`[lenses] daily health: ${r.healthy} healthy, ${r.stale} stale, ${r.failing} failing (of ${r.checked})`);
    } catch (e: any) { console.warn('[lenses] health check tick failed:', e?.message || e); }
  };
  setTimeout(runLensHealthChecks, 60 * 1000);
  setInterval(runLensHealthChecks, 24 * 60 * 60 * 1000);

  // Ensure daemon + worker sockets are ready (memory search, BrainLoader fast path)
  {
    const bt4 = path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
    const oiDir = path.join(getProjectRoot(), '.vodou');
    const daemonSock = path.join(oiDir, 'daemon.sock');
    const workerSock = path.join(oiDir, 'worker.sock');

    // Clean stale sockets before ensuring (prevents "address in use" failures).
    // Windows: the worker/daemon serve NAMED PIPES (ipc.rs), not .sock files —
    // there is nothing on the filesystem to clean, and the pipe's lifecycle is
    // owned by the Rust listener (first_pipe_instance). Skip entirely on win32.
    if (process.platform !== 'win32') {
      for (const sock of [daemonSock, workerSock]) {
        if (fs.existsSync(sock)) {
          try {
            // Quick connect test — if it fails, socket is stale
            const net = await import('net');
            await new Promise<void>((resolve, reject) => {
              const c = net.createConnection(sock);
              const timer = setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, 1000);
              c.on('connect', () => { clearTimeout(timer); c.destroy(); resolve(); });
              c.on('error', () => { clearTimeout(timer); reject(new Error('dead')); });
            });
          } catch {
            console.error(`[Gateway] Removing stale socket: ${path.basename(sock)}`);
            try { fs.unlinkSync(sock); } catch {}
          }
        }
      }
    }

    if (!gatewayAutoEnsureEnabled()) {
      console.error('[Gateway] VODOU_GATEWAY_AUTO_ENSURE=0 — skipping daemon/worker ensure (startup + periodic). Use when replacing vodou-core; restart gateway after swap.');
    } else {
      // Ensure daemon — killSignal SIGKILL so timeout actually kills UE-state processes
      // (default SIGTERM is ignored by macOS UE/uninterruptible-sleep processes,
      // causing this execSync to hang forever and block gateway startup).
      try {
        execSync(`"${bt4}" daemon ensure`, { cwd: getProjectRoot(), timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
      } catch {}

      // Ensure worker — same SIGKILL fix
      try {
        execSync(`"${bt4}" worker ensure`, { cwd: getProjectRoot(), timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
      } catch {}

      // Wait for sockets to appear (up to 5s). On Windows there is no .sock file
      // (named pipe) — existsSync is always false — so probe by connecting to
      // the pipe target instead.
      const isWin = process.platform === 'win32';
      const canConnect = async (sockPath: string): Promise<boolean> => {
        const net = await import('net');
        return new Promise((resolve) => {
          const c = net.createConnection(sockConnectTarget(sockPath));
          const t = setTimeout(() => { c.destroy(); resolve(false); }, 600);
          c.on('connect', () => { clearTimeout(t); c.destroy(); resolve(true); });
          c.on('error', () => { clearTimeout(t); resolve(false); });
        });
      };
      const waitForSocket = async (sockPath: string, label: string) => {
        for (let i = 0; i < 10; i++) {
          const ready = isWin ? await canConnect(sockPath) : fs.existsSync(sockPath);
          if (ready) {
            console.error(`  ${label}: socket ready`);
            return true;
          }
          await new Promise(r => setTimeout(r, 500));
        }
        console.error(`  ${label}: socket not ready after 5s`);
        return false;
      };
      await Promise.all([
        waitForSocket(daemonSock, 'daemon'),
        waitForSocket(workerSock, 'worker'),
      ]);

      // Periodic ensure — runs every 30s. Catches the case where the worker dies
      // mid-session, AND the gnarlier case where the worker process is still
      // alive but its sock file got unlinked (Drop on a sibling worker, swap-
      // binary.sh cleanup race, etc.). When sock is missing, `vodou-core worker
      // ensure` can't fix it on its own — the new process bails on `flock` because
      // the stale worker still holds the lock. So we detect that exact state
      // here and SIGKILL the stale worker before re-ensuring.
      //
      // Without this, every gateway tool call falls back to `vodou-core call`
      // CLI spawn → trips the 5-process overload guard → drops requests →
      // chat agent dies mid-turn (the 2026-05-19 incident).
      const probeWorkerSock = async (sockPath: string, timeoutMs = 800): Promise<'ok' | 'missing' | 'dead'> => {
        // Bug 1: on Windows a bound named pipe has NO filesystem entry, so
        // existsSync is a false-negative — rely purely on the connect probe (the
        // same check `service status` uses). Bug 3: connect to the pipe target.
        if (process.platform !== 'win32' && !fs.existsSync(sockPath)) return 'missing';
        const net = await import('net');
        return new Promise((resolve) => {
          const c = net.createConnection(sockConnectTarget(sockPath));
          const t = setTimeout(() => { c.destroy(); resolve('dead'); }, timeoutMs);
          c.on('connect', () => { clearTimeout(t); c.destroy(); resolve('ok'); });
          c.on('error', () => { clearTimeout(t); resolve('dead'); });
        });
      };
      const reapStaleWorker = () => {
        try {
          const pidFile = path.join(oiDir, 'worker.pid');
          if (fs.existsSync(pidFile)) {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
            if (Number.isFinite(pid) && pid > 0) {
              try { process.kill(pid, 'SIGKILL'); console.error(`[Gateway] reaped stale worker pid=${pid} (sock dead, process alive)`); } catch {}
            }
          }
        } catch {}
        if (process.platform !== 'win32') { try { execSync(`pkill -9 -f "vodou-core worker start"`, { stdio: 'ignore', timeout: 3_000, windowsHide: true }); } catch {} }
      };
      setInterval(async () => {
        try {
          const state = await probeWorkerSock(workerSock);
          if (state !== 'ok') {
            // Sock missing or unresponsive — reap any stale worker first so the
            // new process can acquire worker.lock, then re-ensure.
            // Bug 2: NOT on Windows. The share_mode(0) lock already enforces
            // single-instance, and the daemon watchdog is the sole worker
            // manager — a gateway reap here would fight it (kill a healthy
            // worker on a transient probe miss) + unlinking a .sock that doesn't
            // exist is meaningless. The idempotent `worker ensure` below still
            // respawns a genuinely-dead worker.
            if ((state === 'missing' || state === 'dead') && process.platform !== 'win32') {
              console.error(`[Gateway] worker sock ${state} — reaping + re-ensuring`);
              reapStaleWorker();
              try { fs.unlinkSync(workerSock); } catch {}
            }
          }
          execSync(`"${bt4}" daemon ensure`, { cwd: getProjectRoot(), timeout: 5_000, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true });
          execSync(`"${bt4}" worker ensure`, { cwd: getProjectRoot(), timeout: 5_000, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true });
        } catch {
          /* swallow — next tick will retry */
        }
      }, 30_000).unref();
    }
  }

  // Janitor: deactivate orphan HTTP integrations that have no credentials.
  // Happens when oauth-begin creates an mcp_servers row but user abandons the consent flow.
  // Without this, stale active=1 rows pollute Capabilities → Tools and reconnect-all.
  try {
    const db = getDb();
    const result = db.prepare(`
      UPDATE mcp_servers
      SET active = 0
      WHERE connection_type = 'http'
        AND active = 1
        AND id NOT IN (
          SELECT server_id FROM server_credentials
          WHERE credential_type IN ('oauth_access_token', 'bearer_token', 'api_key')
        )
    `).run();
    if (result.changes > 0) {
      console.error(`[Gateway] Janitor: deactivated ${result.changes} orphan HTTP integration(s) with no credentials`);
    }
  } catch (err) {
    console.error('[Gateway] Janitor error (non-fatal):', (err as Error).message);
  }

  // Reconnect all MCP servers — non-blocking so HTTP listener starts immediately
  {
    const bt4 = path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
    if (fs.existsSync(bt4)) {
      console.error('[Gateway] Reconnecting MCP servers (background)...');
      const child = spawn(bt4, ['reconnect-all'], {
        cwd: getProjectRoot(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, // no phantom conhost window on Windows
      });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('close', (code: number | null) => {
        if (code === 0) {
          const connected = (stdout.match(/✅ Reconnected/g) || []).length;
          const failed = (stdout.match(/❌/g) || []).length;
          console.error(`[Gateway] MCP servers: ${connected} connected, ${failed} failed`);
          if (failed > 0) {
            const lines = stdout.split('\n').filter((l: string) => l.includes('❌'));
            for (const line of lines) console.error(`  ${line.trim()}`);
          }
        } else {
          console.error(`[Gateway] reconnect-all exited ${code}`);
        }
      });
      // Kill if it takes more than 30s
      setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 30_000);
    }
  }

  // Start server
  // Bind explicitly to IPv4 loopback. Default dual-stack listen has caused
  // WS-fails-but-HTTP-works symptoms when Node binds to ::1 only and the
  // browser resolves localhost to 127.0.0.1 (or vice versa) — most visible on
  // some Intel Macs. Gateway is local-only by design so 127.0.0.1 is safe.
  await new Promise<void>((resolve, reject) => {
    const onListenError = async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const peerOk = await probeHealthyGateway(PORT, 5000);
        if (peerOk) {
          console.error(
            `[Gateway] EADDRINUSE on 127.0.0.1:${PORT} but /health is OK — another gateway owns the port; exiting 0`,
          );
          process.exit(0);
        }
        console.error(`[Gateway] EADDRINUSE: 127.0.0.1:${PORT} is already in use.`);
        console.error('[Gateway] Another Vodou-Console (e.g. LaunchAgent) or process is bound to this port.');
        console.error(`[Gateway] Inspect: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
        console.error(
          '[Gateway] Fix: ./scripts/restart-gateway.sh or stop the other listener, then start again.',
        );
      } else {
        console.error('[Gateway] HTTP listen failed:', err.message);
      }
      reject(err);
    };
    server.once('error', onListenError);
    server.listen(PORT, '127.0.0.1', () => {
      server.off('error', onListenError);
      server.on('error', (e: NodeJS.ErrnoException) => {
        console.error('[Gateway] HTTP server error (after listen):', e.message);
      });
      console.error(`Vodou-Console running on http://localhost:${PORT}`);
      // Tier 3 chat-latency: pre-spawn warm Claude CLI session so the first new
      // conversation skips the ~5-8s cold spawn. No-op if claude binary missing.
      kickstartWarmCliPool();
      console.error('');
      console.error('Endpoints:');
      console.error(`  Web UI:    http://localhost:${PORT}/`);
      console.error(`  WebSocket: ws://localhost:${PORT}/`);
      console.error(`  REST API:  http://localhost:${PORT}/chat`);
      console.error(`  Health:    http://localhost:${PORT}/health`);
      console.error(`  Diagnostics (localhost): http://localhost:${PORT}/api/system/diagnostics`);
      console.error('');
      resolve();
    });
  });

  // Auto-register any SKILL.md files not yet in skills_registry
  syncSkillsFromFilesystem().catch((err) => console.error('[Skills] Startup sync failed:', err));

  // PLAN-SKILL-CONSOLE-LOOP §32 Tier 2 — auto-tab-open SSE/WS poller.
  // The MCP server `vc_skills_create` writes to gateway.db directly; the gateway
  // doesn't get an in-process callback because they're separate processes. So
  // we poll skills_meta every 4s for new rows and broadcast a `skill_console_created`
  // WS event to all live clients. The UI reacts by inserting the new tab without
  // a page refresh.
  let lastSeenSkillId = 0;
  try {
    const seedRow = getGatewayDb().prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM skills_meta`).get() as { id: number };
    lastSeenSkillId = seedRow?.id ?? 0;
    console.error(`[SkillConsole] auto-tab-open poller seeded at last_skill_id=${lastSeenSkillId}`);
  } catch (e) {
    console.error(`[SkillConsole] poller seed failed (table missing? will retry):`, (e as Error).message);
  }
  setInterval(() => {
    try {
      const rows = getGatewayDb().prepare(`
        SELECT s.id, s.name, s.display_name, s.is_active, b.conversation_id
        FROM skills_meta s
        LEFT JOIN skill_console_bindings b ON b.skill_id = s.id
        WHERE s.id > ?
        ORDER BY s.id ASC
      `).all(lastSeenSkillId) as Array<{ id: number; name: string; display_name: string; is_active: number; conversation_id: string | null }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        if (row.id > lastSeenSkillId) lastSeenSkillId = row.id;
        const payload = {
          type: 'skill_console_created',
          skillId: row.id,
          skillName: row.name,
          displayName: row.display_name,
          conversationId: row.conversation_id,
          isActive: row.is_active === 1,
        };
        let sent = 0;
        for (const c of clients.values()) {
          if (c.ws.readyState === 1) {
            try { c.ws.send(JSON.stringify(payload)); sent++; } catch { /* socket dying */ }
          }
        }
        console.error(`[SkillConsole] auto-tab-open broadcast skill=${row.name} (id=${row.id}) → ${sent} client(s)`);
      }
    } catch { /* DB transient — try again next tick */ }
  }, 4000);

  // ExecDesk warmup — fire one tiny claude-cli call at startup to prime OAuth state
  // and warm any caches. Drops first-real-call latency by ~2–3s.
  // Fire-and-forget, non-blocking.
  (async () => {
    try {
      const os = await import('os');
      const cliBin = process.env.CLAUDE_BIN || 'claude';
      const cliEnv = { ...process.env };
      delete cliEnv.ANTHROPIC_API_KEY;
      delete cliEnv.CLAUDECODE;
      delete cliEnv.VODOU_PROJECT_PATH;
      const startMs = Date.now();
      const proc = require('child_process').spawn(
        cliBin,
        ['-p', '--model', 'haiku', '--output-format', 'text', '--system-prompt', 'You output one word: OK.'],
        { cwd: os.tmpdir(), env: cliEnv, stdio: ['pipe', 'ignore', 'ignore'] }
      );
      proc.stdin.write('Reply with OK.');
      proc.stdin.end();
      proc.on('close', () => {
        console.error(`[ExecDesk] claude-cli warmup completed in ${Date.now() - startMs}ms`);
      });
      proc.on('error', () => {});
    } catch { /* warmup is fire-and-forget */ }
  })();

  // Periodic MCP server health check — reconnect any that dropped.
  //
  // Stops retrying a server after MAX_RECONNECT_ATTEMPTS consecutive failures.
  // History: dalle + uml-mcp depend on external Python (`uvx`) that isn't
  // installed on every machine; on those hosts the reconnect call could never
  // succeed and the HealthCheck loop spammed the log every 5 minutes forever
  // (see PLANS/joes debugging §S6 / §F8). Resets the counter on first success
  // so a temporary outage doesn't permanently disable a real server.
  const MCP_HEALTH_INTERVAL = parseInt(process.env.VODOU_MCP_HEALTH_INTERVAL_MS || '300000', 10); // 5 min
  const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.VODOU_MCP_MAX_RECONNECT_ATTEMPTS || '3', 10);
  const reconnectFailures = new Map<string, number>();
  const disabledServers = new Set<string>();
  setInterval(() => {
    const bt4 = path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
    if (!fs.existsSync(bt4)) return;
    exec(`"${bt4}" health-check`, {
      cwd: getProjectRoot(),
      timeout: 30_000,
      killSignal: 'SIGKILL' as NodeJS.Signals,
    }, (err, stdout) => {
      if (err && !stdout) return;
      const result = stdout || '';
      const failedServers = result.split('\n')
        .filter((l: string) => l.includes('❌'))
        .map((l: string) => {
          // Health-check format: "  Testing <server>: ❌ Connection failed: ..."
          const m = l.match(/Testing\s+(\S+?):/);
          return m ? m[1] : null;
        })
        .filter(Boolean) as string[];

      // Reset success-counters for servers that ARE working now.
      const recoveredServers = Array.from(reconnectFailures.keys())
        .filter((s) => !failedServers.includes(s));
      for (const srv of recoveredServers) {
        reconnectFailures.delete(srv);
        if (disabledServers.delete(srv)) {
          console.error(`[HealthCheck] ${srv} recovered — re-enabling reconnect attempts`);
        }
      }

      const reconnectable = failedServers.filter((s) => !disabledServers.has(s));
      if (reconnectable.length > 0) {
        console.error(`[HealthCheck] ${reconnectable.length} servers down: ${reconnectable.join(', ')} — reconnecting`);
        for (const srv of reconnectable) {
          // execFile (array args, no shell) — `srv` is parsed from health-check
          // output (server names); a name with shell metacharacters would inject
          // via the old template-string `exec`. Array args neutralize it.
          execFile(bt4, ['reconnect', srv], {
            cwd: getProjectRoot(),
            timeout: 15_000,
            killSignal: 'SIGKILL' as NodeJS.Signals,
          }, (reconnErr) => {
            if (reconnErr) {
              const count = (reconnectFailures.get(srv) || 0) + 1;
              reconnectFailures.set(srv, count);
              if (count >= MAX_RECONNECT_ATTEMPTS) {
                disabledServers.add(srv);
                console.error(`  ❌ ${srv} failed ${count} consecutive reconnects — disabling further attempts (check dependencies, then restart gateway)`);
              } else {
                console.error(`  ❌ Failed to reconnect: ${srv} (attempt ${count}/${MAX_RECONNECT_ATTEMPTS})`);
              }
            } else {
              console.error(`  ✅ Reconnected: ${srv}`);
              reconnectFailures.delete(srv);
            }
          });
        }
      }
    });
  }, MCP_HEALTH_INTERVAL);

  // ── Vodou Board: embedded dispatcher tick ─────────────────
  // Shells to `vodou-core board dispatch --json` every BOARD_DISPATCH_INTERVAL_MS
  // (default 30s). Reclaims stale claims, promotes todo→ready, claims ready→running.
  // Set VODOU_BOARD_DISPATCH_DISABLED=1 to opt out (e.g. during dev/test).
  const BOARD_DISPATCH_INTERVAL_MS = parseInt(
    process.env.VODOU_BOARD_DISPATCH_INTERVAL_MS || '30000', 10,
  );
  // SIGKILL budget for each `board dispatch` shell-out. The tick claims a task,
  // then builds worker context (incl. in-process memory embedding, which is cold
  // in this one-shot CLI), then spawns. The old 15s budget SIGKILLed the process
  // *after* the claim but *before* the spawn — leaving tasks claimed-but-unspawned
  // until the circuit breaker gave up (the "task moves to running, no worker" bug).
  // Override with VODOU_BOARD_DISPATCH_TIMEOUT_MS.
  const BOARD_DISPATCH_TIMEOUT_MS = parseInt(
    process.env.VODOU_BOARD_DISPATCH_TIMEOUT_MS || '60000', 10,
  );
  if (process.env.VODOU_BOARD_DISPATCH_DISABLED !== '1') {
    // Re-entrancy guard: a dispatch tick can run longer than the interval (cold
    // context build, slow spawn). Without this, setInterval fires overlapping
    // dispatches that race to claim/reclaim the same tasks and pile up processes
    // (the storm of 2026-05-29). Skip a tick if the prior one is still running.
    let dispatchInFlight = false;
    setInterval(() => {
      const bt4 = process.env.VODOU_CORE_BIN ?? path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
      if (!fs.existsSync(bt4)) return;
      // Skip if board.db isn't initialized yet
      if (!fs.existsSync(path.join(getProjectRoot(), 'board.db'))) return;
      if (dispatchInFlight) {
        console.error('[board.dispatcher] previous tick still running — skipping this interval');
        return;
      }
      dispatchInFlight = true;
      exec(`"${bt4}" board dispatch --max 5 --json`, {
        cwd: getProjectRoot(),
        timeout: BOARD_DISPATCH_TIMEOUT_MS,
        killSignal: 'SIGKILL' as NodeJS.Signals,
        windowsHide: true,
      }, (err, stdout) => {
        dispatchInFlight = false;
        if (err && !stdout) {
          const msg = err.message ?? '';
          if (!msg.includes('system overloaded')) {
            console.error('[board.dispatcher] tick error:', msg.slice(0, 200));
          }
          return;
        }
        try {
          const report = JSON.parse((stdout || '').trim());
          // Only log when there's actual activity (cuts noise on idle boards)
          const total = (report.spawned ?? 0) + (report.reclaimed ?? 0)
                      + (report.promoted ?? 0) + (report.crashed ?? 0);
          if (total > 0) {
            console.error(`[board.dispatcher] tick: ${JSON.stringify(report)}`);
          }
        } catch {
          /* malformed JSON — ignore this tick */
        }
      });
    }, BOARD_DISPATCH_INTERVAL_MS);
    console.error(`[board.dispatcher] embedded tick enabled (interval=${BOARD_DISPATCH_INTERVAL_MS}ms)`);
  }

  // ── Vodou Board: notifier tick ────────────────────────────
  // Shells to `vodou-core board notifier --json` every NOTIFIER_INTERVAL_MS
  // (default 5s). Polls task_events, dispatches per-platform notifications
  // for terminal events (completed/blocked/crashed/etc.).
  const BOARD_NOTIFIER_INTERVAL_MS = parseInt(
    process.env.VODOU_BOARD_NOTIFIER_INTERVAL_MS || '5000', 10,
  );
  if (process.env.VODOU_BOARD_NOTIFIER_DISABLED !== '1') {
    setInterval(() => {
      const bt4 = process.env.VODOU_CORE_BIN ?? path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
      if (!fs.existsSync(bt4)) return;
      if (!fs.existsSync(path.join(getProjectRoot(), 'board.db'))) return;
      exec(`"${bt4}" board notifier --json`, {
        cwd: getProjectRoot(),
        timeout: 30_000,
        killSignal: 'SIGKILL' as NodeJS.Signals,
      }, (err, stdout) => {
        if (err && !stdout) {
          const msg = err.message ?? '';
          if (!msg.includes('system overloaded')) {
            console.error('[board.notifier] tick error:', msg.slice(0, 200));
          }
          return;
        }
        try {
          const report = JSON.parse((stdout || '').trim());
          if ((report.messages_sent ?? 0) > 0 || (report.pruned_subs ?? 0) > 0) {
            console.error(`[board.notifier] tick: ${JSON.stringify(report)}`);
          }
        } catch {
          /* malformed JSON — ignore */
        }
      });
    }, BOARD_NOTIFIER_INTERVAL_MS);
    console.error(`[board.notifier] embedded tick enabled (interval=${BOARD_NOTIFIER_INTERVAL_MS}ms)`);
  }

  // Handle shutdown signals — scheduleCleanup may delay for in-flight chats
  process.on('SIGINT', () => scheduleCleanup('SIGINT'));
  process.on('SIGTERM', () => scheduleCleanup('SIGTERM'));

  // On uncaught crash, kill detached CLI subprocesses before dying so they
  // don't become orphans. shutdownCliPool() sets poolKillReason='shutdown'
  // so close handlers won't fire error events to already-dead WS clients.
  process.on('uncaughtException', (err) => {
    console.error('[Gateway] uncaughtException — killing CLI pool before exit:', err.message);
    shutdownCliPool();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[Gateway] unhandledRejection — killing CLI pool before exit:', msg);
    shutdownCliPool();
    process.exit(1);
  });
}

const isGatewayCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]!) === fileURLToPath(import.meta.url);

if (isGatewayCliMain) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
