/**
 * Channel Manager
 * Coordinates all channel implementations and provides unified interface
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discoverChannels } from './channel-loader.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || join(__dirname, '..', '..', '..');
const VC_PATH = join(PROJECT_ROOT, 'vodou-core');
export class ChannelManager {
    channels = new Map();
    messageHandler;
    useOI;
    // Per-user conversation IDs: "channel:senderId" → gateway conversationId
    conversationIds = new Map();
    constructor(useOI = true) {
        this.useOI = useOI;
    }
    /** Discover and register channels from ~/.vodou/channels/node_modules. */
    async init() {
        const discovered = await discoverChannels();
        for (const { manifest, instance } of discovered) {
            this.channels.set(manifest.name, instance);
        }
        console.error(`[ChannelManager] Loaded ${discovered.length} channel(s): ${discovered.map(d => d.manifest.name).join(', ') || 'none'}`);
    }
    /**
     * Connect specific channels (by name) or all discovered channels.
     * Returns a per-channel report instead of throwing on the first failure —
     * the manager logs each failure but keeps going so one bad channel (e.g.
     * missing SLACK_BOT_TOKEN) doesn't take down Telegram and Discord too.
     */
    async connect(channelNames) {
        const names = channelNames ?? Array.from(this.channels.keys());
        const report = [];
        for (const type of names) {
            const channel = this.channels.get(type);
            if (!channel) {
                report.push({ name: type, ok: false, error: 'channel not registered (not discovered or built?)' });
                continue;
            }
            try {
                channel.onMessage(this.handleIncomingMessage.bind(this));
                await channel.connect();
                report.push({ name: type, ok: true });
            }
            catch (err) {
                const msg = err.message || String(err);
                console.error(`[ChannelManager] connect(${type}) failed:`, msg);
                report.push({ name: type, ok: false, error: msg });
            }
        }
        return report;
    }
    /**
     * Connect all discovered channels.
     */
    async connectAll() {
        await this.connect();
    }
    /**
     * Disconnect specific channels
     */
    async disconnect(channelTypes) {
        const types = channelTypes || Array.from(this.channels.keys());
        for (const type of types) {
            const channel = this.channels.get(type);
            if (channel) {
                await channel.disconnect();
            }
        }
    }
    /**
     * Disconnect all channels
     */
    async disconnectAll() {
        await this.disconnect();
    }
    /**
     * Send a message to a channel
     */
    async send(message) {
        const channel = this.channels.get(message.channel);
        if (!channel) {
            console.error(`[ChannelManager] Unknown channel: ${message.channel}`);
            return false;
        }
        return channel.send(message);
    }
    /**
     * Broadcast a message to all connected channels
     */
    async broadcast(content, recipient = 'all') {
        const results = new Map();
        for (const [type, channel] of this.channels) {
            if (channel.getStatus().connected) {
                const success = await channel.send({
                    channel: type,
                    recipient,
                    content,
                });
                results.set(type, success);
            }
        }
        return results;
    }
    /**
     * Get status of all channels
     */
    getStatus() {
        return Array.from(this.channels.values()).map(ch => ch.getStatus());
    }
    /**
     * Get status of a specific channel
     */
    getChannelStatus(type) {
        return this.channels.get(type)?.getStatus();
    }
    /**
     * Get a specific channel
     */
    getChannel(type) {
        return this.channels.get(type);
    }
    /**
     * Set custom message handler
     */
    setMessageHandler(handler) {
        this.messageHandler = handler;
    }
    /**
     * Handle incoming message — routes through gateway chat engine for full Vodou brain
     * (BrainLoader, memory, skills, conversation history). Falls back to direct LLM if gateway is down.
     */
    async handleIncomingMessage(message) {
        console.error(`[ChannelManager] Received from ${message.channel}: ${message.content.substring(0, 50)}...`);
        // Use custom handler if set
        if (this.messageHandler) {
            return this.messageHandler(message);
        }
        if (this.useOI) {
            // Integrations-parity conversation ID: one scoped conversation per
            // channel type (`workbench:channel:slack`), not one per inbound thread.
            // All Slack traffic from every user/channel lands in the same chat so
            // clicking "Slack" in the left-nav workbench OR the Slack chat-view tab
            // shows the SAME unified feed. Mirrors integrations exactly —
            // integrations use `workbench:integration:<id>` as the single scoped
            // conversation id.
            //
            // Reply routing still needs to know WHICH user/channel to reply to.
            // The original per-sender key becomes `recipient`, passed as a separate
            // field. The gateway's sendChannelMessage(source, recipient, ...) uses
            // this recipient value to route replies back to the correct thread on
            // the channel side.
            const convId = `workbench:channel:${message.channel}`;
            const recipient = message.sender;
            // Build enriched content with attachment references
            let enrichedContent = message.content;
            if (message.attachments && message.attachments.length > 0) {
                const attachmentDescs = message.attachments.map(a => {
                    const typeLabel = a.type === 'image' ? '🖼️ Image' : a.type === 'audio' ? '🔊 Audio' : a.type === 'video' ? '🎬 Video' : '📎 File';
                    return `${typeLabel}: ${a.filename} (${a.mimeType}) → ${a.url}`;
                });
                enrichedContent += `\n\n[Attachments from ${message.channel}]\n` + attachmentDescs.join('\n');
                console.error(`[ChannelManager] Enriched message with ${message.attachments.length} attachment(s)`);
            }
            return this.processWithGateway(enrichedContent, convId, message.channel, message.senderName, message.attachments, recipient, {
                // S-PRINCIPAL: the bridge is where sender + room identity actually live,
                // so the tier is computed there and carried to the gateway rather than
                // re-derived from a conversation id.
                principal: message.principal,
                guestVault: message.guestVault,
            });
        }
        return null;
    }
    /**
     * Gateway URL — routes messages through the full Vodou brain (BrainLoader, memory, skills, history).
     */
    getGatewayUrl() {
        // VODOU_GATEWAY_PORT or fallback to 8765 (NOT WEB_PORT, which is the web channel's port 8766)
        const port = process.env.VODOU_GATEWAY_PORT || '8765';
        return 'http://localhost:' + port + '/chat';
    }
    /**
     * Route message through the gateway chat engine for full Vodou intelligence.
     * Each channel+sender gets a persistent conversation with history, memory, skills.
     * Falls back to direct LLM call if gateway is unreachable.
     */
    async processWithGateway(query, convId, source, senderName, attachments, recipient, opts) {
        // Empty input → nothing to respond to. The channel handlers should already
        // filter these out, but this is a second-line defense: never invoke an LLM
        // (even the fallback) on empty content. The fallback would hallucinate a
        // conversational reply to nothing, which is exactly the bug class we're
        // closing — bot responding to its own edit echoes.
        if (!query.trim() && !(attachments && attachments.length > 0)) {
            console.error(`[ChannelManager] Skipping empty query for ${convId} (no text, no attachments)`);
            return '';
        }
        const url = this.getGatewayUrl();
        try {
            const body = { message: query, conversationId: convId };
            if (source)
                body.source = source;
            if (senderName)
                body.senderName = senderName;
            // S-PRINCIPAL: only ever SEND 'guest'. Omitting the field means owner, so
            // a downgrade is explicit and an upgrade is impossible to express — a
            // dropped field can never silently promote a guest.
            if (opts?.principal === 'guest') {
                body.principal = 'guest';
                if (opts.guestVault)
                    body.guestVault = opts.guestVault;
            }
            // Gateway needs Slack channel id (C…/D…) for chat.postMessage — always send when present.
            if (recipient != null && String(recipient).trim())
                body.recipient = String(recipient).trim();
            else if (source === 'slack')
                console.error('[ChannelManager] WARN: empty recipient for Slack — gateway cannot post back to a channel');
            if (attachments && attachments.length > 0) {
                body.attachments = attachments.map(a => ({
                    type: a.type,
                    url: a.url, // local file path
                    mimeType: a.mimeType,
                    filename: a.filename,
                }));
            }
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(900_000), // 15 min — deep thinking + multi-tool sessions can be long
            });
            if (!res.ok) {
                // 4xx = "your request was bad" (empty body, malformed payload, auth issue).
                // The fallback would re-send the same bad input and produce garbage. Only
                // fall back on 5xx (gateway internal error) where retrying with a simpler
                // direct LLM call has a chance of recovering the user's intent.
                if (res.status >= 400 && res.status < 500) {
                    console.error(`[ChannelManager] Gateway returned ${res.status} (client error) — NOT falling back, returning empty`);
                    return '';
                }
                console.error(`[ChannelManager] Gateway returned ${res.status} (server error), falling back to direct LLM`);
                return this.processWithLLMFallback(query);
            }
            const data = await res.json();
            console.error(`[ChannelManager] Gateway response for ${convId}: ${(data.response || '').substring(0, 60)}...`);
            // Gateway already forwarded the response to the channel via progressive streaming
            // (startChannelStream/feedChannelStream/finishChannelStream). Return empty so the
            // channel code doesn't send a duplicate message.
            return '';
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ChannelManager] Gateway unavailable (${msg}), falling back to direct LLM`);
            return this.processWithLLMFallback(query);
        }
    }
    /**
     * Fallback: direct LLM call via vodou-core when gateway is unreachable.
     * No conversation history, no memory, no skills — just a one-shot LLM response.
     */
    async processWithLLMFallback(query) {
        return new Promise((resolve) => {
            const args = ['call', 'Vodou-LLM-router', 'chat', JSON.stringify({ message: query })];
            const proc = spawn(VC_PATH, args, {
                cwd: PROJECT_ROOT,
                env: process.env,
                timeout: 300_000, // 5 min fallback timeout
            });
            let stdout = '';
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            proc.stderr.on('data', () => { });
            proc.on('close', (code) => {
                const text = this.extractChatResponse(stdout);
                if (text)
                    resolve(text);
                else if (code !== 0)
                    resolve('Sorry, I couldn\'t get a reply right now. Try again in a moment.');
                else
                    resolve('I\'m not sure how to respond to that.');
            });
            proc.on('error', (err) => {
                resolve(`Error: ${err.message}`);
            });
        });
    }
    extractChatResponse(stdout) {
        // P1-22: the reply used to be found ONLY by scanning for the '📤 Result:'
        // emoji marker in vodou-core stdout. Any change to the CLI's output format
        // silently dropped every channel reply to "I'm not sure how to respond to
        // that." Prefer the marker, but fall back to the first '{' that parses, and
        // WARN when the marker is missing so the coupling can't rot unnoticed.
        const marker = '📤 Result:';
        const i = stdout.indexOf(marker);
        let jsonStr;
        if (i >= 0) {
            jsonStr = stdout.slice(i + marker.length).trim();
        }
        else {
            console.error('[ChannelManager] extractChatResponse: \'📤 Result:\' marker not found in vodou-core output — falling back to first JSON object. If this recurs, the CLI output format changed and this parser needs updating.');
            jsonStr = stdout.trim();
        }
        const jsonStart = jsonStr.indexOf('{');
        const raw = jsonStart >= 0 ? jsonStr.slice(jsonStart) : jsonStr;
        try {
            const result = JSON.parse(raw);
            const text = result?.content?.[0]?.text;
            if (typeof text !== 'string')
                return null;
            const inner = JSON.parse(text);
            if (inner.response)
                return inner.response;
            if (inner.message)
                return inner.message;
            if (inner.error)
                return inner.error;
            return null;
        }
        catch {
            return null;
        }
    }
}
// Singleton instance
let manager = null;
export function getChannelManager(useOI = true) {
    if (!manager) {
        manager = new ChannelManager(useOI);
    }
    return manager;
}
//# sourceMappingURL=channel-manager.js.map