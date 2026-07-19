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
import { readFile } from 'fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import { homedir } from 'os';
/** Where the standalone Slack bridge records the last channel it saw inbound, so
 *  "upload X here" (no channel arg) can resolve to the current conversation. */
function lastChannelStatePath() {
    const root = process.env.VODOU_PROJECT_PATH || process.cwd();
    return resolve(root, '.vodou', 'workspace', 'slack-last-channel.json');
}
/** Called by the Slack inbound handler (slack.ts) on every message so the upload
 *  tool can auto-target the active conversation. Best-effort — never throws. */
export function recordLastSlackChannel(channelId) {
    if (!channelId)
        return;
    try {
        const file = lastChannelStatePath();
        mkdirSync(resolve(file, '..'), { recursive: true });
        // No Date.now() dependency hazard here — this runs in the live bridge, not a workflow.
        writeFileSync(file, JSON.stringify({ channelId, at: new Date().toISOString() }), 'utf8');
    }
    catch {
        // best-effort: auto-resolve simply won't have a hint if this fails
    }
}
/** Read the last inbound Slack channel id, or null if none recorded. */
export function readLastSlackChannel() {
    try {
        const raw = JSON.parse(readFileSync(lastChannelStatePath(), 'utf8'));
        const id = raw?.channelId;
        return typeof id === 'string' && id ? id : null;
    }
    catch {
        return null;
    }
}
/** Prefer the auto-refreshed slack-mcp cache; fall back to env SLACK_TOKEN/SLACK_COOKIE. */
export function loadSessionTokens() {
    const cachePath = join(homedir(), '.slack-mcp-tokens.json');
    try {
        const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
        const token = raw?.SLACK_TOKEN;
        const cookie = raw?.SLACK_COOKIE;
        if (typeof token === 'string' && token.startsWith('xoxc') && typeof cookie === 'string' && cookie.startsWith('xoxd')) {
            return { token, cookie, source: '~/.slack-mcp-tokens.json' };
        }
    }
    catch {
        // cache missing/unreadable — fall through to env
    }
    const envToken = process.env.SLACK_TOKEN;
    const envCookie = process.env.SLACK_COOKIE;
    if (envToken?.startsWith('xoxc') && envCookie?.startsWith('xoxd')) {
        return { token: envToken, cookie: envCookie, source: 'env' };
    }
    return null;
}
export async function uploadFileViaSession(opts) {
    const tokens = loadSessionTokens();
    if (!tokens) {
        return {
            ok: false,
            error: 'No Slack session tokens found (checked ~/.slack-mcp-tokens.json and env SLACK_TOKEN/SLACK_COOKIE). Open a Slack tab in Chrome and run the slack MCP `slack_refresh_tokens` tool.',
        };
    }
    let content;
    if (opts.filePath) {
        try {
            content = await readFile(opts.filePath);
        }
        catch (err) {
            return { ok: false, error: `Failed to read file ${opts.filePath}: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    else if (opts.fileData) {
        content = opts.fileData;
    }
    else {
        return { ok: false, error: 'Either filePath or fileData is required' };
    }
    const filename = opts.filename || (opts.filePath ? basename(opts.filePath) : 'file');
    const fileSizeBytes = content.length;
    const cookieHeader = `d=${tokens.cookie}`;
    try {
        // Step 1 — reserve an upload URL
        const form1 = new URLSearchParams();
        form1.set('token', tokens.token);
        form1.set('filename', filename);
        form1.set('length', String(fileSizeBytes));
        const r1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader },
            body: form1.toString(),
        });
        const j1 = (await r1.json());
        if (!j1.ok || !j1.upload_url || !j1.file_id) {
            return { ok: false, error: `getUploadURLExternal failed: ${j1.error || 'no upload_url/file_id'}`, fileSizeBytes, tokenSource: tokens.source };
        }
        // Step 2 — push the bytes
        const up = await fetch(j1.upload_url, { method: 'POST', body: content });
        if (!up.ok) {
            return { ok: false, error: `Byte upload failed: HTTP ${up.status}`, fileSizeBytes, tokenSource: tokens.source };
        }
        // Step 3 — complete + share into the channel
        const form3 = new URLSearchParams();
        form3.set('token', tokens.token);
        form3.set('files', JSON.stringify([{ id: j1.file_id, title: opts.title || filename }]));
        form3.set('channel_id', opts.channelId);
        if (opts.initialComment)
            form3.set('initial_comment', opts.initialComment);
        if (opts.threadTs)
            form3.set('thread_ts', opts.threadTs);
        const r3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader },
            body: form3.toString(),
        });
        const j3 = (await r3.json());
        if (!j3.ok) {
            return { ok: false, error: `completeUploadExternal failed: ${j3.error || 'unknown'}`, fileSizeBytes, tokenSource: tokens.source };
        }
        const f = j3.files?.[0];
        const fileId = f?.id || j1.file_id;
        const hasShares = (s) => {
            const sh = (s || {});
            return Object.keys(sh.public || {}).length > 0 || Object.keys(sh.private || {}).length > 0;
        };
        // `completeUploadExternal` returns BEFORE Slack populates `shares`, so its
        // inline `shares` is almost always empty even on a successful post — trusting
        // it makes `posted` a lie. Poll files.info a few times to get the truth.
        let posted = hasShares(f?.shares);
        let permalink = f?.permalink;
        for (let attempt = 0; !posted && attempt < 5; attempt++) {
            await new Promise((r) => setTimeout(r, 400));
            try {
                const info = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${tokens.token}`, Cookie: cookieHeader },
                });
                const ij = (await info.json());
                if (ij.ok && ij.file) {
                    if (ij.file.permalink)
                        permalink = ij.file.permalink;
                    if (hasShares(ij.file.shares)) {
                        posted = true;
                        break;
                    }
                }
            }
            catch {
                // transient — keep polling until the attempt budget runs out
            }
        }
        return {
            ok: true,
            fileId,
            permalink,
            fileSizeBytes,
            posted,
            tokenSource: tokens.source,
        };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), fileSizeBytes, tokenSource: tokens.source };
    }
}
//# sourceMappingURL=slack-session-upload.js.map