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
import { Router } from 'express';
import { getOnboardingProgress, setOnboardingFlag, resetOnboarding, isOnboardingKey, getSetting, getGatewayDb, getBoardDb, getDb, } from '../db.js';
/**
 * Current capability inventory (names) for the "what's new" nudge. The client
 * snapshots this and diffs on later visits to surface newly-added apps/skills.
 * Defensive: any query failure → empty list (no false "new" items).
 */
function capabilityInventory() {
    let servers = [];
    let skills = [];
    try {
        servers = getDb().prepare('SELECT name FROM mcp_servers ORDER BY name').all()
            .map((r) => r.name).filter(Boolean);
    }
    catch { /* table may not exist yet */ }
    try {
        skills = getDb().prepare('SELECT name FROM skills_registry ORDER BY name').all()
            .map((r) => r.name).filter(Boolean);
    }
    catch { /* noop */ }
    return { servers, skills };
}
const router = Router();
/**
 * Server-computed checklist signals (Layer B). Each returns a boolean from a
 * real source. Defensive: any query failure → false (the item just stays open).
 * Once true, a sticky `onboarding.checklist.<id>` flag is written so the item
 * stays checked even if the underlying data is later deleted (you learned it).
 */
function computeServerChecklist() {
    const out = {};
    // Sent a real message (a user-role row in the chat history).
    out.send_first_message = (() => {
        if (getSetting('onboarding.checklist.send_first_message'))
            return true;
        try {
            const row = getGatewayDb()
                .prepare("SELECT 1 FROM gateway_messages WHERE role = 'user' LIMIT 1")
                .get();
            return !!row;
        }
        catch {
            return false;
        }
    })();
    // Ran (or created) at least one Board task.
    out.run_board_task = (() => {
        if (getSetting('onboarding.checklist.run_board_task'))
            return true;
        try {
            const bdb = getBoardDb();
            if (!bdb)
                return false;
            const row = bdb.prepare('SELECT 1 FROM tasks LIMIT 1').get();
            return !!row;
        }
        catch {
            return false;
        }
    })();
    // Completed the guided tour.
    out.take_the_tour = !!getSetting('onboarding.tour.completed_at');
    // Persist sticky flags for the data-derived items so they never un-check.
    for (const id of ['send_first_message', 'run_board_task']) {
        if (out[id] && !getSetting(`onboarding.checklist.${id}`)) {
            try {
                setOnboardingFlag(`onboarding.checklist.${id}`, new Date().toISOString());
            }
            catch { /* noop */ }
        }
    }
    return out;
}
/** Shape the flat `onboarding.*` map into the client's contract. */
function shapeProgress(raw) {
    const get = (k) => raw[k] ?? null;
    const subset = (prefix) => {
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            if (k.startsWith(prefix))
                out[k.slice(prefix.length)] = v;
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
router.get('/', (_req, res) => {
    try {
        res.json(shapeProgress(getOnboardingProgress()));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/onboarding/progress/capabilities — current app/skill inventory (names)
// for the client's "what's new since your last visit" diff.
router.get('/capabilities', (_req, res) => {
    try {
        res.json(capabilityInventory());
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/onboarding/progress/checklist — server-computed completion signals
// for the data-derived items. Client merges its own (⌘K, channel-connected, …).
router.get('/checklist', (_req, res) => {
    try {
        res.json({ server: computeServerChecklist() });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// PUT /api/onboarding/progress  { key, value }
router.put('/', (req, res) => {
    const { key, value } = (req.body ?? {});
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
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/onboarding/progress/reset — replay (discovery only; setup untouched)
router.post('/reset', (_req, res) => {
    try {
        const cleared = resetOnboarding();
        res.json({ ok: true, cleared, message: 'Onboarding tips reset — they will show again.' });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export { router as onboardingProgressRouter };
