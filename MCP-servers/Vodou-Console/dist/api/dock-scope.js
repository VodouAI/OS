/**
 * Dock scope API — PLAN-UNIFIED-PROJECT-SCOPE §2.5 (PLANS/0.6.26).
 *
 * Two routers, one idea: the SERVER decides what a project can see, and the
 * client reads booleans. That is what makes the unification real rather than a
 * shared helper that drifts — `scope.ts::scopeVisibility` is the only place the
 * §2.2 absence table exists, and everything here is a thin transport over it.
 *
 *   GET    /api/dock/visibility?project=<id>   — { scopes: {scope: bool}, defaultVisible }
 *   GET    /api/projects/:id/scopes            — { scopes: string[] }
 *   PUT    /api/projects/:id/scopes            — body { scopes: string[] }  (replace)
 *   POST   /api/projects/:id/scopes            — body { scope }             (pin one)
 *   DELETE /api/projects/:id/scopes/:scope     —                            (unpin one)
 *
 * The three mutating verbs are POST/PUT/DELETE and so are already covered by the
 * gateway's CSRF / cross-site write guard — no new auth surface.
 *
 * Lives in its own module rather than inline in index.ts so it can be mounted on a
 * bare express app in tests, the same way board.ts and workbench.ts are.
 */
import { Router } from 'express';
import { getGatewayDb } from '../db.js';
import { resolveScope, scopeVisibility, isVisibleIn } from '../scope.js';
import { listProjectScopes, setProjectScopes, pinScope, unpinScope, liveMembershipStores, getProject, } from '../projects-store.js';
import { getConversation, setConversationProject } from '../conversation-store.js';
export const dockRouter = Router();
export const projectScopesRouter = Router();
export const conversationProjectRouter = Router();
// ── PUT /api/conversations/:id/project ───────────────────────────────────────
//
// Move an OWNED surface (a chat, a skill console) to another project.
//
// Before this, `setConversationProject` had exactly two callers and both ran at
// CREATION time — so a conversation's project was decided once and could never
// be changed. That was survivable only because the dock showed every chat
// regardless. The moment filtering turns on it becomes a trap: a chat started in
// the wrong project disappears from the right one with no way back. A filter
// without a repair path is worse than no filter.
//
// Note this is the OWNED half of the model — one row, one owner. Shared surfaces
// are many-to-many and pin instead (see the routes above); they must never be
// moved through here.
conversationProjectRouter.put('/:id/project', (req, res) => {
    const convId = req.params.id;
    const raw = (req.body || {}).project_id;
    const projectId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    try {
        if (!getConversation(convId)) {
            res.status(404).json({ error: 'conversation not found' });
            return;
        }
        // A real id must exist; `null`/'proj_default' both mean Default, and
        // setConversationProject normalizes Default to NULL on the way in.
        if (projectId && projectId !== 'proj_default' && !getProject(projectId)) {
            res.status(400).json({ error: 'project not found' });
            return;
        }
        setConversationProject(convId, projectId);
        res.json({ ok: true, conversationId: convId, project_id: getConversation(convId)?.project_id ?? null });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
// ── GET /api/conversations/scoped-surfaces ───────────────────────────────────
//
// The pinnable surfaces, for the bulk editor in projects.js. Deliberately only
// the PINNED-mode types: chats and skill consoles are owned and move rather than
// pin (§2.2), and offering both in one checklist is how four mechanisms became
// confusable in the first place.
conversationProjectRouter.get('/scoped-surfaces', (_req, res) => {
    try {
        const db = getGatewayDb();
        const rows = db
            .prepare(
        // deleted_at is deliberately NOT filtered, for the same reason as
        // /dock/visibility above: every channel row on this install is
        // soft-deleted yet its tile is on screen. Filtering them out would offer
        // an editor listing none of the surfaces the user can actually see.
        `SELECT id, title FROM gateway_conversations
          WHERE id LIKE 'workbench:channel:%'
             OR id LIKE 'workbench:integration:%'
             OR id LIKE 'workbench:flow:%'
             OR id LIKE 'workbench:automation:%'
          ORDER BY id`)
            .all();
        res.json({ surfaces: rows.map((r) => ({ scope: r.id, title: r.title || r.id })) });
    }
    catch (e) {
        // Fail open with an empty list — the editor degrades to "no pinnable
        // surfaces yet" rather than blocking the whole project form.
        console.warn('[scoped-surfaces] failing open:', e.message);
        res.json({ surfaces: [] });
    }
});
// ── GET /api/dock/visibility ─────────────────────────────────────────────────
//
// A prefetched MAP rather than per-scope resolution, for a concrete reason:
// ScopeRegistry.resolve() is async (scope-registry.js:33), so it cannot be awaited
// inside a synchronous render loop over N dock tabs. One call, one map, sync filter.
dockRouter.get('/visibility', (req, res) => {
    const projectId = (typeof req.query.project === 'string' && req.query.project) || 'proj_default';
    try {
        const stores = liveMembershipStores();
        const db = getGatewayDb();
        // An id that names no project ⇒ everything visible (INV-3, and §5.3-B says
        // 200-all-visible rather than 404). This is not hypothetical: the active
        // project lives in localStorage, so archiving or deleting a project leaves
        // every open tab pointing at an id that no longer resolves. Without this,
        // those clients would keep a hollow dock — every OWNED chat filtered out,
        // only pinned surfaces left — which is precisely the "things silently
        // disappeared" failure this plan exists to prevent.
        const known = db
            .prepare('SELECT 1 FROM projects WHERE id = ?')
            .get(projectId);
        if (!known) {
            const all = {};
            for (const r of db
                .prepare(`SELECT id FROM gateway_conversations
            WHERE deleted_at IS NULL OR id LIKE 'workbench:%'`)
                .all()) {
                all[r.id] = true;
            }
            res.json({ project: projectId, scopes: all, defaultVisible: true, unknownProject: true });
            return;
        }
        // Everything the dock can render: live conversations + every pinned scope
        // (a scope can be pinned before its conversation row exists).
        //
        // `workbench:*` rows are included even when SOFT-DELETED, and that is not an
        // oversight. Verified live 2026-08-17: all five channel conversations
        // (slack/telegram/discord/whatsapp/imessage) carry deleted_at, yet their tiles
        // render in the dock — the messaging tier draws them from client tab state and
        // WorkbenchSurfaces, not from live rows. Excluding them left the map silent
        // about surfaces that are visibly on screen, so their verdict came from the
        // fail-open default rather than from the resolver. Correct today, but only by
        // accident: it would invert the moment defaultVisible changed. Ordinary chats
        // still honour deleted_at — a deleted chat is genuinely gone from the dock.
        const convs = db
            .prepare(`SELECT id FROM gateway_conversations
          WHERE deleted_at IS NULL OR id LIKE 'workbench:%'`)
            .all();
        const pinned = db
            .prepare('SELECT DISTINCT scope FROM project_scopes')
            .all();
        const scopes = {};
        for (const raw of [...convs.map((c) => c.id), ...pinned.map((p) => p.scope)]) {
            if (raw in scopes)
                continue;
            scopes[raw] = isVisibleIn(scopeVisibility(raw, stores), projectId);
        }
        res.json({ project: projectId, scopes, defaultVisible: true });
    }
    catch (e) {
        // INV-3: a failure shows MORE, never less. A 200 carrying an empty map plus
        // defaultVisible:true is indistinguishable, client-side, from "no filter" —
        // exactly the behaviour wanted when this endpoint is broken. A 500 here would
        // be a dock that renders nothing.
        console.warn('[dock/visibility] failing open:', e.message);
        res.json({ project: projectId, scopes: {}, defaultVisible: true, degraded: true });
    }
});
// ── /api/projects/:id/scopes ─────────────────────────────────────────────────
projectScopesRouter.get('/:id/scopes', (req, res) => {
    try {
        res.json({ scopes: listProjectScopes(req.params.id) });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
projectScopesRouter.put('/:id/scopes', (req, res) => {
    try {
        const raw = (req.body || {}).scopes;
        const list = Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
        // Reject anything that isn't a parseable workbench scope: a typo must not
        // become a permanent pin that hides a surface from every project but one.
        const bad = list.find((s) => !resolveScope(s));
        if (bad) {
            res.status(400).json({ error: `unparseable scope: ${bad}` });
            return;
        }
        res.json({ scopes: setProjectScopes(req.params.id, list) });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
projectScopesRouter.post('/:id/scopes', (req, res) => {
    const scope = String((req.body || {}).scope || '').trim();
    if (!resolveScope(scope)) {
        res.status(400).json({ error: 'unparseable scope' });
        return;
    }
    try {
        pinScope(req.params.id, scope);
        res.json({ ok: true, scopes: listProjectScopes(req.params.id) });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
projectScopesRouter.delete('/:id/scopes/:scope', (req, res) => {
    try {
        unpinScope(req.params.id, decodeURIComponent(req.params.scope));
        res.json({ ok: true, scopes: listProjectScopes(req.params.id) });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
});
