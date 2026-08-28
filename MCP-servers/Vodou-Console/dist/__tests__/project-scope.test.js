/**
 * PLAN-UNIFIED-PROJECT-SCOPE §5.3 — the rule table, the endpoint, and the client module.
 *
 * Four mechanisms used to answer "what project does this belong to", each giving a
 * different meaning to a MISSING record. Commit 121e5290 was that disagreement
 * surfacing as a bug. These tests exist so mechanism #5 cannot appear quietly.
 *
 * The client half loads the REAL shipped public/js/project-scope.js in a vm
 * sandbox and calls its actual methods — same idiom, and same reason, as
 * dock-grouping.test.ts:122: "A re-implementation here would validate intent, not
 * semantics — precisely the trap that shipped a broken query once already."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { scopeVisibility, isVisibleIn } from '../scope.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');
// Throwaway DB before anything imports db.js — resolveGatewayDbPath() reads this
// env var at first connection.
const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-project-scope-test-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');
afterAll(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
});
// ---------------------------------------------------------------------------
// A. The §2.2 absence table — pure, no DB
// ---------------------------------------------------------------------------
function stores(over = {}) {
    return {
        conversationProject: () => null,
        skillProjects: () => [],
        scopeProjects: () => [],
        ...over,
    };
}
const visIn = (raw, pid, s = stores()) => isVisibleIn(scopeVisibility(raw, s), pid);
describe('scopeVisibility — the §2.2 absence table', () => {
    it('owned chat with a project is visible only there', () => {
        const s = stores({ conversationProject: () => 'proj_x' });
        expect(visIn('conv-1', 'proj_x', s)).toBe(true);
        expect(visIn('conv-1', 'proj_default', s)).toBe(false);
    });
    it('owned chat with NO project means Default (mirrors conversation-store)', () => {
        // setConversationProject() WRITES NULL for proj_default, so absence really is
        // Default here rather than a guess.
        expect(visIn('conv-1', 'proj_default')).toBe(true);
        expect(visIn('conv-1', 'proj_x')).toBe(false);
    });
    it('owned skill console follows its conversation row', () => {
        const s = stores({ conversationProject: () => 'proj_966659d8' });
        expect(visIn('workbench:skill-console:daily-competitor-intel', 'proj_966659d8', s)).toBe(true);
        expect(visIn('workbench:skill-console:daily-competitor-intel', 'proj_default', s)).toBe(false);
    });
    it('unpinned automation is visible everywhere', () => {
        expect(visIn('workbench:automation:4', 'proj_a')).toBe(true);
        expect(visIn('workbench:automation:4', 'proj_b')).toBe(true);
    });
    it('pinned automation narrows to its projects', () => {
        const s = stores({ scopeProjects: () => ['proj_a'] });
        expect(visIn('workbench:automation:4', 'proj_a', s)).toBe(true);
        expect(visIn('workbench:automation:4', 'proj_b', s)).toBe(false);
    });
    // THE §1.4 TRAP. `workbench:automation:<id>` carries an `automations` row id;
    // project_tasks maps `scheduled_tasks` ids. Two AUTOINCREMENT sequences that
    // collide: automation 4 = mcp-ecosystem-watch, scheduled task 4 = vodou-heartbeat.
    // An earlier draft of the plan specified resolving automations through
    // project_tasks, which would file one under a DIFFERENT OBJECT's project.
    // This test exists so nobody re-wires it.
    it('an automation NEVER consults an owner map, even when ids collide', () => {
        const s = stores({ conversationProject: () => 'proj_zzz' }); // as a task map would answer
        expect(visIn('workbench:automation:4', 'proj_a', s)).toBe(true);
        expect(visIn('workbench:automation:4', 'proj_zzz', s)).toBe(true);
        expect(scopeVisibility('workbench:automation:4', s).mode).toBe('pinned');
    });
    it('a dangling automation id does not throw and stays visible', () => {
        // Live state: 5 pinned automation surfaces, only 2 of which still exist.
        expect(() => scopeVisibility('workbench:automation:9999', stores())).not.toThrow();
        expect(visIn('workbench:automation:9999', 'proj_a')).toBe(true);
    });
    it('pinned channel narrows, and supports many-to-many', () => {
        const one = stores({ scopeProjects: () => ['proj_a'] });
        expect(visIn('workbench:channel:slack', 'proj_a', one)).toBe(true);
        expect(visIn('workbench:channel:slack', 'proj_b', one)).toBe(false);
        const both = stores({ scopeProjects: () => ['proj_a', 'proj_b'] });
        expect(visIn('workbench:channel:slack', 'proj_a', both)).toBe(true);
        expect(visIn('workbench:channel:slack', 'proj_b', both)).toBe(true);
    });
    it('unpinned channel and integration are visible everywhere (INV-3)', () => {
        // The live install has 5 channels + 28 integrations with zero pins. If this
        // rule inverts, all of them vanish from every non-default project on day one.
        expect(visIn('workbench:channel:telegram', 'proj_a')).toBe(true);
        expect(visIn('workbench:integration:gmail', 'proj_b')).toBe(true);
    });
    it('skills read project_skills by NAME (INV-2 — dock and #/skills share a table)', () => {
        const s = stores({ skillProjects: (n) => (n === 'competitor-intel' ? ['proj_a'] : []) });
        expect(visIn('workbench:skill:competitor-intel', 'proj_a', s)).toBe(true);
        expect(visIn('workbench:skill:competitor-intel', 'proj_b', s)).toBe(false);
        expect(visIn('workbench:skill:other', 'proj_b', s)).toBe(true); // uncurated
    });
    it('a scope pinned only to an ARCHIVED project is still visible there', () => {
        // listProjects() excludes archived by default, so an archived-only pin is the
        // edge case that could make a surface unreachable (INV-1).
        const s = stores({ scopeProjects: () => ['proj_2895fd69'] });
        expect(visIn('workbench:channel:slack', 'proj_2895fd69', s)).toBe(true);
    });
    it('fails open on anything it does not understand (INV-3)', () => {
        for (const raw of ['workbench:surface:cli', 'workbench:bogus:1', '', null, undefined]) {
            expect(visIn(raw, 'proj_a')).toBe(true);
        }
    });
    it('heartbeat and board-chat are global infra', () => {
        expect(visIn('vodou-heartbeat', 'proj_a')).toBe(true);
        expect(visIn('board-chat', 'proj_a')).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// B/C. The endpoint + pinning round-trip
// ---------------------------------------------------------------------------
describe('GET /api/dock/visibility + pinning routes', () => {
    let app;
    let request;
    beforeAll(async () => {
        const { getGatewayDb } = await import('../db.js');
        const db = getGatewayDb();
        db.prepare(`INSERT OR IGNORE INTO projects (id, name, root_path) VALUES (?, ?, ?)`).run('proj_a', 'Alpha', CONSOLE_ROOT);
        db.prepare(`INSERT OR IGNORE INTO projects (id, name, root_path) VALUES (?, ?, ?)`).run('proj_b', 'Beta', CONSOLE_ROOT);
        const conv = db.prepare(`INSERT OR IGNORE INTO gateway_conversations (id, title, source, project_id) VALUES (?, ?, ?, ?)`);
        conv.run('chat-in-a', 'A chat', 'web', 'proj_a');
        conv.run('chat-untagged', 'Untagged chat', 'web', null);
        conv.run('workbench:channel:slack', 'Slack', 'channel', null);
        conv.run('workbench:integration:gmail', 'Gmail', 'integration', null);
        conv.run('workbench:automation:4', 'Automation 4', 'automation', null);
        conv.run('vodou-heartbeat', 'Heartbeat', 'heartbeat', null);
        // Same idiom as dock-grouping.test.ts / board-clear-scope.test.ts: mount the
        // real routers on a bare express app rather than booting the whole gateway.
        const express = (await import('express')).default;
        const { dockRouter, projectScopesRouter, conversationProjectRouter } = await import('../api/dock-scope.js');
        app = express();
        app.use(express.json());
        app.use('/api/dock', dockRouter);
        app.use('/api/projects', projectScopesRouter);
        app.use('/api/conversations', conversationProjectRouter);
        request = (await import('supertest')).default;
    });
    it('returns a boolean per known scope, with defaultVisible', async () => {
        const res = await request(app).get('/api/dock/visibility?project=proj_a').expect(200);
        expect(res.body.project).toBe('proj_a');
        expect(res.body.defaultVisible).toBe(true);
        expect(res.body.scopes['chat-in-a']).toBe(true);
        expect(res.body.scopes['chat-untagged']).toBe(false); // owned ⇒ Default only
        expect(res.body.scopes['workbench:channel:slack']).toBe(true); // unpinned ⇒ everywhere
        expect(res.body.scopes['workbench:automation:4']).toBe(true);
        expect(res.body.scopes['vodou-heartbeat']).toBe(true);
    });
    it('an unknown project id is all-visible and 200, not 404 (fail-open)', async () => {
        const res = await request(app).get('/api/dock/visibility?project=proj_nope').expect(200);
        for (const v of Object.values(res.body.scopes))
            expect(v).toBe(true);
    });
    // INV-4 — switching projects mutates NO server state.
    it('20 calls across projects change nothing in any table', async () => {
        const { getGatewayDb } = await import('../db.js');
        const db = getGatewayDb();
        const snap = () => ['gateway_conversations', 'project_tasks', 'project_skills', 'project_scopes']
            .map((t) => `${t}:${JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())}`)
            .join('|');
        const before = snap();
        for (let i = 0; i < 20; i++) {
            await request(app)
                .get('/api/dock/visibility?project=' + (i % 2 ? 'proj_a' : 'proj_b'))
                .expect(200);
        }
        expect(snap()).toBe(before);
    });
    it('pins, narrows, and unpins back to visible-everywhere (INV-5)', async () => {
        await request(app)
            .post('/api/projects/proj_a/scopes')
            .send({ scope: 'workbench:channel:slack' })
            .expect(200);
        // Idempotent on repeat.
        await request(app)
            .post('/api/projects/proj_a/scopes')
            .send({ scope: 'workbench:channel:slack' })
            .expect(200);
        let a = await request(app).get('/api/dock/visibility?project=proj_a').expect(200);
        let b = await request(app).get('/api/dock/visibility?project=proj_b').expect(200);
        expect(a.body.scopes['workbench:channel:slack']).toBe(true);
        expect(b.body.scopes['workbench:channel:slack']).toBe(false);
        await request(app)
            .delete('/api/projects/proj_a/scopes/' + encodeURIComponent('workbench:channel:slack'))
            .expect(200);
        // Unpin must RESTORE it everywhere, not hide it. This is the difference
        // between an escape hatch and a trap.
        a = await request(app).get('/api/dock/visibility?project=proj_a').expect(200);
        b = await request(app).get('/api/dock/visibility?project=proj_b').expect(200);
        expect(a.body.scopes['workbench:channel:slack']).toBe(true);
        expect(b.body.scopes['workbench:channel:slack']).toBe(true);
    });
    it('PUT replaces, and PUT [] returns the project to uncurated', async () => {
        await request(app)
            .put('/api/projects/proj_a/scopes')
            .send({ scopes: ['workbench:channel:slack', 'workbench:integration:gmail'] })
            .expect(200);
        let list = await request(app).get('/api/projects/proj_a/scopes').expect(200);
        expect(list.body.scopes).toHaveLength(2);
        await request(app).put('/api/projects/proj_a/scopes').send({ scopes: [] }).expect(200);
        list = await request(app).get('/api/projects/proj_a/scopes').expect(200);
        expect(list.body.scopes).toHaveLength(0);
        const b = await request(app).get('/api/dock/visibility?project=proj_b').expect(200);
        expect(b.body.scopes['workbench:channel:slack']).toBe(true);
    });
    // ── B3: moving an OWNED conversation between projects ──────────────────────
    // Before this route existed, setConversationProject ran only at creation, so a
    // mis-filed chat could never be repaired — and once the dock filters, it is
    // also invisible. A filter without a repair path is worse than no filter.
    it('moves an owned chat to another project and the verdict follows it', async () => {
        let a = await request(app).get('/api/dock/visibility?project=proj_a').expect(200);
        let b = await request(app).get('/api/dock/visibility?project=proj_b').expect(200);
        expect(a.body.scopes['chat-in-a']).toBe(true);
        expect(b.body.scopes['chat-in-a']).toBe(false);
        await request(app)
            .put('/api/conversations/chat-in-a/project')
            .send({ project_id: 'proj_b' })
            .expect(200);
        a = await request(app).get('/api/dock/visibility?project=proj_a').expect(200);
        b = await request(app).get('/api/dock/visibility?project=proj_b').expect(200);
        expect(a.body.scopes['chat-in-a']).toBe(false);
        expect(b.body.scopes['chat-in-a']).toBe(true);
        // move it back so later assertions see the fixture as seeded
        await request(app).put('/api/conversations/chat-in-a/project').send({ project_id: 'proj_a' }).expect(200);
    });
    it('moving to Default stores NULL (mirrors conversation-store) and shows under Default', async () => {
        await request(app)
            .put('/api/conversations/chat-in-a/project')
            .send({ project_id: 'proj_default' })
            .expect(200);
        const res = await request(app).get('/api/dock/visibility?project=proj_default').expect(200);
        expect(res.body.scopes['chat-in-a']).toBe(true);
        const { getGatewayDb } = await import('../db.js');
        const row = getGatewayDb().prepare('SELECT project_id FROM gateway_conversations WHERE id = ?').get('chat-in-a');
        expect(row.project_id).toBeNull();
        await request(app).put('/api/conversations/chat-in-a/project').send({ project_id: 'proj_a' }).expect(200);
    });
    it('refuses to move an unknown conversation or into an unknown project', async () => {
        await request(app).put('/api/conversations/no-such-conv/project').send({ project_id: 'proj_a' }).expect(404);
        await request(app).put('/api/conversations/chat-in-a/project').send({ project_id: 'proj_nope' }).expect(400);
        // the failed move changed nothing
        const a = await request(app).get('/api/dock/visibility?project=proj_a').expect(200);
        expect(a.body.scopes['chat-in-a']).toBe(true);
    });
    it('rejects an unparseable scope and writes nothing', async () => {
        await request(app)
            .put('/api/projects/proj_a/scopes')
            .send({ scopes: ['not-a-scope'] })
            .expect(400);
        const list = await request(app).get('/api/projects/proj_a/scopes').expect(200);
        expect(list.body.scopes).toHaveLength(0);
        await request(app).post('/api/projects/proj_a/scopes').send({ scope: 'garbage' }).expect(400);
    });
});
// ---------------------------------------------------------------------------
// D. The REAL ProjectScope client module, in a vm sandbox
// ---------------------------------------------------------------------------
/** Load the shipped project-scope.js and hand back its window.ProjectScope. */
function loadProjectScope(opts = {}) {
    const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/project-scope.js'), 'utf8');
    const store = new Map();
    if (opts.flag !== undefined)
        store.set('vodou.dockScope.v2', opts.flag);
    const sandbox = {
        console: { log() { }, error() { }, warn() { } },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => { store.delete(k); },
        },
        fetch: opts.fetchImpl || (async () => ({ ok: false })),
        CustomEvent: class {
            type;
            detail;
            constructor(t, o) { this.type = t; this.detail = o?.detail; }
        },
        setTimeout, clearTimeout,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.dispatchEvent = () => true;
    sandbox.addEventListener = () => { };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.ProjectScope;
}
describe('ProjectScope (real shipped module)', () => {
    // P4 retired the flag: UNSET now means ON. What must still work is the explicit
    // kill switch, because this feature's failure mode is silence rather than an error.
    it('the kill switch ("0") makes everything visible and fetches nothing', () => {
        let called = 0;
        const PS = loadProjectScope({ flag: '0', fetchImpl: async () => { called++; return { ok: false }; } });
        expect(PS.enabled()).toBe(false);
        expect(PS.visible('workbench:channel:slack')).toBe(true);
        expect(PS.visible('anything-at-all')).toBe(true);
        expect(called).toBe(0);
    });
    it('is ON by default after P4 retired the flag', () => {
        const PS = loadProjectScope({ fetchImpl: async () => ({ ok: false }) });
        expect(PS.enabled()).toBe(true);
    });
    it('returns true before the map has loaded (never hide during load)', () => {
        const PS = loadProjectScope({ flag: '1', fetchImpl: () => new Promise(() => { }) });
        expect(PS.visible('workbench:channel:slack')).toBe(true);
    });
    it('a rejected fetch fails open (INV-3)', async () => {
        const PS = loadProjectScope({ flag: '1', fetchImpl: async () => { throw new Error('boom'); } });
        await PS.ready();
        expect(PS.visible('workbench:channel:slack')).toBe(true);
    });
    it('malformed JSON fails open (INV-3)', async () => {
        const PS = loadProjectScope({ flag: '1', fetchImpl: async () => ({ ok: true, json: async () => 'nope' }) });
        await PS.refresh();
        expect(PS.visible('workbench:channel:slack')).toBe(true);
    });
    it('applies the server verdict when the map loads', async () => {
        const PS = loadProjectScope({
            flag: '1',
            fetchImpl: async () => ({
                ok: true,
                json: async () => ({ project: 'proj_a', scopes: { 'workbench:channel:slack': false }, defaultVisible: true }),
            }),
        });
        await PS.refresh();
        expect(PS.visible('workbench:channel:slack')).toBe(false);
        expect(PS.visible('a-scope-the-server-never-mentioned')).toBe(true); // defaultVisible
    });
    it('showAll() overrides every verdict (INV-5)', async () => {
        const PS = loadProjectScope({
            flag: '1',
            fetchImpl: async () => ({
                ok: true,
                json: async () => ({ project: 'proj_a', scopes: { 'workbench:channel:slack': false }, defaultVisible: true }),
            }),
        });
        await PS.refresh();
        expect(PS.visible('workbench:channel:slack')).toBe(false);
        PS.setShowAll(true);
        expect(PS.visible('workbench:channel:slack')).toBe(true);
        PS.setShowAll(false);
        expect(PS.visible('workbench:channel:slack')).toBe(false);
    });
    it('setActive() loads the new map BEFORE announcing the change', async () => {
        const seen = [];
        const PS = loadProjectScope({
            flag: '1',
            fetchImpl: async (url) => {
                seen.push('fetch:' + url);
                return { ok: true, json: async () => ({ project: 'proj_b', scopes: {}, defaultVisible: true }) };
            },
        });
        PS.onChange(() => seen.push('changed'));
        await PS.setActive('proj_b');
        expect(seen.filter((s) => s.startsWith('fetch:')).length).toBeGreaterThan(0);
        // The fetch must precede the announcement, or listeners render on a stale map.
        expect(seen.indexOf('changed')).toBeGreaterThan(seen.findIndex((s) => s.startsWith('fetch:')));
        expect(PS.active()).toBe('proj_b');
    });
});
// ---------------------------------------------------------------------------
// E. Dock filtering with the REAL shipped chat.js (§5.3-E)
// ---------------------------------------------------------------------------
/**
 * Load the shipped chat.js and drive its actual tier renderers. The point of
 * using the real file (dock-grouping.test.ts:122's rule) is that a
 * re-implementation would validate intent, not semantics — and the semantics
 * here are "does a surface disappear", which is the entire risk of this phase.
 */
