import { Router } from 'express';
import { getSetting, setSetting, getProjectRoot } from '../db.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
function getWsDir() {
    return path.join(getProjectRoot(), '.vodou', 'workspace');
}
function getPublicDir() {
    return path.resolve(__dirname, '..', '..', 'public');
}
function readMd(file) {
    try {
        return readFileSync(file, 'utf-8');
    }
    catch {
        return '';
    }
}
// tzdata-or-nothing: Intl throws on any name the runtime has no zone for,
// so what passes here is a zone every date computation can actually use.
export function isValidTimezone(tz) {
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
function extractMdField(content, key) {
    const boldMatch = content.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`, 'i'));
    if (boldMatch)
        return boldMatch[1].trim();
    const dashMatch = content.match(new RegExp(`^- ${key}:\\s*(.+)`, 'im'));
    if (dashMatch)
        return dashMatch[1].trim();
    return '';
}
function clean(v) {
    return v && !v.startsWith('(') && !v.startsWith('_') ? v : '';
}
/**
 * PLAN-CONTEXT-THAT-MAINTAINS-ITSELF P11.2 — carry the old files' values into
 * settings ONCE, so nobody's picker resets on the update that stops reading
 * them.
 *
 * Idempotent by construction: it only fills a setting that has no value yet, so
 * a later hand-edit in the picker always wins and re-running changes nothing.
 * Placeholders are skipped — `clean()` already rejects `(TBD)` and `_(pick…)`,
 * and §3.6 says an unknown field emits nothing rather than a blank.
 */
export function migrateNamesToSettings() {
    const wsDir = getWsDir();
    const fill = (key, value) => {
        if (!value)
            return;
        const existing = (getSetting(key) || '').trim();
        if (!existing)
            setSetting(key, value);
    };
    try {
        const userMd = readMd(path.join(wsDir, 'USER.md')); // WORKSPACE-MIGRATION-SOURCE: one-time carry into settings; retire archives the file
        fill('user.display_name', clean(extractMdField(userMd, 'What to call them') || extractMdField(userMd, 'Name')));
    }
    catch { /* no file, nothing to carry */ }
    try {
        const idMd = readMd(path.join(wsDir, 'IDENTITY.md')); // WORKSPACE-MIGRATION-SOURCE: one-time carry into settings; retire archives the file
        fill('ai_name', clean(extractMdField(idMd, 'Name')));
        fill('ai_vibe', clean(extractMdField(idMd, 'Vibe')));
        fill('ai_emoji', clean(extractMdField(idMd, 'Emoji')));
    }
    catch { /* no file, nothing to carry */ }
}
// GET /api/profile
router.get('/', (_req, res) => {
    // P11.2 — settings are the owner; the files are only a migration source.
    migrateNamesToSettings();
    res.json({
        userName: (getSetting('user.display_name') || '').trim(),
        pronouns: (getSetting('user.pronouns') || '').trim(),
        timezone: (getSetting('user.timezone') || '').trim(),
        userAvatar: getSetting('user_avatar') || '',
        aiName: (getSetting('ai_name') || '').trim() || 'Vodou',
        aiVibe: (getSetting('ai_vibe') || '').trim(),
        aiEmoji: (getSetting('ai_emoji') || '').trim(),
        aiAvatar: getSetting('ai_avatar') || '/icons/vodou-icon.png',
        aiAvatarColor: getSetting('ai_avatar_color') || '#6B7280',
    });
});
// POST /api/profile — update text fields
router.post('/', (req, res) => {
    const { userName, pronouns, timezone, aiName, aiVibe, aiEmoji, aiAvatarColor } = req.body;
    const wsDir = getWsDir();
    // P11.2 — writes go to the OWNER, not to a markdown file. USER.md and
    // IDENTITY.md are no longer written here; they are a one-time migration
    // source (see migrateNamesToSettings) and `workspace retire` archives them.
    //
    // Empty string is a deliberate CLEAR, not a placeholder: the setting is
    // emptied and the UI falls back to its default. Nothing writes "(TBD)"
    // anywhere ever again (§3.6) — that string, consumed by a model at trust
    // `policy`, is what this plan opened with.
    if (userName !== undefined)
        setSetting('user.display_name', String(userName || '').trim());
    if (pronouns !== undefined)
        setSetting('user.pronouns', String(pronouns || '').trim());
    if (timezone !== undefined) {
        const tz = String(timezone || '').trim();
        if (tz && isValidTimezone(tz))
            setSetting('user.timezone', tz);
        else if (!tz)
            setSetting('user.timezone', '');
    }
    if (aiName !== undefined)
        setSetting('ai_name', String(aiName || '').trim());
    if (aiVibe !== undefined)
        setSetting('ai_vibe', String(aiVibe || '').trim());
    if (aiEmoji !== undefined)
        setSetting('ai_emoji', String(aiEmoji || '').trim());
    if (aiAvatarColor !== undefined) {
        try {
            setSetting('ai_avatar_color', aiAvatarColor);
        }
        catch (e) {
            console.error('[Profile] ai_avatar_color save failed:', e);
        }
    }
    res.json({ ok: true });
});
// POST /api/profile/avatar — upload user avatar (base64 body)
router.post('/avatar', (req, res) => {
    const { data, ext } = req.body;
    if (!data) {
        res.status(400).json({ error: 'data required' });
        return;
    }
    const safeExt = (ext || 'png').replace(/[^a-zA-Z]/g, '').slice(0, 5).toLowerCase();
    const uploadsDir = path.join(getPublicDir(), 'uploads');
    if (!existsSync(uploadsDir))
        mkdirSync(uploadsDir, { recursive: true });
    try {
        const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const filename = `user-avatar.${safeExt}`;
        writeFileSync(path.join(uploadsDir, filename), buf);
        const urlPath = `/uploads/${filename}`;
        setSetting('user_avatar', urlPath);
        res.json({ ok: true, url: urlPath });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// POST /api/profile/ai-avatar — upload AI avatar (base64 body)
router.post('/ai-avatar', (req, res) => {
    const { data, ext } = req.body;
    if (!data) {
        res.status(400).json({ error: 'data required' });
        return;
    }
    const safeExt = (ext || 'png').replace(/[^a-zA-Z]/g, '').slice(0, 5).toLowerCase();
    const iconsDir = path.join(getPublicDir(), 'icons');
    if (!existsSync(iconsDir))
        mkdirSync(iconsDir, { recursive: true });
    try {
        const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const filename = `vodou-icon.${safeExt}`;
        writeFileSync(path.join(iconsDir, filename), buf);
        if (safeExt !== 'png')
            writeFileSync(path.join(iconsDir, 'vodou-icon.png'), buf);
        const urlPath = `/icons/${filename}`;
        setSetting('ai_avatar', urlPath);
        res.json({ ok: true, url: urlPath });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
export { router as profileRouter };
