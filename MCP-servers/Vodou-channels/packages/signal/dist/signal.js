/**
 * Signal — inbound via `signal-cli … jsonRpc` (line-delimited JSON-RPC on stdio),
 * outbound via the same RPC `send` while connected.
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import { AllowlistWatcher, normalizeSignalHandle } from '@vodou/channel-sdk';
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
function digitsOnly(s) {
    return (s || '').replace(/\D/g, '');
}
export function encodeSignalRecipient(phone, groupId) {
    const p = (phone || '').trim();
    const g = (groupId || '').trim();
    return Buffer.from(JSON.stringify({ p, g }), 'utf8').toString('base64url');
}
export function decodeSignalRecipient(recipient) {
    if (!recipient || typeof recipient !== 'string')
        return null;
    try {
        const buf = Buffer.from(recipient, 'base64url');
        const o = JSON.parse(buf.toString('utf8'));
        const phone = (o.p || '').trim();
        const groupId = (o.g || '').trim();
        if (!phone && !groupId)
            return null;
        return { ...(phone ? { phone } : {}), ...(groupId ? { groupId } : {}) };
    }
    catch {
        try {
            const buf = Buffer.from(recipient, 'base64');
            const o = JSON.parse(buf.toString('utf8'));
            const phone = (o.p || '').trim();
            const groupId = (o.g || '').trim();
            if (!phone && !groupId)
                return null;
            return { ...(phone ? { phone } : {}), ...(groupId ? { groupId } : {}) };
        }
        catch {
            return null;
        }
    }
}
export class SignalChannel {
    type = 'signal';
    proc = null;
    rl = null;
    connected = false;
    lastActivity;
    error;
    messageHandler;
    allowlist = null;
    pending = new Map();
    nextRpcId = 1;
    ownDigits = '';
    async connect() {
        if (this.proc)
            return;
        const cli = (process.env.SIGNAL_CLI_PATH || 'signal-cli').trim();
        const accountRaw = (process.env.SIGNAL_PHONE_NUMBER || '').trim();
        if (!accountRaw) {
            this.error = 'SIGNAL_PHONE_NUMBER required (E.164, e.g. +15551234567)';
            console.error(`[Signal] ${this.error}`);
            return;
        }
        const account = accountRaw.startsWith('+') ? accountRaw : `+${digitsOnly(accountRaw)}`;
        this.ownDigits = digitsOnly(account);
        const config = (process.env.SIGNAL_CLI_CONFIG || '').trim();
        const args = [];
        if (config)
            args.push('--config', config);
        args.push('-a', account, 'jsonRpc');
        if (!this.allowlist) {
            this.allowlist = new AllowlistWatcher(PROJECT_ROOT, 'signal', normalizeSignalHandle);
        }
        console.error(`[Signal] Spawning: ${cli} ${args.join(' ')}`);
        this.proc = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.on('error', (e) => {
            this.error = e.message;
            this.connected = false;
            console.error('[Signal] spawn error:', e.message);
        });
        this.proc.on('exit', (code, sig) => {
            console.error(`[Signal] signal-cli exited code=${code} signal=${sig}`);
            this.proc = null;
            this.rl?.close();
            this.rl = null;
            this.connected = false;
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error('signal-cli process exited'));
            }
            this.pending.clear();
        });
        this.proc.stderr.on('data', (b) => {
            process.stderr.write(`[signal-cli] ${b.toString()}`);
        });
        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on('line', (line) => this.handleLine(line.trim()).catch((err) => console.error('[Signal] handleLine:', err)));
        this.connected = true;
        this.error = undefined;
        this.lastActivity = new Date();
    }
    handleLine(line) {
        if (!line)
            return Promise.resolve();
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            return Promise.resolve();
        }
        if (typeof obj.id === 'number' && this.pending.has(obj.id)) {
            const p = this.pending.get(obj.id);
            this.pending.delete(obj.id);
            clearTimeout(p.timer);
            if (obj.error) {
                p.reject(new Error(JSON.stringify(obj.error)));
            }
            else {
                p.resolve(obj.result);
            }
            return Promise.resolve();
        }
        if (obj.method === 'receive') {
            return this.onReceive(obj.params);
        }
        return Promise.resolve();
    }
    async onReceive(params) {
        const envelope = params?.envelope;
        if (!envelope || typeof envelope !== 'object')
            return;
        const syncOnly = envelope.syncMessage && !envelope.dataMessage;
        if (syncOnly)
            return;
        const dm = envelope.dataMessage;
        if (!dm || typeof dm !== 'object')
            return;
        const text = typeof dm.message === 'string' ? dm.message.trim() : '';
        if (!text)
            return;
        const sourceNumber = typeof envelope.sourceNumber === 'string'
            ? envelope.sourceNumber
            : typeof envelope.source === 'string'
                ? envelope.source
                : '';
        const sourceUuid = typeof envelope.sourceUuid === 'string' ? envelope.sourceUuid : '';
        const gi = dm.groupInfo;
        const groupId = gi && typeof gi.groupId === 'string' ? gi.groupId : '';
        const candidates = [sourceNumber, sourceUuid, groupId].filter(Boolean);
        if (this.allowlist && !this.allowlist.isAnyAllowed(candidates)) {
            console.error(`[Signal] Not in allowlist (from=${sourceNumber}) — skipping`);
            return;
        }
        const senderDigits = digitsOnly(sourceNumber);
        if (this.ownDigits && senderDigits && senderDigits === this.ownDigits && !groupId) {
            return;
        }
        this.lastActivity = new Date();
        const recipientRef = groupId
            ? encodeSignalRecipient(null, groupId)
            : encodeSignalRecipient(sourceNumber || null, null);
        const display = (typeof dm.profileName === 'string' && dm.profileName.trim()) ||
            (groupId ? `Group ${groupId.slice(0, 8)}…` : sourceNumber || 'Signal');
        const incoming = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channel: 'signal',
            sender: recipientRef,
            senderName: display,
            content: text,
            timestamp: new Date(),
            raw: envelope,
        };
        if (!this.messageHandler) {
            console.error('[Signal] No messageHandler — dropping');
            return;
        }
        try {
            const reply = await this.messageHandler(incoming);
            if (reply && reply.trim()) {
                await this.send({ channel: 'signal', recipient: recipientRef, content: reply.trim() });
            }
        }
        catch (e) {
            console.error('[Signal] handler error:', e);
        }
    }
    rpcCall(method, params, timeoutMs = 120_000) {
        if (!this.proc?.stdin)
            return Promise.reject(new Error('signal-cli not running'));
        return new Promise((resolve, reject) => {
            const id = this.nextRpcId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const payload = JSON.stringify({ jsonrpc: '2.0', method, params, id });
            this.proc.stdin.write(payload + '\n', (err) => {
                if (err) {
                    this.pending.delete(id);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }
    async disconnect() {
        if (this.rl) {
            try {
                this.rl.close();
            }
            catch { }
            this.rl = null;
        }
        if (this.proc) {
            try {
                this.proc.kill('SIGTERM');
            }
            catch { }
            this.proc = null;
        }
        this.connected = false;
        this.allowlist?.dispose();
        this.allowlist = null;
    }
    async send(message) {
        const routing = decodeSignalRecipient(message.recipient);
        if (!routing || (!routing.phone && !routing.groupId)) {
            console.error('[Signal] send: invalid recipient ref');
            return false;
        }
        if (!this.proc?.stdin) {
            console.error('[Signal] send: not connected');
            return false;
        }
        const params = { message: message.content };
        if (routing.groupId)
            params.groupId = routing.groupId;
        else if (routing.phone) {
            const r = routing.phone.trim().startsWith('+') ? routing.phone.trim() : `+${digitsOnly(routing.phone)}`;
            params.recipient = [r];
        }
        else {
            return false;
        }
        try {
            await this.rpcCall('send', params);
            return true;
        }
        catch (e) {
            console.error('[Signal] send failed:', e instanceof Error ? e.message : e);
            return false;
        }
    }
    getStatus() {
        return {
            channel: 'signal',
            connected: this.connected && !!this.proc,
            error: this.error,
            lastActivity: this.lastActivity,
            metadata: {
                allowlistMode: this.allowlist?.get().mode ?? 'off',
                allowlistCount: this.allowlist?.get().senders.length ?? 0,
                cli: (process.env.SIGNAL_CLI_PATH || 'signal-cli').trim(),
            },
        };
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    manifest() {
        return {
            name: 'signal',
            displayName: 'Signal',
            version: '1.0.0',
            description: 'Signal channel for Vodou',
            author: 'Vodou AI',
            signed: true,
            requiredEnv: ['SIGNAL_PHONE_NUMBER'],
            optionalEnv: ['SIGNAL_CLI_PATH', 'SIGNAL_CLI_CONFIG'],
        };
    }
}
//# sourceMappingURL=signal.js.map