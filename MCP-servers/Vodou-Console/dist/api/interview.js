/**
 * PLAN-CONTEXT-THAT-MAINTAINS-ITSELF P1.6 — the interview.
 *
 * Three thin routes over the daemon. Deliberately thin: the question text, the
 * branch logic and the skip state all live in Rust (`src/interview.rs`), served
 * from here rather than duplicated in TypeScript. Two spellings of one contract
 * is how F4 happened — the heartbeat editor wrote a file nothing read for
 * months because two places disagreed about which file that was.
 *
 * This file owns NO markup. The redesign owns Chat's empty state; it calls
 * these.
 */
import { Router } from 'express';
import net from 'net';
import path from 'path';
import { getProjectRoot, setSetting } from '../db.js';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { upsertContinuityIdentityEnv, withEnvLock } from './onboarding.js';
const execFileAsync = promisify(execFile);
import { sockConnectTarget } from '../cli-portability.js';
export const interviewRouter = Router();
function callDaemon(cmd, payload, timeoutMs = 15000) {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    const request = JSON.stringify({ cmd, payload }) + '\n';
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) {
            settled = true;
            resolve(v);
        } };
        const c = net.createConnection({ path: sockConnectTarget(sockPath) }, () => c.end(request));
        c.setTimeout(timeoutMs);
        let data = '';
        c.on('data', (b) => { data += b.toString(); });
        const finish = () => {
            try {
                done(JSON.parse(data.trim()));
            }
            catch {
                done({ ok: false, error: 'daemon returned unparseable JSON' });
            }
        };
        c.on('end', finish);
        c.on('close', finish);
        c.on('error', (e) => done({ ok: false, error: `daemon unreachable: ${e.message}` }));
        c.on('timeout', () => { try {
            c.destroy();
        }
        catch { /* noop */ } done({ ok: false, error: 'daemon timed out' }); });
    });
}
// GET /api/interview/next → { key, question, section, portable, remaining } | null
//
// `null` means the interview is over. The caller renders NOTHING for that — no
// "all done" placeholder, no empty card (§3.6).
interviewRouter.get('/next', async (_req, res) => {
    const r = await callDaemon('interview_next', {});
    if (!r?.ok) {
        res.status(502).json({ error: r?.error || 'daemon did not answer' });
        return;
    }
    res.json(r.data ?? null);
});
// POST /api/interview/answer { key, text }
//
// The answer is pinned in the user's OWN words — never paraphrased first — and
// a non-portable question's answer (people, boundaries) is marked private so it
// does not leave for another AI host by default (Q1d).
interviewRouter.post('/answer', async (req, res) => {
    const key = String(req.body?.key ?? '').trim();
    const text = String(req.body?.text ?? '').trim();
    if (!key) {
        res.status(400).json({ error: 'key required' });
        return;
    }
    if (text.length < 2) {
        res.status(400).json({ error: 'answer too short' });
        return;
    }
    const r = await callDaemon('interview_answer', { key, text });
    if (!r?.ok) {
        res.status(502).json({ error: r?.error || 'could not record the answer' });
        return;
    }
    // P11.2 — some answers also own a gateway setting (the user's display name,
    // the assistant's name). The ENGINE returns the key and never writes it:
    // gateway.db has an owner and the engine is not it (lane canon rule 4). A UI
    // needs a field, not prose — pin text is deduplicated and merged, so it is
    // not a name lookup.
    // Q1a — the wizard no longer collects the name, so the continuity
    // self-identity it used to seed is seeded HERE, when the name is answered:
    // `VODOU_USER_NAME` in .env and `continuity update-self --name`. Both were
    // previously the wizard's job; both are best-effort and never fail the answer.
    if (key === 'a_name' && text) {
        try {
            const root = getProjectRoot();
            const envPath = path.join(root, '.env');
            await withEnvLock(() => {
                let envContent = '';
                if (fs.existsSync(envPath))
                    envContent = fs.readFileSync(envPath, 'utf-8');
                envContent = upsertContinuityIdentityEnv(envContent, text, '');
                fs.writeFileSync(envPath, envContent);
                try {
                    fs.chmodSync(envPath, 0o600);
                }
                catch { /* best-effort */ }
            });
            await execFileAsync(path.join(root, 'vodou-core'), ['continuity', 'update-self', '--name', text], { cwd: root, timeout: 20000 });
        }
        catch (e) {
            console.error('[interview] continuity identity (non-fatal):', e.message);
        }
    }
    if (r.data?.setting && typeof r.data.setting === 'string') {
        try {
            setSetting(r.data.setting, String(r.data.setting_value ?? '').trim());
        }
        catch (e) {
            // The answer is already recorded; a failed setting write must not read as
            // "your answer was lost". Say which half failed.
            console.error('[interview] setting write failed:', e.message);
            res.json({ ...r.data, setting_written: false });
            return;
        }
    }
    res.json({ ...r.data, setting_written: !!r.data?.setting });
});
// POST /api/interview/skip { key }
//
// Records that it was offered and declined. Emits no fact of any kind.
interviewRouter.post('/skip', async (req, res) => {
    const key = String(req.body?.key ?? '').trim();
    if (!key) {
        res.status(400).json({ error: 'key required' });
        return;
    }
    const r = await callDaemon('interview_skip', { key });
    if (!r?.ok) {
        res.status(502).json({ error: r?.error || 'could not record the skip' });
        return;
    }
    res.json(r.data);
});
