/**
 * Google Chat app — HTTP POST /api/googlechat, outbound via Chat REST API
 * (@googleapis/chat + service account).
 */

import { createServer, Server as HttpServer } from 'http';
import express, { Express } from 'express';
import { chat } from '@googleapis/chat';
import { JWT, OAuth2Client } from 'google-auth-library';
import type { chat_v1 } from '@googleapis/chat';
import { Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '../types.js';
import { AllowlistWatcher, normalizeGoogleChatHandle } from '../channel-allowlist.js';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

function encodeGoogleChatRecipient(spaceName: string, threadName?: string | null): string {
  return Buffer.from(JSON.stringify({ s: spaceName, t: threadName || '' }), 'utf8').toString('base64url');
}

export class GoogleChatChannel implements Channel {
  type = 'googlechat' as const;
  private app: Express | null = null;
  private server: HttpServer | null = null;
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  private allowlist: AllowlistWatcher | null = null;
  private credsJson = '';
  private port = 3979;
  private chatApi: chat_v1.Chat | null = null;
  /**
   * SEC-1 — bind loopback by default.
   *
   * `listen(port)` with no host binds EVERY interface, so this endpoint was
   * reachable from the whole local network (and from anywhere that could reach
   * the host) while accepting `req.body` with no verification at all. The
   * documented deployment is "your public URL + /api/googlechat", i.e. through
   * a reverse proxy or tunnel — which works fine against loopback and is the
   * only shape where the operator has decided to expose it.
   */
  private host = '127.0.0.1';
  /**
   * SEC-1 — the audience Google signs its request JWT for: your Chat app's
   * project number. Verification is skipped, loudly, when it is not configured,
   * because a silent skip is the state this finding is about.
   */
  private audience = '';

  constructor() {
    this.credsJson = (process.env.GOOGLE_CHAT_CREDENTIALS || '').trim();
    this.port = parseInt(process.env.GOOGLE_CHAT_PORT || '3979', 10);
    this.host = (process.env.GOOGLE_CHAT_HOST || '127.0.0.1').trim() || '127.0.0.1';
    this.audience = (process.env.GOOGLE_CHAT_PROJECT_NUMBER || '').trim();
  }

  /**
   * SEC-1 — is this POST actually from Google Chat?
   *
   * Google signs every request to a Chat app's HTTP endpoint with a Bearer JWT
   * issued by `chat@system.gserviceaccount.com`, audienced to the app's project
   * number. Nothing checked it: the handler answered 200 and dispatched
   * `req.body` straight into the message pipeline, so anything that could reach
   * the port could inject a message as any sender. Teams already verifies via
   * the Bot Framework; this lane simply did not.
   *
   * Returns null when the request is good, or the reason to refuse it.
   */
  private async verifyGoogleRequest(authHeader: string | undefined): Promise<string | null> {
    if (!this.audience) {
      // Not configured. Refuse rather than wave through — the whole finding is
      // that unverified bodies were dispatched. An operator who genuinely wants
      // the old behaviour has to say so.
      if (process.env.GOOGLE_CHAT_ALLOW_UNVERIFIED === '1') return null;
      return 'GOOGLE_CHAT_PROJECT_NUMBER is not set, so this request cannot be verified as coming from Google. ' +
             'Set it to your Chat app project number (or GOOGLE_CHAT_ALLOW_UNVERIFIED=1 if you have put your own auth in front).';
    }
    const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return 'missing Bearer token';
    try {
      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({ idToken: token, audience: this.audience });
      const payload = ticket.getPayload();
      // The issuer check is the point: a valid Google token for some OTHER
      // service is still not Google Chat calling this endpoint.
      if (payload?.email !== 'chat@system.gserviceaccount.com') {
        return `token issuer ${payload?.email ?? '(none)'} is not chat@system.gserviceaccount.com`;
      }
      return null;
    } catch (e) {
      return `token verification failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async connect(): Promise<void> {
    if (!this.credsJson) {
      this.error = 'GOOGLE_CHAT_CREDENTIALS required (service account JSON, one line or pasted from gateway)';
      console.error(`[GoogleChat] ${this.error}`);
      return;
    }
    let creds: Record<string, unknown>;
    try {
      creds = JSON.parse(this.credsJson) as Record<string, unknown>;
    } catch {
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
      this.app.post('/api/googlechat', async (req, res) => {
        // SEC-1 — verify BEFORE answering and before dispatching. The old order
        // (200, then dispatch) meant an unverified body was already in the
        // pipeline by the time anyone could have objected.
        const refusal = await this.verifyGoogleRequest(req.header('authorization'));
        if (refusal) {
          console.error(`[GoogleChat] REFUSED an unverified POST — ${refusal}`);
          res.status(401).json({ error: 'unverified request' });
          return;
        }
        res.status(200).json({});
        void this.handleEventPayload(req.body);
      });

      this.server = createServer(this.app);
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.port, this.host, () => {
          this.connected = true;
          this.error = undefined;
          console.error(
            `[GoogleChat] Listening on http://${this.host}:${this.port}/api/googlechat — ` +
            `point the Chat app at your public URL + /api/googlechat through a proxy or tunnel. ` +
            `(SEC-1: loopback by default; GOOGLE_CHAT_HOST=0.0.0.0 to bind every interface.)`
          );
          resolve();
        });
        this.server!.on('error', reject);
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.connected = false;
      this.chatApi = null;
      console.error('[GoogleChat] connect failed:', this.error);
    }
  }

  private async handleEventPayload(body: Record<string, unknown>): Promise<void> {
    const eventType = typeof body.type === 'string' ? body.type : '';
    if (eventType !== 'MESSAGE') return;

    const msg = body.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') return;

    const sender = msg.sender as Record<string, unknown> | undefined;
    if (sender?.type === 'BOT') return;

    const text = (typeof msg.text === 'string' ? msg.text : '').trim();
    if (!text) return;

    const space = msg.space as Record<string, unknown> | undefined;
    const spaceName = typeof space?.name === 'string' ? space.name : '';
    if (!spaceName) {
      console.error('[GoogleChat] Missing space.name — skipping');
      return;
    }

    const thread = msg.thread as Record<string, unknown> | undefined;
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
      } else {
        console.error(`[GoogleChat] Not in allowlist (user=${userName}) — skipping`);
      }
      return;
    }

    this.lastActivity = new Date();
    const senderRef = encodeGoogleChatRecipient(spaceName, threadName || null);

    const incoming: IncomingMessage = {
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
        const requestBody: chat_v1.Schema$Message = { text: response };
        if (threadName) requestBody.thread = { name: threadName };
        await this.chatApi.spaces.messages.create({
          parent: spaceName,
          requestBody,
        });
      }
    } catch (err) {
      console.error('[GoogleChat] handler/send error:', err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.app = null;
    this.chatApi = null;
    this.connected = false;
    this.allowlist?.dispose();
    this.allowlist = null;
  }

  async send(message: OutgoingMessage): Promise<boolean> {
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
      const requestBody: chat_v1.Schema$Message = { text: message.content };
      if (routing.thread) requestBody.thread = { name: routing.thread };
      await this.chatApi.spaces.messages.create({
        parent: routing.space,
        requestBody,
      });
      return true;
    } catch (e) {
      console.error('[GoogleChat] send failed:', e instanceof Error ? e.message : e);
      return false;
    }
  }

  getStatus(): ChannelStatus {
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

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }
}

export type GoogleChatRouting = { space: string; thread?: string };

export function decodeGoogleChatRecipient(recipient: string): GoogleChatRouting | null {
  if (!recipient || typeof recipient !== 'string') return null;
  try {
    const buf = Buffer.from(recipient, 'base64url');
    const o = JSON.parse(buf.toString('utf8')) as { s?: string; t?: string; space?: string; thread?: string };
    const space = (o.s || o.space || '').trim();
    if (!space) return null;
    const thread = (o.t || o.thread || '').trim();
    return { space, ...(thread ? { thread } : {}) };
  } catch {
    try {
      const buf = Buffer.from(recipient, 'base64');
      const o = JSON.parse(buf.toString('utf8')) as { s?: string; t?: string; space?: string; thread?: string };
      const space = (o.s || o.space || '').trim();
      if (!space) return null;
      const thread = (o.t || o.thread || '').trim();
      return { space, ...(thread ? { thread } : {}) };
    } catch {
      return null;
    }
  }
}
