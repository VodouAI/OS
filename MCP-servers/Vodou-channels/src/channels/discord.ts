/**
 * Discord Channel Implementation
 */

import { Client, GatewayIntentBits, Message, TextChannel, DMChannel } from 'discord.js';
import { saveBufferAsAttachment } from '../channel-attachment-download.js';
import { Attachment, Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '../types.js';
import { AllowlistWatcher, normalizeDiscordHandle, isDiscordRoomId } from '../channel-allowlist.js';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

export class DiscordChannel implements Channel {
  type = 'discord' as const;
  private client: Client | null = null;
  private token: string;
  private guildId?: string;
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  private allowlist: AllowlistWatcher | null = null;

  constructor() {
    this.token = process.env.DISCORD_BOT_TOKEN || '';
    this.guildId = process.env.DISCORD_GUILD_ID;
  }

  private async extractAttachments(msg: Message): Promise<Attachment[]> {
    if (msg.attachments.size === 0) return [];

    const out: Attachment[] = [];
    let idx = 0;
    for (const att of msg.attachments.values()) {
      try {
        const res = await fetch(att.url);
        if (!res.ok) {
          console.error(`[Discord] Failed to download ${att.name}: HTTP ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const mime = att.contentType || 'application/octet-stream';
        const name = att.name || `attachment_${idx}`;
        const idPrefix = `${msg.channelId}_${msg.id}_${att.id || idx}`;
        const saved = await saveBufferAsAttachment(buffer, name, mime, idPrefix);
        if (saved) {
          out.push(saved);
          console.error(`[Discord] Downloaded: ${name} (${mime}) → ${saved.url}`);
        }
      } catch (err) {
        console.error(`[Discord] Error downloading attachment ${att.name}:`, err);
      }
      idx++;
    }
    return out;
  }

  async connect(): Promise<void> {
    if (!this.token) {
      this.error = 'DISCORD_BOT_TOKEN not set';
      console.error(`[Discord] ${this.error}`);
      return;
    }

    if (!this.allowlist) {
      // isDiscordRoomId: snowflakes are shape-identical for users and channels, so
      // legacy entries migrate to ROOMS (guest) — the fail-safe direction.
      this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'discord', normalizeDiscordHandle, isDiscordRoomId);
    }

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      this.client.on('ready', () => {
        console.error(`[Discord] Logged in as ${this.client?.user?.tag}`);
        this.connected = true;
        this.error = undefined;
      });

      this.client.on('messageCreate', async (msg: Message) => {
        if (msg.author.bot) return;

        // Allowlist: match ONLY on immutable IDs — author snowflake id and
        // channel id. CWE-639 hardening (OpenClaw 2026-06-03 zero-day class):
        // the mutable username is NEVER an auth key — Discord usernames are
        // changeable and (post-2023 unique-username migration) reclaimable, so
        // an attacker could rename to an allowlisted handle and hijack the
        // owner's agent. Reject username-only matches with a loud warning.
        // S-PRINCIPAL: a listed CHANNEL now grants guest (ask-only) access;
        // full capability requires being on the sender list. Previously either
        // match produced a fully tool-capable agent.
        const principal = this.allowlist
          ? this.allowlist.classify([msg.author.id], [msg.channelId])
          : 'owner';
        if (principal === 'denied') {
          if (msg.author.username && this.allowlist?.isAllowed(msg.author.username)) {
            console.error(`[Discord] SECURITY: rejected sender matched ONLY by mutable username (${msg.author.username}); re-add by user id ${msg.author.id} to allow (CWE-639 fix)`);
          } else {
            console.error(
              `[Discord] Not in allowlist (user=${msg.author.username}/${msg.author.id} channel=${msg.channelId}) — skipping`
            );
          }
          return;
        }
        if (principal === 'guest') {
          console.error(
            `[Discord] GUEST turn (user=${msg.author.username}/${msg.author.id} channel=${msg.channelId}) — ` +
            `ask-only, no tools. Add ${msg.author.id} under "senders" for full capability.`,
          );
        }

        this.lastActivity = new Date();

        const attachments = await this.extractAttachments(msg);

        let content = msg.content || '';
        if (!content.trim() && attachments.length > 0) {
          content = `[${attachments.length} attachment(s)]`;
        }
        if (!content.trim() && attachments.length === 0) {
          return;
        }

        const incoming: IncomingMessage = {
          id: msg.id,
          channel: 'discord',
          sender: msg.channelId,
          senderName: msg.author.username,
          content,
          timestamp: msg.createdAt,
          attachments: attachments.length > 0 ? attachments : undefined,
          raw: msg,
          principal,
          guestVault: principal === 'guest' ? this.allowlist?.vaultForRoom([msg.channelId]) : undefined,
        };

        if (this.messageHandler) {
          try {
            const response = await this.messageHandler(incoming);
            if (response) {
              await msg.reply(response);
            }
          } catch (err) {
            console.error('[Discord] Error handling message:', err);
          }
        }
      });

      this.client.on('error', (err) => {
        console.error('[Discord] Client error:', err);
        this.error = err.message;
      });

      await this.client.login(this.token);
      console.error('[Discord] Connected and listening for messages');
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[Discord] Connection failed: ${this.error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    if (this.allowlist) {
      this.allowlist.dispose();
      this.allowlist = null;
    }
    this.connected = false;
    console.error('[Discord] Disconnected');
  }

  async send(message: OutgoingMessage): Promise<boolean> {
    if (!this.client) {
      console.error('[Discord] Cannot send - not connected');
      return false;
    }

    try {
      const channel = await this.client.channels.fetch(message.recipient);

      if (channel && (channel instanceof TextChannel || channel instanceof DMChannel)) {
        await channel.send(message.content);
        this.lastActivity = new Date();
        return true;
      }

      console.error('[Discord] Channel not found or not a text channel');
      return false;
    } catch (err) {
      console.error('[Discord] Send error:', err);
      return false;
    }
  }

  getStatus(): ChannelStatus {
    return {
      channel: 'discord',
      connected: this.connected,
      error: this.error,
      lastActivity: this.lastActivity,
      metadata: {
        hasToken: !!this.token,
        guildId: this.guildId,
        username: this.client?.user?.username,
        allowlistMode: this.allowlist?.get().mode ?? 'off',
        allowlistCount: this.allowlist?.get().senders.length ?? 0,
      },
    };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
}
