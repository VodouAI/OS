/**
 * Shared per-channel allowlist — the "Apple-style" allow-any / restrict-to-list
 * toggle used by iMessage, WhatsApp, Slack, and any future messaging channel.
 *
 * File layout:  `.vodou/channels/<channel>-allowlist.json`
 *   { "mode": "off" | "on", "senders": [{ "id": "...", "name": "..." }, ...] }
 *
 *   - mode: "off"  → allow everyone (default, matches what users expect after install)
 *   - mode: "on"   → only senders whose normalized id matches one in the list pass
 *
 * The gateway UI manages this file; channels read + fs.watch it for live updates
 * (no restart needed when the user toggles mode or adds/removes senders).
 *
 * Each channel supplies its own `normalize` fn (phones want digits-only, emails
 * want lowercase-trim, Slack wants raw channel/user IDs, etc.) — the allowlist
 * helper is payload-agnostic.
 */
export interface AllowlistEntry {
    id: string;
    name?: string;
}
export interface AllowlistConfig {
    mode: 'on' | 'off';
    senders: AllowlistEntry[];
}
export type HandleNormalizer = (raw: string) => string;
/** Resolve the on-disk path for a channel's allowlist file. */
export declare function allowlistPathForChannel(projectRoot: string, channel: string): string;
/** Read the allowlist file; default to `mode: off` (allow everyone) on any error. */
export declare function readAllowlist(path: string): AllowlistConfig;
/**
 * AllowlistWatcher — loads the allowlist once, starts an fs.watch on the
 * parent directory so any edit (gateway UI writes, user hand-edits, channel
 * rename) triggers a re-read. Safe to construct before the file exists.
 */
export declare class AllowlistWatcher {
    private config;
    private watcher;
    private path;
    private filename;
    private normalize;
    private channelLabel;
    constructor(projectRoot: string, channel: string, normalize: HandleNormalizer);
    /** Force a re-read from disk. Called internally by the watcher.
     *
     * Security: an allowlist is a *deny* control, so it must not fail open. The
     * gateway turns the allowlist off by WRITING `mode:'off'` — it never deletes
     * the file — so a missing or corrupt file at reload time is data loss (a
     * crashed/truncated write, an accidental rm), NOT an intentional "off". If we
     * are currently enforcing `mode:'on'`, retain the last-good config rather than
     * silently reverting to allow-everyone. */
    reload(): void;
    /** Current config snapshot (read-only). */
    get(): Readonly<AllowlistConfig>;
    /** True when the sender passes the allowlist (or mode is off). */
    isAllowed(rawSender: string): boolean;
    /** Pass an array of candidate identifiers — passes if ANY of them match. */
    isAnyAllowed(rawSenders: (string | null | undefined)[]): boolean;
    dispose(): void;
    private startWatching;
}
/** iMessage: phones → digits only (strip +, spaces, parens, dashes).
 *  Emails → lowercased + trimmed. */
export declare function normalizeImessageHandle(raw: string): string;
/** WhatsApp: JIDs look like `15551234567@s.whatsapp.net` or `<groupid>@g.us`.
 *  For matching, use the digits before `@` for user JIDs. Users may enter
 *  phones as `+15551234567` or `(555) 123-4567` — normalize to digits-only.
 *  For group JIDs (contain only digits + `-` before `@g.us`) leave intact. */
export declare function normalizeWhatsappHandle(raw: string): string;
/** Slack: IDs are opaque (`U01XXXX`, `C01XXXX`, `D01XXXX`). Lowercase for
 *  consistency but otherwise leave as-is. */
export declare function normalizeSlackHandle(raw: string): string;
/** Discord: snowflake IDs (18-19 digit numeric strings) for users/channels/guilds.
 *  Users may enter `@username` or `username#1234` — we accept either but match
 *  primarily on the numeric ID (what the API returns). Strip leading `@` and
 *  lowercase for case-insensitive name matching. */
export declare function normalizeDiscordHandle(raw: string): string;
/** Telegram: numeric user/chat IDs (positive for users, negative for groups).
 *  Users may enter `@username` (Telegram handle) — keep lowercase without `@`.
 *  Numeric IDs are kept as-is (the bot API returns them as numbers). */
export declare function normalizeTelegramHandle(raw: string): string;
/** Teams: Azure AD user id, conversation id, or tenant id — opaque strings, trim + lowercase. */
export declare function normalizeTeamsHandle(raw: string): string;
/** Google Chat: `users/…` resource names and opaque IDs — trim + lowercase. */
export declare function normalizeGoogleChatHandle(raw: string): string;
/** Signal: phone-like strings → digits-only; opaque group ids / UUIDs → trim + lowercase. */
export declare function normalizeSignalHandle(raw: string): string;
//# sourceMappingURL=channel-allowlist.d.ts.map