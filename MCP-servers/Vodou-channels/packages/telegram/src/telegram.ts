/**
 * Telegram Channel Implementation
 */

import TelegramBot from 'node-telegram-bot-api';
import { saveBufferAsAttachment } from '@vodou/channel-sdk';
import { Attachment, Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
import { AllowlistWatcher, normalizeTelegramHandle } from '@vodou/channel-sdk';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

export class TelegramChannel implements Channel {
  type = 'telegram' as const;
  private bot: TelegramBot | null = null;
  private token: string;
  private adminId?: string;
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  private didLogSenderId = false;
  private allowlist: AllowlistWatcher | null = null;

  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN || '';
    this.adminId = process.env.TELEGRAM_ADMIN_ID;
  }

  /** Download Telegram file by file_id into Vodou attachment dir. */
  private async downloadTelegramFile(
    fileId: string,
    filename: string,
    mimeType: string,
    idPrefix: string
  ): Promise<Attachment | null> {
    if (!this.bot) return null;
    try {
      const meta = await this.bot.getFile(fileId);
      if (!meta.file_path) {
        console.error('[Telegram] getFile returned no file_path for', fileId);
        return null;
      }
      const url = `https://api.telegram.org/file/bot${this.token}/${meta.file_path}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[Telegram] File download failed: HTTP ${res.status}`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const att = await saveBufferAsAttachment(buffer, filename, mimeType, idPrefix);
      if (att) {
        console.error(`[Telegram] Downloaded: ${filename} (${mimeType}) → ${att.url}`);
      }
      return att;
    } catch (err) {
      console.error('[Telegram] downloadTelegramFile error:', err);
      return null;
    }
  }

  private async extractAttachments(msg: TelegramBot.Message): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const baseId = `${msg.chat.id}_${msg.message_id}`;
    let seq = 0;
    const prefix = () => `${baseId}_${seq++}`;

    if (msg.photo && msg.photo.length > 0) {
      const p = msg.photo[msg.photo.length - 1];
      const att = await this.downloadTelegramFile(p.file_id, 'photo.jpg', 'image/jpeg', prefix());
      if (att) out.push(att);
    }

    if (msg.document) {
      const d = msg.document;
      const name = d.file_name || 'document';
      const mime = d.mime_type || 'application/octet-stream';
      const att = await this.downloadTelegramFile(d.file_id, name, mime, prefix());
      if (att) out.push(att);
    }

    if (msg.video) {
      const v = msg.video;
      const name = (v as { file_name?: string }).file_name || 'video.mp4';
      const mime = v.mime_type || 'video/mp4';
      const att = await this.downloadTelegramFile(v.file_id, name, mime, prefix());
      if (att) out.push(att);
    }

    if (msg.animation) {
      const a = msg.animation;
      const name = a.file_name || 'animation.mp4';
      const mime = a.mime_type || 'video/mp4';
      const att = await this.downloadTelegramFile(a.file_id, name, mime, prefix());
      if (att) out.push(att);
    }

    if (msg.voice) {
      const v = msg.voice;
      const att = await this.downloadTelegramFile(v.file_id, 'voice.ogg', v.mime_type || 'audio/ogg', prefix());
      if (att) out.push(att);
    }

    if (msg.audio) {
      const a = msg.audio;
      const name = (a as { file_name?: string }).file_name || 'audio.mp3';
      const mime = a.mime_type || 'audio/mpeg';
      const att = await this.downloadTelegramFile(a.file_id, name, mime, prefix());
      if (att) out.push(att);
    }

    if (msg.video_note) {
      const vn = msg.video_note;
      const att = await this.downloadTelegramFile(vn.file_id, 'video_note.mp4', 'video/mp4', prefix());
      if (att) out.push(att);
    }

    if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
      const att = await this.downloadTelegramFile(
        msg.sticker.file_id,
        'sticker.webp',
        'image/webp',
        prefix()
      );
      if (att) out.push(att);
    }

    return out;
  }

  async connect(): Promise<void> {
    if (!this.token) {
      this.error = 'TELEGRAM_BOT_TOKEN not set';
      console.error(`[Telegram] ${this.error}`);
      return;
    }

    if (!this.allowlist) {
      this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'telegram', normalizeTelegramHandle);
    }

    try {
      this.bot = new TelegramBot(this.token, {
        polling: {
          params: { timeout: 30 },
        },
      });

      this.bot.on('message', async (msg) => {
        this.lastActivity = new Date();
        // Self-echo guard (defensive): getUpdates polling doesn't normally
        // redeliver the bot's own sends, but drop any bot-authored message so a
        // future webhook/relay config can't loop Vodou onto its own output.
        if (msg.from?.is_bot) {
          console.error('[Telegram] Skipping bot-authored message (self-echo guard)');
          return;
        }
        const senderId = msg.chat.id.toString();
        if (!this.didLogSenderId && !this.adminId) {
          this.didLogSenderId = true;
          console.error('[Telegram] Your Telegram user ID (set as TELEGRAM_ADMIN_ID in .env): ' + senderId);
        }

        // Allowlist: match ONLY on immutable IDs — chat ID (numeric, positive
        // for users / negative for groups) and the sender's numeric user ID.
        // CWE-639 hardening (OpenClaw 2026-06-03 zero-day class): the mutable
        // @username is NEVER an auth key — Telegram usernames are user-settable
        // and reusable, so an attacker could rename to an allowlisted handle and
        // hijack the owner's agent (tools/shell → RCE). If an allowlist entry
        // matches only the username, REJECT and warn so the owner re-adds the
        // numeric id instead of silently keeping an impersonation hole.
        if (
          this.allowlist &&
          !this.allowlist.isAnyAllowed([senderId, msg.from?.id?.toString() ?? ''])
        ) {
          if (msg.from?.username && this.allowlist.isAllowed(msg.from.username)) {
            console.error(`[Telegram] SECURITY: rejected sender matched ONLY by mutable @username (${msg.from.username}); re-add by numeric user id ${msg.from?.id} to allow (CWE-639 fix)`);
          } else {
            console.error(`[Telegram] Not in allowlist (chat=${senderId} user=${msg.from?.username}) — skipping`);
          }
          return;
        }

        const attachments = await this.extractAttachments(msg);

        let content = msg.text || msg.caption || '';
        if (!content.trim()) {
          if (attachments.length > 0) {
            content = `[${attachments.length} attachment(s)]`;
          } else if (msg.sticker) {
            content = '[sticker]';
          } else {
            return;
          }
        }

        const incoming: IncomingMessage = {
          id: msg.message_id.toString(),
          channel: 'telegram',
          sender: senderId,
          senderName: msg.from?.username || msg.from?.first_name,
          content,
          timestamp: new Date(msg.date * 1000),
          attachments: attachments.length > 0 ? attachments : undefined,
          raw: msg,
        };

        if (this.messageHandler) {
          try {
            const response = await this.messageHandler(incoming);
            if (response) {
              await this.send({
                channel: 'telegram',
                recipient: incoming.sender,
                content: response,
                replyTo: incoming.id,
              });
            }
          } catch (err) {
            console.error('[Telegram] Error handling message:', err);
          }
        }
      });

      this.bot.on('error', (err) => {
        console.error('[Telegram] Bot error:', err);
        this.error = err.message;
      });

      this.bot.on('polling_error', (err: Error & { code?: string; response?: { error_code?: number } }) => {
        const code = err.code || String((err as any).response?.error_code ?? '');
        const transient = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EFATAL', '409'].includes(code) ||
          err.message?.includes('409') || err.message?.includes('Conflict');
        if (transient) {
          if (code === '409' || err.message?.includes('Conflict')) {
            console.error('[Telegram] 409 Conflict: another bot instance is polling. Stop other Vodou-channels/Telegram processes and keep only one.');
          } else {
            console.error('[Telegram] Polling error (transient):', err.message);
          }
        } else {
          console.error('[Telegram] Polling error:', err);
          this.error = err.message;
        }
      });

      this.connected = true;
      this.error = undefined;
      console.error('[Telegram] Connected and listening for messages');
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[Telegram] Connection failed: ${this.error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
    }
    if (this.allowlist) {
      this.allowlist.dispose();
      this.allowlist = null;
    }
    this.connected = false;
    console.error('[Telegram] Disconnected');
  }

  async send(message: OutgoingMessage): Promise<boolean> {
    if (!this.bot) {
      console.error('[Telegram] Cannot send - not connected');
      return false;
    }

    try {
      const options: TelegramBot.SendMessageOptions = {};
      if (message.replyTo) {
        options.reply_to_message_id = parseInt(message.replyTo, 10);
      }
      const maxLen = 4096;
      const text = message.content.length > maxLen
        ? message.content.slice(0, maxLen - 2) + '…'
        : message.content;

      await this.bot.sendMessage(message.recipient, text, options);
      this.lastActivity = new Date();
      return true;
    } catch (err) {
      console.error('[Telegram] Send error:', err);
      return false;
    }
  }

  getStatus(): ChannelStatus {
    return {
      channel: 'telegram',
      connected: this.connected,
      error: this.error,
      lastActivity: this.lastActivity,
      metadata: {
        hasToken: !!this.token,
        adminId: this.adminId,
        allowlistMode: this.allowlist?.get().mode ?? 'off',
        allowlistCount: this.allowlist?.get().senders.length ?? 0,
      },
    };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  manifest(): import('@vodou/channel-sdk').ChannelManifest {
    return {
      name: 'telegram',
      displayName: 'Telegram',
      version: '1.0.0',
      description: 'Telegram channel for Vodou',
      author: 'Vodou AI',
      signed: true,
      requiredEnv: ['TELEGRAM_BOT_TOKEN'],
      optionalEnv: ['TELEGRAM_ADMIN_ID'],
    };
  }
}
