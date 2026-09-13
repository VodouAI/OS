/**
 * PLAN-LOOPS-THAT-READ-THE-RECEIPTS P2 — the two queues the use ledger produces.
 *
 * *Load-bearing, never confirmed*: shown to a model ten or more times, never
 * once quoted back, and old enough that the silence means something.
 * *Disputed*: corrected more than once.
 *
 * Both ASK. Neither demotes, invalidates or deletes anything — decision §10.3,
 * queue-only until the correction detector's precision is measured. The only
 * action offered here is `mem correct`'s soft-invalidate, which the person
 * takes deliberately and can undo.
 *
 * Thin, like `api/loops.ts`: the engine owns memory.db and does the counting.
 */

import { Router, type Request, type Response } from 'express';
import { daemonRequest } from '../daemon-client.js';

export const queuesRouter: Router = Router();

/** GET /api/memory/queues — both queues, or a 503 that says the engine is down. */
queuesRouter.get('/', async (_req: Request, res: Response) => {
  const r = await daemonRequest('memory_queues', {}, 8_000);
  if (!r?.ok) {
    // A daemon that is down is not two empty queues. "Nothing to review" and
    // "could not look" are different answers and the page says which.
    res.status(503).json({ error: String(r?.reason ?? 'the engine did not answer'), queues: null });
    return;
  }
  res.json(r.data ?? { load_bearing: [], disputed: [] });
});
