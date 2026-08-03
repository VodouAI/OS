/**
 * Presence registry — PLAN-PRESENCE-DOCK (0.6.18) Phase A.
 *
 * Computes a live "what's running" snapshot across every LLM context Vodou
 * touches: gateway/CLI conversations, channel threads, captured browser tabs
 * (via the vbb bridge), autonomous runs (heartbeat/board/skill consoles), and
 * IDE capture lanes. Aggregation only — no DB tables, no new probes; every
 * field reuses a source of truth that already exists:
 *
 *   conversations  → conversation-store (gateway.db, updated_at recency)
 *   streaming/idle → presenceOnStreamEvent(), hooked into streamToConversation
 *   browser tabs   → getBridge().listTabs() (TTL-cached) + webcap:* convs
 *   IDE lanes      → captureLanesForPresence() (daemon heartbeat meta)
 *
 * Browser-tab ↔ memory identity (plan §4, server-side "B-lite"): capture
 * already persists web turns under `webcap:<provider>:<convToken>` where the
 * token is the provider's own conversation id — the same id that appears in
 * the tab URL. So a tab whose URL contains that token merges into the captured
 * session with a stable id, no extension changes required. Tabs with no
 * captured conversation yet get an ephemeral `web:<provider>:tab:<tabId>` id
 * that upgrades in place (replacesId) once capture creates the webcap row.
 *
 * Privacy rule (plan §9 risk 4): only tabs on known AI hosts are ever listed.
 * Non-AI tabs never enter the snapshot, connected bridge or not.
 */
import { Router } from 'express';
import { loadConversations, getConversation, } from './conversation-store.js';
import { getBridge, bridgeStatus } from './vbb/bridge.js';
import { captureLanesForPresence } from './api/memory-capture.js';
export const LIVE_WINDOW_MS = 15 * 60 * 1000; // "live" badge window
export const VISIBLE_WINDOW_MS = 24 * 60 * 60 * 1000; // presence is *now*, not history
const ACTIVE_DECAY_MS = 2 * 60 * 1000; // stream silence → back to idle
const TABS_TTL_MS = 15_000; // never hammer the extension
const SNAPSHOT_TTL_MS = 5_000;
// ── AI-host map (mirror of the extension manifest's capture surfaces) ────────
// Only these hosts may appear as browser sessions. Key = host suffix match.
const AI_HOSTS = [
    ['chatgpt.com', 'chatgpt'],
    ['chat.openai.com', 'chatgpt'],
    ['claude.ai', 'claude'],
    ['gemini.google.com', 'gemini'],
    ['aistudio.google.com', 'aistudio'],
    ['notebooklm.google.com', 'notebooklm'],
    ['perplexity.ai', 'perplexity'],
    ['grok.com', 'grok'],
    ['chat.deepseek.com', 'deepseek'],
    ['copilot.microsoft.com', 'copilot'],
    ['chat.mistral.ai', 'mistral'],
    ['meta.ai', 'meta'],
    ['manus.im', 'manus'],
    ['kimi.com', 'kimi'],
    ['chat.qwen.ai', 'qwen'],
    ['poe.com', 'poe'],
    ['duckduckgo.com', 'duckai'],
    ['huggingface.co', 'huggingchat'],
    ['you.com', 'you'],
    ['t3.chat', 't3'],
    ['openrouter.ai', 'openrouter'],
    ['character.ai', 'characterai'],
];
// Channel adapters post per-user conversations as `channel:<sender>`; the
// source column carries the platform name (telegram/slack/...).
const AUTONOMOUS_SOURCES = new Set(['heartbeat', 'board', 'board-task', 'skill-console']);
export function providerForHost(host) {
    const h = host.toLowerCase().replace(/^www\./, '');
    for (const [suffix, provider] of AI_HOSTS) {
        if (h === suffix || h.endsWith(`.${suffix}`))
            return provider;
    }
    return null;
}
/** Extract the provider conversation token from a chat URL, normalized the
 *  same way handleCaptureTurn's safeToken() normalizes it for webcap ids. */
export function convTokenFromUrl(url) {
    let path;
    try {
        path = new URL(url).pathname;
    }
    catch {
        return null;
    }
    // uuid anywhere in the path (ChatGPT /c/<uuid>, Claude /chat/<uuid>, ...)
    const uuid = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const raw = uuid ? uuid[0] : (path.match(/\/(?:c|chat|conversation)\/([\w-]{6,})/) || [])[1];
    if (!raw)
        return null;
    const t = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    return t || null;
}
/** Map a stored conversation to a presence session skeleton, or null when the
 *  row isn't a session (imports, manual snippets, byok capture buffers). */
