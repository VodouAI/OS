/**
 * Discord Channel Implementation
 */
import { Client, GatewayIntentBits, TextChannel, DMChannel } from 'discord.js';
import { saveBufferAsAttachment } from '@vodou/channel-sdk';
import { AllowlistWatcher, normalizeDiscordHandle } from '@vodou/channel-sdk';
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
export class DiscordChannel {
    type = 'discord';
    client = null;
    token;
    guildId;
    connected = false;
    lastActivity;
    error;
    messageHandler;
    allowlist = null;
    constructor() {
        this.token = process.env.DISCORD_BOT_TOKEN || '';
        this.guildId = process.env.DISCORD_GUILD_ID;
    }
    async extractAttachments(msg) {
        if (msg.attachments.size === 0)
            return [];
        const out = [];
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
            }
            catch (err) {
                console.error(`[Discord] Error downloading attachment ${att.name}:`, err);
            }
            idx++;
        }
        return out;
    }
    async connect() {
        if (!this.token) {
            this.error = 'DISCORD_BOT_TOKEN not set';
            console.error(`[Discord] ${this.error}`);
            return;
        }
        if (!this.allowlist) {
            this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'discord', normalizeDiscordHandle);
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
            this.client.on('messageCreate', async (msg) => {
                if (msg.author.bot)
                    return;
                // Allowlist: match ONLY on immutable IDs — author snowflake id and
                // channel id. CWE-639 hardening (OpenClaw 2026-06-03 zero-day class):
                // the mutable username is NEVER an auth key — Discord usernames are
                // changeable and (post-2023 unique-username migration) reclaimable, so
                // an attacker could rename to an allowlisted handle and hijack the
                // owner's agent. Reject username-only matches with a loud warning.
                if (this.allowlist &&
                    !this.allowlist.isAnyAllowed([msg.author.id, msg.channelId])) {
                    if (msg.author.username && this.allowlist.isAllowed(msg.author.username)) {
                        console.error(`[Discord] SECURITY: rejected sender matched ONLY by mutable username (${msg.author.username}); re-add by user id ${msg.author.id} to allow (CWE-639 fix)`);
                    }
                    else {
                        console.error(`[Discord] Not in allowlist (user=${msg.author.username}/${msg.author.id} channel=${msg.channelId}) — skipping`);
                    }
                    return;
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
                const incoming = {
                    id: msg.id,
                    channel: 'discord',
                    sender: msg.channelId,
                    senderName: msg.author.username,
                    content,
                    timestamp: msg.createdAt,
                    attachments: attachments.length > 0 ? attachments : undefined,
                    raw: msg,
                };
                if (this.messageHandler) {
                    try {
                        const response = await this.messageHandler(incoming);
                        if (response) {
                            await msg.reply(response);
                        }
                    }
                    catch (err) {
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
        }
        catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
            console.error(`[Discord] Connection failed: ${this.error}`);
        }
    }
    async disconnect() {
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
    async send(message) {
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
        }
        catch (err) {
            console.error('[Discord] Send error:', err);
            return false;
        }
    }
    getStatus() {
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
    onMessage(handler) {
        this.messageHandler = handler;
    }
    manifest() {
        return {
            name: 'discord',
            displayName: 'Discord',
            version: '1.0.0',
            description: 'Discord channel for Vodou',
            author: 'Vodou AI',
            signed: true,
            requiredEnv: ['DISCORD_BOT_TOKEN'],
            optionalEnv: ['DISCORD_GUILD_ID'],
        };
    }
}
//# sourceMappingURL=discord.js.map