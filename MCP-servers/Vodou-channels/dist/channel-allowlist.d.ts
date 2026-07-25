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
/**
 * A room the channel listens in (Slack/Discord channel id, group id, …).
 * PLAN-MASTER-EXECUTION-ORDER item 2 (S-PRINCIPAL).
 *
 * `vault` scopes what a GUEST in this room may know:
 *   - a vault name → guest recall is limited to that vault's members
 *   - "*"          → guest may ask against the whole brain
 *   - absent       → the install's default guest vault
 * It never affects the owner, who always gets the whole brain.
 */
export interface AllowlistRoom {
    id: string;
    name?: string;
    vault?: string;
}
/**
 * Who is driving this turn.
 *  - 'owner'  — matched the sender list. Full capability, unchanged from before tiers existed.
 *  - 'guest'  — matched only a room. May ask; may NOT cause tool calls, shell, or writes.
 *  - 'denied' — matched nothing.
 *
 * Two tiers only, deliberately. Guest is a permanent class, not an owner who
 * hasn't authenticated — promotion happens by landing on the sender list.
 */
export type Principal = 'owner' | 'guest' | 'denied';
export interface AllowlistConfig {
    mode: 'on' | 'off';
    senders: AllowlistEntry[];
    /** Rooms the channel listens in. Posting here alone makes you a GUEST, not the owner. */
    rooms: AllowlistRoom[];
}
export type HandleNormalizer = (raw: string) => string;
/**
 * PLAN-SECURITY-AUDIT-FINDINGS #1a (2026-07-24) — fail-closed enforcement flag.
 * DARK BY DEFAULT: with the flag unset an unconfigured channel (mode:'off')
 * allows all senders (legacy behavior — live channels keep working). With
 * VODOU_CHANNEL_ALLOWLIST_ENFORCE=1, an unconfigured channel DENIES all senders
 * unless they are explicitly listed under mode:'on' — the ship-hardened posture.
 * Operators flip it on AFTER seeding their own sender IDs, so no live outage.
 */
export declare function allowlistEnforceClosed(): boolean;
/** Resolve the on-disk path for a channel's allowlist file. */
export declare function allowlistPathForChannel(projectRoot: string, channel: string): string;
/**
 * Predicate: does this legacy allowlist id denote a ROOM rather than a person?
 * Only used to migrate pre-tier files that kept both kinds in `senders`.
 * Channels whose ids are inherently personal (phone numbers, user ids) can omit
 * it — the default treats every legacy entry as a sender, preserving behavior.
 */
export type RoomIdPredicate = (rawId: string) => boolean;
/**
 * Read the allowlist file; default to `mode: off` (allow everyone) on any error.
 *
 * Accepts both shapes:
 *   - current: { mode, senders: [...], rooms: [...] }
 *   - legacy:  { mode, senders: [...] }  ← room ids lived here too; split via isRoomId
 */
export declare function readAllowlist(path: string, isRoomId?: RoomIdPredicate, channelLabel?: string): AllowlistConfig;
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
    private isRoomId;
    constructor(projectRoot: string, channel: string, normalize: HandleNormalizer, isRoomId?: RoomIdPredicate);
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
    /** True when the sender passes the allowlist (or mode is off).
     * #1a: when mode is 'off' (unconfigured), fail CLOSED (deny) under the
     * enforce flag, else fail OPEN (allow — legacy). */
    isAllowed(rawSender: string): boolean;
    /**
     * Classify a turn into a principal — the core of the owner/guest model
     * (PLAN-MASTER-EXECUTION-ORDER item 2).
     *
     * Callers pass the two kinds of identifier separately, because the SAME id
     * space used to be conflated: `isAnyAllowed([msgChannel, msgUser])` passed if
     * EITHER matched and then handed everything a fully tool-capable agent — so
     * anyone who could post in a listed room drove the agent as the owner.
     *
     * Precedence: sender match wins. Chad posting in a shared room is the owner,
     * not a guest, so his own capability in `#ask-vodou` is unchanged.
     *
     * When mode is not 'on' the channel is unconfigured: honour the existing
     * enforce flag (deny) or legacy allow-all (owner) — no tiering either way,
     * because there is no list to tier against.
     */
    classify(senderIds: (string | null | undefined)[], roomIds?: (string | null | undefined)[]): Principal;
    /**
     * The guest-visible memory slice for a room: a vault name, "*" for the whole
     * brain, or undefined to fall back to the install default. Never consulted for
     * the owner, who always gets everything.
     */
    vaultForRoom(roomIds: (string | null | undefined)[]): string | undefined;
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
/**
 * Slack room ids are unambiguous by prefix: `C` public/private channel,
 * `G` legacy private group, `D` direct-message channel. `U` (user) and `W`
 * (Enterprise Grid user) are people.
 *
 * A `D…` DM channel counts as a room, not as the owner: the DM *channel* being
 * listed shouldn't confer capability. Chad still gets owner in his own DM
 * because his `U…` id is on the sender list and sender match wins.
 */
export declare function isSlackRoomId(raw: string): boolean;
/**
 * Discord snowflakes are shape-identical for users and channels, so legacy
 * entries cannot be classified by inspection. Treat them as ROOMS — the
 * fail-safe direction (less capability, loudly logged at migration) — and let
 * the operator promote a user id into `senders` explicitly.
 */
export declare function isDiscordRoomId(_raw: string): boolean;
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