/**
 * Gateway-only Signal outbound — spawns `signal-cli send` (no jsonRpc session).
 * Matches WhatsApp/iMessage pattern: standalone Vodou-channels owns receive loop.
 */
import { spawn } from 'child_process';
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
function digitsOnly(s) {
    return (s || '').replace(/\D/g, '');
}
export function sendSignalCliMessage(cliPath, account, configDir, recipientEnc, text) {
    const routing = decodeSignalRecipient(recipientEnc);
    if (!routing || (!routing.phone && !routing.groupId))
        return Promise.resolve(false);
    const cli = (cliPath || 'signal-cli').trim();
    const args = [];
    if (configDir?.trim()) {
        args.push('--config', configDir.trim());
    }
    args.push('-a', account.trim(), 'send', '-m', text);
    if (routing.groupId) {
        args.push('-g', routing.groupId);
    }
    else if (routing.phone) {
        const r = routing.phone.trim().startsWith('+') ? routing.phone.trim() : `+${digitsOnly(routing.phone)}`;
        args.push(r);
    }
    else {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const proc = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (b) => {
            err += b.toString();
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                console.error('[Gateway] Signal send failed:', code, err.trim());
            }
            resolve(code === 0);
        });
        proc.on('error', (e) => {
            console.error('[Gateway] Signal spawn error:', e.message);
            resolve(false);
        });
    });
}
