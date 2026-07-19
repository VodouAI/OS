/**
 * Telegram Channel Implementation
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare class TelegramChannel implements Channel {
    type: "telegram";
    private bot;
    private token;
    private adminId?;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private didLogSenderId;
    private allowlist;
    constructor();
    /** Download Telegram file by file_id into Vodou attachment dir. */
    private downloadTelegramFile;
    private extractAttachments;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=telegram.d.ts.map