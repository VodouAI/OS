/**
 * Vodou-Channels Types
 */
export type ChannelType = 'telegram' | 'slack' | 'discord' | 'voice' | 'web' | 'whatsapp' | 'imessage' | 'teams' | 'googlechat' | 'signal';
export interface IncomingMessage {
    id: string;
    channel: string;
    sender: string;
    senderName?: string;
    content: string;
    timestamp: Date;
    replyTo?: string;
    attachments?: Attachment[];
    raw?: any;
}
export interface OutgoingMessage {
    channel: string;
    recipient: string;
    content: string;
    /** Local filesystem path for WhatsApp bridge /api/send (image, doc, etc.) */
    mediaPath?: string;
    replyTo?: string;
    attachments?: Attachment[];
}
export interface Attachment {
    type: 'image' | 'audio' | 'video' | 'file';
    url?: string;
    data?: Buffer;
    mimeType?: string;
    filename?: string;
}
export interface ChannelStatus {
    channel: string;
    connected: boolean;
    error?: string;
    warning?: string;
    lastActivity?: Date;
    metadata?: Record<string, any>;
}
export interface ChannelConfig {
    enabled: boolean;
    token?: string;
    [key: string]: any;
}
export type MessageHandler = (message: IncomingMessage) => Promise<string | null>;
export interface Channel {
    type: string;
    /**
     * Initialize and connect the channel
     */
    connect(): Promise<void>;
    /**
     * Disconnect the channel
     */
    disconnect(): Promise<void>;
    /**
     * Send a message through the channel
     */
    send(message: OutgoingMessage): Promise<boolean>;
    /**
     * Get channel status
     */
    getStatus(): ChannelStatus;
    /**
     * Set message handler for incoming messages
     */
    onMessage(handler: MessageHandler): void;
}
//# sourceMappingURL=types.d.ts.map