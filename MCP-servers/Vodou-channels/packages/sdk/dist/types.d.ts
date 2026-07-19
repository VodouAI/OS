export type ChannelType = 'telegram' | 'slack' | 'discord' | 'voice' | 'web' | 'whatsapp' | 'imessage' | 'teams' | 'googlechat' | 'signal';
export interface IncomingMessage {
    id: string;
    channel: ChannelType;
    sender: string;
    senderName?: string;
    content: string;
    timestamp: Date;
    replyTo?: string;
    attachments?: Attachment[];
    raw?: any;
}
export interface OutgoingMessage {
    channel: ChannelType;
    recipient: string;
    content: string;
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
    channel: ChannelType;
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
    type: ChannelType;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
}
export interface ChannelManifest {
    name: string;
    displayName: string;
    version: string;
    description: string;
    author: string;
    /** true = official @vodou package; false = community (will be sandboxed in v0.8.1) */
    signed: boolean;
    requiredEnv: string[];
    optionalEnv?: string[];
}
/** Every @vodou/channel-* package's default export must implement this. */
export interface VodouChannel extends Channel {
    manifest(): ChannelManifest;
}
//# sourceMappingURL=types.d.ts.map