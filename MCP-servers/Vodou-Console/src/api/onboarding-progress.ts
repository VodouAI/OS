/**
 * Progressive-onboarding progress API — the feature-discovery tour / checklist /
 * coachmark state. Distinct from src/api/onboarding.ts, which handles first-run
 * SETUP (account, LLM, identity). This router only persists DISCOVERY progress so
 * the tour can be resumed and replayed across reloads.
 *
 * Storage: gateway_settings under the `onboarding.*` namespace (install-global).
 * Routes (mounted at /api/onboarding/progress):
 *   GET    /                → structured { tour, checklist, coach, raw }
 *   PUT    /                → body { key, value } (onboarding.* keys only)
 *   POST   /reset           → clear all onboarding.* flags (NOT identity/EULA/creds)
 *
 * Cross-site writes are already blocked by the global CSRF guard in index.ts.
 * See PLANS/0.6.9/PLAN-PROGRESSIVE-ONBOARDING.md.
 */

import { Router, Request, Response } from 'express';
import { getFunnelSummary } from '../funnel.js';
import {
  getOnboardingProgress,
  setOnboardingFlag,
  resetOnboarding,
  isOnboardingKey,
  getSetting,
  getGatewayDb,
  getBoardDb,
  getDb,
} from '../db.js';

/**
 * Capabilities that arrive with the BUILD rather than as a row in a table.
 *
 * The what's-new diff was born reading `mcp_servers` and `skills_registry`, which
 * covers everything a user adds and nothing we ship. That gap has a cost the
 * browser extension made concrete: the extension is distributed through the
 * Chrome Web Store, so `./vodou-core` updating does not install it, and the only
 * place that ever mentions it is the onboarding step — which an existing user,
 * having credentials and an identity and a configured LLM, is never shown again.
 * A user who updated into the extension release had no surface anywhere that
 * said the extension exists.
 *
 * Entries are deliberately STATIC, not derived from live state. Deriving from
 * "is the extension connected right now" would re-fire the nudge for anyone who
 * installs it and later removes it, which is a different sentence than "new since
 * your last visit". Whether the user already has it is the client's call at toast
 * time; whether this build HAS the capability is this list's call.
 *
 * Adding an entry nudges every existing install exactly once. That is the whole
 * point, and also the reason not to add one for a change nobody has to act on.
 */
const BUILD_FEATURES: ReadonlyArray<{ id: string; label: string; href: string }> = [
  {
    id: 'browser-extension',
    label: 'Vodou Bridge browser extension',
    // Settings rather than the store: that section explains the capture consent,
    // shows whether the extension has connected, and (since this release) carries
    // the install link itself. A toast that fires straight into an external store
    // page skips the consent the extension is gated on.
    href: '#/settings?tab=memory&section=bridge',
  },
];

/**
 * Current capability inventory (names) for the "what's new" nudge. The client
 * snapshots this and diffs on later visits to surface newly-added apps/skills.
 * Defensive: any query failure → empty list (no false "new" items).
 */
function capabilityInventory(): {
  servers: string[];
  skills: string[];
  features: Array<{ id: string; label: string; href: string }>;
} {
  let servers: string[] = [];
  let skills: string[] = [];
  try {
    servers = (getDb().prepare('SELECT name FROM mcp_servers ORDER BY name').all() as Array<{ name: string }>)
      .map((r) => r.name).filter(Boolean);
  } catch { /* table may not exist yet */ }
  try {
    skills = (getDb().prepare('SELECT name FROM skills_registry ORDER BY name').all() as Array<{ name: string }>)
      .map((r) => r.name).filter(Boolean);
  } catch { /* noop */ }
  // Spread so a caller mutating the response cannot edit the module constant.
  return { servers, skills, features: BUILD_FEATURES.map((f) => ({ ...f })) };
}

const router = Router();

/**
 * Server-computed checklist signals (Layer B). Each returns a boolean from a
 * real source. Defensive: any query failure → false (the item just stays open).
 * Once true, a sticky `onboarding.checklist.<id>` flag is written so the item
 * stays checked even if the underlying data is later deleted (you learned it).
 */