export function classifyConversation(c) {
    const source = c.source || '';
    // Capture buffers that aren't live sessions.
    if (c.id.startsWith('import:') || source.startsWith('import:'))
        return null;
    if (c.id.startsWith('manual:') || source.startsWith('capture:manual:'))
        return null;
    // BYOK app teed conversations are API traffic, not attended sessions — v2 candidate.
    if (c.id.startsWith('byok:'))
        return null;
    const scope = { vault: null, projectId: c.project_id ?? null };
    if (c.id.startsWith('webcap:') || source.startsWith('capture:web:')) {
        const parts = c.id.split(':'); // webcap:<provider>:<convToken>
        const provider = parts[1] || 'web';
        const token = parts.slice(2).join(':') || 'session';
        return {
            session: {
                id: `web:${provider}:${token}`,
                surface: 'browser',
                provider,
                title: c.title || `Web · ${provider}`,
                capture: 'on',
                injectable: provider === 'chatgpt' ? 'body-rewrite' : 'composer',
                memoryScope: scope,
                detail: { convId: c.id },
            },
        };
    }
    if (c.id.startsWith('channel:')) {
        return {
            session: {
                id: `ch:${c.id}`,
                surface: 'channel',
                provider: source || 'channel',
                title: c.sender_name ? `${c.sender_name} · ${source || 'channel'}` : (c.title || c.id),
                capture: 'on', // channel turns flow through the gateway extractor
                injectable: 'full',
                memoryScope: scope,
                detail: { convId: c.id },
            },
        };
    }
    if (c.id === 'vodou-heartbeat' || c.id === 'board-chat' || AUTONOMOUS_SOURCES.has(source)) {
        const kind = c.id === 'vodou-heartbeat' ? 'heartbeat'
            : c.id === 'board-chat' || source === 'board' || source === 'board-task' ? 'board'
                : 'skill';
        return {
            kind,
            session: {
                id: `auto:${kind}:${c.id}`,
                surface: 'autonomous',
                provider: kind,
                title: c.title || kind,
                capture: c.id === 'vodou-heartbeat' ? 'n/a' : 'on', // extractor excludes vodou-heartbeat
                injectable: 'none',
                memoryScope: scope,
                detail: { convId: c.id, kind },
            },
        };
    }
    // vodou-cli stamps no source; its fixed title is the only marker today.
    // (If session.ts ever stamps source='cli', prefer that.)
    const isCli = source === 'cli' || c.title === 'Vodou CLI';
    return {
        session: {
            id: `${isCli ? 'cli' : 'gw'}:${c.id}`,
            surface: isCli ? 'cli' : 'gateway',
            provider: 'vodou',
            title: c.title || 'Chat',
            capture: 'on', // gateway conversations feed the extractor
            injectable: 'full',
            memoryScope: scope,
            detail: { convId: c.id },
        },
    };
}
const liveMarks = new Map();
const lastEmittedState = new Map();
let broadcastFn = null;
/** index.ts hands us its clients-broadcast once at boot. */
export function setPresenceBroadcaster(fn) {
    broadcastFn = fn;
}
const ACTIVE_TYPES = new Set([
    'chunk', 'status', 'tool_start', 'tool_end', 'tool_result', 'usage',
    'thinking_start', 'thinking_step', 'thinking_complete',
    'heartbeat_pulse', 'heartbeat_activity', 'channel_user_message',
]);
const CLEAR_TYPES = new Set(['done', 'error', 'stopped', 'cleared']);
/** Reducer for stream events → live state. Pure; exported for tests. */
export function reduceStreamEvent(prev, type, now) {
    if (type === 'approval_requested')
        return { state: 'awaiting_approval', at: now };
    if (CLEAR_TYPES.has(type))
        return null; // explicit end → drop mark
    if (ACTIVE_TYPES.has(type)) {
        // approval hold survives ordinary activity until resolved/cleared
        if (prev?.state === 'awaiting_approval')
            return { state: 'awaiting_approval', at: now };
        return { state: 'active', at: now };
    }
    return undefined; // unknown type → no change
}
/**
 * Called (cheaply) from streamToConversation for every streamed event, and
 * from the channel inbound path. Broadcasts presence_update ONLY on a state
 * transition for a classifiable conversation.
 */
