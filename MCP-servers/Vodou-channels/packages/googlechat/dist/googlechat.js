/**
 * Google Chat app — HTTP POST /api/googlechat, outbound via Chat REST API
 * (@googleapis/chat + service account).
 */
import { createServer } from 'http';
import express from 'express';
import { chat } from '@googleapis/chat';
import { JWT } from 'google-auth-library';
import { AllowlistWatcher, normalizeGoogleChatHandle } from '@vodou/channel-sdk';
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
function encodeGoogleChatRecipient(spaceName, threadName) {
    return Buffer.from(JSON.stringify({ s: spaceName, t: threadName || '' }), 'utf8').toString('base64url');
}
export class GoogleChatChannel {
    type = 'googlechat';
    app = null;
    server = null;
    connected = false;
    lastActivity;
    error;
    messageHandler;
    allowlist = null;
    credsJson = '';
    port = 3979;
    chatApi = null;
    constructor() {
        this.credsJson = (process.env.GOOGLE_CHAT_CREDENTIALS || '').trim();
        this.port = parseInt(process.env.GOOGLE_CHAT_PORT || '3979', 10);
    }
    async connect() {
        if (!this.credsJson) {
            this.error = 'GOOGLE_CHAT_CREDENTIALS required (service account JSON, one line or pasted from gateway)';
            console.error(`[GoogleChat] ${this.error}`);
            return;
        }
        let creds;
        try {
            creds = JSON.parse(this.credsJson);
        }
        catch {
            this.error = 'GOOGLE_CHAT_CREDENTIALS must be valid JSON';
            console.error(`[GoogleChat] ${this.error}`);
            return;
        }
        if (!creds.client_email || !creds.private_key) {
            this.error = 'GOOGLE_CHAT_CREDENTIALS must be a service account JSON key (client_email + private_key)';
            console.error(`[GoogleChat] ${this.error}`);
            return;
        }
        if (!this.allowlist) {
            this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'googlechat', normalizeGoogleChatHandle);
        }
        try {
            const jwt = new JWT({
                email: String(creds.client_email),
                key: String(creds.private_key).replace(/\\n/g, '\n'),
                scopes: ['https://www.googleapis.com/auth/chat.bot'],
            });
            this.chatApi = chat({ version: 'v1', auth: jwt });
            this.app = express();
            this.app.use(express.json({ limit: '2mb' }));
            this.app.get('/health', (_req, res) => {
                res.json({ status: 'ok', channel: 'googlechat', connected: this.connected });
            });
            this.app.get('/api/googlechat', (_req, res) => {
                res.status(200).send('ok');
            });
            this.app.post('/api/googlechat', (req, res) => {
                res.status(200).json({});
                void this.handleEventPayload(req.body);
            });
            this.server = createServer(this.app);
            await new Promise((resolve, reject) => {
                this.server.listen(this.port, () => {
                    this.connected = true;
                    this.error = undefined;
                    console.error(`[GoogleChat] Listening on http://0.0.0.0:${this.port}/api/googlechat — set the Chat app HTTP endpoint to your public URL + /api/googlechat`);
                    resolve();
                });
                this.server.on('error', reject);
            });
        }
        catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
            this.connected = false;
            this.chatApi = null;
            console.error('[GoogleChat] connect failed:', this.error);
        }
    }
    async handleEventPayload(body) {
        const eventType = typeof body.type === 'string' ? body.type : '';
        if (eventType !== 'MESSAGE')
            return;
        const msg = body.message;
        if (!msg || typeof msg !== 'object')
            return;
        const sender = msg.sender;
        if (sender?.type === 'BOT')
            return;
        const text = (typeof msg.text === 'string' ? msg.text : '').trim();
        if (!text)
            return;
        const space = msg.space;
        const spaceName = typeof space?.name === 'string' ? space.name : '';
        if (!spaceName) {
            console.error('[GoogleChat] Missing space.name — skipping');
            return;
        }
        const thread = msg.thread;
        const threadName = typeof thread?.name === 'string' ? thread.name : '';
        const userName = typeof sender?.name === 'string' ? sender.name : '';
        const displayName = typeof sender?.displayName === 'string' ? sender.displayName : '';
        // CWE-639 hardening (OpenClaw 2026-06-03 zero-day class): authorize ONLY on
        // immutable IDs — the `users/<id>` resource name and the message/space name.
        // displayName is user-editable and non-unique, so it is NEVER an auth key
        // (an attacker could set their profile name to an allowlisted owner's name
        // and hijack the agent). Reject displayName-only matches with a warning.
        const candidates = [userName, typeof msg.name === 'string' ? msg.name : ''].filter(Boolean);
        if (this.allowlist && !this.allowlist.isAnyAllowed(candidates)) {
            if (displayName && this.allowlist.isAllowed(displayName)) {
                console.error(`[GoogleChat] SECURITY: rejected sender matched ONLY by mutable displayName (${displayName}); re-add by resource name ${userName} to allow (CWE-639 fix)`);
            }
            else {
                console.error(`[GoogleChat] Not in allowlist (user=${userName}) — skipping`);
            }
            return;
        }
        this.lastActivity = new Date();
        const senderRef = encodeGoogleChatRecipient(spaceName, threadName || null);
        const incoming = {
            id: typeof msg.name === 'string' ? msg.name : `${Date.now()}`,
            channel: 'googlechat',
            sender: senderRef,
            senderName: displayName || userName || 'Google Chat user',
            content: text,
            timestamp: new Date(),
            raw: body,
        };
        if (!this.messageHandler) {
            console.error('[GoogleChat] No messageHandler — dropping message');
            return;
        }
        try {
            const response = await this.messageHandler(incoming);
            if (response && this.chatApi) {
                const requestBody = { text: response };
                if (threadName)
                    requestBody.thread = { name: threadName };
                await this.chatApi.spaces.messages.create({
                    parent: spaceName,
                    requestBody,
                });
            }
        }
        catch (err) {
            console.error('[GoogleChat] handler/send error:', err);
        }
    }
    async disconnect() {
        if (this.server) {
            await new Promise((resolve) => {
                this.server.close(() => resolve());
            });
            this.server = null;
        }
        this.app = null;
        this.chatApi = null;
        this.connected = false;
        this.allowlist?.dispose();
        this.allowlist = null;
    }
    async send(message) {
        if (!this.chatApi) {
            console.error('[GoogleChat] send: API client not initialized');
            return false;
        }
        const routing = decodeGoogleChatRecipient(message.recipient);
        if (!routing) {
            console.error('[GoogleChat] send: invalid recipient ref (expected base64url JSON {s,t})');
            return false;
        }
        try {
            const requestBody = { text: message.content };
            if (routing.thread)
                requestBody.thread = { name: routing.thread };
            await this.chatApi.spaces.messages.create({
                parent: routing.space,
                requestBody,
            });
            return true;
        }
        catch (e) {
            console.error('[GoogleChat] send failed:', e instanceof Error ? e.message : e);
            return false;
        }
    }
    getStatus() {
        return {
            channel: 'googlechat',
            connected: this.connected,
            error: this.error,
            lastActivity: this.lastActivity,
            metadata: {
                port: this.port,
                messagingPath: '/api/googlechat',
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
            name: 'googlechat',
            displayName: 'Google Chat',
            version: '1.0.0',
            description: 'Google Chat channel for Vodou',
            author: 'Vodou AI',
            signed: true,
            requiredEnv: ['GOOGLE_CHAT_CREDENTIALS'],
            optionalEnv: ['GOOGLE_CHAT_PORT'],
        };
    }
}
export function decodeGoogleChatRecipient(recipient) {
    if (!recipient || typeof recipient !== 'string')
        return null;
    try {
        const buf = Buffer.from(recipient, 'base64url');
        const o = JSON.parse(buf.toString('utf8'));
        const space = (o.s || o.space || '').trim();
        if (!space)
            return null;
        const thread = (o.t || o.thread || '').trim();
        return { space, ...(thread ? { thread } : {}) };
    }
    catch {
        try {
            const buf = Buffer.from(recipient, 'base64');
            const o = JSON.parse(buf.toString('utf8'));
            const space = (o.s || o.space || '').trim();
            if (!space)
                return null;
            const thread = (o.t || o.thread || '').trim();
            return { space, ...(thread ? { thread } : {}) };
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=googlechat.js.map