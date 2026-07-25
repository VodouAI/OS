/**
 * Slack Channel Implementation
 */

import { readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
// @ts-ignore - CommonJS module
import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import { saveBufferAsAttachment } from '../channel-attachment-download.js';
import { Attachment, Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '../types.js';
import { AllowlistWatcher, normalizeSlackHandle, isSlackRoomId } from '../channel-allowlist.js';
import { recordLastSlackChannel } from './slack-session-upload.js';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

// P1-19: install the Slack disconnect handler at most once per process.
let _slackDisconnectHandlerInstalled = false;

// Type for Slack App
type SlackApp = InstanceType<typeof App>;

export class SlackChannel implements Channel {
  type = 'slack' as const;
  private app: SlackApp | null = null;
  private botToken: string;
  private appToken: string;
  private signingSecret: string;
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  /** Bot's OWN Slack user id (from auth.test). Used to drop self-echoes that arrive without a bot_id. */
  private botUserId: string | null = null;
  private processedMessages = new Set<string>(); // Dedup: track processed message timestamps
  private allowlist: AllowlistWatcher | null = null;
  /** Slack user id → display label (bounded LRU). */
  private userLabelCache = new Map<string, string>();
  private static usersInfoErrorLogged = new Set<string>();

  constructor() {
    this.botToken = process.env.SLACK_BOT_TOKEN || '';
    this.appToken = process.env.SLACK_APP_TOKEN || '';
    this.signingSecret = process.env.SLACK_SIGNING_SECRET || '';
  }

  /** Best-effort display string from a Slack `user` / `member` object (users.info / users.list). */
  private pickSlackDisplayLabelFromUser(u: Record<string, unknown> | null | undefined, fallbackId: string): string {
    if (!u || typeof u !== 'object') return fallbackId;
    const prof = (u.profile as Record<string, unknown> | undefined) || {};
    const first = prof.first_name != null ? String(prof.first_name).trim() : '';
    const last = prof.last_name != null ? String(prof.last_name).trim() : '';
    const combined = [first, last].filter(Boolean).join(' ').trim();
    const label =
      (prof.real_name != null && String(prof.real_name).trim()) ||
      (prof.display_name != null && String(prof.display_name).trim()) ||
      (u.real_name != null && String(u.real_name).trim()) ||
      (u.name != null && String(u.name).trim()) ||
      combined ||
      fallbackId;
    return label.length > 80 ? label.slice(0, 77) + '…' : label;
  }

  private rememberLabel(userId: string, label: string): void {
    this.userLabelCache.set(userId, label);
    while (this.userLabelCache.size > 2000) {
      const first = this.userLabelCache.keys().next().value;
      if (first) this.userLabelCache.delete(first);
      else break;
    }
  }

  /** Optional: bulk-load member names once at connect (same `users:read` as users.info). Set SLACK_PREFETCH_USERS=1. */
  private async prefetchSlackUserLabels(): Promise<void> {
    const on = process.env.SLACK_PREFETCH_USERS === '1' || process.env.SLACK_PREFETCH_USERS === 'true';
    if (!on || !this.app || !this.botToken) return;
    try {
      let cursor: string | undefined;
      let pages = 0;
      const MAX_PAGES = 50;
      let added = 0;
      do {
        const r = await this.app.client.users.list({
          token: this.botToken,
          limit: 200,
          cursor,
        });
        if (!r.ok) {
          console.error(
            `[Slack] users.list prefetch failed: ${(r as { error?: string }).error || 'unknown'} — add **users:read** and reinstall, or set SLACK_PREFETCH_USERS=0`,
          );
          return;
        }
        for (const m of r.members || []) {
          const row = m as { id?: string; is_bot?: boolean; deleted?: boolean };
          if (!row?.id || row.is_bot || row.deleted) continue;
          const id = row.id;
          const label = this.pickSlackDisplayLabelFromUser(m as Record<string, unknown>, id);
          if (label && label !== id) {
            this.rememberLabel(id, label);
            added++;
          }
        }
        cursor = r.response_metadata?.next_cursor || undefined;
        pages++;
        if (pages >= MAX_PAGES) {
          console.error('[Slack] users.list prefetch stopped at 50 pages (~10k members); names still resolve via users.info');
          break;
        }
      } while (cursor);
      console.error(`[Slack] users.list prefetch done: ${added} display name(s) cached`);
    } catch (e) {
      console.error('[Slack] users.list prefetch error:', e);
    }
  }

  /** Resolve U… to real/display name for gateway UI + LLM attribution (needs users:read on the bot). */
  private async resolveSlackUserLabel(userId: string | undefined): Promise<string | undefined> {
    if (!userId || !this.app) return undefined;
    const hit = this.userLabelCache.get(userId);
    if (hit) return hit;
    try {
      const r = await this.app.client.users.info({ token: this.botToken, user: userId });
      if (!r.ok) {
        const err = (r as { error?: string }).error || 'unknown';
        if (!SlackChannel.usersInfoErrorLogged.has(err)) {
          SlackChannel.usersInfoErrorLogged.add(err);
          console.error(
            `[Slack] users.info failed (${err}) — display names stay as U… ids until fixed. ` +
              'Add bot scope **users:read** (OAuth & Permissions) and **Reinstall to Workspace**. ' +
              'Optional: SLACK_PREFETCH_USERS=1 to bulk-cache names on startup.',
          );
        }
        return userId;
      }
      if (!r.user) return userId;
      const out = this.pickSlackDisplayLabelFromUser(r.user as Record<string, unknown>, userId);
      this.rememberLabel(userId, out);
      return out;
    } catch (e) {
      console.error(`[Slack] users.info exception for ${userId}:`, e);
      return userId;
    }
  }

  async connect(): Promise<void> {
    if (!this.botToken || !this.appToken) {
      this.error = 'SLACK_BOT_TOKEN and SLACK_APP_TOKEN required';
      console.error(`[Slack] ${this.error}`);
      return;
    }

    if (!this.allowlist) {
      // isSlackRoomId splits legacy allowlists that kept channel ids (C…/D…/G…)
      // alongside user ids (U…) in `senders`. Rooms grant guest access only.
      this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'slack', normalizeSlackHandle, isSlackRoomId);
    }

    try {
      const debug = process.env.SLACK_DEBUG === '1' || process.env.SLACK_DEBUG === 'true';
      this.app = new App({
        token: this.botToken,
        appToken: this.appToken,
        signingSecret: this.signingSecret,
        socketMode: true,
        logLevel: debug ? LogLevel.DEBUG : LogLevel.ERROR,
      });

      // Handle messages
      this.app.message(async ({ message, say }: { message: any; say: any }) => {
        // CRITICAL: filter out non-user-message subtypes BEFORE doing anything else.
        //
        // When the gateway streams a response by editing its own message via
        // chat.update, Slack delivers a `message_changed` event back to this
        // handler with empty top-level `text` (the new text is at message.message.text)
        // and a brand new `event_ts`. Without this filter, the handler treats
        // each of its own edits as a fresh user message with empty content,
        // forwards it to the gateway (which 400s), the channel-manager falls
        // back to a direct LLM call with empty input, and the LLM hallucinates
        // a conversational filler reply ("Hey Chad! What's up?"). That reply
        // gets sent to Slack as a NEW message, completing an infinite-feedback
        // loop disguised as duplicate responses.
        //
        // Allowed subtypes: undefined (regular user message) and 'file_share'
        // (user posted a file with optional caption). All others are echoes,
        // edits, joins, system events — none of which should be processed.
        const subtype = (message as any).subtype;
        if (subtype && subtype !== 'file_share') {
          console.error(`[Slack] Skipping subtype message: ${subtype}`);
          return;
        }

        // Dedup: skip if we already processed this message (app_mention + message both fire on @mentions)
        const msgTs = 'ts' in message ? message.ts : null;
        if (msgTs && this.processedMessages.has(msgTs)) {
          console.error(`[Slack] Skipping duplicate message (ts=${msgTs})`);
          return;
        }
        if (msgTs) {
          this.processedMessages.add(msgTs);
          // Evict old entries to prevent memory leak (keep last 500)
          if (this.processedMessages.size > 500) {
            const first = this.processedMessages.values().next().value;
            if (first) this.processedMessages.delete(first);
          }
        }

        let text = 'text' in message ? (message.text || '') : '';
        // Slack sometimes sends empty text with rich_text blocks — extract from blocks as fallback
        if (!text && message.blocks) {
          try {
            for (const block of message.blocks) {
              if (block.type === 'rich_text' && block.elements) {
                for (const el of block.elements) {
                  if (el.elements) {
                    for (const inner of el.elements) {
                      if (inner.type === 'text' && inner.text) text += inner.text;
                    }
                  }
                }
              }
            }
          } catch {}
        }
        console.error('[Slack] message received:', text.slice(0, 80) + (text.length > 80 ? '...' : ''));
        if ('bot_id' in message) return;
        // Self-echo guard: drop Vodou's own posts when they come back with only a
        // user id (no bot_id). Without this, every message Vodou sends re-enters
        // the pipeline as a fresh "incoming" message.
        const echoUser = 'user' in message ? message.user : '';
        if (this.botUserId && echoUser === this.botUserId) {
          console.error('[Slack] Skipping self-echo (own bot user id)');
          return;
        }

        // Defense in depth: even if a subtype-less event somehow has empty text
        // (no content + no attachments), don't forward it. The gateway will
        // 400 anyway, and the fallback would generate a hallucinated response
        // to nothing.
        if (!text.trim() && !(message.files && message.files.length > 0)) {
          console.error('[Slack] Skipping empty message (no text, no files)');
          return;
        }

        // S-PRINCIPAL: classify into owner / guest / denied. This REPLACES the
        // old `isAnyAllowed([msgChannel, msgUser])`, which passed if EITHER
        // matched and then gave everything a fully tool-capable agent — so any
        // workspace member posting in a listed channel drove the agent as Chad.
        // A listed ROOM now grants ask-only access; capability requires being on
        // the sender list. Sender match wins, so the owner is unaffected.
        const msgChannel = 'channel' in message ? String(message.channel || '') : '';
        const msgUser = 'user' in message ? String(message.user || '') : '';
        const principal = this.allowlist
          ? this.allowlist.classify([msgUser], [msgChannel])
          : 'owner';
        if (principal === 'denied') {
          console.error(`[Slack] Not in allowlist (channel=${msgChannel} user=${msgUser}) — skipping`);
          return;
        }
        if (principal === 'guest') {
          console.error(
            `[Slack] GUEST turn (channel=${msgChannel} user=${msgUser}) — ask-only, no tools. ` +
            `Add ${msgUser} under "senders" in slack-allowlist.json to grant full capability.`,
          );
        }

        this.lastActivity = new Date();

        // Extract file attachments if present
        const attachments = await this.extractAttachments(message.files);

        const displaySender = await this.resolveSlackUserLabel(msgUser);
        const slackChannelId = 'channel' in message ? String(message.channel || '').trim() : '';
        if (!slackChannelId) {
          console.error('[Slack] Missing message.channel — cannot route gateway reply; check bot scopes/events');
          return;
        }
        // Record the active channel so slack_upload_file can auto-target "here"
        // when called without an explicit channel id.
        recordLastSlackChannel(slackChannelId);
        const incoming: IncomingMessage = {
          id: 'ts' in message ? message.ts : Date.now().toString(),
          channel: 'slack',
          sender: slackChannelId,
          senderName: displaySender || msgUser,
          content: text,
          timestamp: new Date(),
          attachments: attachments.length > 0 ? attachments : undefined,
          raw: message,
          principal,
          guestVault: principal === 'guest' ? this.allowlist?.vaultForRoom([msgChannel]) : undefined,
        };

        if (attachments.length > 0) {
          console.error(`[Slack] ${attachments.length} attachment(s) extracted: ${attachments.map(a => a.filename).join(', ')}`);
        }

        if (!this.messageHandler) {
          console.error('[Slack] No messageHandler registered — message not processed');
          return;
        }
        try {
          const response = await this.messageHandler(incoming);
          if (response) {
            await say(response);
          }
        } catch (err) {
          console.error('[Slack] Error handling message:', err);
        }
      });

      // Handle app mentions
      this.app.event('app_mention', async ({ event, say }: { event: any; say: any }) => {
        // Skip non-user-message subtypes (same reasoning as the message handler above —
        // bot's own edits, deletes, etc. arrive as subtype events with empty text).
        const subtype = (event as any).subtype;
        if (subtype && subtype !== 'file_share') {
          console.error(`[Slack] Skipping app_mention subtype: ${subtype}`);
          return;
        }

        // Self-echo guard: a bot cannot @mention itself into work; if the event's
        // author is our own user id, it's an echo — drop it.
        if (this.botUserId && event.user === this.botUserId) {
          console.error('[Slack] Skipping self-echo app_mention (own bot user id)');
          return;
        }

        // Dedup: skip if we already processed this message (app_mention + message both fire on @mentions)
        const mentionTs = event.ts;
        if (mentionTs && this.processedMessages.has(mentionTs)) {
          console.error(`[Slack] Skipping duplicate app_mention (ts=${mentionTs})`);
          return;
        }
        if (mentionTs) {
          this.processedMessages.add(mentionTs);
          if (this.processedMessages.size > 500) {
            const first = this.processedMessages.values().next().value;
            if (first) this.processedMessages.delete(first);
          }
        }

        let mentionText = event.text || '';
        // Slack sometimes sends empty text with rich_text blocks
        if (!mentionText && event.blocks) {
          try {
            for (const block of event.blocks) {
              if (block.type === 'rich_text' && block.elements) {
                for (const el of block.elements) {
                  if (el.elements) {
                    for (const inner of el.elements) {
                      if (inner.type === 'text' && inner.text) mentionText += inner.text;
                    }
                  }
                }
              }
            }
          } catch {}
        }
        console.error('[Slack] app_mention received:', mentionText.slice(0, 80));

        // Defense in depth: skip empty mentions (e.g., user @-mentioned bot with no text)
        if (!mentionText.trim() && !(event.files && event.files.length > 0)) {
          console.error('[Slack] Skipping empty app_mention');
          return;
        }

        // S-PRINCIPAL: mirror the message handler above. An @-mention is a
        // second, independent entry point — miss it and the tier is bypassed by
        // anyone who simply @-mentions the bot instead of posting plainly.
        const mentionPrincipal = this.allowlist
          ? this.allowlist.classify([String(event.user || '')], [String(event.channel || '')])
          : 'owner';
        if (mentionPrincipal === 'denied') {
          console.error(`[Slack] Mention not in allowlist (channel=${event.channel} user=${event.user}) — skipping`);
          return;
        }
        if (mentionPrincipal === 'guest') {
          console.error(
            `[Slack] GUEST mention (channel=${event.channel} user=${event.user}) — ask-only, no tools.`,
          );
        }

        this.lastActivity = new Date();

        // Extract file attachments if present
        const attachments = await this.extractAttachments(event.files);

        const mentionSenderLabel = await this.resolveSlackUserLabel(event.user);
        const incoming: IncomingMessage = {
          id: event.ts,
          channel: 'slack',
          sender: event.channel,
          senderName: mentionSenderLabel || event.user,
          content: mentionText,
          timestamp: new Date(parseFloat(event.ts) * 1000),
          attachments: attachments.length > 0 ? attachments : undefined,
          raw: event,
          principal: mentionPrincipal,
          guestVault:
            mentionPrincipal === 'guest'
              ? this.allowlist?.vaultForRoom([String(event.channel || '')])
              : undefined,
        };

        if (!this.messageHandler) {
          console.error('[Slack] No messageHandler registered — mention not processed');
          return;
        }
        try {
          const response = await this.messageHandler(incoming);
          if (response) {
            await say(response);
          }
        } catch (err) {
          console.error('[Slack] Error handling mention:', err);
        }
      });

      // Global error handler for Bolt app
      this.app.error(async (error: any) => {
        console.error('[Slack] Bolt app error (handled):', error?.message || error);
      });

      await this.app.start();
      this.connected = true;
      this.error = undefined;

      // Resolve the bot's OWN user id so we can filter self-echoes. When Vodou
      // posts to a channel, Slack relays that message back to this handler. If
      // the relay carries a bot_id, the guard below (`'bot_id' in message`)
      // catches it — but in some workspace/token configs the echo arrives with
      // only a `user` field set to the bot's own user id and NO bot_id, so it
      // slips through and reads as a fresh incoming message (the "echo" bug).
      // auth.test.user_id is the ground truth for "who am I".
      try {
        const auth = await this.app.client.auth.test({ token: this.botToken });
        this.botUserId = (auth as { user_id?: string }).user_id || null;
        console.error(`[Slack] Bot user id resolved for echo filter: ${this.botUserId || '(none)'}`);
      } catch (e) {
        console.error('[Slack] auth.test failed — self-echo filter disabled this session:', e);
      }

      console.error('[Slack] Connected and listening for messages');
      console.error('[Slack] If nothing happens when you message the app: add bot events at api.slack.com → your app → Event Subscriptions → Subscribe to bot events → message.im (DMs) and app_mention (@mentions). Then reinstall.');
      void this.prefetchSlackUserLabels();

      // Handle Socket Mode disconnects gracefully — the SDK's state machine
      // throws on 'server explicit disconnect' during reconnection. Catch it
      // and auto-reconnect instead of crashing.
      // P1-19: install ONCE, and never process.exit on a non-Slack error in a
      // multi-channel process (it would kill every other adapter).
      if (!_slackDisconnectHandlerInstalled) {
        _slackDisconnectHandlerInstalled = true;
        process.on('uncaughtException', (err) => {
          if (err.message?.includes('Unhandled event') && err.message?.includes('disconnect')) {
            console.error('[Slack] Socket disconnect during reconnection — auto-recovering...');
            this.connected = false;
            setTimeout(async () => {
              try {
                console.error('[Slack] Attempting reconnect...');
                if (this.app) {
                  try { await this.app.stop(); } catch (_) {}
                }
                this.app = null;
                await this.connect();
              } catch (reconnectErr) {
                console.error('[Slack] Reconnect failed:', reconnectErr);
              }
            }, 3000);
          } else {
            console.error('[Slack] Ignoring non-Slack uncaught exception (not exiting multi-channel process):', err);
          }
        });
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[Slack] Connection failed: ${this.error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    if (this.allowlist) {
      this.allowlist.dispose();
      this.allowlist = null;
    }
    this.connected = false;
    console.error('[Slack] Disconnected');
  }

  async send(message: OutgoingMessage): Promise<boolean> {
    if (!this.app) {
      console.error('[Slack] Cannot send - not connected');
      return false;
    }

    try {
      await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: message.recipient,
        text: message.content,
        thread_ts: message.replyTo,
      });
      this.lastActivity = new Date();
      return true;
    } catch (err) {
      console.error('[Slack] Send error:', err);
      return false;
    }
  }

  getStatus(): ChannelStatus {
    return {
      channel: 'slack',
      connected: this.connected,
      error: this.error,
      lastActivity: this.lastActivity,
      metadata: {
        hasBotToken: !!this.botToken,
        hasAppToken: !!this.appToken,
        allowlistMode: this.allowlist?.get().mode ?? 'off',
        allowlistCount: this.allowlist?.get().senders.length ?? 0,
      },
    };
  }

  /**
   * Upload a file to a Slack channel using files.uploadV2
   * Includes dynamic timeout based on file size and retry logic.
   */
  async uploadFile(options: {
    channelId: string;
    filePath?: string;
    fileData?: Buffer;
    filename: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
  }): Promise<{ ok: boolean; fileId?: string; permalink?: string; error?: string; fileSizeBytes?: number }> {
    if (!this.app) {
      return { ok: false, error: 'Not connected to Slack' };
    }

    // Read file content
    let content: Buffer;
    if (options.filePath) {
      try {
        content = await readFile(options.filePath);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Slack] Failed to read file ${options.filePath}:`, errMsg);
        return { ok: false, error: `Failed to read file: ${errMsg}` };
      }
    } else if (options.fileData) {
      content = options.fileData;
    } else {
      return { ok: false, error: 'Either filePath or fileData is required' };
    }

    const fileSizeBytes = content.length;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);

    // Dynamic timeout: 30s base + 30s per MB, min 30s, max 5 minutes
    const timeoutMs = Math.min(Math.max(30000, 30000 + Math.ceil(fileSizeMB) * 30000), 300000);

    console.log(`[Slack] Uploading file: ${options.filename} (${fileSizeBytes} bytes / ${fileSizeMB.toFixed(2)} MB) timeout=${timeoutMs}ms`);

    const maxRetries = 3;
    let lastError = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Race the upload against our timeout
        const uploadPromise = this.app.client.filesUploadV2({
          token: this.botToken,
          channel_id: options.channelId,
          file: content,
          filename: options.filename || (options.filePath ? basename(options.filePath) : 'file'),
          title: options.title || options.filename,
          initial_comment: options.initialComment,
          thread_ts: options.threadTs,
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Upload timed out after ${timeoutMs}ms`)), timeoutMs)
        );

        const result = await Promise.race([uploadPromise, timeoutPromise]);

        this.lastActivity = new Date();

        // Validate the response thoroughly
        if (!result || typeof result !== 'object') {
          console.warn(`[Slack] Upload attempt ${attempt}: unexpected response type:`, typeof result);
          lastError = `Unexpected response from Slack API: ${JSON.stringify(result)}`;
          continue;
        }

        const resultAny = result as any;
        if (resultAny.ok === false) {
          console.warn(`[Slack] Upload attempt ${attempt}: API returned ok=false, error=${resultAny.error}`);
          lastError = resultAny.error || 'Slack API returned ok=false';
          // Don't retry on auth/permission errors
          if (['not_authed', 'invalid_auth', 'missing_scope', 'channel_not_found', 'not_in_channel'].includes(resultAny.error)) {
            return { ok: false, error: lastError, fileSizeBytes };
          }
          continue;
        }

        // filesUploadV2 returns { ok, files[] } — extract file info
        const uploadedFile = resultAny?.files?.[0];
        const fileId = uploadedFile?.id;
        const permalink = uploadedFile?.permalink;

        console.log(`[Slack] Upload SUCCESS (attempt ${attempt}): fileId=${fileId}, permalink=${permalink}`);

        return {
          ok: true,
          fileId,
          permalink,
          fileSizeBytes,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;
        console.error(`[Slack] Upload attempt ${attempt}/${maxRetries} failed: ${errMsg}`);

        // Don't retry on certain errors
        if (errMsg.includes('not_in_channel') || errMsg.includes('channel_not_found') || errMsg.includes('invalid_auth')) {
          return { ok: false, error: lastError, fileSizeBytes };
        }

        // Exponential backoff before retry (1s, 2s, 4s)
        if (attempt < maxRetries) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          console.log(`[Slack] Retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    console.error(`[Slack] Upload FAILED after ${maxRetries} attempts: ${lastError}`);
    return { ok: false, error: `Upload failed after ${maxRetries} attempts: ${lastError}`, fileSizeBytes };
  }

  /**
   * Extract and download file attachments from a Slack message.
   * Saves under VODOU_CHANNEL_ATTACHMENTS_DIR or <VODOU_PROJECT_PATH>/.vodou/channel-attachments.
   */
  private async extractAttachments(files?: any[]): Promise<Attachment[]> {
    if (!files || files.length === 0) return [];

    const attachments: Attachment[] = [];

    for (const file of files) {
      try {
        const downloadUrl = file.url_private_download || file.url_private;
        if (!downloadUrl) {
          console.error(`[Slack] No download URL for file: ${file.name}`);
          continue;
        }

        const response = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });

        if (!response.ok) {
          console.error(`[Slack] Failed to download ${file.name}: HTTP ${response.status}`);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = file.mimetype || 'application/octet-stream';
        const idPrefix = String(file.id || Date.now());
        const saved = await saveBufferAsAttachment(buffer, file.name || 'file', mimeType, idPrefix);
        if (saved) {
          attachments.push(saved);
          console.error(`[Slack] Downloaded attachment: ${file.name} (${mimeType}) → ${saved.url}`);
        }
      } catch (err) {
        console.error(`[Slack] Error downloading file ${file.name}:`, err);
      }
    }

    return attachments;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
}
