/**
 * GET /api/capture/sites?days=N — the per-site capture table for the console.
 * PLAN-CAPTURE-GRADED-PER-SITE §3.6 (Connect → Browser).
 *
 * One grader, one spelling: the verdict function lives in Rust
 * (`src/capture_cmd.rs`, with a fixture per cell), and this route shells to
 * `vodou-core capture --json` rather than re-deriving the words in TypeScript.
 * Two implementations of "broken" is how a console and a CLI end up disagreeing
 * about the same row (COHERENCE, the seam rule). Read-only, no daemon.
 */
import { Router } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../db.js';
export const captureSitesRouter = Router();
captureSitesRouter.get('/sites', (req, res) => {
    const days = Math.min(Math.max(parseInt(String(req.query.days || '7'), 10) || 7, 1), 30);
    const root = getProjectRoot();
    const bin = process.env.VODOU_CORE_BIN
        ?? path.join(root, process.platform === 'win32' ? 'vodou-core.exe' : 'vodou-core');
    if (!fs.existsSync(bin)) {
        res.status(503).json({ ok: false, error: { code: 'NO_ENGINE', message: 'vodou-core binary not found at ' + bin } });
        return;
    }
    execFile(bin, ['capture', '--json', '--days', String(days)], { cwd: root, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        // Exit 2 is "reported and red" (a broken site with history), not a failure:
        // the JSON is complete and the console shows the red row. Only a missing
        // or malformed report is an error.
        let report = null;
        try {
            report = stdout ? JSON.parse(stdout) : null;
        }
        catch {
            report = null;
        }
        if (!report) {
            const msg = (stderr || (err && err.message) || 'capture produced no report').toString().trim();
            res.status(503).json({ ok: false, error: { code: 'CAPTURE_UNAVAILABLE', message: msg.slice(0, 500) } });
            return;
        }
        res.json({ ok: true, data: report });
    });
});