function computeServerChecklist(): Record<string, boolean> {
  const out: Record<string, boolean> = {};

  // Sent a real message (a user-role row in the chat history).
  out.send_first_message = (() => {
    if (getSetting('onboarding.checklist.send_first_message')) return true;
    try {
      const row = getGatewayDb()
        .prepare("SELECT 1 FROM gateway_messages WHERE role = 'user' LIMIT 1")
        .get();
      return !!row;
    } catch { return false; }
  })();

  // Ran (or created) at least one Board task.
  out.run_board_task = (() => {
    if (getSetting('onboarding.checklist.run_board_task')) return true;
    try {
      const bdb = getBoardDb();
      if (!bdb) return false;
      const row = bdb.prepare('SELECT 1 FROM tasks LIMIT 1').get();
      return !!row;
    } catch { return false; }
  })();

  // Completed the guided tour.
  out.take_the_tour = !!getSetting('onboarding.tour.completed_at');

  // Persist sticky flags for the data-derived items so they never un-check.
  for (const id of ['send_first_message', 'run_board_task']) {
    if (out[id] && !getSetting(`onboarding.checklist.${id}`)) {
      try { setOnboardingFlag(`onboarding.checklist.${id}`, new Date().toISOString()); } catch { /* noop */ }
    }
  }
  return out;
}

/** Shape the flat `onboarding.*` map into the client's contract. */
function shapeProgress(raw: Record<string, string>) {
  const get = (k: string) => raw[k] ?? null;
  const subset = (prefix: string) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
    return out;
  };
  return {
    tour: {
      offeredAt: get('onboarding.tour.offered_at'),
      completedAt: get('onboarding.tour.completed_at'),
      lastChapter: Number(get('onboarding.tour.last_chapter') ?? 0) || 0,
    },
    checklist: {
      dismissedAt: get('onboarding.checklist.dismissed_at'),
      items: subset('onboarding.checklist.'), // itemId → ISO done-at (minus dismissed_at handled by client)
    },
    coach: subset('onboarding.coach.'), // viewId_seen_at → ISO
    raw,
  };
}

// GET /api/onboarding/progress
/**
 * PLAN-EXECUTION-SHELF-FUNNEL §5 — the activation funnel for THIS install.
 *
 * Local-only, owner-readable, nine timestamps. Deliberately a sibling of the tour
 * progress rather than part of it: the tour records what the user was SHOWN, this
 * records what they actually DID, and conflating them is how a checklist starts
 * being mistaken for adoption.
 */
router.get('/funnel', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, data: getFunnelSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.get('/', (_req: Request, res: Response) => {
  try {
    res.json(shapeProgress(getOnboardingProgress()));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/onboarding/progress/capabilities — current app/skill inventory (names)
// for the client's "what's new since your last visit" diff.
router.get('/capabilities', (_req: Request, res: Response) => {
  try {
    res.json(capabilityInventory());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/onboarding/progress/checklist — server-computed completion signals
// for the data-derived items. Client merges its own (⌘K, channel-connected, …).
router.get('/checklist', (_req: Request, res: Response) => {
  try {
    res.json({ server: computeServerChecklist() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/onboarding/progress  { key, value }
router.put('/', (req: Request, res: Response) => {
  const { key, value } = (req.body ?? {}) as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || !isOnboardingKey(key)) {
    res.status(400).json({ error: 'key must be a string in the onboarding.* namespace' });
    return;
  }
  if (value != null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    res.status(400).json({ error: 'value must be a string, number, boolean, or null' });
    return;
  }
  try {
    setOnboardingFlag(key, value == null ? '' : String(value));
    res.json({ ok: true, key, value: value == null ? '' : String(value) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/onboarding/progress/reset — replay (discovery only; setup untouched)
router.post('/reset', (_req: Request, res: Response) => {
  try {
    const cleared = resetOnboarding();
    res.json({ ok: true, cleared, message: 'Onboarding tips reset — they will show again.' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as onboardingProgressRouter };
