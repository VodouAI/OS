/**
 * Slack Channel Implementation
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare class SlackChannel implements Channel {
    type: "slack";
    private app;
    private botToken;
    private appToken;
    private signingSecret;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    /** Bot's OWN Slack user id (from auth.test). Used to drop self-echoes that arrive without a bot_id. */
    private botUserId;
    private processedMessages;
    private allowlist;
    /** Slack user id → display label (bounded LRU). */
    private userLabelCache;
    private static usersInfoErrorLogged;
    constructor();
    /** Best-effort display string from a Slack `user` / `member` object (users.info / users.list). */
    private pickSlackDisplayLabelFromUser;
    private rememberLabel;
    /** Optional: bulk-load member names once at connect (same `users:read` as users.info). Set SLACK_PREFETCH_USERS=1. */
    private prefetchSlackUserLabels;
    /** Resolve U… to real/display name for gateway UI + LLM attribution (needs users:read on the bot). */
    private resolveSlackUserLabel;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    /**
     * Upload a file to a Slack channel using files.uploadV2
     * Includes dynamic timeout based on file size and retry logic.
     */
    uploadFile(options: {
        channelId: string;
        filePath?: string;
        fileData?: Buffer;
        filename: string;
        title?: string;
        initialComment?: string;
        threadTs?: string;
    }): Promise<{
        ok: boolean;
        fileId?: string;
        permalink?: string;
        error?: string;
        fileSizeBytes?: number;
    }>;
    /**
     * Extract and download file attachments from a Slack message.
     * Saves under VODOU_CHANNEL_ATTACHMENTS_DIR or <VODOU_PROJECT_PATH>/.vodou/channel-attachments.
     */
    private extractAttachments;
    onMessage(handler: MessageHandler): void;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=slack.d.ts.map