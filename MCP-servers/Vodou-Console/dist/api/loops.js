/**
 * PLAN-COMMITMENTS-LANE P3 — the open-loops list, for the console.
 *
 * Thin by design: every read and every action goes to the daemon's `open_loops`
 * op, which is the one place `done` / `snooze` / `drop` are applied. The console
 * does not open vodou-core.db (the engine owns it, lane canon rule 4) and does
 * not re-implement what a control word means — the channel reply, the CLI and
 * this list all land in the same Rust function.
 */
import { Router } from 'express';
import { daemonRequest } from '../daemon-client.js';
export const loopsRouter = Router();
/** GET /api/loops?open=1 — the list, newest due first. */
loopsRouter.get('/', async (req, res) => {
    const onlyOpen = String(req.query.open ?? '1') !== '0';
    const r = await daemonRequest('open_loops', { action: 'list', only_open: onlyOpen }, 6_000);
    if (!r?.ok) {
        // A daemon that is down is not an empty list. Saying "no open loops" here
        // would be the absence-shaped lie this plan's grader exists to prevent.
        res.status(503).json({ error: String(r?.reason ?? 'daemon unavailable'), loops: null });
        return;
    }
    const loops = r.data?.loops ?? [];
    res.json({ loops });
});
/** POST /api/loops/:id/:action — done | snooze | drop. Body: { when? } */
loopsRouter.post('/:id/:action', async (req, res) => {
    const id = Number(req.params.id);
    const action = String(req.params.action);
    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'bad loop id' });
        return;
    }
    if (!['done', 'close', 'snooze', 'drop'].includes(action)) {
        res.status(400).json({ error: `unknown action ${action}` });
        return;
    }
    const when = typeof req.body?.when === 'string' ? req.body.when : '';
    const r = await daemonRequest('open_loops', { action, id, when, by: 'button' }, 8_000);
    if (!r?.ok) {
        res.status(409).json({ error: String(r?.reason ?? 'could not apply') });
        return;
    }
    res.json({ ok: true, message: r.data?.message ?? 'Done.' });
});
