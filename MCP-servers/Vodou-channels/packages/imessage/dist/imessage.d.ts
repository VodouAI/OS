/**
 * iMessage Channel — native macOS, no BlueBubbles / external server needed.
 *
 * Architecture:
 *   READ (incoming):  SQLite read-only on ~/Library/Messages/chat.db.
 *                     On connect, record MAX(ROWID) as the cursor; then poll
 *                     every IMESSAGE_POLL_INTERVAL_MS (default 2s) and also
 *                     watch chat.db-wal via fs.watch for near-instant drains.
 *                     New rows → forward via the registered MessageHandler.
 *
 *   WRITE (outgoing): spawn `osascript` to tell Messages.app to send text
 *                     to a buddy. macOS prompts the user on first send to
 *                     grant Automation permission; thereafter TCC caches it.
 *
 * Required macOS permissions (one-time, per-user, revocable):
 *   1. Full Disk Access    → to read chat.db
 *   2. Automation → Messages → for osascript send
 *
 * Privacy-first allowlist (optional):
 *   If `.vodou/channels/imessage-allowlist.json` exists AND has `mode: "on"`,
 *   only senders in its list are forwarded. The gateway UI writes this file;
 *   the channel reads + watches it. Default: file absent → forward all.
 *
 * Platform: macOS only. Silently no-ops on other platforms (connect() throws).
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare class IMessageChannel implements Channel {
    type: "imessage";
    private db;
    private lastRowId;
    private handler?;
    private connected;
    private lastActivity?;
    private error?;
    private warning?;
    private pollTimer;
    private walWatcher;
    private allowlist;
    private recentOutbound;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(msg: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    private _drain;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=imessage.d.ts.map