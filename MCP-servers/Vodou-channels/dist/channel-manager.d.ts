/**
 * Channel Manager
 * Coordinates all channel implementations and provides unified interface
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from './types.js';
export declare class ChannelManager {
    private channels;
    private messageHandler?;
    private useOI;
    private conversationIds;
    constructor(useOI?: boolean);
    /** Discover and register channels from ~/.vodou/channels/node_modules. */
    init(): Promise<void>;
    /**
     * Connect specific channels (by name) or all discovered channels.
     * Returns a per-channel report instead of throwing on the first failure —
     * the manager logs each failure but keeps going so one bad channel (e.g.
     * missing SLACK_BOT_TOKEN) doesn't take down Telegram and Discord too.
     */
    connect(channelNames?: string[]): Promise<Array<{
        name: string;
        ok: boolean;
        error?: string;
    }>>;
    /**
     * Connect all discovered channels.
     */
    connectAll(): Promise<void>;
    /**
     * Disconnect specific channels
     */
    disconnect(channelTypes?: string[]): Promise<void>;
    /**
     * Disconnect all channels
     */
    disconnectAll(): Promise<void>;
    /**
     * Send a message to a channel
     */
    send(message: OutgoingMessage): Promise<boolean>;
    /**
     * Broadcast a message to all connected channels
     */
    broadcast(content: string, recipient?: string): Promise<Map<string, boolean>>;
    /**
     * Get status of all channels
     */
    getStatus(): ChannelStatus[];
    /**
     * Get status of a specific channel
     */
    getChannelStatus(type: string): ChannelStatus | undefined;
    /**
     * Get a specific channel
     */
    getChannel(type: string): Channel | undefined;
    /**
     * Set custom message handler
     */
    setMessageHandler(handler: MessageHandler): void;
    /**
     * Handle incoming message — routes through gateway chat engine for full Vodou brain
     * (BrainLoader, memory, skills, conversation history). Falls back to direct LLM if gateway is down.
     */
    private handleIncomingMessage;
    /**
     * Gateway URL — routes messages through the full Vodou brain (BrainLoader, memory, skills, history).
     */
    private getGatewayUrl;
    /**
     * Route message through the gateway chat engine for full Vodou intelligence.
     * Each channel+sender gets a persistent conversation with history, memory, skills.
     * Falls back to direct LLM call if gateway is unreachable.
     */
    processWithGateway(query: string, convId: string, source?: string, senderName?: string, attachments?: import('./types.js').Attachment[], recipient?: string, opts?: {
        principal?: 'owner' | 'guest';
        guestVault?: string;
    }): Promise<string>;
    /**
     * Fallback: direct LLM call via vodou-core when gateway is unreachable.
     * No conversation history, no memory, no skills — just a one-shot LLM response.
     */
    private processWithLLMFallback;
    private extractChatResponse;
}
export declare function getChannelManager(useOI?: boolean): ChannelManager;
//# sourceMappingURL=channel-manager.d.ts.map