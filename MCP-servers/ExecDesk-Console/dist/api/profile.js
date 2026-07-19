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
function extractMdField(content, key) {
    const boldMatch = content.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`, 'i'));
    if (boldMatch)
        return boldMatch[1].trim();
    const dashMatch = content.match(new RegExp(`^- ${key}:\\s*(.+)`, 'im'));
    if (dashMatch)
        return dashMatch[1].trim();
    return '';
}
function patchMdField(content, key, value) {
    const boldRe = new RegExp(`(\\*\\*${key}:\\*\\*\\s*)(.+)`, 'i');
    if (boldRe.test(content))
        return content.replace(boldRe, `$1${value}`);
    const dashRe = new RegExp(`^(- ${key}:\\s*)(.*)`, 'im');
    if (dashRe.test(content))
        return content.replace(dashRe, `$1${value}`);
    return content.trimEnd() + `\n- **${key}:** ${value}\n`;
}
function clean(v) {
    return v && !v.startsWith('(') && !v.startsWith('_') ? v : '';
}
// GET /api/profile
router.get('/', (_req, res) => {
    const wsDir = getWsDir();
    const userMd = readMd(path.join(wsDir, 'USER.md'));
    const idMd = readMd(path.join(wsDir, 'IDENTITY.md'));
    res.json({
        userName: clean(extractMdField(userMd, 'What to call them') || extractMdField(userMd, 'Name')),
        pronouns: clean(extractMdField(userMd, 'Pronouns')),
        timezone: clean(extractMdField(userMd, 'Timezone')),
        userAvatar: getSetting('user_avatar') || '',
        aiName: clean(extractMdField(idMd, 'Name')) || 'Vodou',
        aiVibe: clean(extractMdField(idMd, 'Vibe')),
        aiEmoji: clean(extractMdField(idMd, 'Emoji')),
        aiAvatar: getSetting('ai_avatar') || '/icons/vodou-icon.png',
        aiAvatarColor: getSetting('ai_avatar_color') || '#6B7280',
    });
});
// POST /api/profile — update text fields
router.post('/', (req, res) => {
    const { userName, pronouns, timezone, aiName, aiVibe, aiEmoji, aiAvatarColor } = req.body;
    const wsDir = getWsDir();
    if (userName !== undefined || pronouns !== undefined || timezone !== undefined) {
        try {
            const userPath = path.join(wsDir, 'USER.md');
            let md = readMd(userPath);
            if (userName !== undefined) {
                md = patchMdField(md, 'What to call them', userName || 'User');
                md = patchMdField(md, 'Name', userName || 'User');
            }
            if (pronouns !== undefined)
                md = patchMdField(md, 'Pronouns', pronouns || '(TBD)');
            if (timezone !== undefined)
                md = patchMdField(md, 'Timezone', timezone || '(TBD)');
            writeFileSync(userPath, md, 'utf-8');
        }
        catch (e) {
            console.error('[Profile] USER.md write failed:', e);
        }
    }
    if (aiName !== undefined || aiVibe !== undefined || aiEmoji !== undefined) {
        try {
            const idPath = path.join(wsDir, 'IDENTITY.md');
            let md = readMd(idPath);
            if (aiName !== undefined)
                md = patchMdField(md, 'Name', aiName || 'Vodou');
            if (aiVibe !== undefined)
                md = patchMdField(md, 'Vibe', aiVibe || '');
            if (aiEmoji !== undefined)
                md = patchMdField(md, 'Emoji', aiEmoji || '(none)');
            writeFileSync(idPath, md, 'utf-8');
        }
        catch (e) {
            console.error('[Profile] IDENTITY.md write failed:', e);
        }
    }
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
