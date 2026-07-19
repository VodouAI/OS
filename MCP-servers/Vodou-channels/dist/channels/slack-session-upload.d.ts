/**
 * Slack file upload via SESSION tokens (xoxc + xoxd), not a bot token.
 *
 * Why this exists: the bot-token path (Bolt `filesUploadV2`, see slack.ts
 * `uploadFile`) is dead — SLACK_BOT_TOKEN was revoked (auth.test → invalid_auth).
 * The live, self-healing credential is the xoxc/xoxd session pair that the
 * `@jtalk22/slack-mcp` server extracts from Chrome and keeps fresh in
 * `~/.slack-mcp-tokens.json`. We read THAT cache (falling back to env) so uploads
 * ride the same auto-refreshed token as the rest of the Slack integration and
 * don't rot the way hard-coded .env tokens did.
 *
 * Flow is Slack's 3-step external upload:
 *   1. files.getUploadURLExternal  → { upload_url, file_id }
 *   2. POST bytes to upload_url
 *   3. files.completeUploadExternal → posts into channel_id, returns permalink
 */
interface SessionTokens {
    token: string;
    cookie: string;
    source: string;
}
/** Called by the Slack inbound handler (slack.ts) on every message so the upload
 *  tool can auto-target the active conversation. Best-effort — never throws. */
export declare function recordLastSlackChannel(channelId: string): void;
/** Read the last inbound Slack channel id, or null if none recorded. */
export declare function readLastSlackChannel(): string | null;
/** Prefer the auto-refreshed slack-mcp cache; fall back to env SLACK_TOKEN/SLACK_COOKIE. */
export declare function loadSessionTokens(): SessionTokens | null;
export interface SessionUploadResult {
    ok: boolean;
    fileId?: string;
    permalink?: string;
    error?: string;
    fileSizeBytes?: number;
    posted?: boolean;
    tokenSource?: string;
}
export declare function uploadFileViaSession(opts: {
    channelId: string;
    filePath?: string;
    fileData?: Buffer;
    filename?: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
}): Promise<SessionUploadResult>;
export {};
//# sourceMappingURL=slack-session-upload.d.ts.map