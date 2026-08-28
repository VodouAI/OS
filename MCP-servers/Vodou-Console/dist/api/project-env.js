/**
 * Project root `.env` — read/write with structure from `.env.example`.
 * Secrets are masked on GET; POST only updates keys the UI knows about.
 */
import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../db.js';
import { resolveEnvDescription } from './env-field-help.js';
export const projectEnvRouter = Router();
const KEY_LINE = /^#?\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;
const SECTION_DIV = /^#\s*={20,}/;
const TRAILING_INLINE_COMMENT = /\s+#.*$/;
function isSecretKey(key) {
    const u = key.toUpperCase();
    const neverMask = new Set(['VODOU_USER_ID', 'TELEGRAM_ADMIN_ID', 'DISCORD_GUILD_ID']);
    if (neverMask.has(u))
        return false;
    if (/_API_KEY$/i.test(key) || /^[A-Z][A-Z0-9_]*_KEY$/i.test(key))
        return true;
    if (/_TOKEN$/i.test(key) || /_BOT_TOKEN$/i.test(key) || u === 'VODOU_TOKEN' || u === 'GH_TOKEN')
        return true;
    if (/_SECRET$/i.test(key) || /SIGNING_SECRET/i.test(u))
        return true;
    if (/PASSWORD|COOKIE|WEBHOOK|CREDENTIAL|PRIVATE/i.test(u))
        return true;
    return false;
}
function maskKey(val) {
    if (!val || val.length < 8)
        return val ? '***' : '';
    return val.substring(0, 7) + '...' + val.substring(val.length - 4);
}
function parseEnvExample(examplePath) {
    if (!existsSync(examplePath))
        return [];
    const lines = readFileSync(examplePath, 'utf8').split(/\r?\n/);
    const sections = [];
    let current = { title: 'General', keys: [] };
    let pendingDesc = [];
    let afterDivider = false;
    function pushCurrent() {
        if (current.keys.length)
            sections.push(current);
    }
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line)
            continue;
        if (SECTION_DIV.test(line)) {
            // `.env.example` writes a section header as a SANDWICH:
            //
            //     # =====================
            //     # SECTION NAME
            //     # =====================
            //
            // The opening divider collected "SECTION NAME" into pendingDesc — and the
            // CLOSING divider then threw it away, because this branch unconditionally
            // reset pendingDesc. The section was left title-less, so the keyMatch
            // branch below filled it with the first KEY's description instead. That is
            // why every section on Settings -> Environment was titled
            // "VODOU_TOKEN -- Your Vodou cloud API token from https://app.vodou.ai..."
            // rather than "Account" — every section, since the page shipped.
            //
            // Carry the pending name across the closing divider. A single-divider
            // section (no sandwich) is unaffected: afterDivider is false there, so
            // nothing is carried and the old first-comment-wins path still applies.
            const carriedTitle = afterDivider && pendingDesc.length ? pendingDesc[0] : '';
            pushCurrent();
            current = { title: carriedTitle, keys: [] };
            afterDivider = true;
            pendingDesc = [];
            continue;
        }
        const keyMatch = line.match(KEY_LINE);
        if (keyMatch) {
            if (afterDivider && current.title === '' && pendingDesc.length) {
                current.title = pendingDesc[0];
                const blurb = pendingDesc.slice(1).join('\n').trim();
                pendingDesc = blurb ? [blurb] : [];
            }
            afterDivider = false;
            const key = keyMatch[1];
            let val = (keyMatch[2] ?? '').trim();
            val = val.replace(TRAILING_INLINE_COMMENT, '').trim();
            const desc = pendingDesc.join('\n').trim();
            pendingDesc = [];
            current.keys.push({ key, description: desc, exampleHint: val });
            continue;
        }
        if (line.startsWith('#')) {
            pendingDesc.push(line.replace(/^#\s?/, ''));
        }
    }
    pushCurrent();
    if (!sections.length && current.keys.length === 0)
        return [];
    return sections;
}
function parseDotEnv(filePath) {
    const m = new Map();
    if (!existsSync(filePath))
        return m;
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const exportStripped = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eq = exportStripped.indexOf('=');
        if (eq <= 0)
            continue;
        const k = exportStripped.slice(0, eq).trim();
        if (!/^[A-Z][A-Z0-9_]*$/.test(k))
            continue;
        let v = exportStripped.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))) {
            const q = v[0];
            v = v.slice(1, -1);
            v = v.replace(new RegExp(`\\\\${q}`, 'g'), q);
        }
        m.set(k, v);
    }
    return m;
}
function collectAllowedKeys(sections) {
    const s = new Set();
    for (const sec of sections)
        for (const k of sec.keys)
            s.add(k.key);
    return s;
}
function formatEnvValue(val) {
    if (val === '')
        return '';
    if (/[\s#"'\n\\]/.test(val)) {
        const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return `"${escaped}"`;
    }
    return val;
}
function applyPatchToEnvFile(envPath, patch, allowed) {
    const keysToSet = Object.entries(patch).filter(([k]) => allowed.has(k));
    if (!keysToSet.length)
        return;
    let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const lines = content.length ? content.split(/\r?\n/) : [];
    const keyToIndex = new Map();
    const keyExported = new Map();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw || raw.startsWith('#'))
            continue;
        const exported = raw.startsWith('export ');
        const ex = exported ? raw.slice(7).trim() : raw;
        const eq = ex.indexOf('=');
        if (eq <= 0)
            continue;
        const k = ex.slice(0, eq).trim();
        if (/^[A-Z][A-Z0-9_]*$/.test(k) && !keyToIndex.has(k)) {
            keyToIndex.set(k, i);
            keyExported.set(k, exported);
        }
    }
    const appended = [];
    for (const [key, value] of keysToSet) {
        if (!allowed.has(key))
            continue;
        const exp = keyExported.get(key) ?? false;
        const line = (exp ? 'export ' : '') + `${key}=${formatEnvValue(value)}`;
        const idx = keyToIndex.get(key);
        if (idx !== undefined)
            lines[idx] = line;
        else
            appended.push(line);
    }
    let out = lines.join('\n');
    if (appended.length) {
        if (out && !out.endsWith('\n'))
            out += '\n';
        out += '\n# Added via gateway Environment settings\n' + appended.join('\n') + '\n';
    }
    writeFileSync(envPath, out, 'utf8');
}
projectEnvRouter.get('/', (_req, res) => {
    try {
        const root = getProjectRoot();
        const examplePath = path.join(root, '.env.example');
        const envPath = path.join(root, '.env');
        const sections = parseEnvExample(examplePath);
        const allowed = collectAllowedKeys(sections);
        const values = parseDotEnv(envPath);
        const extraKeys = [...values.keys()].filter((k) => !allowed.has(k)).sort();
        if (extraKeys.length) {
            sections.push({
                title: 'Other (in your .env but not in .env.example)',
                keys: extraKeys.map((key) => ({
                    key,
                    description: 'Defined locally; not documented in the shipped example file.',
                    exampleHint: '',
                })),
            });
            for (const k of extraKeys)
                allowed.add(k);
        }
        const payload = {
            envPath: '.env',
            restartNote: 'Changes save automatically after you pause typing. Most values need a full restart (gateway, worker, daemon) to apply; use the restart strips on this page. VODOU_SHOW_RAW_RESULTS and DEBUG hot-reload in the gateway when saved.',
            sections: sections.map((sec) => ({
                title: sec.title || 'General',
                items: sec.keys.map((pk) => {
                    const raw = values.get(pk.key) ?? '';
                    const secret = isSecretKey(pk.key);
                    return {
                        key: pk.key,
                        description: resolveEnvDescription(pk.key, pk.description),
                        exampleDefault: pk.exampleHint || undefined,
                        isSecret: secret,
                        value: secret ? '' : raw,
                        maskedPreview: secret && raw ? maskKey(raw) : undefined,
                        hasValue: Boolean(raw),
                    };
                }),
            })),
        };
        res.json(payload);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: msg });
    }
});
projectEnvRouter.post('/', (req, res) => {
    try {
        const root = getProjectRoot();
        const examplePath = path.join(root, '.env.example');
        const envPath = path.join(root, '.env');
        const sections = parseEnvExample(examplePath);
        const allowed = collectAllowedKeys(sections);
        const values = parseDotEnv(envPath);
        for (const k of values.keys())
            if (!allowed.has(k))
                allowed.add(k);
        const patch = req.body?.patch;
        if (!patch || typeof patch !== 'object') {
            res.status(400).json({ error: 'Expected JSON body { patch: { KEY: "value", ... } }' });
            return;
        }
        const effective = {};
        for (const [k, raw] of Object.entries(patch)) {
            if (typeof raw !== 'string' || !allowed.has(k))
                continue;
            if (isSecretKey(k) && raw.trim() === '')
                continue;
            effective[k] = raw;
        }
        if (Object.keys(effective).length === 0) {
            res.json({ ok: true, message: 'No changes applied (empty secret fields keep existing values).' });
            return;
        }
        if (existsSync(envPath)) {
            try {
                copyFileSync(envPath, envPath + '.gateway-bak');
            }
            catch {
                /* ignore backup failure */
            }
        }
        applyPatchToEnvFile(envPath, effective, allowed);
        const hotKeys = new Set(['VODOU_SHOW_RAW_RESULTS', 'DEBUG']);
        for (const [k, v] of Object.entries(effective)) {
            if (hotKeys.has(k))
                process.env[k] = v;
        }
        const savedKeys = Object.keys(effective);
        const maskedPreview = {};
        for (const k of savedKeys) {
            if (isSecretKey(k))
                maskedPreview[k] = maskKey(effective[k]);
        }
        res.json({
            ok: true,
            message: 'Saved to .env. Restart gateway and worker for most variables to take effect.',
            savedKeys,
            maskedPreview: Object.keys(maskedPreview).length ? maskedPreview : undefined,
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: msg });
    }
});
