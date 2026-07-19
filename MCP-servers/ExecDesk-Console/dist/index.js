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
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { chat, chatWithSkill, clearConversation, getStats, isConfigured, initAuth, triggerMemoryFlush, getActiveModelLabel, getLastMemoryUsed, getLastMemoryDebug, getTotalMemoryCount, markHeartbeatConversation, setConversationMaxTokens, setConversationMaxToolIterations, warmupCliSession } from './llm.js';
import { appendChannelAttachmentHints } from './channelAttachments.js';
import { getConversationManager, setFlushCallback } from './conversation.js';
import { checkExecutorHealth, cleanStaleToolResults } from './executor.js';
import { getToolNames } from './tools.js';
import { closeDb, getDb, getGatewayDb, getProjectRoot, getSetting, getThinkingDb, saveUsage } from './db.js';
import fs from 'fs';
import { createTerminal, writeTerminal, resizeTerminal, destroyTerminal, destroyAllTerminals, getTerminalCount } from './terminal.js';
import { withLedgerLock } from './task_ledger_lock.js';
import { systemRouter } from './api/system.js';
import { serversRouter } from './api/servers.js';
import { skillsRouter, syncSkillsFromFilesystem } from './api/skills.js';
import { execRouter } from './api/exec.js';
import { intentsRouter } from './api/intents.js';
import { schedulerRouter } from './api/scheduler.js';
import { automationsRouter } from './api/automations.js';
import { scriptsRouter } from './api/scripts.js';
import { logsRouter } from './api/logs.js';
import { memoryRouter } from './api/memory.js';
import memoryExtractorRouter from './api/memory-extractor.js';
import { conversationsRouter } from './api/conversations.js';
import { filesRouter } from './api/files.js';
import { linkPreviewRouter } from './api/link-preview.js';
import { onboardingRouter } from './api/onboarding.js';
import { channelsRouter } from './api/channels.js';
import { cascadeReadinessRouter } from './api/cascadeReadiness.js';
import { decodeTeamsRecipient, getBotFrameworkAccessToken, sendTeamsActivity, updateTeamsActivity, } from './api/teams-outbound.js';
import { sendGoogleChatMessage } from './api/googlechat-outbound.js';
import { sendSignalCliMessage } from './api/signal-outbound.js';
import { settingsRouter } from './api/settings.js';
import { toolsRouter } from './api/tools.js';
import { routeRouter } from './api/route.js';
import { workflowsRouter } from './api/workflows.js';
import { webhooksRouter } from './api/webhooks.js';
import { openaiCompatRouter } from './api/openai-compat.js';
import { usageRouter } from './api/usage.js';
import { docsRouter } from './api/docs.js';
import { oauthRouter } from './api/oauth.js';
import { mcpRegistryRouter } from './api/mcp-registry.js';
import { profileRouter } from './api/profile.js';
import { workbenchRouter } from './api/workbench.js';
import { saveMessage, loadRecentMessages, loadMessagesOlderThan, hasMessagesOlderThan, ensureConversation, getConversation, updateConversationTitle, loadConversations, getMessageCount, deleteConversation as deleteGatewayConversation, } from './conversation-store.js';
import { resolveScope } from './scope.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Configuration
const PORT = parseInt(process.env.WEB_PORT || '8767', 10);
/** When true, show raw <oi_results> tags in chat history instead of stripping them. */
function showRawResults() {
    // Re-read from .env on disk so edits take effect without gateway restart
    try {
        const envPath = path.resolve(process.env.VODOU_PROJECT_PATH || process.cwd(), '.env');
        const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#'))
                continue;
            if (trimmed.startsWith('VODOU_SHOW_RAW_RESULTS=')) {
                return trimmed.split('=')[1]?.trim() === '1';
            }
        }
    }
    catch { }
    return false;
}
/** Web UI initial / “Load earlier” page size — not the LLM path (llm.ts does not load gateway.db here). */
const UI_CHAT_HISTORY_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.VODOU_UI_CHAT_HISTORY_LIMIT || '20', 10) || 20, 10), 200);
/**
 * Turn raw gateway_messages rows into the shape the web UI replays over WS / REST.
 * Mirrors WebSocket `history` / `switch_conversation` processing (heartbeat HEARTBEAT_OK filter, etc.).
 */
