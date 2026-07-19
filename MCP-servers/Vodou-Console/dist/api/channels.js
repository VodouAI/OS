/**
 * Messaging API (`/api/channels/*`) — proxy to Vodou-channels MCP via vodou-core call + standalone start/stop
 */
import { Router } from 'express';
import { spawn, spawnSync, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { runVodouCore } from '../executor.js';
import { getProjectRoot, getSetting, setSetting } from '../db.js';
import { getBotFrameworkAccessToken } from './teams-outbound.js';
const SERVER = 'Vodou-channels';
const STANDALONE_STATE_PATH = () => path.join(getProjectRoot(), '.vodou', 'workspace', 'channels-standalone.json');
const CHANNELS_DIR = () => path.join(getProjectRoot(), 'MCP-servers', 'Vodou-channels');
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readChannelPids() {
    try {
        const raw = fs.readFileSync(STANDALONE_STATE_PATH(), 'utf-8');
        const j = JSON.parse(raw);
        // Migrate old format: { pid, channels } → per-channel format
        if (j && typeof j.pid === 'number' && Array.isArray(j.channels)) {
            const migrated = {};
            for (const ch of j.channels)
                migrated[ch] = { pid: j.pid, startedAt: j.startedAt || '' };
            writeChannelPids(migrated);
            return migrated;
        }
        return (j && typeof j === 'object') ? j : {};
    }
    catch {
        return {};
    }
}
function writeChannelPids(state) {
    const dir = path.dirname(STANDALONE_STATE_PATH());
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch { }
    fs.writeFileSync(STANDALONE_STATE_PATH(), JSON.stringify(state), 'utf-8');
}
function getAliveChannels() {
    const state = readChannelPids();
    const alive = [];
    let changed = false;
    for (const [ch, info] of Object.entries(state)) {
        if (isProcessAlive(info.pid)) {
            alive.push({ channel: ch, pid: info.pid, startedAt: info.startedAt });
        }
        else {
            delete state[ch];
            changed = true;
        }
    }
    if (changed)
        writeChannelPids(state);
    return alive;
}
function channelLogPath(channel) {
    const dir = path.join(getProjectRoot(), '.vodou', 'workspace');
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch { }
    return path.join(dir, `channels-${channel}.log`);
}
function tailChannelLog(channel, maxLines) {
    try {
        const content = fs.readFileSync(channelLogPath(channel), 'utf-8');
        const lines = content.split('\n');
        return lines.slice(-maxLines).join('\n');
    }
    catch {
        return '';
    }
}
/** Read first `maxBytes` of a file (UTF-8). Startup / pairing lines stay near the top. */
function readChannelLogHeadUtf8(channel, maxBytes) {
    const p = channelLogPath(channel);
    try {
        const st = fs.statSync(p);
        const n = Math.min(st.size, maxBytes);
        const fd = fs.openSync(p, 'r');
        try {
            const buf = Buffer.alloc(n);
            let got = 0;
            while (got < n) {
                const r = fs.readSync(fd, buf, got, n - got, got);
                if (r <= 0)
                    break; // short read — slice below so the zero-filled tail isn't stringified as NULs
                got += r;
            }
            return buf.toString('utf-8', 0, got);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return '';
    }
}
/** Read last `maxBytes` of a file (UTF-8) — reconnect may log pairing again at the end. */
function readChannelLogTailBytesUtf8(channel, maxBytes) {
    const p = channelLogPath(channel);
    try {
        const st = fs.statSync(p);
        const n = Math.min(st.size, maxBytes);
        const start = Math.max(0, st.size - n);
        const fd = fs.openSync(p, 'r');
        try {
            const buf = Buffer.alloc(n);
            let got = 0;
            while (got < n) {
                const r = fs.readSync(fd, buf, got, n - got, start + got);
                if (r <= 0)
                    break; // short read — slice below so the zero-filled tail isn't stringified as NULs
                got += r;
            }
            return buf.toString('utf-8', 0, got);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return '';
    }
}
function stripEnvQuotes(v) {
    let s = v.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
    }
    return s.trim();
}
/**
 * REST /api/health port for the WhatsApp bridge — must match Vodou-channels
 * (WHATSAPP_BRIDGE_PORT in MCP-servers/Vodou-channels/.env) and gateway send path
 * (index.ts getChannelEnv). The gateway Node process often does not inherit
 * Vodou-channels/.env, so reading the file here fixes "connected in app but no
 * green bar" when health was probed on the wrong port.
 */
function resolveWhatsAppBridgePort() {
    const fromProc = process.env.WHATSAPP_BRIDGE_PORT?.trim();
    if (fromProc)
        return stripEnvQuotes(fromProc);
    const scanFile = (filePath) => {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            for (const line of raw.split('\n')) {
                const t = line.trim();
                if (!t || t.startsWith('#'))
                    continue;
                const eq = t.indexOf('=');
                if (eq <= 0)
                    continue;
                if (t.slice(0, eq).trim() === 'WHATSAPP_BRIDGE_PORT') {
                    const v = stripEnvQuotes(t.slice(eq + 1));
                    if (v)
                        return v;
                }
            }
        }
        catch { }
        return null;
    };
    const fromChannels = scanFile(path.join(getProjectRoot(), 'MCP-servers', 'Vodou-channels', '.env'));
    if (fromChannels)
        return fromChannels;
    const fromRoot = scanFile(path.join(getProjectRoot(), '.env'));
    if (fromRoot)
        return fromRoot;
    return '8081';
}
function coerceEnvBool(v) {
    if (v === true || v === 1)
        return true;
    if (typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim()))
        return true;
    return false;
}
function parseWaBridgeHealthBody(body) {
    try {
        const j = JSON.parse(body);
        return {
            connected: coerceEnvBool(j.connected),
            logged_in: coerceEnvBool(j.logged_in ?? j.loggedIn),
        };
    }
    catch {
        return null;
    }
}
/** Standalone Vodou-channels writes here; line appears when bridge is paired (health poller). */
function whatsappStandaloneLogLooksAuthenticated() {
    // Don't trust the log alone — a previous run's "authenticated" line stays
    // forever, so after a /disconnect or kill the gateway would still report
    // connected. Require a live standalone PID first; the log just confirms.
    const state = readChannelPids();
    const wa = state.whatsapp;
    if (!wa || !isProcessAlive(wa.pid))
        return false;
    const re = /\bBridge connected and authenticated\b/i;
    // Pairing is logged once near process start; long runs append megabytes of [bridge] lines,
    // so a short tail-only scan misses it. Check file head first, then recent tail (reconnect).
    if (re.test(readChannelLogHeadUtf8('whatsapp', 384 * 1024)))
        return true;
    return re.test(readChannelLogTailBytesUtf8('whatsapp', 512 * 1024));
}
/** Last bridge REST port from the same log (spawn line + Go banner). */
function bridgePortsFromWhatsappLog() {
    const head = readChannelLogHeadUtf8('whatsapp', 256 * 1024);
    const tail = readChannelLogTailBytesUtf8('whatsapp', 256 * 1024);
    // Head = process start; tail = recent (reconnect). Concat head then tail so lastIndexOf prefers newer.
    const text = `${head}\n${tail}`;
    const found = [];
    let idx = text.lastIndexOf('(port=');
    if (idx >= 0) {
        const sub = text.slice(idx, idx + 40);
        const m = sub.match(/\(port=(\d+)/);
        if (m)
            found.push(m[1]);
    }
    idx = text.lastIndexOf('Starting REST API server on :');
    if (idx >= 0) {
        const sub = text.slice(idx, idx + 80);
        const m = sub.match(/Starting REST API server on :(\d+)/);
        if (m)
            found.push(m[1]);
    }
    const seen = new Set();
    return found.filter((p) => {
        if (!p || seen.has(p))
            return false;
        seen.add(p);
        return true;
    });
}
function httpGetWaHealth(url) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: 2500 }, (r) => {
            let body = '';
            r.on('data', (c) => {
                body += c.toString();
            });
            r.on('end', () => {
                if (r.statusCode !== 200) {
                    resolve(null);
                    return;
                }
                resolve(parseWaBridgeHealthBody(body));
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}
/** Probe one TCP port on IPv4 loopback and IPv6 loopback (Go binds :port on all interfaces). */
async function fetchWhatsAppBridgeHealthOnPort(port) {
    const urls = [`http://127.0.0.1:${port}/api/health`, `http://[::1]:${port}/api/health`];
    for (const url of urls) {
        const h = await httpGetWaHealth(url);
        if (h && (h.logged_in || h.connected))
            return h;
    }
    for (const url of urls) {
        const h = await httpGetWaHealth(url);
        if (h)
            return h;
    }
    return null;
}
/** MCP channel_status may include `metadata.bridgePort` from the pooled server env — use as first probe. */
function whatsappBridgePortHintsFromStatuses(statuses) {
    const hints = [];
    for (const s of statuses || []) {
        if (!s || typeof s !== 'object')
            continue;
        const o = s;
        if (String(o.channel || '').toLowerCase() !== 'whatsapp')
            continue;
        const p = o.metadata?.bridgePort;
        if (p != null && Number.isFinite(Number(p)))
            hints.push(String(Number(p)));
    }
    return hints;
}
/** Try resolved + hinted + common ports so UI matches even when child env drifted. */
async function fetchWhatsAppBridgeHealthBest(statuses) {
    const candidates = [
        ...bridgePortsFromWhatsappLog(),
        ...whatsappBridgePortHintsFromStatuses(statuses),
        resolveWhatsAppBridgePort(),
        '8081',
        '8082',
        '8083',
        '8084',
        '8085',
        '8086',
        '8087',
        '8088',
        '8089',
        '8090',
    ];
    const seen = new Set();
    const ordered = candidates.filter((p) => {
        const key = String(p).trim();
        if (!key || seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    for (const port of ordered) {
        const h = await fetchWhatsAppBridgeHealthOnPort(port);
        if (h && (h.logged_in || h.connected))
            return h;
    }
    return null;
}
async function mergeWhatsAppStandaloneHealth(statuses) {
    const alive = getAliveChannels();
    const chKey = (s) => String(s && typeof s === 'object' && s.channel || '').toLowerCase();
    const hasWhatsappRow = (statuses || []).some((s) => chKey(s) === 'whatsapp');
    // Poll the bridge whenever WhatsApp exists in MCP status OR we have a standalone
    // child PID — otherwise MCP can report disconnected while the bridge is paired.
    if (!alive.some((a) => a.channel === 'whatsapp') && !hasWhatsappRow)
        return;
    // Prefer the standalone process log: same machine as the gateway, survives HTTP
    // probe misses (wrong guessed port, IPv6-only quirks, etc.).
    const logReady = whatsappStandaloneLogLooksAuthenticated();
    const health = logReady ? { connected: true, logged_in: true } : await fetchWhatsAppBridgeHealthBest(statuses);
    // `logged_in` = paired device session; `connected` = socket up (often both after QR).
    const waReady = logReady || !!(health && (health.logged_in || health.connected));
    if (!waReady)
        return;
    const waIdx = statuses.findIndex((s) => chKey(s) === 'whatsapp');
    const patch = { channel: 'whatsapp', connected: true, error: null };
    if (waIdx >= 0) {
        statuses[waIdx] = { ...statuses[waIdx], ...patch };
    }
    else {
        statuses.push(patch);
    }
}
function spawnChannel(channel) {
    const channelsDir = CHANNELS_DIR();
    const node = process.execPath;
    // Write stdout/stderr to a log file so QR codes, errors, etc. are visible
    const logFile = channelLogPath(channel);
    const logFd = fs.openSync(logFile, 'w');
    // Inject channel credentials from DB into the child process env
    const credEnv = readAllChannelCreds();
    // Standalone WhatsApp reads BRIDGE_PORT from process.env; the gateway often does
    // not inherit MCP-servers/Vodou-channels/.env, so inject the same resolved port we probe.
    const waPortEnv = channel === 'whatsapp' ? { WHATSAPP_BRIDGE_PORT: resolveWhatsAppBridgePort() } : {};
    const child = spawn(node, ['dist/index.js'], {
        cwd: channelsDir,
        // VODOU_CHANNELS_DETACHED=1 tells dist/index.js that this is an intentional
        // detached spawn (stdio: ['ignore', ...]) and to enter standalone mode even
        // without a TTY. Without this flag the bridge falls through to MCP stdio
        // mode and exits immediately on EOF — symptom: channel toggle "starts"
        // then disconnects in <1s, and starting one channel kills the others.
        // PLAN-SILENT-ISSUES-AUDIT.md follow-up (Sprint C Phase 4 regression).
        env: { ...process.env, ...credEnv, ...waPortEnv, VODOU_CHANNELS_STANDALONE: channel, VODOU_CHANNELS_DETACHED: '1', VODOU_PROJECT_PATH: getProjectRoot() },
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    const pid = child.pid;
    // Update state file
    const state = readChannelPids();
    state[channel] = { pid, startedAt: new Date().toISOString() };
    writeChannelPids(state);
    return pid;
}
function parseToolOutput(stdout) {
    // vodou-core prints "📤 Result:" then the MCP JSON; earlier "🔧 Generated parameters: {...}" has a leading {
    const resultMarker = '📤 Result:';
    const afterResult = stdout.indexOf(resultMarker);
    const searchStart = afterResult >= 0 ? afterResult + resultMarker.length : 0;
    const jsonStart = stdout.indexOf('{', searchStart);
    const raw = jsonStart >= 0 ? stdout.substring(jsonStart) : stdout;
    try {
        let obj = JSON.parse(raw);
        if (obj?.content && Array.isArray(obj.content)) {
            const textBlock = obj.content.find((b) => b.type === 'text');
            if (textBlock?.text) {
                try {
                    obj = JSON.parse(textBlock.text);
                }
                catch {
                    // keep unwrapped
                }
            }
        }
        const isError = (obj && typeof obj === 'object' && obj.isError) || !!obj?.error;
        return { data: obj, isError };
    }
    catch {
        const hint = stdout.includes('NOT connected') ? 'Set VODOU_TOKEN and VODOU_USER_ID in project .env.'
            : stdout.includes('INVALID CREDENTIALS') ? 'VODOU_TOKEN and VODOU_USER_ID do not match. Check .env.'
                : undefined;
        return { data: null, isError: true, rawHint: hint };
    }
}
async function callChannelTool(tool, args) {
    try {
        const stdout = await runVodouCore(SERVER, tool, args);
        const { data, isError, rawHint } = parseToolOutput(stdout);
        if (isError && data?.error) {
            return { data: null, error: typeof data.error === 'string' ? data.error : String(data.error) };
        }
        if (!data) {
            const msg = rawHint || 'Messaging connectors unavailable. Ensure Vodou-channels is enabled under MCP Servers and VODOU_TOKEN / VODOU_USER_ID are set in project .env.';
            return { data: null, error: msg };
        }
        return { data };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { data: null, error: msg.includes('timed out') ? 'Messaging request timed out.' : msg.includes('ENOENT') ? 'vodou-core not found at project root.' : 'Messaging connectors unavailable. Check MCP Servers and .env.' };
    }
}
export const channelsRouter = Router();
// GET /api/channels/status — all or single channel
channelsRouter.get('/status', async (req, res) => {
    const channel = req.query.channel?.trim() || undefined;
    const args = channel ? { channel } : {};
    const { data, error } = await callChannelTool('channel_status', args);
    if (error) {
        res.status(502).json({ error });
        return;
    }
    const statuses = Array.isArray(data)
        ? [...data]
        : data && typeof data === 'object' && 'channel' in data
            ? [data]
            : Array.isArray(data?.statuses)
                ? [...data.statuses]
                : [];
    await mergeWhatsAppStandaloneHealth(statuses);
    let worst_channel_status = 'ok';
    for (const s of statuses) {
        if (s && typeof s === 'object' && 'error' in s && s.error) {
            worst_channel_status = 'warn';
            break;
        }
    }
    if (Array.isArray(data)) {
        res.json({ statuses, worst_channel_status });
    }
    else if (data && typeof data === 'object' && 'channel' in data) {
        const ch = data.channel;
        const one = statuses.find((s) => s?.channel === ch) ?? statuses[0] ?? data;
        res.json({ status: one, worst_channel_status });
    }
    else {
        res.json({ statuses, worst_channel_status });
    }
});
// POST /api/channels/connect
channelsRouter.post('/connect', async (req, res) => {
    const { channels } = req.body || {};
    const list = Array.isArray(channels) ? channels : ['web'];
    const { data, error } = await callChannelTool('channel_connect', { channels: list });
    if (error) {
        const isBusinessError = /standalone|409|cannot be used|token|credential/i.test(error);
        res.status(isBusinessError ? 400 : 502).json({ error });
        return;
    }
    res.json(data ?? { connected: list, statuses: [] });
});
// POST /api/channels/disconnect
channelsRouter.post('/disconnect', async (req, res) => {
    const { channels } = req.body || {};
    const { data, error } = await callChannelTool('channel_disconnect', channels ? { channels } : {});
    if (error) {
        res.status(502).json({ error });
        return;
    }
    // Also stop the standalone bridge process + clear its log so status checks
    // (which key off the log) flip to "disconnected" immediately. Without this,
    // the UI keeps showing "running" because a previous run's "authenticated"
    // line stays in the log forever.
    const targets = Array.isArray(channels) && channels.length
        ? channels.map(String)
        : Object.keys(readChannelPids());
    const state = readChannelPids();
    for (const ch of targets) {
        if (state[ch]) {
            try {
                process.kill(state[ch].pid, 'SIGTERM');
            }
            catch { }
            delete state[ch];
        }
        try {
            fs.writeFileSync(channelLogPath(ch), '', 'utf-8');
        }
        catch { }
    }
    writeChannelPids(state);
    res.json(data ?? { disconnected: 'all', message: 'Messaging disconnected.' });
});
// POST /api/channels/send
channelsRouter.post('/send', async (req, res) => {
    const { channel, recipient, message, media_path } = req.body || {};
    const msgStr = message != null ? String(message) : '';
    const mediaStr = media_path != null ? String(media_path) : '';
    if (!channel || (!msgStr.trim() && !mediaStr)) {
        res.status(400).json({ error: 'channel and (message or media_path) are required' });
        return;
    }
    const { data, error } = await callChannelTool('channel_send', {
        channel,
        recipient: recipient || 'all',
        message: msgStr,
        ...(mediaStr ? { media_path: mediaStr } : {}),
    });
    if (error) {
        res.status(502).json({ error });
        return;
    }
    res.json(data ?? { success: false });
});
// POST /api/channels/broadcast
channelsRouter.post('/broadcast', async (req, res) => {
    const { message } = req.body || {};
    if (!message) {
        res.status(400).json({ error: 'message is required' });
        return;
    }
    const { data, error } = await callChannelTool('channel_broadcast', { message: String(message) });
    if (error) {
        res.status(502).json({ error });
        return;
    }
    res.json(data ?? { broadcast: true, results: {} });
});
// POST /api/channels/voice/speak — calls system 'say' directly (gateway is long-lived, audio completes)
let activeSayProcess = null;
channelsRouter.post('/voice/speak', (req, res) => {
    const { text, voice } = req.body || {};
    if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
    }
    // Kill any existing speech
    if (activeSayProcess) {
        try {
            activeSayProcess.kill();
        }
        catch { }
    }
    // Run say directly — use Samantha voice as default (macOS default voice can silently fail)
    const voiceName = voice || 'Samantha';
    activeSayProcess = spawn('/usr/bin/say', ['-v', voiceName, String(text)], { stdio: 'inherit' });
    activeSayProcess.on('close', () => { activeSayProcess = null; });
    activeSayProcess.on('error', (err) => console.error('[Voice] say error:', err.message));
    res.json({ success: true, message: 'Speaking...' });
});
// POST /api/channels/voice/stop
channelsRouter.post('/voice/stop', (_req, res) => {
    if (activeSayProcess) {
        try {
            activeSayProcess.kill();
        }
        catch { }
        activeSayProcess = null;
    }
    // Also kill any stray say processes
    if (process.platform === 'darwin') {
        try {
            execSync('killall say 2>/dev/null', { stdio: 'ignore' });
        }
        catch { }
    } // mac-only; execSync = cmd.exe flash on win
    res.json({ message: 'Speech stopped' });
});
// GET /api/channels/voice/voices
channelsRouter.get('/voice/voices', async (req, res) => {
    const { data, error } = await callChannelTool('voice_list_voices', {});
    if (error) {
        res.status(502).json({ error });
        return;
    }
    const voices = (data?.voices ?? []);
    res.json({ voices, count: voices.length });
});
// --- Standalone (Telegram) process control ---
// GET /api/channels/standalone/status — per-channel PID status
channelsRouter.get('/standalone/status', (_req, res) => {
    const alive = getAliveChannels();
    const channels = alive.map(a => a.channel);
    // Build per-channel info for frontend
    const perChannel = {};
    for (const a of alive)
        perChannel[a.channel] = { pid: a.pid, startedAt: a.startedAt };
    res.json({
        running: alive.length > 0,
        channels,
        perChannel,
    });
});
// POST /api/channels/standalone/start — start individual channel processes
// Body: { channels: ['telegram', 'slack'] }
channelsRouter.post('/standalone/start', (_req, res) => {
    const list = Array.isArray(_req.body?.channels) ? _req.body.channels : ['telegram'];
    const requested = list.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    const alive = getAliveChannels();
    const aliveSet = new Set(alive.map(a => a.channel));
    const started = [];
    const skipped = [];
    for (const ch of requested) {
        if (aliveSet.has(ch)) {
            skipped.push(ch);
        }
        else {
            spawnChannel(ch);
            started.push(ch);
        }
    }
    const parts = [];
    if (started.length)
        parts.push(`Started: ${started.join(', ')}`);
    if (skipped.length)
        parts.push(`Already running: ${skipped.join(', ')}`);
    res.json({ ok: true, message: parts.join('. ') || 'Nothing to start.' });
});
// POST /api/channels/standalone/stop — stop individual channel processes
// Body: { channels: ['telegram'] } or omit to stop all
channelsRouter.post('/standalone/stop', (_req, res) => {
    const removeList = Array.isArray(_req.body?.channels) ? _req.body.channels : undefined;
    const state = readChannelPids();
    let stopped = 0;
    if (removeList) {
        // Stop specific channels
        for (const ch of removeList) {
            if (state[ch]) {
                try {
                    process.kill(state[ch].pid, 'SIGTERM');
                }
                catch { }
                delete state[ch];
                stopped++;
            }
        }
        writeChannelPids(state);
        res.json({ ok: true, message: stopped ? `Stopped ${removeList.join(', ')}.` : 'Messaging connectors not running.' });
    }
    else {
        // Stop all
        for (const [ch, info] of Object.entries(state)) {
            try {
                process.kill(info.pid, 'SIGTERM');
            }
            catch { }
            stopped++;
        }
        writeChannelPids({});
        res.json({ ok: true, message: stopped ? `Stopped ${stopped} channel(s).` : 'No channels running.' });
    }
});
// GET /api/channels/whatsapp/qr — return QR code data for WhatsApp pairing
channelsRouter.get('/whatsapp/qr', async (_req, res) => {
    const logReady = whatsappStandaloneLogLooksAuthenticated();
    const health = logReady
        ? { connected: true, logged_in: true }
        : await fetchWhatsAppBridgeHealthBest([]);
    if (health?.logged_in) {
        res.json({
            qr: null,
            paired: true,
            message: 'WhatsApp is linked — no QR needed. If the card still shows “waiting”, click Refresh status.',
        });
        return;
    }
    const waRunning = getAliveChannels().some((a) => a.channel === 'whatsapp');
    const qrPath = path.join(getProjectRoot(), '.vodou', 'whatsapp-auth', 'qr.txt');
    const pairingPath = path.join(getProjectRoot(), '.vodou', 'whatsapp-auth', 'pairing-code.txt');
    const logPath = path.join(getProjectRoot(), '.vodou', 'workspace', 'channels-whatsapp.log');
    const waitMsg = waRunning
        ? 'Waiting for QR or restoring your session… try Refresh in a few seconds.'
        : 'Start WhatsApp on the card first, then open this panel again.';
    try {
        const qr = fs.readFileSync(qrPath, 'utf-8').trim();
        if (!qr) {
            let pairingCode = null;
            try {
                pairingCode = fs.readFileSync(pairingPath, 'utf-8').trim() || null;
            }
            catch { }
            let message = waitMsg;
            try {
                const log = fs.readFileSync(logPath, 'utf-8');
                if (log.includes('Stale session (405)') || log.includes('Disconnected (code 405)')) {
                    message =
                        'WhatsApp session failed (code 405). Session auth is being reset, but QR is not being issued by WhatsApp Web yet. Stop/Start WhatsApp and try again.';
                }
            }
            catch { }
            res.json({ qr: null, pairingCode, message });
            return;
        }
        res.json({ qr });
    }
    catch {
        let pairingCode = null;
        try {
            pairingCode = fs.readFileSync(pairingPath, 'utf-8').trim() || null;
        }
        catch { }
        let message = waitMsg;
        try {
            const log = fs.readFileSync(logPath, 'utf-8');
            if (log.includes('Stale session (405)') || log.includes('Disconnected (code 405)')) {
                message =
                    'WhatsApp session failed (code 405). Session auth is being reset, but QR is not being issued by WhatsApp Web yet. Stop/Start WhatsApp and try again.';
            }
        }
        catch { }
        res.json({ qr: null, pairingCode, message });
    }
});
// POST /api/channels/whatsapp/reset — stop WhatsApp, purge auth, restart; return log tail
channelsRouter.post('/whatsapp/reset', async (_req, res) => {
    const channel = 'whatsapp';
    const state = readChannelPids();
    if (state[channel]) {
        try {
            process.kill(state[channel].pid, 'SIGTERM');
        }
        catch { }
        delete state[channel];
        writeChannelPids(state);
    }
    const authDir = path.join(getProjectRoot(), '.vodou', 'whatsapp-auth');
    try {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
    catch { }
    try {
        fs.mkdirSync(authDir, { recursive: true });
    }
    catch { }
    let pid;
    try {
        pid = spawnChannel(channel);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({
            ok: false,
            error: msg,
            logTail: tailChannelLog(channel, 80),
        });
        return;
    }
    await new Promise((r) => setTimeout(r, 600));
    const logTail = tailChannelLog(channel, 80);
    res.json({
        ok: true,
        message: 'WhatsApp session cleared and process restarted. Scan the QR when it appears.',
        pid,
        logTail,
    });
});
// GET /api/channels/log/:channel — tail the channel log file
channelsRouter.get('/log/:channel', (req, res) => {
    const channel = req.params.channel.replace(/[^a-z0-9-]/g, '');
    const logFile = path.join(getProjectRoot(), '.vodou', 'workspace', `channels-${channel}.log`);
    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        // Return last 200 lines
        const lines = content.split('\n');
        const tail = lines.slice(-200).join('\n');
        res.json({ log: tail, lines: lines.length });
    }
    catch {
        res.json({ log: '', lines: 0 });
    }
});
// --- Channel Credentials Management (DB-only, single source of truth) ---
const CHANNEL_KEYS = {
    telegram: {
        keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID'],
        labels: { TELEGRAM_BOT_TOKEN: 'Bot Token', TELEGRAM_ADMIN_ID: 'Admin Chat ID' },
    },
    slack: {
        keys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_DEFAULT_CHANNEL'],
        labels: { SLACK_BOT_TOKEN: 'Bot Token (xoxb-...)', SLACK_APP_TOKEN: 'App Token (xapp-...)', SLACK_SIGNING_SECRET: 'Signing Secret', SLACK_DEFAULT_CHANNEL: 'Default Channel ID' },
    },
    discord: {
        keys: ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'],
        labels: { DISCORD_BOT_TOKEN: 'Bot Token', DISCORD_GUILD_ID: 'Guild (Server) ID' },
    },
    whatsapp: {
        keys: ['WHATSAPP_PHONE_NUMBER'],
        labels: {
            WHATSAPP_PHONE_NUMBER: 'Phone Number for Pairing Code (E.164, digits only)',
        },
    },
    // iMessage has no credentials — it reads chat.db locally and sends via
    // AppleScript. All "config" is TCC grants (Full Disk Access + Automation)
    // + the optional allowlist file. Kept here so the empty panel renders
    // consistently and so the gateway's standalone/status pipeline has an
    // entry to look up.
    imessage: { keys: [], labels: {} },
    teams: {
        keys: ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID', 'TEAMS_PORT'],
        labels: {
            TEAMS_APP_ID: 'Azure Bot App ID (Microsoft App ID)',
            TEAMS_APP_PASSWORD: 'Client Secret (Microsoft App Password)',
            TEAMS_TENANT_ID: 'Directory (Tenant) ID — only for single-tenant bots; leave empty for multi-tenant',
            TEAMS_PORT: 'HTTP listen port for /api/messages (default 3978)',
        },
    },
    googlechat: {
        keys: ['GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_PORT'],
        labels: {
            GOOGLE_CHAT_CREDENTIALS: 'Service account JSON (full key object, paste as one line)',
            GOOGLE_CHAT_PORT: 'HTTP listen port for /api/googlechat (default 3979)',
        },
    },
    signal: {
        keys: ['SIGNAL_CLI_PATH', 'SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_CONFIG'],
        labels: {
            SIGNAL_CLI_PATH: 'signal-cli binary path (leave empty to use PATH)',
            SIGNAL_PHONE_NUMBER: 'Registered Signal number (E.164, e.g. +15551234567)',
            SIGNAL_CLI_CONFIG: 'Optional signal-cli --config directory',
        },
    },
};
function maskToken(val) {
    if (!val || val.length < 10)
        return val ? '***' : '';
    return val.substring(0, 8) + '...' + val.substring(val.length - 4);
}
/** DB key for a channel credential: channel_telegram_bot_token */
function credDbKey(envKey) {
    return 'channel_' + envKey.toLowerCase();
}
/** Read a single channel credential from DB */
function getChannelCred(envKey) {
    return getSetting(credDbKey(envKey)) || '';
}
/** Read all channel credentials from DB as a flat env-style map */
function readAllChannelCreds() {
    const result = {};
    for (const meta of Object.values(CHANNEL_KEYS)) {
        for (const key of meta.keys) {
            const val = getChannelCred(key);
            if (val)
                result[key] = val;
        }
    }
    return result;
}
/** One-time migration: import any existing Vodou-channels/.env credentials into DB */
function migrateEnvToDb() {
    const envPath = path.join(getProjectRoot(), 'MCP-servers', 'Vodou-channels', '.env');
    let raw = '';
    try {
        raw = fs.readFileSync(envPath, 'utf-8');
    }
    catch {
        return;
    }
    const allKeys = new Set();
    for (const meta of Object.values(CHANNEL_KEYS)) {
        for (const k of meta.keys)
            allKeys.add(k);
    }
    let migrated = 0;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0)
            continue;
        const key = trimmed.substring(0, eq);
        const val = trimmed.substring(eq + 1);
        if (allKeys.has(key) && val && !getChannelCred(key)) {
            setSetting(credDbKey(key), val);
            migrated++;
        }
    }
    if (migrated > 0)
        console.log(`[channels] Migrated ${migrated} credential(s) from .env to DB`);
}
// Run migration on module load
migrateEnvToDb();
// GET /api/channels/credentials — returns masked tokens for all channels (from DB)
channelsRouter.get('/credentials', (req, res) => {
    // `reveal=1` returns the raw saved token in `value`, otherwise `value` is
    // masked (same as `masked`). The Settings > Tokens UI fetches with reveal=1
    // so users can see what's configured AND edit it in place without retyping.
    // Same trust boundary as the rest of the gateway API — caller is already
    // authenticated on this machine.
    const reveal = req.query.reveal === '1' || req.query.reveal === 'true';
    const channels = {};
    for (const [channel, meta] of Object.entries(CHANNEL_KEYS)) {
        channels[channel] = {};
        for (const key of meta.keys) {
            const val = getChannelCred(key);
            channels[channel][key] = {
                value: val ? (reveal ? val : maskToken(val)) : '',
                masked: val ? maskToken(val) : '',
                label: meta.labels[key] || key,
            };
        }
    }
    res.json({ channels });
});
// POST /api/channels/credentials — save channel tokens (DB-only)
channelsRouter.post('/credentials', (req, res) => {
    const { channel, credentials } = req.body;
    if (!channel || !credentials || typeof credentials !== 'object') {
        res.status(400).json({ error: 'channel and credentials object required' });
        return;
    }
    const meta = CHANNEL_KEYS[channel];
    if (!meta) {
        res.status(400).json({ error: 'Unknown channel: ' + channel });
        return;
    }
    let saved = 0;
    for (const key of meta.keys) {
        if (credentials[key] !== undefined && credentials[key] !== '') {
            setSetting(credDbKey(key), String(credentials[key]));
            saved++;
        }
    }
    if (saved === 0) {
        res.status(400).json({ error: 'No credentials provided' });
        return;
    }
    res.json({ ok: true, channel, saved });
});
// POST /api/channels/credentials/test — test a channel connection
channelsRouter.post('/credentials/test', async (req, res) => {
    const { channel } = req.body;
    try {
        switch (channel) {
            case 'telegram': {
                const token = getChannelCred('TELEGRAM_BOT_TOKEN');
                if (!token) {
                    res.json({ success: false, error: 'No bot token configured' });
                    return;
                }
                const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
                const data = await resp.json();
                if (data.ok) {
                    res.json({ success: true, info: `Bot: @${data.result.username} (${data.result.first_name})` });
                }
                else {
                    res.json({ success: false, error: data.description || 'Invalid token' });
                }
                return;
            }
            case 'slack': {
                const token = getChannelCred('SLACK_BOT_TOKEN');
                if (!token) {
                    res.json({ success: false, error: 'No bot token configured' });
                    return;
                }
                const resp = await fetch('https://slack.com/api/auth.test', {
                    headers: { 'Authorization': 'Bearer ' + token },
                });
                const data = await resp.json();
                if (data.ok) {
                    res.json({ success: true, info: `Workspace: ${data.team} — Bot: ${data.user}` });
                }
                else {
                    res.json({ success: false, error: data.error || 'Invalid token' });
                }
                return;
            }
            case 'discord': {
                const token = getChannelCred('DISCORD_BOT_TOKEN');
                if (!token) {
                    res.json({ success: false, error: 'No bot token configured' });
                    return;
                }
                const resp = await fetch('https://discord.com/api/v10/users/@me', {
                    headers: { 'Authorization': 'Bot ' + token },
                });
                const data = await resp.json();
                if (data.id) {
                    res.json({ success: true, info: `Bot: ${data.username}#${data.discriminator}` });
                }
                else {
                    res.json({ success: false, error: data.message || 'Invalid token' });
                }
                return;
            }
            case 'teams': {
                const appId = getChannelCred('TEAMS_APP_ID');
                const secret = getChannelCred('TEAMS_APP_PASSWORD');
                const tenant = getChannelCred('TEAMS_TENANT_ID');
                if (!appId || !secret) {
                    res.json({ success: false, error: 'TEAMS_APP_ID and TEAMS_APP_PASSWORD required' });
                    return;
                }
                const tok = await getBotFrameworkAccessToken(appId, secret, tenant || undefined);
                if (tok) {
                    res.json({
                        success: true,
                        info: 'Bot Framework OAuth token OK — App ID and secret match Azure. Ensure messaging endpoint + Teams channel are configured in Azure Portal.',
                    });
                }
                else {
                    res.json({ success: false, error: 'Token request failed — check App ID, secret, and tenant (single-tenant needs Directory ID).' });
                }
                return;
            }
            case 'googlechat': {
                const raw = getChannelCred('GOOGLE_CHAT_CREDENTIALS');
                if (!raw) {
                    res.json({ success: false, error: 'GOOGLE_CHAT_CREDENTIALS required' });
                    return;
                }
                let o;
                try {
                    o = JSON.parse(raw);
                }
                catch {
                    res.json({ success: false, error: 'Invalid JSON' });
                    return;
                }
                if (!o.client_email || !o.private_key) {
                    res.json({ success: false, error: 'Expected service account JSON (client_email + private_key)' });
                    return;
                }
                try {
                    const { JWT } = await import('google-auth-library');
                    const jwt = new JWT({
                        email: String(o.client_email),
                        key: String(o.private_key).replace(/\\n/g, '\n'),
                        scopes: ['https://www.googleapis.com/auth/chat.bot'],
                    });
                    const tok = await jwt.getAccessToken();
                    if (tok?.token) {
                        res.json({
                            success: true,
                            info: `Service account OAuth OK (${String(o.client_email)}) — enable Chat API, publish the Chat app, and point HTTP endpoint at …/api/googlechat.`,
                        });
                    }
                    else {
                        res.json({ success: false, error: 'No access token returned' });
                    }
                }
                catch (e) {
                    res.json({ success: false, error: e instanceof Error ? e.message : String(e) });
                }
                return;
            }
            case 'signal': {
                const cli = (getChannelCred('SIGNAL_CLI_PATH') || 'signal-cli').trim();
                const phone = getChannelCred('SIGNAL_PHONE_NUMBER').trim();
                if (!phone) {
                    res.json({ success: false, error: 'SIGNAL_PHONE_NUMBER required' });
                    return;
                }
                const r = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 8000 });
                if (r.status === 0) {
                    const line = (r.stdout || r.stderr || '').split('\n')[0].trim() || 'signal-cli';
                    res.json({ success: true, info: `${line} — account ${phone} (register with signal-cli link if needed).` });
                }
                else {
                    res.json({
                        success: false,
                        error: (r.stderr || r.stdout || 'signal-cli not found or not executable').trim() || 'signal-cli check failed',
                    });
                }
                return;
            }
            default:
                res.status(400).json({ success: false, error: 'Unknown channel' });
        }
    }
    catch (err) {
        res.json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
});
// ── iMessage endpoints ───────────────────────────────────────────────────
// iMessage ships with native macOS integration (chat.db read + AppleScript
// send). These endpoints power the gateway Messaging → iMessage UI:
//   - /permissions       → probe whether Full Disk Access works right now
//   - /allowlist         → get/set the "only read from these senders" list
//   - /allowlist/top     → read chat.db for most-frequent recent senders
//                          so the user can one-click import them
import os from 'os';
const IMESSAGE_CHAT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
// ── Shared per-channel allowlist file helpers ─────────────────────────────
// Every messaging channel (iMessage, WhatsApp, Slack, Discord, Telegram) uses
// the same on-disk format:  `.vodou/channels/<channel>-allowlist.json`
//   { "mode": "on"|"off", "senders": [{"id": "...", "name": "..."}, ...] }
// The Vodou-channels side reads + fs.watch()es this file, so any POST here is
// picked up live by the running channel — no restart needed.
const ALLOWLIST_CHANNELS = new Set(['imessage', 'whatsapp', 'slack', 'discord', 'telegram', 'teams', 'googlechat', 'signal']);
function channelAllowlistPath(channel) {
    const dir = path.join(getProjectRoot(), '.vodou', 'channels');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${channel}-allowlist.json`);
}
function readChannelAllowlist(channel) {
    try {
        const p = channelAllowlistPath(channel);
        if (!fs.existsSync(p))
            return { mode: 'off', senders: [] };
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            mode: parsed.mode === 'on' ? 'on' : 'off',
            senders: Array.isArray(parsed.senders) ? parsed.senders : [],
        };
    }
    catch {
        return { mode: 'off', senders: [] };
    }
}
function writeChannelAllowlist(channel, cfg) {
    fs.writeFileSync(channelAllowlistPath(channel), JSON.stringify(cfg, null, 2), 'utf8');
}
// Backwards-compat shims for the iMessage-specific endpoints below.
function readImessageAllowlist() { return readChannelAllowlist('imessage'); }
function writeImessageAllowlist(cfg) {
    writeChannelAllowlist('imessage', cfg);
}
function walkResponsibleProcess(startPid) {
    const ancestors = [];
    let pid = startPid;
    for (let depth = 0; depth < 10 && pid > 1; depth++) {
        let ppid = -1, comm = '', argv0 = '';
        // ps -o comm gives the launched command path (full path when launched
        // with one; bare basename when launched off PATH). Good enough for our
        // classification — we recognise terminals/IDEs by name and Vodou.app by
        // its .app/Contents/MacOS/ pattern. `lsof -p` is unreliable on macOS
        // without elevated privileges (returns sibling processes), so we skip
        // it and also grab `command` (full argv) as a fallback.
        try {
            const out = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf-8' });
            if (out.status !== 0)
                break;
            const line = (out.stdout || '').trim();
            if (!line)
                break;
            const m = line.match(/^\s*(\d+)\s+(.+)$/);
            if (!m)
                break;
            ppid = parseInt(m[1], 10);
            comm = m[2].trim();
        }
        catch {
            break;
        }
        // Pull argv0 (full command) as a backup signal — useful when an IDE
        // helper hides behind a generic comm like "node".
        try {
            const out2 = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
            if (out2.status === 0)
                argv0 = (out2.stdout || '').trim().split(/\s+/)[0] || '';
        }
        catch { }
        const exe = comm.startsWith('/') ? comm : (argv0.startsWith('/') ? argv0 : comm);
        ancestors.push({ pid, exe, comm });
        if (ppid <= 1)
            break;
        pid = ppid;
    }
    const APP_RE = /\/([^/]+\.app)\/Contents\/MacOS\//;
    const TERMINALS = ['Terminal', 'iTerm2', 'iTerm', 'WezTerm', 'Alacritty', 'Warp', 'kitty', 'Ghostty', 'Hyper', 'Tabby'];
    const IDES = ['Code Helper', 'Cursor Helper', 'Code', 'Cursor', 'Windsurf', 'WindsurfHelper', 'claude', 'Claude'];
    let result = { context: 'unknown', responsibleApp: null, ideName: null, ancestors };
    for (const a of ancestors) {
        const exe = a.exe || '';
        const comm = a.comm || '';
        const m = exe.match(APP_RE);
        if (m) {
            const appName = m[1].replace(/\.app$/, '');
            const appPath = exe.split('/Contents/MacOS/')[0] + '.app';
            if (/^Vodou(\b|$)/i.test(appName)) {
                return { context: 'app-bundle', responsibleApp: { name: appName, path: appPath }, ideName: null, ancestors };
            }
            if (TERMINALS.some(t => appName.toLowerCase().includes(t.toLowerCase()))) {
                if (result.context === 'unknown' || result.context === 'launchd') {
                    result = { context: 'terminal', responsibleApp: { name: appName, path: appPath }, ideName: null, ancestors };
                }
                continue;
            }
            if (IDES.some(i => appName.toLowerCase().includes(i.toLowerCase()))) {
                result = { context: 'ide', responsibleApp: { name: appName, path: appPath }, ideName: appName, ancestors };
                continue;
            }
        }
        if (IDES.some(i => comm.toLowerCase() === i.toLowerCase())) {
            if (result.context === 'unknown' || result.context === 'launchd') {
                result = { context: 'ide', responsibleApp: null, ideName: comm, ancestors };
            }
        }
    }
    if (result.context === 'unknown' && ancestors.length > 0) {
        const last = ancestors[ancestors.length - 1];
        if (!APP_RE.test(last.exe || '')) {
            result = { context: 'launchd', responsibleApp: null, ideName: null, ancestors };
        }
    }
    return result;
}
function probeChatDbFda() {
    try {
        const fd = fs.openSync(IMESSAGE_CHAT_DB, 'r');
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, 0);
        fs.closeSync(fd);
        return 'granted';
    }
    catch {
        return 'missing';
    }
}
channelsRouter.get('/imessage/permissions', (_req, res) => {
    if (process.platform !== 'darwin') {
        res.json({ platform: process.platform, fullDiskAccess: 'unsupported', chatDbExists: false, chatDbPath: IMESSAGE_CHAT_DB });
        return;
    }
    const chatDbExists = fs.existsSync(IMESSAGE_CHAT_DB);
    const fullDiskAccess = chatDbExists ? probeChatDbFda() : 'unknown';
    const nodeBinaryPath = process.execPath;
    const ctx = walkResponsibleProcess(process.pid);
    const grantTargets = [];
    let warning = null;
    let cta = null;
    switch (ctx.context) {
        case 'app-bundle':
            grantTargets.push({
                path: ctx.responsibleApp.path,
                why: 'Vodou.app is the TCC-responsible process — granting FDA to the bundle covers Node and all child processes.',
                primary: true,
            });
            break;
        case 'terminal':
            grantTargets.push({
                path: ctx.responsibleApp.path,
                why: `Services were launched from ${ctx.responsibleApp.name}.app — macOS attributes FDA to it, not to the node binary.`,
                primary: true,
            });
            grantTargets.push({
                path: nodeBinaryPath,
                why: 'Optional belt-and-suspenders. Usually unnecessary when the terminal app has FDA, but harmless.',
                primary: false,
            });
            break;
        case 'ide':
            warning = `Services were launched from ${ctx.ideName || 'an IDE/tool'}, which macOS often refuses to honor FDA for. ` +
                `Restart services from Terminal.app for a reliable grant.`;
            cta = {
                kind: 'restart-in-terminal',
                text: 'Open Terminal.app and run these commands:',
                cmd: `cd ${process.cwd()}\n./stop-vodou-services.sh && ./start-vodou-services.sh`,
            };
            grantTargets.push({
                path: '/System/Applications/Utilities/Terminal.app',
                why: 'Grant FDA to Terminal.app, then start services from Terminal.',
                primary: true,
            });
            break;
        case 'launchd':
            grantTargets.push({
                path: nodeBinaryPath,
                why: 'Services are launchd-managed — granting FDA to the node binary is sufficient.',
                primary: true,
            });
            break;
        case 'unknown':
        default:
            grantTargets.push({
                path: nodeBinaryPath,
                why: 'Could not determine launch context — try granting FDA to this node binary first.',
                primary: true,
            });
            break;
    }
    try {
        console.error('[FDA-DIAG]', JSON.stringify({
            t: new Date().toISOString(),
            context: ctx.context,
            responsibleApp: ctx.responsibleApp?.name || null,
            ideName: ctx.ideName,
            nodeBinaryPath,
            chatDbExists,
            fullDiskAccess,
            ancestors: ctx.ancestors.map(a => ({ pid: a.pid, comm: a.comm, exe: a.exe })),
        }));
    }
    catch { }
    res.json({
        platform: 'darwin',
        chatDbPath: IMESSAGE_CHAT_DB,
        chatDbExists,
        fullDiskAccess,
        automationMessages: 'unknown',
        nodeBinaryPath,
        context: ctx.context,
        responsibleApp: ctx.responsibleApp,
        ideName: ctx.ideName,
        ancestors: ctx.ancestors,
        grantTargets,
        warning,
        cta,
        settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    });
});
// Definitive FDA test: spawn a fresh child node process and have IT try to
// read chat.db. The gateway's own FDA state is fixed at startup — if the
// user grants FDA after the gateway boots, the gateway won't see it until
// restart. A fresh child gives a true "would FDA work right now?" answer.
channelsRouter.post('/imessage/permissions/test', (_req, res) => {
    if (process.platform !== 'darwin') {
        res.json({ ok: false, errno: 'unsupported', responsibleProcess: null });
        return;
    }
    const probeScript = `try{const fs=require('fs');const fd=fs.openSync(${JSON.stringify(IMESSAGE_CHAT_DB)},'r');fs.closeSync(fd);process.stdout.write('OK');}catch(e){process.stdout.write('FAIL:'+(e.code||'unknown'));}`;
    let stdout = '';
    let errno = null;
    try {
        const out = spawnSync(process.execPath, ['-e', probeScript], { encoding: 'utf-8', timeout: 5000 });
        stdout = (out.stdout || '').trim();
        if (out.error)
            errno = String(out.error.code || out.error.message);
    }
    catch (e) {
        errno = e.code || e.message;
    }
    const ok = stdout === 'OK';
    if (!ok && stdout.startsWith('FAIL:'))
        errno = stdout.slice(5);
    const ctx = walkResponsibleProcess(process.pid);
    try {
        console.error('[FDA-DIAG] test', JSON.stringify({
            t: new Date().toISOString(),
            ok, errno, context: ctx.context,
            responsibleApp: ctx.responsibleApp?.name || null,
        }));
    }
    catch { }
    res.json({
        ok,
        errno,
        responsibleProcess: ctx.responsibleApp,
        context: ctx.context,
    });
});
channelsRouter.get('/imessage/allowlist', (_req, res) => {
    res.json(readImessageAllowlist());
});
channelsRouter.post('/imessage/allowlist/mode', (req, res) => {
    const mode = req.body?.mode === 'on' ? 'on' : 'off';
    const cfg = readImessageAllowlist();
    cfg.mode = mode;
    writeImessageAllowlist(cfg);
    res.json({ ok: true, mode });
});
channelsRouter.post('/imessage/allowlist/add', (req, res) => {
    const id = String(req.body?.id || '').trim();
    const name = req.body?.name ? String(req.body.name).trim() : undefined;
    if (!id) {
        res.status(400).json({ error: 'id required' });
        return;
    }
    const cfg = readImessageAllowlist();
    if (!cfg.senders.some((s) => s.id === id))
        cfg.senders.push({ id, name });
    writeImessageAllowlist(cfg);
    res.json({ ok: true, count: cfg.senders.length });
});
channelsRouter.post('/imessage/allowlist/remove', (req, res) => {
    const id = String(req.body?.id || '').trim();
    if (!id) {
        res.status(400).json({ error: 'id required' });
        return;
    }
    const cfg = readImessageAllowlist();
    cfg.senders = cfg.senders.filter((s) => s.id !== id);
    writeImessageAllowlist(cfg);
    res.json({ ok: true, count: cfg.senders.length });
});
// ── Generic per-channel allowlist routes (whatsapp/slack/discord/telegram) ──
// iMessage keeps its dedicated routes above (for backwards-compat with the
// settings panel + because /allowlist/top needs chat.db-specific SQL). These
// generic routes cover the other messaging channels using the same JSON shape
// on disk so the Vodou-channels AllowlistWatcher picks up changes live.
function allowlistChannelGuard(req, res) {
    const channel = String(req.params.channel || '').toLowerCase();
    if (!ALLOWLIST_CHANNELS.has(channel)) {
        res.status(404).json({ error: `Unknown channel '${channel}'. Supported: ${Array.from(ALLOWLIST_CHANNELS).join(', ')}` });
        return null;
    }
    return channel;
}
channelsRouter.get('/:channel/allowlist', (req, res) => {
    const channel = allowlistChannelGuard(req, res);
    if (!channel)
        return;
    res.json(readChannelAllowlist(channel));
});
channelsRouter.post('/:channel/allowlist/mode', (req, res) => {
    const channel = allowlistChannelGuard(req, res);
    if (!channel)
        return;
    const mode = req.body?.mode === 'on' ? 'on' : 'off';
    const cfg = readChannelAllowlist(channel);
    cfg.mode = mode;
    writeChannelAllowlist(channel, cfg);
    res.json({ ok: true, mode });
});
channelsRouter.post('/:channel/allowlist/add', (req, res) => {
    const channel = allowlistChannelGuard(req, res);
    if (!channel)
        return;
    const id = String(req.body?.id || '').trim();
    const name = req.body?.name ? String(req.body.name).trim() : undefined;
    if (!id) {
        res.status(400).json({ error: 'id required' });
        return;
    }
    const cfg = readChannelAllowlist(channel);
    if (!cfg.senders.some((s) => s.id === id))
        cfg.senders.push({ id, name });
    writeChannelAllowlist(channel, cfg);
    res.json({ ok: true, count: cfg.senders.length });
});
channelsRouter.post('/:channel/allowlist/remove', (req, res) => {
    const channel = allowlistChannelGuard(req, res);
    if (!channel)
        return;
    const id = String(req.body?.id || '').trim();
    if (!id) {
        res.status(400).json({ error: 'id required' });
        return;
    }
    const cfg = readChannelAllowlist(channel);
    cfg.senders = cfg.senders.filter((s) => s.id !== id);
    writeChannelAllowlist(channel, cfg);
    res.json({ ok: true, count: cfg.senders.length });
});
// One-click import helper: return the top-N most-frequent senders in chat.db
// over the last ~6 months. Requires Full Disk Access (same gate as connect).
channelsRouter.get('/imessage/allowlist/top', async (req, res) => {
    if (process.platform !== 'darwin') {
        res.status(400).json({ error: 'macOS only' });
        return;
    }
    if (!fs.existsSync(IMESSAGE_CHAT_DB)) {
        res.status(404).json({ error: 'chat.db not found' });
        return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    try {
        // Use built-in node:sqlite (Node 24+). Dynamic import keeps non-macOS code paths clean.
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(IMESSAGE_CHAT_DB, { readOnly: true });
        // Apple epoch (ns since 2001-01-01) — 6 months ago in ns
        const nowMs = Date.now();
        const sixMonthsAgoMs = nowMs - 1000 * 60 * 60 * 24 * 30 * 6;
        const appleEpochMs = new Date('2001-01-01T00:00:00Z').getTime();
        const cutoffNs = (sixMonthsAgoMs - appleEpochMs) * 1_000_000;
        const rows = db.prepare(`
      SELECT h.id AS sender_id, COUNT(*) AS n
      FROM message m JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.is_from_me = 0
        AND m.date > ?
        AND m.service IN ('iMessage', 'SMS')
      GROUP BY h.id
      ORDER BY n DESC
      LIMIT ?
    `).all(cutoffNs, limit);
        db.close();
        res.json({ senders: rows });
    }
    catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});
// ── Pluggable channel package management ─────────────────────────────────────
const CHANNEL_INSTALL_DIR = () => path.join(process.env.HOME || '~', '.vodou', 'channels');
/** Read manifest from an installed channel package dir. */
function readChannelManifest(pkgDir) {
    try {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
        const main = typeof pkgJson.main === 'string' ? pkgJson.main : 'dist/index.js';
        // Best-effort: read the compiled manifest() output from package.json vodou field,
        // or construct a minimal stub from the package name.
        if (pkgJson.vodouManifest)
            return pkgJson.vodouManifest;
        const parts = (pkgJson.name || '').split('/');
        const channelName = (parts[parts.length - 1] || '').replace(/^channel-/, '');
        return {
            name: channelName,
            displayName: channelName.charAt(0).toUpperCase() + channelName.slice(1),
            version: pkgJson.version || '0.0.0',
            description: pkgJson.description || '',
            author: typeof pkgJson.author === 'string' ? pkgJson.author : 'Unknown',
            signed: (pkgJson.name || '').startsWith('@vodou/'),
            requiredEnv: [],
        };
    }
    catch {
        return null;
    }
}
/** GET /api/channels/installed — list all packages in ~/.vodou/channels/node_modules */
channelsRouter.get('/installed', (req, res) => {
    const nodeModules = path.join(CHANNEL_INSTALL_DIR(), 'node_modules');
    const result = [];
    try {
        const scopes = fs.readdirSync(nodeModules);
        for (const scope of scopes) {
            if (!scope.startsWith('@'))
                continue;
            const scopeDir = path.join(nodeModules, scope);
            try {
                for (const pkg of fs.readdirSync(scopeDir)) {
                    if (!pkg.startsWith('channel-'))
                        continue;
                    const pkgDir = path.join(scopeDir, pkg);
                    const manifest = readChannelManifest(pkgDir);
                    if (manifest)
                        result.push({ packageName: `${scope}/${pkg}`, manifest });
                }
            }
            catch { }
        }
    }
    catch {
        // no ~/.vodou/channels/node_modules yet
    }
    res.json({ channels: result });
});
/** POST /api/channels/install — body: { package: "@vodou/channel-telegram" } */
channelsRouter.post('/install', (req, res) => {
    const pkg = (req.body?.package || '').toString().trim();
    if (!pkg || !/^@[^/]+\/channel-/.test(pkg)) {
        res.status(400).json({ error: 'package must match @scope/channel-<name>' });
        return;
    }
    const installDir = CHANNEL_INSTALL_DIR();
    if (!fs.existsSync(path.join(installDir, 'package.json'))) {
        fs.mkdirSync(installDir, { recursive: true });
        fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'vodou-channels-install', version: '1.0.0', private: true }));
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const child = spawn('npm', ['install', '--prefix', installDir, pkg], {
        env: process.env,
        shell: false,
    });
    child.stdout.on('data', (d) => res.write(`data: ${d.toString().trim()}\n\n`));
    child.stderr.on('data', (d) => res.write(`data: ${d.toString().trim()}\n\n`));
    child.on('close', (code) => {
        res.write(`data: ${JSON.stringify({ done: true, code })}\n\n`);
        res.end();
    });
});
/** DELETE /api/channels/uninstall — body: { package: "@vodou/channel-telegram" } */
channelsRouter.delete('/uninstall', (req, res) => {
    const pkg = (req.body?.package || '').toString().trim();
    if (!pkg || !/^@[^/]+\/channel-/.test(pkg)) {
        res.status(400).json({ error: 'package must match @scope/channel-<name>' });
        return;
    }
    const installDir = CHANNEL_INSTALL_DIR();
    const child = spawnSync('npm', ['uninstall', '--prefix', installDir, pkg], {
        env: process.env,
        encoding: 'utf-8',
    });
    if (child.status !== 0) {
        res.status(500).json({ error: child.stderr || 'npm uninstall failed' });
        return;
    }
    res.json({ ok: true, package: pkg });
});