export function presenceOnStreamEvent(convId, type) {
    try {
        const t = typeof type === 'string' ? type : '';
        if (!t)
            return;
        const now = Date.now();
        const next = reduceStreamEvent(liveMarks.get(convId), t, now);
        if (next === undefined)
            return;
        if (next === null)
            liveMarks.delete(convId);
        else
            liveMarks.set(convId, next);
        const session = sessionForConversation(convId, now);
        if (!session)
            return;
        if (lastEmittedState.get(convId) === session.state)
            return;
        lastEmittedState.set(convId, session.state);
        broadcastFn?.({ type: 'presence_update', session });
    }
    catch { /* presence must never break the stream path */ }
}
function stateForConv(convId, updatedAtMs, now) {
    const mark = liveMarks.get(convId);
    if (mark && now - mark.at <= ACTIVE_DECAY_MS) {
        return mark.state === 'awaiting_approval' ? 'awaiting_approval' : 'active';
    }
    return now - updatedAtMs <= LIVE_WINDOW_MS ? 'idle' : 'stale';
}
function actionsFor(surface, state) {
    const acts = ['open'];
    if (surface === 'gateway' || surface === 'cli' || surface === 'channel') {
        acts.push('send');
        if (state === 'active')
            acts.push('stop');
    }
    if (surface === 'browser')
        acts.push('inject');
    if (surface === 'autonomous') {
        if (state === 'awaiting_approval')
            acts.push('approve');
        if (state === 'active' || state === 'running')
            acts.push('stop');
    }
    if (surface === 'ide')
        return ['view-memory'];
    acts.push('view-memory');
    return acts;
}
function finishSession(cls, updatedAtIso, now) {
    const convId = String(cls.session.detail?.convId || '');
    const updatedMs = Date.parse(updatedAtIso.includes('T') ? updatedAtIso : updatedAtIso.replace(' ', 'T') + 'Z') || now;
    let state = stateForConv(convId, updatedMs, now);
    if (cls.session.surface === 'autonomous' && state === 'active')
        state = 'running';
    const mark = liveMarks.get(convId);
    const lastMs = mark && now - mark.at <= ACTIVE_DECAY_MS ? mark.at : updatedMs;
    return {
        ...cls.session,
        state,
        lastActivity: new Date(lastMs).toISOString(),
        actions: actionsFor(cls.session.surface, state),
    };
}
function sessionForConversation(convId, now) {
    const c = getConversation(convId);
    if (!c)
        return null;
    const cls = classifyConversation(c);
    if (!cls)
        return null;
    return finishSession(cls, c.updated_at, now);
}
let tabsCache = { at: 0, tabs: [] };
async function listAiTabs() {
    const now = Date.now();
    if (now - tabsCache.at < TABS_TTL_MS)
        return tabsCache.tabs;
    const bridge = getBridge();
    if (!bridge) {
        tabsCache = { at: now, tabs: [] };
        return [];
    }
    try {
        const tabs = (await bridge.listTabs(''));
        // Privacy rule: AI hosts only — non-AI tabs never enter presence.
        const ai = (tabs || []).filter((t) => {
            try {
                return !!providerForHost(new URL(t.url).hostname);
            }
            catch {
                return false;
            }
        });
        tabsCache = { at: now, tabs: ai };
        return ai;
    }
    catch {
        tabsCache = { at: now, tabs: [] };
        return [];
    }
}
/** Merge open AI tabs into webcap sessions (stable id) or mint ephemeral tab
 *  sessions. Pure given inputs; exported for tests. */
