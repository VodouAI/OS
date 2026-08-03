/**
 * Workbench API — per-scope instructions + metadata for scoped workbenches.
 *
 * Instructions are stored as a single key-value entry in gateway_settings
 * (key: `workbench_instructions:<scope.raw>`) and injected into the system
 * prompt of any conversation whose scope matches. This is the MVP backing —
 * will migrate to pinned memories when PLAN-UNIFIED-MEMORY-GRID lands.
 */

import { Router, Request, Response } from 'express';
import { getSetting, setSetting } from '../db.js';
import { resolveScope } from '../scope.js';
import { ensureConversation, loadSkillWorkbenches } from '../conversation-store.js';

const router = Router();

// POST /api/workbench/ensure { scope, title? }
// Idempotent — creates a conversation with id == scope.raw if it doesn't exist.
router.post('/ensure', (req: Request, res: Response) => {
  const { scope: rawScope, title } = req.body || {};
  const scope = resolveScope(rawScope);
  if (!scope) {
    res.status(400).json({ error: 'scope is required and must start with "workbench:"' });
    return;
  }
  // Deterministic: id === source === scope.raw (see plan §2).
  ensureConversation(scope.raw, title || scope.id, scope.raw);
  res.json({ ok: true, conversationId: scope.raw, scope: scope.raw });
});

// GET /api/workbench/skills — every expert-persona workbench that exists,
// newest first. The dock's Skills tier seeds its (client-only) surface list
// from this so personas survive a cleared localStorage / new browser profile.
router.get('/skills', (_req: Request, res: Response) => {
  try {
    const skills = loadSkillWorkbenches().map((c) => ({
      scope: c.id,
      // `title` is the skill name as it was when the workbench was created;
      // fall back to parsing the scope so a null title never renders as blank.
      title: c.title || c.id.slice('workbench:skill:'.length),
      updatedAt: c.updated_at,
    }));
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Validate a raw scope string and return the normalized key, or null. */
function scopeKey(rawScope: string | undefined): string | null {
  if (!rawScope) return null;
  const scope = resolveScope(rawScope);
  if (!scope) return null;
  return `workbench_instructions:${scope.raw}`;
}

// GET /api/workbench/instructions?scope=workbench:integration:linear
router.get('/instructions', (req: Request, res: Response) => {
  const rawScope = typeof req.query.scope === 'string' ? req.query.scope : '';
  const key = scopeKey(rawScope);
  if (!key) {
    res.status(400).json({ error: 'scope is required and must start with "workbench:"' });
    return;
  }
  const content = getSetting(key) || '';
  res.json({ scope: rawScope, content });
});

// POST /api/workbench/instructions { scope, content }
router.post('/instructions', (req: Request, res: Response) => {
  const { scope: rawScope, content } = req.body || {};
  const key = scopeKey(rawScope);
  if (!key) {
    res.status(400).json({ error: 'scope is required and must start with "workbench:"' });
    return;
  }
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' });
    return;
  }
  // 8KB cap — instructions are always-on system-prompt overhead; keep them lean.
  if (content.length > 8000) {
    res.status(400).json({ error: 'content exceeds 8000 character limit' });
    return;
  }
  setSetting(key, content);
  res.json({ ok: true, scope: rawScope });
});

export { router as workbenchRouter };
