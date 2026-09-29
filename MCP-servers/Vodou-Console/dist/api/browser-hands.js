/**
 * Browser Hands API (PLAN-BROWSER-HANDS §14.3, §6.4).
 *
 *   GET  /api/browser-hands/status        the doctor's last result (ok/degraded/absent/unknown)
 *   POST /api/browser-hands/check         re-run the doctor now
 *   GET  /api/browser-hands/tasks/:id     a task's receipt: the task and every step
 *
 * Read-mostly and local: the gateway's host/origin guards apply as to every /api route.
 */
import { Router } from 'express';
import { browserHandsStatus, browserTaskReceipt } from '../browser-hands/service.js';
import { browserHandsEnabled } from '../browser-hands/flag.js';
export const browserHandsRouter = Router();
browserHandsRouter.get('/status', async (_req, res) => {
    try {
        res.json({ enabled: browserHandsEnabled(), ...(await browserHandsStatus(false)) });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
browserHandsRouter.post('/check', async (_req, res) => {
    try {
        res.json({ enabled: browserHandsEnabled(), ...(await browserHandsStatus(true)) });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
browserHandsRouter.get('/tasks/:id', (req, res) => {
    const r = browserTaskReceipt(String(req.params.id));
    if (!r) {
        res.status(404).json({ error: 'no such task' });
        return;
    }
    res.json(r);
});
