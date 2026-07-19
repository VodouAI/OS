/**
 * Web Channel Implementation
 * Simple WebSocket-based web interface for Vodou
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '../types.js';
export declare class WebChannel implements Channel {
    type: "web";
    private app;
    private server;
    private wss;
    private port;
    private clients;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    constructor();
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    private getHtmlInterface;
}
//# sourceMappingURL=web.d.ts.map