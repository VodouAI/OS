/**
 * Microsoft Teams via Azure Bot Framework (HTTP POST /api/messages).
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare class TeamsChannel implements Channel {
    type: "teams";
    private app;
    private server;
    private adapter;
    private bot;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private allowlist;
    private appId;
    private appPassword;
    private tenantId;
    private port;
    constructor();
    connect(): Promise<void>;
    private handleTurn;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=teams.d.ts.map