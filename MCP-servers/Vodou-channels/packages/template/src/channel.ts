/**
 * Vodou Channel Template
 *
 * Copy this package, rename to `@yourscope/channel-<name>`, and replace the
 * marked sections to integrate a new messaging service.
 *
 *   1. Rename the package in package.json (must match `@scope/channel-<name>`).
 *   2. Replace MY_CHANNEL_TYPE below with your channel id (e.g. 'matrix').
 *      If your id isn't in the SDK's ChannelType union, either widen the union
 *      in @vodou/channel-sdk or cast as shown.
 *   3. Implement connect()/disconnect()/send().
 *   4. List required + optional env vars in manifest().
 *   5. `npm run build` then `npm publish` (or install locally for testing).
 *
 * Local testing without publishing:
 *   cd ~/.vodou/channels && npm install /absolute/path/to/this/package
 */

import type {
  Attachment,
  Channel,
  ChannelManifest,
  ChannelStatus,
  ChannelType,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  VodouChannel,
} from '@vodou/channel-sdk';
import { AllowlistWatcher } from '@vodou/channel-sdk';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

// Replace with your channel id. Cast keeps the template compiling until the
// SDK union is widened to include it.
const MY_CHANNEL_TYPE = 'web' as ChannelType;
const MY_CHANNEL_NAME = 'template';

export class TemplateChannel implements VodouChannel {
  type = MY_CHANNEL_TYPE;

  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  private allowlist: AllowlistWatcher | null = null;

  // Replace with the env vars your service needs.
  private token: string;

  constructor() {
    this.token = process.env.MY_CHANNEL_TOKEN || '';
  }

  async connect(): Promise<void> {
    if (!this.token) {
      this.error = 'MY_CHANNEL_TOKEN not set';
      console.error(`[${MY_CHANNEL_NAME}] ${this.error}`);
      return;
    }

    // Per-channel allowlist file: .vodou/channels/<name>-allowlist.json
    // The third arg normalizes incoming sender ids before comparison —
    // strip @ prefixes, lowercase, etc. Identity is fine for most channels.
    if (!this.allowlist) {
      this.allowlist = new AllowlistWatcher(PROJECT_ROOT, MY_CHANNEL_NAME, (s) => s.trim());
    }

    try {
      // ── REPLACE ──────────────────────────────────────────────────────────
      // Open the connection / start polling / register webhook.
      // When a message arrives from the upstream service:
      //   1. Check `this.allowlist?.isAnyAllowed([senderId, username, ...])`
      //   2. Build an IncomingMessage
      //   3. Call this.deliver(incoming)
      // ─────────────────────────────────────────────────────────────────────

      this.connected = true;
      this.error = undefined;
      console.error(`[${MY_CHANNEL_NAME}] Connected`);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[${MY_CHANNEL_NAME}] Connection failed: ${this.error}`);
    }
  }

  async disconnect(): Promise<void> {
    // Tear down upstream connection here.
    if (this.allowlist) {
      this.allowlist.dispose();
      this.allowlist = null;
    }
    this.connected = false;
    console.error(`[${MY_CHANNEL_NAME}] Disconnected`);
  }

  async send(message: OutgoingMessage): Promise<boolean> {
    if (!this.connected) {
      console.error(`[${MY_CHANNEL_NAME}] Cannot send — not connected`);
      return false;
    }

    try {
      // ── REPLACE ──────────────────────────────────────────────────────────
      // Translate `message.content` into your service's send call.
      // Honor message.replyTo and message.attachments if your service supports them.
      // ─────────────────────────────────────────────────────────────────────
      console.error(`[${MY_CHANNEL_NAME}] (stub) send to ${message.recipient}: ${message.content}`);
      this.lastActivity = new Date();
      return true;
    } catch (err) {
      console.error(`[${MY_CHANNEL_NAME}] Send error:`, err);
      return false;
    }
  }

  getStatus(): ChannelStatus {
    return {
      channel: MY_CHANNEL_TYPE,
      connected: this.connected,
      error: this.error,
      lastActivity: this.lastActivity,
      metadata: {
        hasToken: !!this.token,
        allowlistMode: this.allowlist?.get().mode ?? 'off',
        allowlistCount: this.allowlist?.get().senders.length ?? 0,
      },
    };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  manifest(): ChannelManifest {
    return {
      name: MY_CHANNEL_NAME,
      displayName: 'Template Channel',
      version: '1.0.0',
      description: 'Starter template — replace this string',
      author: 'your-name',
      signed: false,
      requiredEnv: ['MY_CHANNEL_TOKEN'],
      optionalEnv: [],
    };
  }

  /**
   * Helper: hand an IncomingMessage to the gateway and pipe the response back.
   * Call this from your upstream listener after the allowlist check passes.
   */
  protected async deliver(incoming: IncomingMessage, attachments?: Attachment[]): Promise<void> {
    this.lastActivity = new Date();
    const msg: IncomingMessage = attachments?.length ? { ...incoming, attachments } : incoming;

    if (!this.messageHandler) return;
    try {
      const response = await this.messageHandler(msg);
      if (response) {
        await this.send({
          channel: MY_CHANNEL_TYPE,
          recipient: msg.sender,
          content: response,
          replyTo: msg.id,
        });
      }
    } catch (err) {
      console.error(`[${MY_CHANNEL_NAME}] Error handling message:`, err);
    }
  }
}

// Compile-time guard: TemplateChannel must satisfy the Channel contract.
const _typecheck: Channel = new TemplateChannel();
void _typecheck;
