/**
 * Microsoft Teams via Azure Bot Framework (HTTP POST /api/messages).
 */

import { createServer, Server as HttpServer } from 'http';
import express, { Express } from 'express';
import {
  ActivityHandler,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
} from 'botbuilder';
import { Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
import { AllowlistWatcher, normalizeTeamsHandle } from '@vodou/channel-sdk';
import { decodeTeamsRecipient, getBotFrameworkAccessToken, sendTeamsActivity } from './teams-outbound-rest.js';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

function encodeTeamsRecipient(serviceUrl: string, conversationId: string): string {
  return Buffer.from(JSON.stringify({ s: serviceUrl, c: conversationId }), 'utf8').toString('base64url');
}

export class TeamsChannel implements Channel {
  type = 'teams' as const;
  private app: Express | null = null;
  private server: HttpServer | null = null;
  private adapter: CloudAdapter | null = null;
  private bot: ActivityHandler | null = null;
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  private allowlist: AllowlistWatcher | null = null;
  private appId = '';
  private appPassword = '';
  private tenantId = '';
  private port = 3978;

  constructor() {
    this.appId = process.env.TEAMS_APP_ID || process.env.MicrosoftAppId || '';
    this.appPassword = process.env.TEAMS_APP_PASSWORD || process.env.MicrosoftAppPassword || '';
    this.tenantId = process.env.TEAMS_TENANT_ID || '';
    this.port = parseInt(process.env.TEAMS_PORT || process.env.TEAMS_APP_PORT || '3978', 10);
  }

  async connect(): Promise<void> {
    if (!this.appId || !this.appPassword) {
      this.error = 'TEAMS_APP_ID and TEAMS_APP_PASSWORD required (Azure Bot App ID + Client Secret)';
      console.error(`[Teams] ${this.error}`);
      return;
    }

    if (!this.allowlist) {
      this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'teams', normalizeTeamsHandle);
    }

    try {
      const auth = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: this.appId,
        MicrosoftAppPassword: this.appPassword,
        ...(this.tenantId.trim() ?
          { MicrosoftAppTenantId: this.tenantId.trim(), MicrosoftAppType: 'SingleTenant' }
        : { MicrosoftAppType: 'MultiTenant' }),
      });
      this.adapter = new CloudAdapter(auth);

      this.bot = new ActivityHandler();
      this.bot.onMessage(async (context: TurnContext, next: () => Promise<void>) => {
        await this.handleTurn(context);
        await next();
      });

      this.app = express();
      this.app.use(express.json({ limit: '1mb' }));
      this.app.get('/health', (_req, res) => {
        res.json({ status: 'ok', channel: 'teams', connected: this.connected });
      });
      this.app.post('/api/messages', async (req, res) => {
        if (!this.adapter || !this.bot) {
          res.status(503).send('Teams adapter not ready');
          return;
        }
        await this.adapter.process(req, res, (ctx) => this.bot!.run(ctx));
      });

      this.server = createServer(this.app);
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.port, () => {
          this.connected = true;
          this.error = undefined;
          console.error(`[Teams] Listening on http://0.0.0.0:${this.port}/api/messages — set Azure Bot messaging endpoint to your public URL + /api/messages`);
          resolve();
        });
        this.server!.on('error', reject);
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.connected = false;
      console.error('[Teams] connect failed:', this.error);
    }
  }

  private async handleTurn(context: TurnContext): Promise<void> {
    const act = context.activity;
    if (act.type !== 'message') return;
    if (act.from?.role === 'bot') return;

    const text = (act.text || '').trim();
    if (!text) return;

    const convId = act.conversation?.id || '';
    const serviceUrl = act.serviceUrl || '';
    if (!convId || !serviceUrl) {
      console.error('[Teams] Missing conversation id or serviceUrl — skipping');
      return;
    }

    const userId = act.from?.id || '';
    const tenantHint = act.conversation?.tenantId || '';
    const candidates = [userId, convId, tenantHint].filter(Boolean);

    if (this.allowlist && !this.allowlist.isAnyAllowed(candidates)) {
      console.error(`[Teams] Not in allowlist (user=${userId} conv=${convId.slice(0, 24)}…) — skipping`);
      return;
    }

    this.lastActivity = new Date();
    const sender = encodeTeamsRecipient(serviceUrl, convId);

    const incoming: IncomingMessage = {
      id: act.id || `${Date.now()}`,
      channel: 'teams',
      sender,
      senderName: act.from?.name || act.from?.aadObjectId || userId,
      content: text,
      timestamp: new Date(),
      raw: act,
    };

    if (!this.messageHandler) {
      console.error('[Teams] No messageHandler — dropping message');
      return;
    }

    try {
      const response = await this.messageHandler(incoming);
      if (response) {
        await context.sendActivity(response);
      }
    } catch (err) {
      console.error('[Teams] handler error:', err);
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
    this.adapter = null;
    this.bot = null;
    this.connected = false;
    this.allowlist?.dispose();
    this.allowlist = null;
  }

  async send(message: OutgoingMessage): Promise<boolean> {
    const routing = decodeTeamsRecipient(message.recipient);
    if (!routing) {
      console.error('[Teams] send: invalid recipient ref (expected base64url JSON {s,c})');
      return false;
    }
    const token = await getBotFrameworkAccessToken(this.appId, this.appPassword, this.tenantId || undefined);
    if (!token) return false;
    const id = await sendTeamsActivity({
      token,
      routing,
      text: message.content,
      botAppId: this.appId,
    });
    return id !== null;
  }

  getStatus(): ChannelStatus {
    return {
      channel: 'teams',
      connected: this.connected,
      error: this.error,
      lastActivity: this.lastActivity,
      metadata: {
        port: this.port,
        messagingPath: '/api/messages',
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
      name: 'teams',
      displayName: 'Microsoft Teams',
      version: '1.0.0',
      description: 'Microsoft Teams channel for Vodou',
      author: 'Vodou AI',
      signed: true,
      requiredEnv: ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD'],
      optionalEnv: [],
    };
  }

}