function loadChatViewWithScope(scopes, flagOn) {
    const chatSrc = readFileSync(path.join(CONSOLE_ROOT, 'public/js/views/chat.js'), 'utf8');
    const psSrc = readFileSync(path.join(CONSOLE_ROOT, 'public/js/project-scope.js'), 'utf8');
    const store = new Map();
    store.set('vodou.activeProject', 'proj_a');
    // P4: unset now means ON, so "off" has to be written explicitly.
    store.set('vodou.dockScope.v2', flagOn ? '1' : '0');
    const made = [];
    const mkEl = () => {
        const el = {
            children: [], className: '', style: {}, textContent: '', innerHTML: '',
            classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
            appendChild(c) { this.children.push(c); return c; },
            querySelectorAll: () => [], querySelector: () => null,
            addEventListener() { }, setAttribute() { }, getAttribute: () => null,
            append() { }, remove() { }, get childElementCount() { return this.children.length; },
        };
        made.push(el);
        return el;
    };
    const sandbox = {
        console: { log() { }, error() { }, warn() { } },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => { store.delete(k); },
        },
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: mkEl, body: mkEl() },
        setTimeout, clearTimeout, setInterval, clearInterval,
        // The REAL ProjectScope fetches its map; hand it the server's answer.
        fetch: async () => ({ ok: true, json: async () => ({ project: 'proj_a', scopes, defaultVisible: true }) }),
        requestAnimationFrame: (fn) => fn(),
        CustomEvent: class {
            type;
            detail;
            constructor(t, o) { this.type = t; this.detail = o?.detail; }
        },
        WorkbenchSurfaces: { list: () => [] },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.dispatchEvent = () => true;
    sandbox.addEventListener = () => { };
    vm.createContext(sandbox);
    // BOTH shipped files, in the order index.html loads them. No stub stands in
    // for the module under test — a stubbed `visible()` would silently skip the
    // module's own "flag off ⇒ true" short-circuit, which is exactly the behaviour
    // the flag-off case exists to prove.
    vm.runInContext(psSrc, sandbox);
    vm.runInContext(chatSrc + '\n;globalThis.__ChatView = ChatView;', sandbox);
    return { ChatView: sandbox.__ChatView, mkEl, ProjectScope: sandbox.window.ProjectScope };
}
describe('dock tiers filter through ProjectScope (real shipped chat.js + real project-scope.js)', () => {
    const entries = [
        { scope: 'workbench:channel:slack', title: 'Slack', kind: 'workbench' },
        { scope: 'workbench:channel:telegram', title: 'Telegram', kind: 'workbench' },
        { scope: 'workbench:integration:gmail', title: 'Gmail', kind: 'workbench' },
        { scope: 'workbench:skill:growth-hacker', title: 'growth-hacker', kind: 'workbench' },
    ];
    async function renderTiers(scopes, flagOn = true) {
        const { ChatView, mkEl, ProjectScope } = loadChatViewWithScope(scopes, flagOn);
        await ProjectScope.ready();
        const messaging = mkEl();
        const apps = mkEl();
        const skills = mkEl();
        const tabBar = mkEl();
        Object.assign(ChatView, {
            _messagingTabBar: messaging, _integrationTabBar: apps, _skillsTabBar: skills, _tabBar: tabBar,
            _tabs: [], _messagingTierWrap: null, _appsTierWrap: null, _skillsTierWrap: null,
            _sortTabsStable: () => [], _isChannelConversationTab: () => false,
            _syncTierCollapsedFromLs() { }, _updateDockOverflow: null,
        });
        ChatView._renderMessagingTier(entries);
        ChatView._renderAppsTier(entries);
        return { messaging: messaging.children.length, apps: apps.children.length, skills: skills.children.length };
    }
    it('shows everything when nothing is pinned (uncurated ⇒ visible, INV-3)', async () => {
        expect(await renderTiers({})).toEqual({ messaging: 2, apps: 1, skills: 1 });
    });
    it('hides only what the server says is hidden', async () => {
        const r = await renderTiers({ 'workbench:channel:slack': false });
        expect(r).toEqual({ messaging: 1, apps: 1, skills: 1 }); // telegram survives
    });
    it('P2: the Skills tier filters too, not just messaging/apps', async () => {
        const r = await renderTiers({ 'workbench:skill:growth-hacker': false });
        expect(r).toEqual({ messaging: 2, apps: 1, skills: 0 });
    });
    // The pre-flight for shipping dark: with the flag OFF the dock must render as
    // it always did, even when the server's verdict says hide everything.
    it('the kill switch ignores every verdict and renders the full dock', async () => {
        const hideAll = { 'workbench:channel:slack': false, 'workbench:channel:telegram': false,
            'workbench:integration:gmail': false, 'workbench:skill:growth-hacker': false };
        expect(await renderTiers(hideAll, false)).toEqual({ messaging: 2, apps: 1, skills: 1 });
        // …and the SAME verdicts with it enabled DO filter, so the switch is what differs.
        expect(await renderTiers(hideAll, true)).toEqual({ messaging: 0, apps: 0, skills: 0 });
    });
});
