/**
 * Discord Channel Implementation
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare class DiscordChannel implements Channel {
    type: "discord";
    private client;
    private token;
    private guildId?;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private allowlist;
    constructor();
    private extractAttachments;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=discord.d.ts.map