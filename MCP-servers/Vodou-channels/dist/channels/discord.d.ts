/**
 * Discord Channel Implementation
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '../types.js';
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
}
//# sourceMappingURL=discord.d.ts.map