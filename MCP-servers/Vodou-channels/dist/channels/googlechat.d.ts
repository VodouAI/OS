/**
 * Google Chat app — HTTP POST /api/googlechat, outbound via Chat REST API
 * (@googleapis/chat + service account).
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '../types.js';
export declare class GoogleChatChannel implements Channel {
    type: "googlechat";
    private app;
    private server;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private allowlist;
    private credsJson;
    private port;
    private chatApi;
    constructor();
    connect(): Promise<void>;
    private handleEventPayload;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
}
export type GoogleChatRouting = {
    space: string;
    thread?: string;
};
export declare function decodeGoogleChatRecipient(recipient: string): GoogleChatRouting | null;
//# sourceMappingURL=googlechat.d.ts.map