export function mergeTabs(sessions, tabs, webCaptureArmed, now) {
    const byWebId = new Map(sessions.filter((s) => s.surface === 'browser').map((s) => [s.id, s]));
    const out = [...sessions];
    for (const tab of tabs) {
        let host = '';
        try {
            host = new URL(tab.url).hostname;
        }
        catch {
            continue;
        }
        const provider = providerForHost(host);
        if (!provider)
            continue;
        const token = convTokenFromUrl(tab.url);
        const stableId = token ? `web:${provider}:${token}` : null;
        const existing = stableId ? byWebId.get(stableId) : undefined;
        if (existing) {
            // Tab open on an already-captured conversation → enrich in place.
            existing.detail = { ...existing.detail, tabId: tab.id, url: tab.url, host, tabActive: !!tab.active };
            if (existing.state === 'stale')
                existing.state = 'idle';
            continue;
        }
        const ephemeralId = `web:${provider}:tab:${tab.id}`;
        if (byWebId.has(ephemeralId))
            continue;
        out.push({
            id: stableId ?? ephemeralId,
            surface: 'browser',
            provider,
            title: tab.title || `${provider} tab`,
            state: tab.active ? 'idle' : 'stale',
            lastActivity: new Date(now).toISOString(),
            capture: webCaptureArmed ? 'pending' : 'off',
            injectable: provider === 'chatgpt' ? 'body-rewrite' : 'composer',
            memoryScope: { vault: null, projectId: null },
            actions: ['open', 'inject'],
            ...(stableId ? {} : { replacesId: undefined }),
            detail: { tabId: tab.id, url: tab.url, host, tabActive: !!tab.active },
        });
    }
    return out;
}
const realDeps = {
    loadConversations,
    listAiTabs,
    bridgeConnected: () => !!bridgeStatus().connected,
    captureLanes: captureLanesForPresence,
    now: () => Date.now(),
};
export async function buildSnapshot(deps = realDeps) {
    const now = deps.now();
    // 1) Conversations (captures included — webcap rows ARE browser sessions).
    const convs = deps.loadConversations({ includeCaptures: true });
    const sessions = [];
    for (const c of convs) {
        const updatedMs = Date.parse(c.updated_at.includes('T') ? c.updated_at : c.updated_at.replace(' ', 'T') + 'Z') || 0;
        const mark = liveMarks.get(c.id);
        const liveEnough = updatedMs > now - VISIBLE_WINDOW_MS || (mark && now - mark.at <= ACTIVE_DECAY_MS);
        if (!liveEnough)
            continue;
        const cls = classifyConversation(c);
        if (!cls)
            continue;
        sessions.push(finishSession(cls, c.updated_at, now));
    }
    // 2) Browser tabs (bridge offline → none; never phantom tiles).
    const bridgeConnected = deps.bridgeConnected();
    let lanes;
    try {
        lanes = deps.captureLanes();
    }
    catch {
        lanes = { ide: { enabled: false, sources: [], connected: false, lastRunAt: null, lagSeconds: null }, web: { armed: false } };
    }
    let all = sessions;
    if (bridgeConnected) {
        const tabs = await deps.listAiTabs();
        all = mergeTabs(sessions, tabs, lanes.web.armed, now);
    }
    // 3) IDE capture lanes — one observed session per source, honest about lag.
    if (lanes.ide.enabled) {
        for (const src of lanes.ide.sources) {
            const lastMs = lanes.ide.lastRunAt ? Date.parse(lanes.ide.lastRunAt) : 0;
            all.push({
                id: `ide:${src}`,
                surface: 'ide',
                provider: src,
                title: `IDE capture · ${src}`,
                state: lanes.ide.connected ? 'idle' : 'stale',
                lastActivity: lastMs ? new Date(lastMs).toISOString() : new Date(0).toISOString(),
                capture: lanes.ide.connected ? 'on' : 'pending',
                injectable: 'none',
                memoryScope: { vault: null, projectId: null },
                actions: ['view-memory'],
                detail: { lagSeconds: lanes.ide.lagSeconds, sources: lanes.ide.sources },
            });
        }
    }
    all.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
    const liveCut = now - LIVE_WINDOW_MS;
    const isLive = (s) => Date.parse(s.lastActivity) >= liveCut;
    return {
        version: 1,
        generatedAt: new Date(now).toISOString(),
        sessions: all,
        counts: {
            live: all.filter(isLive).length,
            capturing: all.filter((s) => s.capture === 'on' && isLive(s)).length,
            awaitingApproval: all.filter((s) => s.state === 'awaiting_approval').length,
        },
        liveWindowMs: LIVE_WINDOW_MS,
        bridge: { connected: bridgeConnected },
    };
}
// ── Router ───────────────────────────────────────────────────────────────────
let snapCache = null;
export const presenceRouter = Router();
presenceRouter.get('/', async (_req, res) => {
    try {
        const now = Date.now();
        if (snapCache && now - snapCache.at < SNAPSHOT_TTL_MS) {
            res.json(snapCache.snap);
            return;
        }
        const snap = await buildSnapshot();
        snapCache = { at: now, snap };
        res.json(snap);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
