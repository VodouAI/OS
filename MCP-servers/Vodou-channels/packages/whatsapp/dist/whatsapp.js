/**
 * WhatsApp Channel — thin wrapper around the vendored whatsmeow bridge.
 *
 * Architecture:
 *   1. On connect(), spawn `whatsapp-bridge/whatsapp-bridge` as a child process
 *      with BRIDGE_STORE_DIR pointed at .vodou/whatsapp-auth so existing reset
 *      tooling continues to work.
 *   2. The bridge writes its QR code to <storeDir>/qr.txt — the gateway UI
 *      reads this same path. No extra plumbing needed.
 *   3. The bridge POSTs your own messages (IsFromMe) to BRIDGE_INCOMING_WEBHOOK;
 *      others' DMs are not forwarded. We run a tiny localhost server to receive
 *      them and forward through the message handler.
 *   4. Outbound messages POST to the bridge's /api/send.
 *
 * Why this replaces the previous Baileys implementation: Baileys 7.x rcs lag
 * WhatsApp Web protocol changes and we were getting consistent 405 handshake
 * rejections. whatsmeow (Go) is the most actively maintained WA Web client
 * and is the same one Vodou used successfully in earlier versions.
 */
import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import * as http from 'http';
import { AllowlistWatcher, normalizeWhatsappHandle } from '@vodou/channel-sdk';
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || join(PROJECT_ROOT, '.vodou', 'whatsapp-auth');
const BRIDGE_BIN = join(PROJECT_ROOT, 'MCP-servers', 'Vodou-channels', 'whatsapp-bridge', 'whatsapp-bridge');
const BRIDGE_PORT = parseInt(process.env.WHATSAPP_BRIDGE_PORT || '8081', 10);
const WEBHOOK_PORT = parseInt(process.env.WHATSAPP_WEBHOOK_PORT || '8082', 10);
function guessMimeFromWhatsApp(filename, mediaType) {
    if (!filename) {
        if (mediaType === 'image')
            return 'image/jpeg';
        if (mediaType === 'video')
            return 'video/mp4';
        if (mediaType === 'audio')
            return 'audio/ogg';
        return undefined;
    }
    const ext = filename.toLowerCase().split('.').pop() || '';
    const map = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
        ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
        pdf: 'application/pdf',
    };
    return map[ext];
}
export class WhatsAppChannel {
    type = 'whatsapp';
    bridge = null;
    webhookServer = null;
    connected = false;
    loggedIn = false;
    lastActivity;
    error;
    messageHandler;
    healthPoller;
    /** User or disconnectAll() requested shutdown — do not auto-respawn bridge */
    intentionalDisconnect = false;
    reconnectTimer = null;
    allowlist = null;
    // Echo tracker — this channel only processes is_from_me messages (the owner
    // drives their own WhatsApp account). Vodou's OWN replies go out via
    // /api/send and come straight back through the webhook as is_from_me too, so
    // without this guard every reply re-enters handleIncoming and loops. Mirrors
    // the iMessage echo tracker: record what we send, skip matching inbound
    // within a 60s window (bridge normally webhooks the echo within 1-2s).
    recentOutbound = [];
    constructor() {
        try {
            mkdirSync(AUTH_DIR, { recursive: true });
        }
        catch { }
    }
    async connect() {
        if (this.bridge)
            return; // already running
        this.intentionalDisconnect = false;
        if (!this.allowlist) {
            this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'whatsapp', normalizeWhatsappHandle);
        }
        if (!existsSync(BRIDGE_BIN)) {
            this.error = `WhatsApp bridge binary not found at ${BRIDGE_BIN}. Run: cd MCP-servers/Vodou-channels/whatsapp-bridge && go build -o whatsapp-bridge ./main.go`;
            console.error(`[WhatsApp] ${this.error}`);
            return;
        }
        // 0. Kill any orphaned whatsapp-bridge processes from a previous run that
        //    didn't get a clean shutdown. They'd be holding our BRIDGE_PORT and
        //    EADDRINUSE the new spawn.
        this.killOrphanedBridges();
        // 1. Start the local webhook receiver before the bridge so we don't miss
        //    messages that arrive immediately after pairing.
        this.startWebhookServer();
        // 2. Spawn the bridge with our env config.
        const env = {
            ...process.env,
            BRIDGE_STORE_DIR: AUTH_DIR,
            BRIDGE_PORT: String(BRIDGE_PORT),
            BRIDGE_INCOMING_WEBHOOK: `http://127.0.0.1:${WEBHOOK_PORT}/incoming`,
        };
        console.error(`[WhatsApp] Spawning bridge: ${BRIDGE_BIN} (port=${BRIDGE_PORT}, store=${AUTH_DIR})`);
        this.bridge = spawn(BRIDGE_BIN, [], {
            cwd: AUTH_DIR, // bridge writes ./store relative paths if BRIDGE_STORE_DIR isn't picked up — keep cwd safe
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.bridge.stdout?.on('data', (d) => {
            const text = d.toString();
            // Forward bridge stdout to the channel log so it shows up alongside
            // [WhatsApp] lines in .vodou/workspace/channels-whatsapp.log.
            // P1-20: write to STDERR, not stdout — when Vodou-channels runs as a
            // pooled MCP-stdio server, stdout carries JSON-RPC framing and any stray
            // bytes corrupt the protocol stream. stderr is the channel log anyway.
            process.stderr.write(`[bridge] ${text}`);
        });
        this.bridge.stderr?.on('data', (d) => {
            process.stderr.write(`[bridge] ${d.toString()}`);
        });
        this.bridge.on('exit', (code, signal) => {
            console.error(`[WhatsApp] Bridge exited (code=${code}, signal=${signal})`);
            this.bridge = null;
            this.connected = false;
            this.loggedIn = false;
            if (code !== 0 && code !== null) {
                this.error = `Bridge crashed with exit code ${code}`;
            }
            // Respawn only on crash — clean exit 0 is normal shutdown / user stop.
            if (!this.intentionalDisconnect && code !== 0 && code !== null) {
                this.scheduleBridgeReconnect();
            }
        });
        // 3. Poll bridge /api/health until it reports connected+logged_in.
        this.startHealthPoller();
    }
    killOrphanedBridges() {
        // pkill -f matches the full command line. The bridge binary path is
        // unique enough that this won't false-positive.
        try {
            const result = spawnSync('pkill', ['-f', 'whatsapp-bridge/whatsapp-bridge'], { stdio: 'ignore' });
            if (result.status === 0) {
                console.error('[WhatsApp] Killed orphaned bridge process(es) from previous run');
                // Give the OS a beat to release the port
                const wait = spawnSync('sleep', ['0.5']);
                void wait;
            }
        }
        catch {
            // pkill not available (unlikely on macOS/Linux) — silently skip
        }
    }
    startWebhookServer() {
        if (this.webhookServer)
            return;
        this.webhookServer = http.createServer((req, res) => {
            if (req.method !== 'POST' || req.url !== '/incoming') {
                res.writeHead(404);
                res.end();
                return;
            }
            let body = '';
            req.on('data', (c) => { body += c.toString(); });
            req.on('end', () => {
                // ACK the bridge immediately so its HTTP client doesn't time out
                // waiting for us to run the full LLM pipeline (which can take 10-30s
                // for deep thinking sessions). Processing happens async — any error
                // shows up in the WhatsApp log, not as a webhook 500.
                let payload;
                try {
                    payload = JSON.parse(body);
                }
                catch (err) {
                    console.error('[WhatsApp] Webhook JSON parse error:', err);
                    res.writeHead(400);
                    res.end();
                    return;
                }
                res.writeHead(200);
                res.end('{"ok":true}');
                this.handleIncoming(payload).catch((err) => {
                    console.error('[WhatsApp] handleIncoming error:', err);
                });
            });
        });
        this.webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => {
            console.error(`[WhatsApp] Webhook listener on 127.0.0.1:${WEBHOOK_PORT}/incoming`);
        });
        this.webhookServer.on('error', (err) => {
            console.error('[WhatsApp] Webhook server error:', err);
            const hint = err.code === 'EADDRINUSE'
                ? ` Port ${WEBHOOK_PORT} in use — stop the other Vodou-channels/WhatsApp process (or MCP worker with WA) so only one listener owns 127.0.0.1:${WEBHOOK_PORT}.`
                : '';
            this.error = `Webhook listener failed: ${err.message}.${hint}`;
        });
    }
    /** Debounced respawn after unexpected bridge exit (standalone / long-running WA). */
    scheduleBridgeReconnect() {
        if (this.intentionalDisconnect)
            return;
        if (this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.intentionalDisconnect || this.bridge)
                return;
            console.error('[WhatsApp] Attempting bridge reconnect after exit...');
            try {
                await this.connect();
            }
            catch (e) {
                console.error('[WhatsApp] Reconnect failed:', e);
            }
        }, 4000);
    }
    startHealthPoller() {
        if (this.healthPoller)
            return;
        let attempts = 0;
        this.healthPoller = setInterval(async () => {
            attempts++;
            const health = await this.fetchHealth();
            if (health) {
                this.connected = health.connected;
                this.loggedIn = health.logged_in;
                if (health.connected) {
                    this.error = undefined;
                    this.lastActivity = new Date();
                }
            }
            // Stop polling once healthy and logged in (we'll resume on disconnect)
            if (this.connected && this.loggedIn) {
                if (this.healthPoller)
                    clearInterval(this.healthPoller);
                this.healthPoller = undefined;
                console.error('[WhatsApp] Bridge connected and authenticated');
            }
            // Give up after ~3 minutes if still not paired (user hasn't scanned QR)
            if (attempts > 180) {
                if (this.healthPoller)
                    clearInterval(this.healthPoller);
                this.healthPoller = undefined;
            }
        }, 1000);
    }
    fetchHealth() {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${BRIDGE_PORT}/api/health`, { timeout: 1500 }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c.toString(); });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    }
                    catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }
    async handleIncoming(payload) {
        if (!payload.is_from_me)
            return;
        if (payload.is_group)
            return;
        if (!payload.content && !payload.media_type)
            return;
        // Echo guard — drop our own /api/send replies that the bridge webhooks back
        // as is_from_me. Match recipient (chat_jid) + text within the 60s window.
        {
            const now = Date.now();
            const isEcho = this.recentOutbound.some(r => r.recipient === payload.chat_jid &&
                r.text === (payload.content || '') &&
                now - r.sentAt < 60_000);
            if (isEcho) {
                console.error('[WhatsApp] Skipping self-echo (matches recent outbound)');
                return;
            }
        }
        // Apple-style allowlist: if mode=on, only pass senders on the list.
        // Match against both chat_jid (the reply target) and the raw sender JID.
        if (this.allowlist && !this.allowlist.isAnyAllowed([payload.chat_jid, payload.sender])) {
            console.error(`[WhatsApp] Sender not in allowlist: ${payload.sender} — skipping`);
            return;
        }
        this.lastActivity = new Date();
        const incoming = {
            id: payload.id,
            channel: 'whatsapp',
            sender: payload.chat_jid,
            senderName: payload.name || payload.sender,
            content: payload.content || `[${payload.media_type || 'media'}]`,
            timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
            raw: payload,
        };
        if (payload.media_type) {
            const mt = payload.media_type;
            const t = mt === 'image' ? 'image' :
                mt === 'audio' ? 'audio' :
                    mt === 'video' ? 'video' : 'file';
            const mime = payload.mime_type || guessMimeFromWhatsApp(payload.filename, mt);
            incoming.attachments = [{
                    type: t,
                    filename: payload.filename,
                    url: payload.media_path,
                    mimeType: mime,
                }];
        }
        if (this.messageHandler) {
            try {
                const response = await this.messageHandler(incoming);
                if (response) {
                    await this.send({
                        channel: 'whatsapp',
                        recipient: payload.chat_jid,
                        content: response,
                    });
                }
            }
            catch (err) {
                console.error('[WhatsApp] Error handling message:', err);
            }
        }
    }
    async disconnect() {
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.healthPoller) {
            clearInterval(this.healthPoller);
            this.healthPoller = undefined;
        }
        if (this.bridge) {
            try {
                this.bridge.kill('SIGTERM');
            }
            catch { }
            this.bridge = null;
        }
        if (this.webhookServer) {
            try {
                this.webhookServer.close();
            }
            catch { }
            this.webhookServer = null;
        }
        if (this.allowlist) {
            this.allowlist.dispose();
            this.allowlist = null;
        }
        this.connected = false;
        this.loggedIn = false;
        console.error('[WhatsApp] Disconnected');
    }
    async send(message) {
        if (!this.bridge || !this.connected) {
            console.error('[WhatsApp] Cannot send — bridge not connected');
            return false;
        }
        return new Promise((resolve) => {
            const body = JSON.stringify({
                recipient: message.recipient,
                message: message.content,
                ...(message.mediaPath ? { media_path: message.mediaPath } : {}),
            });
            const req = http.request({
                host: '127.0.0.1',
                port: BRIDGE_PORT,
                path: '/api/send',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 10000,
            }, (res) => {
                let respBody = '';
                res.on('data', (c) => { respBody += c.toString(); });
                res.on('end', () => {
                    const ok = res.statusCode === 200;
                    if (!ok)
                        console.error(`[WhatsApp] Send failed: ${res.statusCode} ${respBody}`);
                    this.lastActivity = new Date();
                    if (ok) {
                        // Record for the echo guard so the bridge's is_from_me webhook of
                        // this very message doesn't re-enter handleIncoming as new input.
                        const now = Date.now();
                        this.recentOutbound.push({ recipient: message.recipient, text: message.content, sentAt: now });
                        this.recentOutbound = this.recentOutbound.filter(r => now - r.sentAt < 60_000);
                    }
                    resolve(ok);
                });
            });
            req.on('error', (err) => {
                console.error('[WhatsApp] Send error:', err.message);
                resolve(false);
            });
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.write(body);
            req.end();
        });
    }
    getStatus() {
        return {
            channel: 'whatsapp',
            connected: this.connected,
            error: this.error,
            lastActivity: this.lastActivity,
            metadata: {
                bridgeRunning: !!this.bridge,
                loggedIn: this.loggedIn,
                bridgePort: BRIDGE_PORT,
                webhookPort: WEBHOOK_PORT,
                authDir: AUTH_DIR,
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
            name: 'whatsapp',
            displayName: 'WhatsApp',
            version: '1.0.0',
            description: 'WhatsApp channel for Vodou',
            author: 'Vodou AI',
            signed: true,
            requiredEnv: [],
            optionalEnv: ['WHATSAPP_BRIDGE_PORT'],
        };
    }
}
//# sourceMappingURL=whatsapp.js.map