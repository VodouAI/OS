import { watch, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
export function allowlistPathForChannel(projectRoot, channel) {
    return join(projectRoot, '.vodou', 'channels', `${channel}-allowlist.json`);
}
export function readAllowlist(path) {
    try {
        if (!existsSync(path))
            return { mode: 'off', senders: [] };
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.mode === 'on' || parsed.mode === 'off') && Array.isArray(parsed.senders)) {
            return parsed;
        }
        return { mode: 'off', senders: [] };
    }
    catch {
        return { mode: 'off', senders: [] };
    }
}
export function isAllowed(config, senderId, normalize) {
    if (config.mode === 'off')
        return true;
    const normalized = normalize(senderId);
    return config.senders.some(e => normalize(e.id) === normalized);
}
export class AllowlistWatcher {
    config = { mode: 'off', senders: [] };
    watcher = null;
    path;
    normalize;
    constructor(projectRoot, channel, normalize) {
        this.path = allowlistPathForChannel(projectRoot, channel);
        this.normalize = normalize;
        this.reload();
        this.startWatch();
    }
    reload() {
        this.config = readAllowlist(this.path);
    }
    startWatch() {
        const dir = join(this.path, '..');
        try {
            mkdirSync(dir, { recursive: true });
        }
        catch { }
        try {
            this.watcher = watch(dir, (_event, filename) => {
                if (filename && this.path.endsWith(filename))
                    this.reload();
            });
        }
        catch { }
    }
    isAllowed(senderId) {
        return isAllowed(this.config, senderId, this.normalize);
    }
    getConfig() {
        return this.config;
    }
    destroy() {
        this.watcher?.close();
    }
}
// Channel-specific normalizers
export function normalizeImessageHandle(raw) {
    if (!raw)
        return '';
    const trimmed = raw.trim().toLowerCase();
    if (/^\+?\d/.test(trimmed) && !/@/.test(trimmed))
        return trimmed.replace(/\D/g, '');
    return trimmed;
}
export function normalizeWhatsappHandle(raw) {
    if (!raw)
        return '';
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.includes('@g.us'))
        return trimmed;
    return trimmed.split('@')[0].replace(/\D/g, '');
}
export function normalizeSlackHandle(raw) {
    return (raw || '').trim().toLowerCase();
}
export function normalizeDiscordHandle(raw) {
    if (!raw)
        return '';
    const trimmed = raw.trim().replace(/^@/, '').toLowerCase();
    if (/^\d{15,25}$/.test(trimmed))
        return trimmed;
    return trimmed.split('#')[0];
}
export function normalizeTelegramHandle(raw) {
    if (!raw)
        return '';
    const trimmed = raw.trim().replace(/^@/, '').toLowerCase();
    if (/^-?\d+$/.test(trimmed))
        return trimmed;
    return trimmed;
}
export function normalizeTeamsHandle(raw) {
    return (raw || '').trim().toLowerCase();
}
export function normalizeGoogleChatHandle(raw) {
    return (raw || '').trim().toLowerCase();
}
export function normalizeSignalHandle(raw) {
    if (!raw)
        return '';
    const t = raw.trim();
    if (/^[\d+\-().\s]+$/.test(t) && t.replace(/\D/g, '').length >= 10)
        return t.replace(/\D/g, '');
    return t.toLowerCase();
}
//# sourceMappingURL=allowlist.js.map