function formatGatewayHistoryForWebUi(conversationId, dbMessages) {
    const isHeartbeat = conversationId === 'vodou-heartbeat';
    let historyMessages = [];
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
                });
            }
        }
        else if (m.role === 'assistant') {
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
        const skipIds = new Set();
        for (let i = 0; i < historyMessages.length; i++) {
            if (historyMessages[i].role === 'assistant' && historyMessages[i].text.trim() === 'HEARTBEAT_OK') {
                if (historyMessages[i].id)
                    skipIds.add(historyMessages[i].id);
                if (i > 0 && historyMessages[i - 1].role === 'user' && historyMessages[i - 1].id) {
                    skipIds.add(historyMessages[i - 1].id);
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
function historyPageHasOlder(conversationId, dbRows) {
    if (dbRows.length === 0)
        return false;
    const minId = dbRows.reduce((acc, r) => Math.min(acc, r.id), dbRows[0].id);
    return hasMessagesOlderThan(conversationId, minId);
}
/**
 * Forward a gateway response to an external channel (Slack, Telegram, etc.)
 * Reads tokens from Vodou-channels .env and calls the platform API directly.
 * Fire-and-forget — errors are logged but don't block the gateway.
 */
function getChannelEnv() {
    const envVars = {};
    // Layer 1: Vodou-channels/.env — the original source. Ports, feature flags,
    // and any credential the user never touched through the UI live here.
    const channelsEnvPath = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-channels', '.env');
    try {
        const raw = fs.readFileSync(channelsEnvPath, 'utf-8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const eq = trimmed.indexOf('=');
            if (eq > 0)
                envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
        }
    }
    catch { }
    // Layer 2: DB credentials written by the Messaging → Credentials UI override
    // the .env values. Without this, saving a new Bot Token through the UI went
    // to the DB but the send path kept using the stale .env value — exactly the
    // "why isn't my saved token working" class of bug.
    const CRED_PREFIX = 'channel_';
    for (const key of [
        'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID',
        'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET',
        'SLACK_DEFAULT_CHANNEL', 'SLACK_CHANNEL_ID',
        'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
        'TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID', 'TEAMS_PORT',
        'GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_PORT',
        'SIGNAL_CLI_PATH', 'SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_CONFIG',
    ]) {
        const dbVal = getSetting(CRED_PREFIX + key.toLowerCase());
        if (dbVal)
            envVars[key] = dbVal;
    }
    if (!envVars.SLACK_CHANNEL_ID?.trim() && envVars.SLACK_DEFAULT_CHANNEL?.trim()) {
        envVars.SLACK_CHANNEL_ID = envVars.SLACK_DEFAULT_CHANNEL.trim();
    }
    return envVars;
}
/** WhatsApp text limit per message; longer replies are split into sequential sends. */
const WHATSAPP_TEXT_CHUNK = 4096;
function chunkTextForWhatsApp(full, maxLen) {
    const t = full.trimEnd();
    if (t.length <= maxLen)
        return [t.length ? t : ''];
    const parts = [];
    let rest = t;
    while (rest.length > 0) {
        if (rest.length <= maxLen) {
            parts.push(rest);
            break;
        }
        let cut = rest.lastIndexOf('\n\n', maxLen);
        if (cut < Math.floor(maxLen / 2))
            cut = rest.lastIndexOf('\n', maxLen);
        if (cut < Math.floor(maxLen / 2))
            cut = maxLen;
        parts.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    return parts.length ? parts : [''];
}
async function sendWhatsAppViaBridge(envVars, recipient, text, mediaPath) {
    const port = envVars.WHATSAPP_BRIDGE_PORT || process.env.WHATSAPP_BRIDGE_PORT || '8081';
    const chunks = chunkTextForWhatsApp(text, WHATSAPP_TEXT_CHUNK);
    for (let i = 0; i < chunks.length; i++) {
        const body = { recipient, message: chunks[i] };
        if (i === 0 && mediaPath)
            body.media_path = mediaPath;
        const r = await fetch(`http://127.0.0.1:${port}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const d = (await r.json().catch(() => ({})));
        if (!r.ok || d.success === false) {
            console.error('[Gateway] WhatsApp send failed:', r.status, d);
            return false;
        }
    }
    console.error(`[Gateway DIAG] sendWhatsAppViaBridge OK chunks=${chunks.length}`);
    return true;
}
/** Send the full response to a channel (final message or single-shot) */
function forwardToChannel(source, recipient, text) {
    const envVars = getChannelEnv();
    sendChannelMessage(source, recipient, text, envVars);
}
/** Send a message to a channel — returns the message ID for later editing */
async function sendChannelMessage(source, recipient, text, envVars) {
    // [DIAG] Log every send so duplicate-message bugs are visible in stderr.
    // The full call stack hint helps locate the call site (feedChannelStream timer,
    // finishChannelStream fallback, or forwardToChannel single-shot).
    console.error(`[Gateway DIAG] sendChannelMessage source=${source} recipient=${recipient} text_len=${text.length} preview=${JSON.stringify(text.substring(0, 80))}`);
    console.error(`[Gateway DIAG] sendChannelMessage stack: ${new Error().stack?.split('\n').slice(2, 5).join(' | ')}`);
    try {
        if (source === 'slack') {
            const token = envVars.SLACK_BOT_TOKEN;
            if (!token)
                return null;
            const r = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: recipient, text }),
            });
            const d = await r.json();
            if (!d.ok) {
                console.error('[Gateway] Slack send failed:', d.error);
                return null;
            }
            console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=slack ts=${d.ts}`);
            return d.ts; // Slack message ID for editing
        }
        else if (source === 'telegram') {
            const token = envVars.TELEGRAM_BOT_TOKEN;
            if (!token)
                return null;
            const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: recipient, text }),
            });
            const d = await r.json();
            return d.result?.message_id ? String(d.result.message_id) : null;
        }
        else if (source === 'discord') {
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
            const d = await r.json();
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
        }
        else if (source === 'whatsapp') {
            const ok = await sendWhatsAppViaBridge(envVars, recipient, text);
            return ok ? null : null;
        }
        else if (source === 'imessage') {
            // iMessage: spawn osascript directly from the gateway. The Gateway Node
            // runs on the user's Mac (same machine as Messages.app) and has the
            // same TCC-grant envelope as the Vodou-channels standalone (same binary).
            // First send triggers macOS Automation → Messages prompt (one-time).
            const ok = await sendImessageViaAppleScript(recipient, text);
            return ok ? null : null;
        }
        else if (source === 'teams') {
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
            if (!token)
                return null;
            const id = await sendTeamsActivity({ token, routing, text, botAppId: appId });
            console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=teams activityId=${id}`);
            return id;
        }
        else if (source === 'googlechat') {
            const creds = envVars.GOOGLE_CHAT_CREDENTIALS;
            if (!creds) {
                console.error('[Gateway] Google Chat send: GOOGLE_CHAT_CREDENTIALS missing');
                return null;
            }
            const id = await sendGoogleChatMessage(creds, recipient, text);
            console.error(`[Gateway DIAG] sendChannelMessage SUCCESS source=googlechat name=${id}`);
            return id;
        }
        else if (source === 'signal') {
            const account = (envVars.SIGNAL_PHONE_NUMBER || '').trim();
            if (!account) {
                console.error('[Gateway] Signal send: SIGNAL_PHONE_NUMBER missing');
                return null;
            }
            const cli = (envVars.SIGNAL_CLI_PATH || 'signal-cli').trim();
            const config = (envVars.SIGNAL_CLI_CONFIG || '').trim() || undefined;
            const ok = await sendSignalCliMessage(cli, account, config, recipient, text);
            if (ok)
                console.error('[Gateway DIAG] sendChannelMessage SUCCESS source=signal');
            else
                console.error('[Gateway] Signal send failed');
            return null;
        }
    }
    catch (e) {
        console.error(`[Gateway] ${source} send error:`, e.message);
    }
    return null;
}
/** Send an iMessage by spawning `osascript` to drive Messages.app. macOS-only.
 *  Returns true on exit=0 (usually means the send was handed to Messages,
 *  though actual delivery is asynchronous on Apple's side). */
async function sendImessageViaAppleScript(recipient, text) {
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
    return new Promise((resolve) => {
        const proc = spawn('osascript', ['-e', script]);
        let stderr = '';
        proc.stderr.on('data', (b) => { stderr += b.toString(); });
        proc.on('close', (code) => {
            if (code !== 0) {
                console.error(`[Gateway] iMessage send failed (exit ${code}): ${stderr.trim()}`);
            }
            else {
                console.error(`[Gateway DIAG] sendImessage SUCCESS recipient=${recipient} len=${text.length}`);
            }
            resolve(code === 0);
        });
        proc.on('error', (e) => {
            console.error('[Gateway] osascript spawn error:', e.message);
            resolve(false);
        });
    });
}
/** Edit an existing channel message (for progressive streaming updates) */
async function editChannelMessage(source, recipient, messageId, text, envVars) {
    console.error(`[Gateway DIAG] editChannelMessage source=${source} recipient=${recipient} messageId=${messageId} text_len=${text.length}`);
    try {
        if (source === 'slack') {
            const token = envVars.SLACK_BOT_TOKEN;
            if (!token)
                return;
            await fetch('https://slack.com/api/chat.update', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: recipient, ts: messageId, text }),
            });
        }
        else if (source === 'telegram') {
            const token = envVars.TELEGRAM_BOT_TOKEN;
            if (!token)
                return;
            await fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: recipient, message_id: parseInt(messageId, 10), text }),
            });
        }
        else if (source === 'discord') {
            const token = envVars.DISCORD_BOT_TOKEN;
            if (!token)
                return;
            await fetch('https://discord.com/api/v10/channels/' + recipient + '/messages/' + messageId, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text }),
            });
        }
        else if (source === 'whatsapp') {
            // No edit API on the bridge; finishChannelStream sends the full text once.
        }
        else if (source === 'teams') {
            const appId = envVars.TEAMS_APP_ID;
            const secret = envVars.TEAMS_APP_PASSWORD;
            const tenant = envVars.TEAMS_TENANT_ID;
            if (!appId || !secret)
                return;
            const routing = decodeTeamsRecipient(recipient);
            if (!routing)
                return;
            const token = await getBotFrameworkAccessToken(appId, secret, tenant || undefined);
            if (!token)
                return;
            await updateTeamsActivity({ token, routing, activityId: messageId, text, botAppId: appId });
        }
    }
    catch { }
}
/** Track active channel streams for progressive forwarding */
const _channelStreams = new Map();
/** Start progressive channel streaming — call on first text chunk for channel conversations */
function startChannelStream(convId, source, recipient) {
    if (_channelStreams.has(convId))
        return;
    _channelStreams.set(convId, {
        source, recipient, messageId: null,
        envVars: getChannelEnv(), lastUpdate: 0, text: '',
        timer: null, sendPromise: null,
    });
}
/** Feed a text chunk to the channel stream — edits the message every 3s */
function feedChannelStream(convId, chunk) {
    const stream = _channelStreams.get(convId);
    if (!stream)
        return;
    stream.text += chunk;
    // Throttle edits to every 3 seconds
    if (stream.timer)
        return;
    stream.timer = setTimeout(async () => {
        stream.timer = null;
        const now = Date.now();
        if (now - stream.lastUpdate < 2500)
            return;
        // RACE FIX: if a previous send is still in flight, await it before starting another.
        // Without this guard, the timer can fire (and clear stream.timer above) while the
        // first send is still on the wire — when chunks arrive in that window they set a
        // NEW timer, which fires while messageId is still null and starts a SECOND parallel
        // sendChannelMessage. Each parallel send creates a new Slack message instead of
        // editing the original. Symptom: 2-5 separate Slack messages from a single LLM
        // stream when Slack API latency exceeds the 1.5s throttle window.
        if (stream.sendPromise) {
            try {
                await stream.sendPromise;
            }
            catch { }
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
        const preview = stream.text.substring(0, 4000) + (stream.text.length > 4000 ? '...' : ' ...');
        // Track the in-flight send so finishChannelStream and the next timer iteration can await it
        stream.sendPromise = (async () => {
            try {
                if (!stream.messageId) {
                    // First update — send initial message
                    stream.messageId = await sendChannelMessage(stream.source, stream.recipient, preview, stream.envVars);
                }
                else {
                    // Edit existing message
                    await editChannelMessage(stream.source, stream.recipient, stream.messageId, preview, stream.envVars);
                }
            }
            finally {
                // Clear the in-flight marker so finishChannelStream's await is a no-op once we're done
                // (we can't null sendPromise itself or the await above breaks; finishChannelStream
                // already awaits whatever's there before its own send)
            }
        })();
    }, 1500);
}
/** Finish the channel stream — final edit with complete text */
async function finishChannelStream(convId, finalText) {
    const stream = _channelStreams.get(convId);
    _channelStreams.delete(convId);
    if (!stream) {
        // No stream was started — just send the full message directly
        return;
    }
    if (stream.timer)
        clearTimeout(stream.timer);
    // Wait for any in-flight send from the timer to complete (prevents race where
    // messageId hasn't been set yet, causing a duplicate sendChannelMessage)
    if (stream.sendPromise)
        await stream.sendPromise;
    if (stream.messageId) {
        // Edit with final text
        await editChannelMessage(stream.source, stream.recipient, stream.messageId, finalText.substring(0, 4000), stream.envVars);
    }
    else if (stream.source === 'whatsapp') {
        await sendWhatsAppViaBridge(stream.envVars, stream.recipient, finalText);
    }
    else {
        // Never sent — send the full message (Signal, iMessage, Google Chat, Slack, etc.)
        await sendChannelMessage(stream.source, stream.recipient, finalText.substring(0, 4000), stream.envVars);
    }
}
// Express app and HTTP server
let app;
let server;
let wss;
const clients = new Map();
// Single persistent conversation for the gateway (local single-user app)
// On startup, resume the most recent web conversation instead of generating a new UUID.
// Keeps UI + gateway.db on the same thread; in-process LLM history is still cold until turns run (no DB replay here).
function loadLastConversationId() {
    try {
        const convs = loadConversations();
        const last = convs.find(c => !c.source || c.source === 'web');
        return last?.id ?? null;
    }
    catch {
        return null;
    }
}
let persistentConversationId = loadLastConversationId() ?? randomUUID();
// Skill Runner — stores SKILL.md content per skill conversation
const skillConversations = new Map();
/**
 * Initialize Express app with routes
 */
function setupExpress() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    // CORS headers
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
        }
        next();
    });
    // Health check
    app.get('/health', async (req, res) => {
        const executorHealth = await checkExecutorHealth();
        const stats = getStats();
        res.json({
            status: 'ok',
            configured: isConfigured(),
            executor: executorHealth,
            stats,
            clients: clients.size,
            terminals: getTerminalCount(),
            tools: getToolNames()
        });
    });
    // Chat endpoint (REST API) — used by gateway web UI and channel-manager (Telegram/Slack/Discord)
    app.post('/chat', async (req, res) => {
        const { conversationId, source, senderName, attachments, recipient: explicitRecipient } = req.body;
        const userText = typeof req.body.message === 'string' ? req.body.message.trim() : '';
        const attachmentList = Array.isArray(attachments)
            ? attachments.filter((a) => a && typeof a.url === 'string' && a.url.trim())
            : [];
        const displayMessage = attachmentList.length > 0 ? appendChannelAttachmentHints(userText, attachmentList) : userText;
        const messageForLlm = userText || (attachmentList.length ? ' ' : '');
        if (!displayMessage.trim()) {
            res.status(400).json({ error: 'Message or attachment with url is required' });
            return;
        }
        if (!isConfigured()) {
            res.status(500).json({ error: 'API not configured. Set ANTHROPIC_API_KEY.' });
            return;
        }
        const convId = conversationId || randomUUID();
        const chunks = [];
        const toolCalls = [];
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
        // For channel conversations, broadcast events to WebSocket clients so tabs update live
        const isChannel = !!(source && source !== 'web');
        const broadcast = (msg) => {
            if (!isChannel)
                return;
            const payload = JSON.stringify(msg);
            for (const c of clients.values()) {
                if (c.ws.readyState === 1)
                    c.ws.send(payload);
            }
        };
        // Broadcast the incoming user message so channel tabs show it
        if (isChannel) {
            try {
                saveMessage(convId, 'user', displayMessage.substring(0, 10000));
            }
            catch { }
            broadcast({ type: 'channel_user_message', conversationId: convId, content: displayMessage, source, senderName });
            // Start progressive channel streaming (edits message as response builds).
            // Prefer the explicit `recipient` field from the request body (channel-manager
            // now uses unified convId `workbench:channel:<type>` and passes recipient
            // separately). Fall back to convId-parsing for legacy callers.
            const parts = convId.split(':');
            const fallbackRecipient = parts.length > 1 ? parts.slice(1).join(':') : '';
            const channelRecipient = explicitRecipient || fallbackRecipient;
            if (channelRecipient) {
                startChannelStream(convId, source, channelRecipient);
            }
        }
        try {
            await chat(convId, messageForLlm, (event) => {
                if (event.type === 'text' && event.content) {
                    chunks.push(event.content);
                    broadcast({ type: 'chunk', conversationId: convId, content: event.content });
                    // Feed chunks to channel stream for progressive updates
                    if (isChannel)
                        feedChannelStream(convId, event.content);
                }
                if (event.type === 'tool_call_end' && event.toolName) {
                    toolCalls.push({
                        name: event.toolName,
                        result: event.toolResult || ''
                    });
                }
                if (event.type === 'done') {
                    // Save assistant response to DB
                    const fullResponse = chunks.join('');
                    if (fullResponse.trim()) {
                        try {
                            saveMessage(convId, 'assistant', fullResponse.trim());
                        }
                        catch { }
                    }
                    // Track API usage/cost
                    if (event.usage) {
                        saveUsage(convId, source || 'web', event.usage.model || '', event.usage);
                    }
                    // Finish channel stream with final text (replaces progressive updates)
                    if (isChannel) {
                        finishChannelStream(convId, fullResponse.trim()).catch(() => { });
                    }
                    broadcast({ type: 'done', conversationId: convId });
                }
            }, attachmentList.length ? { channelAttachments: attachmentList } : undefined);
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
        }
        catch (error) {
            res.status(500).json({
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });
    // POST /chat/automation-emit — scheduled automation run from Rust engine
    // injects a synthetic user message into a scoped workbench:automation:<id>
    // conversation and runs the LLM against it. The LLM response streams back
    // to any WS client subscribed to that conversation (pinned tab) and is
    // persisted to conversation history either way. Triggered only when the
    // automation has `post_to_chat=1` AND `events_matched > 0` server-side.
    app.post('/chat/automation-emit', async (req, res) => {
        const { message, conversationId, system_only, role } = req.body || {};
        if (!message || !conversationId) {
            res.status(400).json({ error: 'message + conversationId required' });
            return;
        }
        // Auth — same shared secret as the heartbeat path
        const expectedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
        if (expectedSecret) {
            const provided = req.headers['x-scheduler-secret'];
            if (provided !== expectedSecret) {
                res.status(403).json({ error: 'Invalid scheduler secret' });
                return;
            }
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
            try {
                saveMessage(conversationId, msgRole, String(message).substring(0, 2000));
            }
            catch { }
            for (const c of clients.values()) {
                if (c.ws.readyState === 1) {
                    c.ws.send(JSON.stringify({
                        type: 'chunk',
                        conversationId,
                        content: String(message),
                        role: msgRole,
                    }));
                    c.ws.send(JSON.stringify({ type: 'done', conversationId }));
                }
            }
            return res.json({ ok: true, conversationId, systemOnly: true });
        }
        if (!isConfigured()) {
            res.status(500).json({ error: 'LLM not configured' });
            return;
        }
        try {
            saveMessage(conversationId, 'user', String(message).substring(0, 10000));
        }
        catch { }
        let assistantFullText = '';
        try {
            await chat(conversationId, message, (event) => {
                // Broadcast every event to ALL connected WS clients — clients on the
                // frontend filter by conversationId so only the right tab reacts.
                const broadcast = (payload) => {
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({ ...payload, conversationId }));
                        }
                    }
                };
                if (event.type === 'text' && event.content) {
                    assistantFullText += event.content;
                    broadcast({ type: 'chunk', content: event.content });
                }
                else if (event.type === 'tool_call_start') {
                    broadcast({
                        type: 'tool_start',
                        tool: event.toolName,
                        toolId: event.toolId,
                        server: event.toolArgs?.server,
                        args: event.toolArgs,
                    });
                }
                else if (event.type === 'tool_call_end') {
                    broadcast({
                        type: 'tool_end',
                        tool: event.toolName,
                        toolId: event.toolId,
                        result: event.toolResult,
                        executionTime: event.executionTime,
                        success: event.success,
                    });
                }
            });
            if (assistantFullText) {
                try {
                    saveMessage(conversationId, 'assistant', assistantFullText.substring(0, 50000));
                }
                catch { }
            }
            // Tell clients the turn finished
            for (const c of clients.values()) {
                if (c.ws.readyState === 1) {
                    c.ws.send(JSON.stringify({ type: 'done', conversationId }));
                }
            }
            res.json({ ok: true, conversationId, responseChars: assistantFullText.length });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            for (const c of clients.values()) {
                if (c.ws.readyState === 1) {
                    c.ws.send(JSON.stringify({ type: 'error', conversationId, message: msg }));
                }
            }
            res.status(500).json({ error: msg });
        }
    });
    // POST /chat/heartbeat — scheduled heartbeat from Rust scheduler
    app.post('/chat/heartbeat', async (req, res) => {
        const { message, conversationId, maxTokens, maxToolRounds, runCount } = req.body;
        if (!message) {
            res.status(400).json({ error: 'message required' });
            return;
        }
        // Auth check
        const expectedSecret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET;
        if (expectedSecret) {
            const provided = req.headers['x-scheduler-secret'];
            if (provided !== expectedSecret) {
                res.status(403).json({ error: 'Invalid scheduler secret' });
                return;
            }
        }
        if (!isConfigured()) {
            res.status(500).json({ error: 'LLM not configured' });
            return;
        }
        const convId = conversationId || 'vodou-heartbeat';
        ensureConversation(convId, 'Vodou Heartbeat', 'heartbeat', 'Vodou');
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
        if (maxTokens)
            setConversationMaxTokens(convId, maxTokens);
        if (maxToolRounds)
            setConversationMaxToolIterations(convId, maxToolRounds);
        // Broadcast heartbeat_activity so Vodou tab appears/activates
        for (const c of clients.values()) {
            if (c.ws.readyState === 1) {
                c.ws.send(JSON.stringify({ type: 'heartbeat_activity', conversationId: convId, runCount }));
            }
        }
        try {
            saveMessage(convId, 'user', message.substring(0, 10000));
        }
        catch { }
        // Track thinking session for this heartbeat run
        let activeThinkingSessionId = null;
        let activeThinkingSynthesis = '';
        const pendingToolArgs = new Map();
        const chunks = [];
        try {
            await chat(convId, message, (event) => {
                if (event.type === 'text' && event.content) {
                    chunks.push(event.content);
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({ type: 'chunk', conversationId: convId, content: event.content }));
                        }
                    }
                }
                // --- Tool call broadcasting + thinking interception ---
                if (event.type === 'tool_call_start') {
                    if (event.toolId && event.toolArgs)
                        pendingToolArgs.set(event.toolId, event.toolArgs);
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({
                                type: 'tool_start', conversationId: convId,
                                tool: event.toolName, toolId: event.toolId,
                                server: event.toolArgs?.server, args: event.toolArgs,
                            }));
                        }
                    }
                }
                if (event.type === 'tool_call_end') {
                    const args = event.toolArgs || pendingToolArgs.get(event.toolId || '');
                    if (event.toolId)
                        pendingToolArgs.delete(event.toolId);
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({
                                type: 'tool_end', conversationId: convId,
                                tool: event.toolName, toolId: event.toolId,
                                result: event.toolResult, executionTime: event.executionTime, success: event.success,
                            }));
                        }
                    }
                    // Detect vodou_core_call targeting Vodou-Enhanced-Thinking
                    const server = args?.server;
                    const tool = args?.tool;
                    const isBt4Call = event.toolName === 'vodou_core_call';
                    // CLI path: Bash command containing "vodou-core call Vodou-Enhanced-Thinking"
                    const isBashThinking = event.toolName === 'Bash' &&
                        typeof args?.command === 'string' &&
                        args.command.includes('Vodou-Enhanced-Thinking');
                    if ((isBt4Call && server === 'Vodou-Enhanced-Thinking') || isBashThinking) {
                        try {
                            let result;
                            if (event.toolResult) {
                                // toolResult may be JSON or may have non-JSON wrapper text
                                const jsonMatch = event.toolResult.match(/\{[\s\S]*\}/);
                                if (jsonMatch)
                                    result = JSON.parse(jsonMatch[0]);
                            }
                            if (!result)
                                throw new Error('no result');
                            // Extract tool name from Bash command like: vodou-core call Vodou-Enhanced-Thinking add_thought '{...}'
                            const detectedTool = tool || (isBashThinking
                                ? (args?.command?.match(/Vodou-Enhanced-Thinking\s+(\w+)/)?.[1] || '')
                                : '');
                            if ((detectedTool === 'start_thinking_session' || result.session_id) && !activeThinkingSessionId && result.topic) {
                                activeThinkingSessionId = result.session_id;
                                for (const c of clients.values()) {
                                    if (c.ws.readyState === 1) {
                                        c.ws.send(JSON.stringify({
                                            type: 'thinking_start', conversationId: convId,
                                            sessionId: result.session_id, topic: result.topic || '',
                                            estimatedSteps: result.estimated_steps || 0,
                                        }));
                                    }
                                }
                            }
                            if ((detectedTool === 'add_thought' || result.currentThought) && result.currentThought) {
                                for (const c of clients.values()) {
                                    if (c.ws.readyState === 1) {
                                        c.ws.send(JSON.stringify({
                                            type: 'thinking_step', conversationId: convId,
                                            sessionId: activeThinkingSessionId,
                                            thoughtNumber: result.thoughtNumber, totalThoughts: result.totalThoughts,
                                            thought: result.currentThought, nextThoughtNeeded: result.nextThoughtNeeded,
                                        }));
                                    }
                                }
                            }
                            // A3d: capture synthesis from complete_thinking_session
                            if ((detectedTool === 'complete_thinking_session' || detectedTool?.includes('complete_thinking')) && result.synthesis) {
                                activeThinkingSynthesis = result.synthesis;
                            }
                            if (detectedTool === 'complete_thinking_session' || (result.status === 'completed' && result.totalThoughts)) {
                                for (const c of clients.values()) {
                                    if (c.ws.readyState === 1) {
                                        c.ws.send(JSON.stringify({
                                            type: 'thinking_complete', conversationId: convId,
                                            sessionId: activeThinkingSessionId || result.session_id,
                                            totalThoughts: result.totalThoughts || 0,
                                            synthesis: activeThinkingSynthesis || '',
                                        }));
                                    }
                                }
                            }
                        }
                        catch {
                            // Result wasn't valid JSON or didn't match — ignore
                        }
                    }
                }
                if (event.type === 'done') {
                    const fullResponse = chunks.join('');
                    if (fullResponse.trim()) {
                        try {
                            saveMessage(convId, 'assistant', fullResponse.trim());
                        }
                        catch { }
                    }
                    // HEARTBEAT_OK suppression
                    const suppressOk = process.env.VODOU_HEARTBEAT_SUPPRESS_OK === '1';
                    if (suppressOk && fullResponse.trim() === 'HEARTBEAT_OK')
                        return;
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({
                                type: 'done', conversationId: convId, source: 'heartbeat',
                                thinkingSessionId: activeThinkingSessionId,
                            }));
                        }
                    }
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
                            if (deliveryFreq === 'daily' && elapsed < 86400000)
                                shouldDeliver = false;
                            if (deliveryFreq === 'every_4h' && elapsed < 14400000)
                                shouldDeliver = false;
                        }
                        catch { } // No file = first delivery
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
                                    execSync(`./vodou-core call Vodou-channels ${toolName} '${JSON.stringify({ channel: deliveryTarget, text: condensed })}'`, { timeout: 10000, cwd: getProjectRoot() });
                                    fs.writeFileSync(lastDeliveryPath, JSON.stringify({ timestamp: new Date().toISOString() }));
                                }
                            }
                            catch (e) {
                                console.error('[heartbeat] Channel delivery failed:', e.message);
                            }
                        }
                    }
                }
            });
            res.json({ conversationId: convId, response: chunks.join(''), thinkingSessionId: activeThinkingSessionId });
        }
        catch (error) {
            res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    // Clear conversation
    app.post('/clear', (req, res) => {
        const { conversationId } = req.body;
        if (!conversationId) {
            res.status(400).json({ error: 'conversationId is required' });
            return;
        }
        clearConversation(conversationId);
        res.json({ success: true, message: 'Conversation cleared' });
    });
    // Stats endpoint
    app.get('/stats', (req, res) => {
        const stats = getStats();
        res.json({
            ...stats,
            clients: clients.size,
            clientIds: Array.from(clients.keys())
        });
    });
    // API routes
    app.use('/api/system', systemRouter);
    app.use('/api/servers', serversRouter);
    app.use('/api/skills', skillsRouter);
    app.use('/api/exec', execRouter);
    app.use('/api/intents', intentsRouter);
    app.use('/api/scheduler', schedulerRouter);
    app.use('/api/automations', automationsRouter);
    app.use('/api/scripts', scriptsRouter);
    app.use('/api/logs', logsRouter);
    app.use('/api/memory', memoryRouter);
    app.use('/api/memory/extractor', memoryExtractorRouter);
    app.use('/api/conversations', conversationsRouter);
    app.use('/api/files', filesRouter);
    app.use('/api/link-preview', linkPreviewRouter);
    app.use('/api/onboarding', onboardingRouter);
    app.use('/api/channels', channelsRouter);
    app.use('/api/cascade/readiness', cascadeReadinessRouter);
    app.use('/api/settings', settingsRouter);
    app.use('/api/tools', toolsRouter);
    app.use('/api/route', routeRouter);
    app.use('/api/workflows', workflowsRouter);
    app.use('/api/webhooks', webhooksRouter);
    app.use('/api/usage', usageRouter);
    app.use('/api/docs', docsRouter);
    app.use('/api/oauth', oauthRouter);
    app.use('/api/mcp-registry', mcpRegistryRouter);
    app.use('/api/profile', profileRouter);
    app.use('/api/workbench', workbenchRouter);
    // OpenAI-compatible API — /v1/chat/completions, /v1/models
    app.use('/v1', openaiCompatRouter);
    console.error(`[Gateway] OpenAI-compatible API mounted at /v1${process.env.VODOU_OPENAI_COMPAT_TOKEN ? ' (bearer auth enabled)' : ' (open — set VODOU_OPENAI_COMPAT_TOKEN for auth)'}`);
    // --- Identity — serve user + AI names from workspace config ---
    app.get('/api/identity', (_req, res) => {
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
                if (raw && !raw.startsWith('_'))
                    userName = raw;
            }
            catch { }
            try {
                const identity = fs.readFileSync(path.join(wsDir, 'IDENTITY.md'), 'utf-8');
                const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
                const emojiMatch = identity.match(/\*\*Emoji:\*\*\s*(.+)/);
                if (nameMatch?.[1]?.trim())
                    aiName = nameMatch[1].trim();
                if (emojiMatch?.[1]?.trim())
                    aiEmoji = emojiMatch[1].trim();
            }
            catch { }
            const userAvatar = getSetting('user_avatar') || '';
            // Default to the bundled VODOU logo when nothing overrides it.
            // chat.js renders an <img> when avatarText starts with "/" or "http".
            const aiAvatar = getSetting('ai_avatar') || '/icons/vodou-icon.png';
            const aiAvatarColor = getSetting('ai_avatar_color') || '#6B7280';
            res.json({ userName, aiName, aiEmoji, aiAvatar, userAvatar, aiAvatarColor });
        }
        catch {
            res.json({ userName: 'User', aiName: 'VODOU', aiEmoji: '', aiAvatar: '/icons/vodou-icon.png', userAvatar: '', aiAvatarColor: '#6B7280' });
        }
    });
    // Paginated gateway chat history (main chat "Load earlier" — same transforms as WS `history`)
    app.get('/api/chat/history', (req, res) => {
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
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    // --- I5: Confirm-to-run — execute a heartbeat suggestion ---
    app.post('/api/heartbeat/run', async (req, res) => {
        const { suggestion } = req.body;
        if (!suggestion) {
            res.status(400).json({ error: 'suggestion text required' });
            return;
        }
        if (!isConfigured()) {
            res.status(500).json({ error: 'LLM not configured' });
            return;
        }
        const convId = 'vodou-heartbeat';
        ensureConversation(convId, 'Vodou Heartbeat', 'heartbeat', 'Vodou');
        const userMsg = `[User approved] Run this suggestion: ${suggestion}`;
        try {
            saveMessage(convId, 'user', userMsg);
        }
        catch { }
        const chunks = [];
        try {
            await chat(convId, userMsg, (event) => {
                if (event.type === 'text' && event.content) {
                    chunks.push(event.content);
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({ type: 'chunk', conversationId: convId, content: event.content }));
                        }
                    }
                }
                if (event.type === 'done') {
                    const full = chunks.join('');
                    if (full.trim()) {
                        try {
                            saveMessage(convId, 'assistant', full.trim());
                        }
                        catch { }
                    }
                    for (const c of clients.values()) {
                        if (c.ws.readyState === 1) {
                            c.ws.send(JSON.stringify({ type: 'done', conversationId: convId, source: 'heartbeat' }));
                        }
                    }
                }
            });
            res.json({ conversationId: convId, response: chunks.join('') });
        }
        catch (error) {
            res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    // --- Heartbeat directive — read/write HEARTBEAT.md template ---
    app.get('/api/heartbeat/directive', (_req, res) => {
        try {
            const tplPath = path.join(getProjectRoot(), 'templates', 'HEARTBEAT.md');
            const content = fs.readFileSync(tplPath, 'utf-8');
            res.json({ content });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    app.put('/api/heartbeat/directive', (req, res) => {
        try {
            const { content } = req.body;
            if (typeof content !== 'string') {
                res.status(400).json({ error: 'content (string) required' });
                return;
            }
            const tplPath = path.join(getProjectRoot(), 'templates', 'HEARTBEAT.md');
            fs.writeFileSync(tplPath, content, 'utf-8');
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // --- Heartbeat task helpers ---
    /**
     * Extract canonical title for dedup — mirrors src/task_ledger.rs::task_title().
     * Rules: first **bold**, first __underscore__, before " — ", before ":", whole line.
     * Then strip emoji/markdown, trim, lowercase.
     */
    function taskTitleForDedup(text) {
        if (!text)
            return '';
        let s = text.trim().replace(/^-\s*\[[ xX]?\]\s*/, '');
        // Rule 1: **bold**
        const bold = s.match(/\*\*([^*]+)\*\*/);
        if (bold?.[1]?.trim())
            return normalizeTaskTitle(bold[1]);
        // Rule 2: __underscore__
        const under = s.match(/__([^_]+)__/);
        if (under?.[1]?.trim())
            return normalizeTaskTitle(under[1]);
        // Rule 3: before em-dash
        const dashIdx = s.indexOf(' \u2014 ');
        if (dashIdx > 0)
            return normalizeTaskTitle(s.slice(0, dashIdx));
        // Rule 4: before colon
        const colonIdx = s.indexOf(':');
        if (colonIdx > 0)
            return normalizeTaskTitle(s.slice(0, colonIdx));
        return normalizeTaskTitle(s);
    }
    function normalizeTaskTitle(s) {
        return s
            .replace(/[*_`#]/g, '')
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    // --- I6: Today strip — task list from latest heartbeat ---
    app.get('/api/heartbeat/tasks', (req, res) => {
        try {
            // Read task ledger if exists
            const ledgerPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'task_ledger.json');
            let tasks = [];
            try {
                const raw = fs.readFileSync(ledgerPath, 'utf-8');
                const ledger = JSON.parse(raw);
                tasks = (ledger.tasks || []).filter((t) => t.status === 'open');
            }
            catch { }
            // Fallback: parse from latest heartbeat message
            if (tasks.length === 0) {
                const gwDb = getGatewayDb();
                const lastMsg = gwDb.prepare("SELECT content FROM gateway_messages WHERE conversation_id='vodou-heartbeat' AND role='assistant' ORDER BY id DESC LIMIT 1").get();
                if (lastMsg?.content) {
                    for (const line of lastMsg.content.split('\n')) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- []')) {
                            tasks.push({ text: trimmed.replace(/^- \[[ ]?\]\s*/, ''), status: 'open' });
                        }
                        else if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
                            tasks.push({ text: trimmed.replace(/^- \[[xX]\]\s*/, ''), status: 'done' });
                        }
                    }
                }
            }
            // Deduplicate by title (mirrors task_title() from src/task_ledger.rs)
            const seen = new Set();
            tasks = tasks.filter((t) => {
                const key = taskTitleForDedup(t.text || '');
                if (!key || seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
            // A3f: filter stale tasks + cap
            tasks = tasks.filter((t) => {
                const staleRuns = t.stale_runs ?? (t.stale === true ? 3 : 0);
                return staleRuns < 3;
            });
            tasks.sort((a, b) => (b.last_seen_run || 0) - (a.last_seen_run || 0));
            tasks = tasks.slice(0, 10);
            res.json(tasks);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /api/heartbeat/tasks/dismiss — remove a task from the ledger
    app.post('/api/heartbeat/tasks/dismiss', (req, res) => {
        try {
            const { text } = req.body;
            if (!text) {
                res.status(400).json({ error: 'text required' });
                return;
            }
            const ledgerPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'task_ledger.json');
            let remaining = 0;
            withLedgerLock(ledgerPath, (ledger) => {
                if (ledger.tasks) {
                    ledger.tasks = ledger.tasks.filter((t) => t.text !== text);
                    remaining = ledger.tasks.length;
                }
            });
            res.json({ success: true, remaining });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // A3e: GET /api/heartbeat/briefing — latest structured response
    app.get('/api/heartbeat/briefing', (_req, res) => {
        try {
            const messages = loadRecentMessages('vodou-heartbeat', 10);
            const latest = [...messages].reverse().find(m => m.role === 'assistant' && m.content.trim() !== 'HEARTBEAT_OK');
            if (!latest)
                return res.json(null);
            res.json({ content: latest.content, timestamp: latest.created_at.replace(' ', 'T') + 'Z' });
        }
        catch {
            res.json(null);
        }
    });
    // A3e: PUT /api/heartbeat/tasks/complete
    app.put('/api/heartbeat/tasks/complete', (req, res) => {
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
        }
        catch {
            res.json({ ok: false });
        }
    });
    // A3e: POST /api/heartbeat/feedback
    app.post('/api/heartbeat/feedback', (req, res) => {
        const { run, reaction } = req.body;
        const fbPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'heartbeat_feedback.json');
        try {
            const data = fs.existsSync(fbPath) ? JSON.parse(fs.readFileSync(fbPath, 'utf8')) : [];
            data.push({ run, reaction, timestamp: new Date().toISOString() });
            while (data.length > 50)
                data.shift();
            fs.writeFileSync(fbPath, JSON.stringify(data, null, 2));
            res.json({ ok: true });
        }
        catch {
            res.json({ ok: false });
        }
    });
    // --- H6: Heartbeat metrics ---
    app.get('/api/heartbeat/stats', (req, res) => {
        try {
            const db = getDb();
            const today = new Date().toISOString().slice(0, 10);
            // Runs today
            const runsToday = db.prepare("SELECT COUNT(*) as c FROM work_logs WHERE message LIKE '%heartbeat%' AND timestamp LIKE ?").get(`${today}%`)?.c || 0;
            // Total runs
            const totalRuns = db.prepare("SELECT COUNT(*) as c FROM work_logs WHERE message LIKE '%heartbeat%'").get()?.c || 0;
            // Failures today
            const failuresToday = db.prepare("SELECT COUNT(*) as c FROM work_logs WHERE message LIKE '%heartbeat%' AND (message LIKE '%fail%' OR message LIKE '%error%' OR message LIKE '%timeout%') AND timestamp LIKE ?").get(`${today}%`)?.c || 0;
            // Last run
            const lastRun = db.prepare("SELECT timestamp, message, metadata FROM work_logs WHERE message LIKE '%heartbeat%' ORDER BY timestamp DESC LIMIT 1").get();
            // Avg response time from metadata
            const recentRuns = db.prepare("SELECT metadata FROM work_logs WHERE message LIKE '%heartbeat%' AND metadata IS NOT NULL ORDER BY timestamp DESC LIMIT 20").all();
            let avgMs = 0;
            let avgChars = 0;
            let count = 0;
            for (const r of recentRuns) {
                try {
                    const m = JSON.parse(r.metadata);
                    if (m.elapsed_ms) {
                        avgMs += m.elapsed_ms;
                        count++;
                    }
                    if (m.response_chars)
                        avgChars += m.response_chars;
                }
                catch { }
            }
            if (count > 0) {
                avgMs = Math.round(avgMs / count);
                avgChars = Math.round(avgChars / count);
            }
            // Consecutive failures
            let consecutiveFailures = 0;
            try {
                const fp = fs.readFileSync(path.join(getProjectRoot(), '.vodou', 'workspace', 'heartbeat_failures.json'), 'utf-8');
                consecutiveFailures = JSON.parse(fp).consecutive_failures || 0;
            }
            catch { }
            // Task info
            const task = db.prepare("SELECT run_count, next_run_at, last_run_at, enabled FROM scheduled_tasks WHERE name = 'vodou-heartbeat'").get();
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
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // --- Thinking session API ---
    // GET /api/thinking/recent — list recent thinking sessions
    app.get('/api/thinking/recent', (req, res) => {
        const tdb = getThinkingDb();
        if (!tdb) {
            res.status(503).json({ error: 'thinking.db not available' });
            return;
        }
        try {
            const limit = Math.min(parseInt(req.query.limit) || 10, 50);
            const sessions = tdb.prepare(`SELECT s.session_id, s.topic, s.status, s.created_at, s.completed_at,
                COUNT(t.id) as thought_count
         FROM thinking_sessions s
         LEFT JOIN thoughts t ON t.session_id = s.session_id
         GROUP BY s.session_id
         ORDER BY s.created_at DESC
         LIMIT ?`).all(limit);
            res.json(sessions.map((s) => ({
                id: s.session_id,
                topic: s.topic,
                status: s.status,
                thoughtCount: s.thought_count,
                createdAt: s.created_at,
                completedAt: s.completed_at,
            })));
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // GET /api/thinking/:sessionId — retrieve a completed thinking session
    app.get('/api/thinking/:sessionId', (req, res) => {
        const sessionId = decodeURIComponent(req.params.sessionId || '');
        if (!sessionId) {
            res.status(400).json({ error: 'sessionId required' });
            return;
        }
        const tdb = getThinkingDb();
        if (!tdb) {
            res.status(503).json({ error: 'thinking.db not available' });
            return;
        }
        try {
            const session = tdb.prepare('SELECT session_id, topic, status, created_at, completed_at, metadata FROM thinking_sessions WHERE session_id = ?').get(sessionId);
            if (!session) {
                res.status(404).json({ error: 'Session not found' });
                return;
            }
            const thoughts = tdb.prepare(`SELECT thought_number, thought_text, total_thoughts, is_revision, revises_thought,
                branch_from_thought, branch_id, next_thought_needed, created_at
         FROM thoughts WHERE session_id = ? ORDER BY thought_number ASC`).all(sessionId);
            let metadata = null;
            try {
                metadata = session.metadata ? JSON.parse(session.metadata) : null;
            }
            catch { }
            res.json({
                session: {
                    id: session.session_id,
                    topic: session.topic,
                    status: session.status,
                    createdAt: session.created_at,
                    completedAt: session.completed_at,
                    metadata,
                },
                thoughts: thoughts.map((t) => ({
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
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Delete a gateway chat tab conversation (SQLite + in-memory + workflow + skill cache)
    app.delete('/api/gateway/conversation/:conversationId', (req, res) => {
        const conversationId = decodeURIComponent(req.params.conversationId || '');
        if (!conversationId) {
            res.status(400).json({ error: 'conversationId required' });
            return;
        }
        try {
            deleteGatewayConversation(conversationId);
        }
        catch (e) {
            console.error('[Gateway] deleteGatewayConversation:', e);
        }
        try {
            clearConversation(conversationId);
        }
        catch (e) {
            console.error('[Gateway] clearConversation:', e);
        }
        skillConversations.delete(conversationId);
        if (persistentConversationId === conversationId) {
            persistentConversationId = randomUUID();
        }
        res.json({ ok: true });
    });
    // Static files (dashboard SPA)
    const publicDir = path.join(__dirname, '..', 'public');
    if (!fs.existsSync(publicDir)) {
        console.error(`[FATAL] Public directory not found: ${publicDir}`);
        console.error(`  Expected at: ${path.resolve(publicDir)}`);
        console.error(`  Gateway cannot serve the web UI without it.`);
        console.error(`  Fix: Re-extract the Vodou archive or check your installation.`);
    }
    app.use(express.static(publicDir, {
        // View scripts are edited often; avoid stale Apps / SPA chunks after deploy.
        setHeaders(res, filePath) {
            if (filePath.endsWith('.js') && filePath.includes(`${path.sep}public${path.sep}js${path.sep}`)) {
                res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            }
        },
    }));
    // Serve node_modules for xterm.js (browser ESM imports)
    const nodeModulesDir = path.join(__dirname, '..', 'node_modules');
    app.use('/node_modules', express.static(nodeModulesDir));
    // Fallback to index.html for SPA routing
    app.get('/', (req, res) => {
        const indexPath = path.resolve(publicDir, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        }
        else {
            res.status(500).send(`<h1>Vodou Gateway</h1><p>Web UI not found at: ${indexPath}</p><p>Re-extract the Vodou archive or run <code>./start-vodou-services.sh</code> from the install directory.</p>`);
        }
    });
    return app;
}
/**
 * Setup WebSocket server for streaming
 */
function setupWebSocket(server) {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const client = {
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
        // UI history only. LLM uses in-memory ConversationManager (no gateway.db replay on cold start in this package).
        let historyMessages = [];
        let hasMore = false;
        try {
            const dbMessages = loadRecentMessages(persistentConversationId, UI_CHAT_HISTORY_PAGE_SIZE);
            hasMore = historyPageHasOlder(persistentConversationId, dbMessages);
            historyMessages = formatGatewayHistoryForWebUi(persistentConversationId, dbMessages);
        }
        catch { }
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
                if (!c.updated_at)
                    return false;
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
                })),
            }));
        }
        catch { }
        // Per-conversation chat queue: prevents duplicate/concurrent requests
        const _chatQueue = new Map();
        ws.on('message', async (data) => {
            try {
                const parsed = JSON.parse(data.toString());
                if (parsed.type === 'message' && parsed.content) {
                    // Check if configured
                    if (!isConfigured()) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'API not configured. Set ANTHROPIC_API_KEY.'
                        }));
                        return;
                    }
                    // Use provided conversationId or client's default
                    const convId = parsed.conversationId || client.conversationId;
                    // --- Dedup + mutex: drop duplicate messages, serialize concurrent ones ---
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
                        if (prev)
                            await prev.catch(() => { });
                        client.activeConvId = convId;
                        client.aborted = false;
                        // Save user message to DB (clean version without Vodou tags, unless debug mode)
                        const cleanContent = (showRawResults() ? parsed.content : parsed.content
                            .replace(/<oi_results>[\s\S]*?<\/oi_results>[^]*/s, ''))
                            .replace(/<file[^>]*>[\s\S]*?<\/file>/g, '[file attached]')
                            .substring(0, 10000)
                            .trim();
                        if (cleanContent) {
                            try {
                                saveMessage(convId, 'user', cleanContent);
                            }
                            catch { }
                        }
                        // Track assistant response for DB save
                        let assistantFullText = '';
                        // Resolve scope from conversation.source — scoped workbench conversations
                        // (source = workbench:integration:linear etc.) get scope-aware system
                        // prompts and tool filtering. Unscoped (`web`, channels) → scope = null.
                        const scope = resolveScope(getConversation(convId)?.source);
                        // Stream response — include conversationId in every event so client routes to correct tab
                        await chat(convId, parsed.content, (event) => {
                            // If user hit stop, swallow remaining events
                            if (client.aborted)
                                return;
                            switch (event.type) {
                                case 'text':
                                    assistantFullText += event.content || '';
                                    ws.send(JSON.stringify({
                                        type: 'chunk',
                                        conversationId: convId,
                                        content: event.content
                                    }));
                                    break;
                                case 'tool_call_start':
                                    ws.send(JSON.stringify({
                                        type: 'tool_start',
                                        conversationId: convId,
                                        tool: event.toolName,
                                        toolId: event.toolId,
                                        server: event.serverName,
                                        args: event.toolArgs,
                                    }));
                                    break;
                                case 'tool_call_end':
                                    ws.send(JSON.stringify({
                                        type: 'tool_end',
                                        conversationId: convId,
                                        tool: event.toolName,
                                        toolId: event.toolId,
                                        result: event.toolResult,
                                        executionTime: event.executionTime,
                                        success: event.success,
                                    }));
                                    break;
                                case 'usage':
                                    ws.send(JSON.stringify({
                                        type: 'usage',
                                        conversationId: convId,
                                        usage: event.usage,
                                    }));
                                    break;
                                case 'status':
                                    ws.send(JSON.stringify({
                                        type: 'status',
                                        conversationId: convId,
                                        status: event.status,
                                    }));
                                    break;
                                case 'error':
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        conversationId: convId,
                                        message: event.error
                                    }));
                                    break;
                                case 'done':
                                    // Save assistant response to DB
                                    if (assistantFullText.trim()) {
                                        try {
                                            saveMessage(convId, 'assistant', assistantFullText.trim());
                                        }
                                        catch { }
                                    }
                                    // Track API usage/cost
                                    if (event.usage) {
                                        saveUsage(convId, getActiveModelLabel(), event.usage.model || '', event.usage);
                                    }
                                    const memoriesUsed = getLastMemoryUsed(convId);
                                    ws.send(JSON.stringify({
                                        type: 'done',
                                        conversationId: convId,
                                        activeModel: getActiveModelLabel(),
                                        usage: event.usage,
                                        memory: {
                                            used: memoriesUsed.length,
                                            total: getTotalMemoryCount(),
                                            items: memoriesUsed.slice(0, 5),
                                            // PLAN-MEMORY-VISIBILITY-UI Phase B.2 — structured per-chunk debug.
                                            debug: getLastMemoryDebug(convId),
                                        },
                                    }));
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
                                                // Unified convId `workbench:channel:<type>` doesn't encode
                                                // the recipient, so skip auto-forward for that shape.
                                                // (Chat-view typing into a channel workbench = user talking
                                                // to Vodou about the channel, not broadcasting to it.)
                                                // Legacy per-sender convIds still work via the slice split.
                                                if (convId.startsWith('workbench:channel:')) {
                                                    console.error('[Gateway] Unified channel workbench conv — no auto-forward (recipient not encoded in convId)');
                                                }
                                                else {
                                                    const parts = convId.split(':');
                                                    const recipient = parts.length > 1 ? parts.slice(1).join(':') : '';
                                                    if (recipient) {
                                                        console.error(`[Gateway] Forwarding to ${conv.source} channel: ${recipient}`);
                                                        forwardToChannel(conv.source, recipient, assistantFullText.trim());
                                                    }
                                                }
                                            }
                                            else {
                                                // Web conversation — standalone, no channel forwarding
                                                console.error(`[Gateway] Web conv — standalone, skipping channel forward`);
                                            }
                                        }
                                        catch (e) {
                                            console.error(`[Gateway] Forward error:`, e);
                                        }
                                    }
                                    client.activeConvId = undefined;
                                    break;
                            }
                        }, { scope });
                    })(); // end chatPromise async wrapper
                    entry.promise = chatPromise;
                    await chatPromise;
                }
                else if (parsed.type === 'skill_message' && parsed.content) {
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
                                .get(skillName);
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
                                    }
                                    catch { }
                                }
                            }
                        }
                        catch (err) {
                            console.error('[Gateway] skill_message: disk fallback failed:', err);
                        }
                    }
                    if (!skillContent) {
                        ws.send(JSON.stringify({ type: 'error', conversationId: convId, message: 'No skill content for this conversation' }));
                        return;
                    }
                    // Save user message to DB
                    const cleanContent = parsed.content.substring(0, 10000).trim();
                    if (cleanContent) {
                        try {
                            ensureConversation(convId, parsed.skillName || convId.replace(/^workbench:skill:/, '') || 'Skill');
                        }
                        catch { }
                        try {
                            saveMessage(convId, 'user', cleanContent);
                        }
                        catch { }
                    }
                    let assistantFullText = '';
                    await chatWithSkill(convId, parsed.content, skillContent, (event) => {
                        if (client.aborted)
                            return;
                        switch (event.type) {
                            case 'text':
                                assistantFullText += event.content || '';
                                ws.send(JSON.stringify({ type: 'chunk', conversationId: convId, content: event.content }));
                                break;
                            case 'tool_call_start':
                                ws.send(JSON.stringify({ type: 'tool_start', conversationId: convId, tool: event.toolName, toolId: event.toolId, server: event.serverName, args: event.toolArgs }));
                                break;
                            case 'tool_call_end':
                                ws.send(JSON.stringify({ type: 'tool_end', conversationId: convId, tool: event.toolName, toolId: event.toolId, result: event.toolResult, executionTime: event.executionTime, success: event.success }));
                                break;
                            case 'usage':
                                ws.send(JSON.stringify({ type: 'usage', conversationId: convId, usage: event.usage }));
                                break;
                            case 'error':
                                ws.send(JSON.stringify({ type: 'error', conversationId: convId, message: event.error }));
                                break;
                            case 'done':
                                if (assistantFullText.trim()) {
                                    try {
                                        saveMessage(convId, 'assistant', assistantFullText.trim());
                                    }
                                    catch { }
                                }
                                ws.send(JSON.stringify({ type: 'done', conversationId: convId, usage: event.usage }));
                                client.activeConvId = undefined;
                                break;
                        }
                    });
                }
                else if (parsed.type === 'switch_conversation') {
                    // Switch to an existing or new conversation
                    const targetId = parsed.conversationId || randomUUID();
                    client.conversationId = targetId;
                    // Always load from DB — it's the source of truth.
                    // UI history only. LLM uses in-memory ConversationManager (no gateway.db replay on cold start in this package).
                    let switchMessages = [];
                    let switchHasMore = false;
                    try {
                        const dbMessages = loadRecentMessages(targetId, UI_CHAT_HISTORY_PAGE_SIZE);
                        switchHasMore = historyPageHasOlder(targetId, dbMessages);
                        switchMessages = formatGatewayHistoryForWebUi(targetId, dbMessages);
                    }
                    catch { }
                    // Handle title updates from client
                    if (parsed.title) {
                        try {
                            updateConversationTitle(targetId, parsed.title);
                        }
                        catch { }
                    }
                    ws.send(JSON.stringify({
                        type: 'history',
                        conversationId: targetId,
                        messages: switchMessages,
                        hasMore: switchHasMore,
                    }));
                    // Pre-warm Claude CLI session so first message has no cold start
                    warmupCliSession(targetId);
                }
                else if (parsed.type === 'update_title') {
                    if (parsed.conversationId && parsed.title) {
                        try {
                            updateConversationTitle(parsed.conversationId, parsed.title);
                        }
                        catch { }
                    }
                }
                else if (parsed.type === 'stop') {
                    // User hit the stop button — abort current streaming
                    client.aborted = true;
                    client.activeConvId = undefined;
                    ws.send(JSON.stringify({ type: 'stopped', conversationId: parsed.conversationId }));
                    console.error(`[Gateway] Client ${clientId} stopped streaming`);
                }
                else if (parsed.type === 'clear') {
                    clearConversation(client.conversationId);
                    const newId = randomUUID();
                    persistentConversationId = newId;
                    client.conversationId = newId;
                    ws.send(JSON.stringify({
                        type: 'cleared',
                        conversationId: newId,
                        message: 'Conversation cleared'
                    }));
                }
                else if (parsed.type === 'flush') {
                    // Browser tab closing — flush memory (equivalent to CLI SessionEnd)
                    triggerMemoryFlush();
                }
                else if (parsed.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    // --- Terminal PTY messages ---
                }
                else if (parsed.type === 'terminal_start') {
                    createTerminal(clientId, ws, undefined, parsed.cols, parsed.rows);
                }
                else if (parsed.type === 'terminal_input') {
                    writeTerminal(clientId, parsed.data);
                }
                else if (parsed.type === 'terminal_resize') {
                    resizeTerminal(clientId, parsed.cols, parsed.rows);
                }
            }
            catch (error) {
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
/**
 * Cleanup on shutdown
 */
function cleanup(signal) {
    console.error(`[Gateway] Shutting down (${signal ?? 'unknown'})...`);
    // Close all WebSocket connections
    for (const client of clients.values()) {
        client.ws.close();
    }
    clients.clear();
    // Kill all terminal sessions
    destroyAllTerminals();
    // Close servers
    if (wss)
        wss.close();
    if (server)
        server.close();
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
function gatewayAutoEnsureEnabled() {
    const v = process.env.VODOU_GATEWAY_AUTO_ENSURE ?? process.env.OI_GATEWAY_AUTO_ENSURE;
    if (v === undefined || v === '')
        return true;
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
    // Kill any stale gateway process on our port before starting
    try {
        const port = parseInt(process.env.WEB_PORT || '8767', 10);
        const { execSync: ex } = await import('child_process');
        const stalePids = ex(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        if (stalePids) {
            for (const pid of stalePids.split('\n').filter(Boolean)) {
                if (parseInt(pid, 10) !== process.pid) {
                    console.error(`[Gateway] Killing stale process on port ${port} (PID ${pid})`);
                    try {
                        process.kill(parseInt(pid, 10), 'SIGTERM');
                    }
                    catch { }
                }
            }
            // Brief wait for port release
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    catch { }
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
    console.error('');
    // Setup Express and WebSocket
    app = setupExpress();
    server = createServer(app);
    wss = setupWebSocket(server);
    // Ensure daemon + worker sockets are ready (memory search, BrainLoader fast path)
    {
        const bt4 = path.join(getProjectRoot(), 'vodou-core');
        const oiDir = path.join(getProjectRoot(), '.vodou');
        const daemonSock = path.join(oiDir, 'daemon.sock');
        const workerSock = path.join(oiDir, 'worker.sock');
        // Clean stale sockets before ensuring (prevents "address in use" failures)
        for (const sock of [daemonSock, workerSock]) {
            if (fs.existsSync(sock)) {
                try {
                    // Quick connect test — if it fails, socket is stale
                    const net = await import('net');
                    await new Promise((resolve, reject) => {
                        const c = net.createConnection(sock);
                        const timer = setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, 1000);
                        c.on('connect', () => { clearTimeout(timer); c.destroy(); resolve(); });
                        c.on('error', () => { clearTimeout(timer); reject(new Error('dead')); });
                    });
                }
                catch {
                    console.error(`[Gateway] Removing stale socket: ${path.basename(sock)}`);
                    try {
                        fs.unlinkSync(sock);
                    }
                    catch { }
                }
            }
        }
        if (!gatewayAutoEnsureEnabled()) {
            console.error('[Gateway] VODOU_GATEWAY_AUTO_ENSURE=0 — skipping daemon/worker ensure (startup + periodic). Use when replacing vodou-core; restart gateway after swap.');
        }
        else {
            // Ensure daemon — killSignal SIGKILL so timeout actually kills UE-state processes
            // (default SIGTERM is ignored by macOS UE/uninterruptible-sleep processes,
            // causing this execSync to hang forever and block gateway startup).
            try {
                execSync(`"${bt4}" daemon ensure`, { cwd: getProjectRoot(), timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'inherit'] });
            }
            catch { }
            // Ensure worker — same SIGKILL fix
            try {
                execSync(`"${bt4}" worker ensure`, { cwd: getProjectRoot(), timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'inherit'] });
            }
            catch { }
            // Wait for sockets to appear (up to 5s)
            const waitForSocket = async (sockPath, label) => {
                for (let i = 0; i < 10; i++) {
                    if (fs.existsSync(sockPath)) {
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
            // Periodic ensure — re-runs `daemon ensure` + `worker ensure` every 60s.
            // Both are idempotent (no-op when sockets are healthy) and cheap (~10ms).
            // Catches the case where the worker dies mid-session — without this, the
            // gateway falls back to spawning `vodou-core call ...` per request,
            // producing the spawn storm Chad reported on 2026-04-25.
            setInterval(() => {
                try {
                    execSync(`"${bt4}" daemon ensure`, { cwd: getProjectRoot(), timeout: 5_000, killSignal: 'SIGKILL', stdio: 'ignore' });
                    execSync(`"${bt4}" worker ensure`, { cwd: getProjectRoot(), timeout: 5_000, killSignal: 'SIGKILL', stdio: 'ignore' });
                }
                catch {
                    /* swallow — next tick will retry */
                }
            }, 60_000).unref();
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
    }
    catch (err) {
        console.error('[Gateway] Janitor error (non-fatal):', err.message);
    }
    // Reconnect all MCP servers — non-blocking so HTTP listener starts immediately
    {
        const bt4 = path.join(getProjectRoot(), 'vodou-core');
        if (fs.existsSync(bt4)) {
            console.error('[Gateway] Reconnecting MCP servers (background)...');
            const child = spawn(bt4, ['reconnect-all'], {
                cwd: getProjectRoot(),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.on('close', (code) => {
                if (code === 0) {
                    const connected = (stdout.match(/✅ Reconnected/g) || []).length;
                    const failed = (stdout.match(/❌/g) || []).length;
                    console.error(`[Gateway] MCP servers: ${connected} connected, ${failed} failed`);
                    if (failed > 0) {
                        const lines = stdout.split('\n').filter((l) => l.includes('❌'));
                        for (const line of lines)
                            console.error(`  ${line.trim()}`);
                    }
                }
                else {
                    console.error(`[Gateway] reconnect-all exited ${code}`);
                }
            });
            // Kill if it takes more than 30s
            setTimeout(() => { try {
                child.kill('SIGTERM');
            }
            catch { } }, 30_000);
        }
    }
    // Start server
    await new Promise((resolve) => {
        server.listen(PORT, () => {
            console.error(`Vodou-Console running on http://localhost:${PORT}`);
            console.error('');
            console.error('Endpoints:');
            console.error(`  Web UI:    http://localhost:${PORT}/`);
            console.error(`  WebSocket: ws://localhost:${PORT}/`);
            console.error(`  REST API:  http://localhost:${PORT}/chat`);
            console.error(`  Health:    http://localhost:${PORT}/health`);
            console.error('');
            resolve();
        });
    });
    // Auto-register any SKILL.md files not yet in skills_registry
    syncSkillsFromFilesystem().catch((err) => console.error('[Skills] Startup sync failed:', err));
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
            const proc = require('child_process').spawn(cliBin, ['-p', '--model', 'haiku', '--output-format', 'text', '--system-prompt', 'You output one word: OK.'], { cwd: os.tmpdir(), env: cliEnv, stdio: ['pipe', 'ignore', 'ignore'] });
            proc.stdin.write('Reply with OK.');
            proc.stdin.end();
            proc.on('close', () => {
                console.error(`[ExecDesk] claude-cli warmup completed in ${Date.now() - startMs}ms`);
            });
            proc.on('error', () => { });
        }
        catch { /* warmup is fire-and-forget */ }
    })();
    // Periodic MCP server health check — reconnect any that dropped
    const MCP_HEALTH_INTERVAL = parseInt(process.env.VODOU_MCP_HEALTH_INTERVAL_MS || '300000', 10); // 5 min
    setInterval(() => {
        const bt4 = path.join(getProjectRoot(), 'vodou-core');
        if (!fs.existsSync(bt4))
            return;
        try {
            const result = execSync(`"${bt4}" health-check`, {
                cwd: getProjectRoot(),
                timeout: 30_000,
                killSignal: 'SIGKILL',
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const failedServers = result.split('\n')
                .filter((l) => l.includes('❌'))
                .map((l) => {
                // Health-check format: "  Testing <server>: ❌ Connection failed: ..."
                // Old regex /❌\s+(\S+)/ wrongly captured "Connection" from "❌ Connection failed".
                const m = l.match(/Testing\s+(\S+?):/);
                return m ? m[1] : null;
            })
                .filter(Boolean);
            if (failedServers.length > 0) {
                console.error(`[HealthCheck] ${failedServers.length} servers down: ${failedServers.join(', ')} — reconnecting`);
                for (const srv of failedServers) {
                    try {
                        execSync(`"${bt4}" reconnect ${srv}`, {
                            cwd: getProjectRoot(),
                            timeout: 15_000,
                            killSignal: 'SIGKILL',
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        console.error(`  ✅ Reconnected: ${srv}`);
                    }
                    catch {
                        console.error(`  ❌ Failed to reconnect: ${srv}`);
                    }
                }
            }
        }
        catch { }
    }, MCP_HEALTH_INTERVAL);
    // Handle shutdown signals — cleanup() closes all DBs (WAL checkpoint) before exit
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
}
// Run
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
