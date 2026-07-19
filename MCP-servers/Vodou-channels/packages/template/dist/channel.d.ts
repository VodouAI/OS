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
import type { Attachment, ChannelManifest, ChannelStatus, ChannelType, IncomingMessage, MessageHandler, OutgoingMessage, VodouChannel } from '@vodou/channel-sdk';
export declare class TemplateChannel implements VodouChannel {
    type: ChannelType;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private allowlist;
    private token;
    constructor();
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    manifest(): ChannelManifest;
    /**
     * Helper: hand an IncomingMessage to the gateway and pipe the response back.
     * Call this from your upstream listener after the allowlist check passes.
     */
    protected deliver(incoming: IncomingMessage, attachments?: Attachment[]): Promise<void>;
}
//# sourceMappingURL=channel.d.ts.map