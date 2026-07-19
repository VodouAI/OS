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
import { spawn, spawnSync } from 'child_process';
import { watch, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { open as openDb } from '../db.js';
import { AllowlistWatcher, normalizeImessageHandle } from '../channel-allowlist.js';
// ── Constants ──────────────────────────────────────────────────────────────
const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const ATTACHMENTS_ROOT = join(homedir(), 'Library', 'Messages', 'Attachments');
const POLL_INTERVAL_MS = parseInt(process.env.IMESSAGE_POLL_INTERVAL_MS || '2000', 10);
const ALLOW_GROUPS = process.env.IMESSAGE_ALLOW_GROUPS === '1';
const INCLUDE_SMS = process.env.IMESSAGE_INCLUDE_SMS !== '0'; // default on: Continuity SMS through
const VODOU_PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
// Apple's epoch is 2001-01-01 UTC; chat.db.message.date is Mach nanoseconds since then.
const APPLE_EPOCH_MS = new Date('2001-01-01T00:00:00Z').getTime();
function appleEpochToDate(ns) {
    // chat.db stores nanoseconds since 2001-01-01 (some older rows may be seconds)
    // Heuristic: values over ~1e12 are ns; lower are seconds
    const ms = ns > 1e12 ? ns / 1e6 : ns * 1000;
    return new Date(APPLE_EPOCH_MS + ms);
}
// ── Channel ────────────────────────────────────────────────────────────────
export class IMessageChannel {
    type = 'imessage';
    db = null;
    lastRowId = 0;
    handler;
    connected = false;
    lastActivity;
    error;
    warning;
    pollTimer = null;
    walWatcher = null;
    allowlist = null;
    // Echo tracker — messages we just sent via AppleScript. chat.db logs them
    // as is_from_me=1; without this guard, reading is_from_me=1 messages causes
    // Vodou to respond to its own outbound, infinitely. 60s window is generous
    // (Messages.app usually writes chat.db within 1-2s of send).
    recentOutbound = [];
    async connect() {
        // GATE 1: macOS only
        if (process.platform !== 'darwin') {
            this.error = 'iMessage channel requires macOS';
            throw new Error(this.error);
        }
        // GATE 2: chat.db exists (Messages.app set up?)
        if (!existsSync(CHAT_DB)) {
            this.error = 'Messages.app not configured — sign in at Messages → Settings → iMessage';
            throw new Error(this.error);
        }
        // GATE 3: Full Disk Access — can we actually open + query the DB?
        try {
            this.db = openDb(CHAT_DB, { readOnly: true });
            this.db.prepare('SELECT 1 FROM message LIMIT 1').get();
        }
        catch (e) {
            this.error =
                'No Full Disk Access for this binary. Grant it in ' +
                    'System Settings → Privacy & Security → Full Disk Access, add the vodou-core binary, ' +
                    'toggle it ON, then reconnect the channel.';
            this.db = null;
            throw new Error(this.error);
        }
        // GATE 4: Automation permission for Messages. First run may throw the
        // system prompt; we probe with a harmless `name` query. If it fails, surface
        // a clear message but DO allow connect() to proceed — reading still works
        // and the first outbound message will re-prompt.
        const probe = spawnSync('osascript', ['-e', 'tell application "Messages" to name'], {
            timeout: 4000,
            encoding: 'utf8',
        });
        if (probe.status !== 0) {
            this.warning =
                'Automation permission not yet granted — inbound messages work, but outbound ' +
                    'send will trigger a macOS prompt on first use. Grant it at: ' +
                    'System Settings → Privacy & Security → Automation → vodou-core → Messages.';
            console.error('[iMessage]', this.warning);
        }
        else {
            this.warning = undefined;
        }
        // Shared per-channel allowlist — default off (allow everyone) until the
        // gateway UI writes `.vodou/channels/imessage-allowlist.json`.
        this.allowlist = new AllowlistWatcher(VODOU_PROJECT_ROOT, 'imessage', normalizeImessageHandle);
        // Record the cursor — do NOT backfill; we only forward new messages.
        const row = this.db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS m FROM message').get();
        this.lastRowId = row.m;
        // fs.watch on the -wal file fires on every Messages DB write. Cheap and
        // near-instant (<100ms). Fall through to interval poll in case of watch
        // glitches (common on macOS for files inside /Library).
        try {
            this.walWatcher = watch(`${CHAT_DB}-wal`, { persistent: false }, () => this._drain());
        }
        catch {
            // If -wal doesn't exist yet (rare), fallback to poll-only
        }
        this.pollTimer = setInterval(() => this._drain(), POLL_INTERVAL_MS);
        this.connected = true;
        this.lastActivity = new Date();
        const al = this.allowlist.get();
        console.error(`[iMessage] Connected. Watching chat.db (cursor=${this.lastRowId}, ` +
            `poll=${POLL_INTERVAL_MS}ms, allowlist=${al.mode}:${al.senders.length}).`);
    }
    async disconnect() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.walWatcher) {
            try {
                this.walWatcher.close();
            }
            catch { }
            this.walWatcher = null;
        }
        if (this.allowlist) {
            this.allowlist.dispose();
            this.allowlist = null;
        }
        if (this.db) {
            try {
                this.db.close();
            }
            catch { }
            this.db = null;
        }
        this.connected = false;
    }
    async send(msg) {
        if (process.platform !== 'darwin') {
            console.error('[iMessage] send: not macOS');
            return false;
        }
        const recipient = (msg.recipient || '').trim();
        if (!recipient) {
            console.error('[iMessage] send: empty recipient');
            return false;
        }
        // Strip chat_guid prefix so AppleScript gets the bare handle.
        // The gateway passes 'iMessage;-;+15551234567' format; AppleScript's buddy
        // lookup needs '+15551234567'. Also used in recentOutbound to match row.handle.
        const bareHandle = recipient.includes(';-;')
            ? (recipient.split(';-;').pop() || recipient)
            : recipient;
        // Escape AppleScript string (double quotes and backslashes are the only
        // issues inside the `send "..."` form; newlines survive via \r)
        const text = msg.content
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
        const script = `
      tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy "${bareHandle}" of targetService
        send "${text}" to targetBuddy
      end tell
    `;
        // Async spawn so we don't block the Node.js event loop during the send.
        const r = await new Promise((resolve) => {
            const child = spawn('osascript', ['-e', script]);
            let stderrBuf = '';
            child.stderr?.on('data', (d) => { stderrBuf += d.toString(); });
            const timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch { }
                resolve({ status: -1, stderr: 'timeout' });
            }, 10000);
            child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stderr: stderrBuf.trim() }); });
            child.on('error', (err) => { clearTimeout(timer); resolve({ status: -1, stderr: err.message }); });
        });
        if (r.status !== 0) {
            const stderr = r.stderr;
            if (/Not authorized to send Apple events|-1743/i.test(stderr)) {
                this.error =
                    'Not authorized to control Messages. Grant in ' +
                        'System Settings → Privacy & Security → Automation → vodou-core → Messages.';
            }
            else if (/doesn't understand|not found|no such|missing value/i.test(stderr)) {
                this.error = `Recipient "${bareHandle}" not on iMessage — try an email or E.164 phone.`;
            }
            else {
                this.error = `osascript failed: ${stderr || 'unknown error'}`;
            }
            console.error('[iMessage] send failed:', this.error);
            return false;
        }
        this.lastActivity = new Date();
        // Track outbound using bare handle — matches row.handle in chat.db so the
        // echo guard correctly suppresses is_from_me=1 rows we just sent.
        const now = Date.now();
        this.recentOutbound.push({ recipient: bareHandle, text: msg.content, sentAt: now });
        this.recentOutbound = this.recentOutbound.filter(r => now - r.sentAt < 60_000);
        return true;
    }
    getStatus() {
        const al = this.allowlist?.get();
        return {
            channel: 'imessage',
            connected: this.connected,
            error: this.error,
            warning: this.warning,
            lastActivity: this.lastActivity,
            metadata: {
                chatDbPath: CHAT_DB,
                pollIntervalMs: POLL_INTERVAL_MS,
                allowGroups: ALLOW_GROUPS,
                includeSms: INCLUDE_SMS,
                allowlistMode: al?.mode ?? 'off',
                allowlistCount: al?.senders.length ?? 0,
                cursor: this.lastRowId,
            },
        };
    }
    onMessage(handler) {
        this.handler = handler;
    }
    // ── Internal ────────────────────────────────────────────────────────────
    _drain() {
        if (!this.db || !this.handler || !this.connected)
            return;
        let rows;
        try {
            const serviceFilter = INCLUDE_SMS ? `('iMessage', 'SMS')` : `('iMessage')`;
            // NOTE: we now pull BOTH is_from_me=0 AND is_from_me=1 — the echo tracker
            // below filters out our own outbound replies so we don't loop. Pulling
            // is_from_me=1 lets the user type into Messages directly and have Vodou
            // respond on their behalf (e.g. self-test, drafting a reply in-thread).
            rows = this.db.prepare(`
        SELECT
          m.ROWID             AS rowid,
          m.guid              AS guid,
          m.text              AS text,
          m.service           AS service,
          m.is_from_me        AS is_from_me,
          m.date              AS date,
          h.id                AS handle,
          c.display_name      AS chat_name,
          c.room_name         AS room,
          c.guid              AS chat_guid
        FROM message m
          LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          LEFT JOIN chat                c ON c.ROWID = cmj.chat_id
          LEFT JOIN handle              h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ?
          AND m.text IS NOT NULL
          AND m.text != ''
          AND m.service IN ${serviceFilter}
        ORDER BY m.ROWID
      `).all(this.lastRowId);
            if (rows.length > 0) {
                console.error(`[iMessage DIAG] drain found ${rows.length} row(s) > cursor=${this.lastRowId}`);
            }
        }
        catch (e) {
            // chat.db briefly locked during WAL checkpoint — surface the first error
            // so we notice if ALL drains are being dropped. (Frequent legit locks
            // during WAL checkpoint are expected, but we shouldn't swallow them all.)
            console.error('[iMessage DIAG] drain query failed:', e instanceof Error ? e.message : String(e));
            return;
        }
        for (const row of rows) {
            // Advance cursor even for filtered-out rows so we don't loop
            this.lastRowId = row.rowid;
            // Group chat guard
            const isGroup = !!row.room;
            if (isGroup && !ALLOW_GROUPS)
                continue;
            // Echo guard — if this row is is_from_me=1 AND matches a message we
            // recently sent via AppleScript, skip it. Prevents reply loops where
            // Vodou responds to its own outbound. The 60s window was set when
            // recentOutbound was recorded; any match in that window is our echo.
            if (row.is_from_me === 1) {
                const now = Date.now();
                const isEcho = this.recentOutbound.some(r => r.recipient === (row.handle || '') &&
                    r.text === (row.text || '') &&
                    now - r.sentAt < 60_000);
                if (isEcho)
                    continue;
            }
            // Allowlist guard. Match against the raw handle (phone/email) — that's
            // what users type into the allowlist UI. Extract the handle from
            // chat_guid as a fallback (chat_guid format is `iMessage;-;<handle>`
            // — the trailing segment is the contact identifier). Needed because
            // some Messages.app chats have handle_id=NULL but a valid chat_guid.
            const chatGuidHandle = row.chat_guid ? row.chat_guid.split(';').pop() || '' : '';
            if (this.allowlist && !this.allowlist.isAnyAllowed([row.handle, chatGuidHandle]))
                continue;
            // Use the CHAT GUID as the reply target — it pins the reply to the exact
            // thread (e.g. "iMessage;-;user@example.com"), bypassing AppleScript's
            // `buddy "<handle>"` path which can route email↔phone wrongly for
            // linked contacts.
            //
            // Race condition handling: fs.watch on chat.db-wal can fire BEFORE
            // chat_message_join is committed, so our LEFT JOIN returns c.guid=null
            // even though Messages.app knows the chat. For 1:1 DMs the chat guid
            // is deterministic — `<service>;-;<handle>` — so we synthesize it
            // instead of falling back to the raw handle (which is what caused
            // replies to land in the wrong thread for linked email/phone contacts).
            let replyTarget;
            if (row.chat_guid) {
                replyTarget = row.chat_guid;
            }
            else if (row.handle && row.service) {
                // Synthesize. `;-;` separator is Messages.app convention for 1:1 DMs.
                replyTarget = `${row.service};-;${row.handle}`;
            }
            else {
                replyTarget = row.handle || '(unknown)';
            }
            console.error(`[iMessage DIAG] rowid=${row.rowid} handle=${JSON.stringify(row.handle)} ` +
                `service=${row.service} chat_guid=${JSON.stringify(row.chat_guid)} ` +
                `replyTarget=${JSON.stringify(replyTarget)}`);
            const msg = {
                id: row.guid,
                channel: 'imessage',
                sender: replyTarget,
                senderName: row.chat_name || row.handle || 'iMessage',
                content: row.text || '',
                timestamp: appleEpochToDate(row.date),
                raw: row,
            };
            this.lastActivity = msg.timestamp;
            Promise.resolve(this.handler(msg)).catch(err => {
                console.error('[iMessage] handler error:', err);
            });
        }
    }
}
//# sourceMappingURL=imessage.js.map