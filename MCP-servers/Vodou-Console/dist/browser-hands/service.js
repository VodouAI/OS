/**
 * Browser Hands service (PLAN-BROWSER-HANDS §3.2): the one object the gateway
 * talks to — the `browser_task` tool, the inbound-reply hook, and the API.
 *
 * Owns backend 2's lifecycle: one chrome-devtools-mcp (pinned, vendored, Vodou's
 * own profile, headed) started lazily on the first task and reused. Off unless
 * VODOU_BROWSER_HANDS=1 until the fresh-install test passes (§14.6).
 */
import * as path from 'path';
import { getProjectRoot } from '../db.js';
import { TaskStore, routeReply } from './tasks.js';
import { Hands } from './runner.js';
import { runLoop } from './loop.js';
import { resolveBrowser, startBackend, profileDir } from './backend.js';
import { checkBrowser, readStatus } from './doctor.js';
import { fetchChromeForTesting } from './fetch-browser.js';
import { onBrowserCancel } from './cancel.js';
import { getRecipe, runRecipe, fillTemplate } from './recipe.js';
import { tunnelNotifyPhone } from '../tunnel/client.js';
import { browserHandsEnabled } from './flag.js';
export { browserHandsEnabled };
/** v1 runs on an allow-list of errand sites (§6.2, decision 4). */
export const ERRAND_SITES = ['opentable.com', 'resy.com'];
let store = null;
let client = null;
/** Which browser process `client` is: a task opened under another session lost its page. */
let clientSession = '';
let starting = null;
/** Set when this errand had to download Vodou's browser first, so the reply can say so once. */
const fetchedNotice = new Set();
function getStore() {
    if (!store)
        store = new TaskStore();
    return store;
}
async function getClient(conversationId) {
    if (client && !client.exited)
        return client;
    if (starting)
        return starting;
    starting = (async () => {
        let browser = resolveBrowser();
        if (!browser) {
            // §14.2: no Chromium on this computer → fetch Chrome for Testing (pinned,
            // checksum-verified) into .vodou/browser/, once, then carry on.
            const f = await fetchChromeForTesting();
            if (!f.ok)
                throw new Error(`no browser on this computer, and setting one up failed: ${f.reason}`);
            if (conversationId)
                fetchedNotice.add(conversationId);
            void checkBrowser().catch(() => undefined); // the doctor goes absent → ok on its own
            browser = resolveBrowser();
            if (!browser)
                throw new Error('the browser was set up but could not be found');
        }
        const c = await startBackend({ executablePath: browser.path, profile: profileDir() });
        client = c;
        clientSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return c;
    })().finally(() => { starting = null; });
    return starting;
}
async function defaultLlm() {
    const { rawLLMCallStrict } = await import('../llm.js');
    return rawLLMCallStrict;
}
function hands(c) {
    return new Hands(getStore(), c, { mediaDir: path.join(getProjectRoot(), '.vodou', 'media', 'browser'), session: clientSession });
}
/** The phone conversation (tunnel/client.ts): only errands started by text get progress texts. */
export const PHONE_CONVERSATION = 'workbench:channel:relay';
/** First progress text after this long, then at most one per interval (§13.1: ~20 s). */
export const PROGRESS_EVERY_MS = 20_000;
/** Errands whose loop is running right now, so STOP can abort between steps. */
const running = new Map();
let notifyPhone = (text) => tunnelNotifyPhone('', text);
/** Tests only. */
export function _setNotify(fn) { notifyPhone = fn; }
/**
 * Run the loop with a STOP handle and throttled progress. Progress is the
 * model's own one-line "why" ("Searching for Carbone"), sent down the notify
 * lane, which doesn't close the pending reply (§13.1).
 */
async function drive(h, s, task, llm, conversationId, now = Date.now) {
    const ctrl = new AbortController();
    running.set(conversationId, ctrl);
    const t0 = now();
    let last = t0;
    const onProgress = conversationId === PHONE_CONVERSATION
        ? (line) => {
            const t = now();
            if (t - last < PROGRESS_EVERY_MS)
                return;
            last = t;
            notifyPhone(`On it — ${line.replace(/\.$/, '')}…`);
        }
        : undefined;
    try {
        // A recipe runs first, with no model calls; where it can't continue it hands
        // the page to the loop with a note saying what it expected (§5.5).
        const rs = task.state.recipe;
        const recipe = rs && !rs.fellBack ? getRecipe(rs.id) : null;
        if (recipe) {
            const r = await runRecipe(h, s, task, recipe, { signal: ctrl.signal });
            if (r.kind !== 'fallback') {
                if (r.kind === 'gate' || r.kind === 'question')
                    scheduleExpiry(task.id);
                return r;
            }
        }
        const out = await runLoop(h, s, task, llm, { signal: ctrl.signal, onProgress });
        if (out.kind === 'gate' || out.kind === 'question')
            scheduleExpiry(task.id);
        return out;
    }
    finally {
        if (running.get(conversationId) === ctrl)
            running.delete(conversationId);
    }
}
/**
 * A waiting errand lapses after its hold (10 min; restaurant holds do too) — and
 * the person hears about it, instead of finding out on their next "yes" (§13.1).
 * TaskStore.active() also expires lazily; this is the half that speaks.
 */
function scheduleExpiry(taskId) {
    const t = getStore().get(taskId);
    if (!t?.expiresAt)
        return;
    const at = Date.parse(t.expiresAt.replace(' ', 'T') + 'Z'); // naive UTC (time canon)
    const timer = setTimeout(() => { void sweepExpired(); }, Math.max(1_000, at - Date.now() + 2_000));
    timer.unref?.();
}
export async function sweepExpired() {
    const lapsed = getStore().expireStale();
    for (const t of lapsed) {
        const pageId = Number(t.state.pageId ?? 0);
        if (client && !client.exited && pageId && t.state.browserSession === clientSession) {
            await client.callTool('close_page', { pageId }, 15_000).catch(() => undefined);
        }
        if (t.conversationId === PHONE_CONVERSATION) {
            notifyPhone(`I stopped waiting on your errand (${t.goal.slice(0, 80)}) — nothing was booked or sent. Just ask again when you're ready.`);
        }
    }
    return lapsed.length;
}
/** STOP from the phone (cancel.ts): abort a running loop and end any active errand. */
export async function cancelErrands(conversationId) {
    if (!browserHandsEnabled())
        return false;
    const ctrl = running.get(conversationId);
    ctrl?.abort();
    const s = getStore();
    const task = s.active(conversationId);
    if (!task)
        return !!ctrl;
    if (client && !client.exited)
        await hands(client).stop(task, 'stopped from the phone');
    else
        s.finish(task.id, 'stopped', 'stopped from the phone');
    return true;
}
onBrowserCancel(cancelErrands);
function asReply(o) {
    if (o.kind === 'cancelled')
        return { text: o.text, pictures: [] };
    if (o.kind === 'done')
        return { text: `Done. ${o.text}`, pictures: o.proof ? [o.proof] : [] };
    if (o.kind === 'gate')
        return { text: o.text, pictures: o.screenshot ? [o.screenshot] : [] };
    if (o.kind === 'question')
        return { text: o.text, pictures: [] };
    return { text: o.text, pictures: o.screenshot ? [o.screenshot] : [] };
}
/** The `browser_task` tool: start an errand. Returns what to tell the person (and pictures). */
export async function startBrowserTask(input, llm) {
    if (!browserHandsEnabled())
        return { text: 'Browser errands are not switched on for this Vodou yet.', pictures: [] };
    const s = getStore();
    const existing = s.active(input.conversationId);
    if (existing)
        return { text: `I'm still on your last errand (${existing.goal}). Say "stop" to cancel it, or finish it first.`, pictures: [] };
    // A recipe with every required slot runs; one missing a slot is ignored (the
    // loop does the errand) rather than run half-filled.
    const recipe = input.recipe ? getRecipe(input.recipe) : null;
    const slots = Object.fromEntries(Object.entries(input.slots ?? {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
    const useRecipe = recipe && recipe.required.every((k) => slots[k]) ? recipe : null;
    const sites = (useRecipe ? useRecipe.site.domains : input.sites?.length ? input.sites : ERRAND_SITES).map((d) => d.toLowerCase().replace(/^www\./, ''));
    let c;
    try {
        c = await getClient(input.conversationId);
    }
    catch (e) {
        // §14.2 step 3: never a raw error — say why, and hand over the link.
        return { text: `I can't run a browser on this computer yet (${e instanceof Error ? e.message : String(e)}). Here's the link to do it yourself: ${input.startUrl}`, pictures: [] };
    }
    // The recipe's first navigate IS the start page, so it isn't loaded twice.
    const first = useRecipe?.steps[0];
    const startUrl = first && 'do' in first && first.do === 'navigate' ? fillTemplate(first.url, slots, 'url') : input.startUrl;
    const recipeState = useRecipe ? { id: useRecipe.id, step: startUrl === input.startUrl ? 0 : 1, slots } : undefined;
    const { task } = s.create({ conversationId: input.conversationId, goal: input.goal, recipeId: useRecipe?.id ?? null, state: { allowedHosts: sites, ...(recipeState ? { recipe: recipeState } : {}) } });
    const h = hands(c);
    const opened = await h.open(task, startUrl);
    if (opened.kind === 'refused') {
        s.finish(task.id, 'failed', opened.reason);
        return { text: `I can't open that: ${opened.reason}.`, pictures: [] };
    }
    const reply = asReply(await drive(h, s, task, llm ?? (await defaultLlm()), input.conversationId));
    if (fetchedNotice.delete(input.conversationId))
        reply.text = `(I set up Vodou's browser first — a one-time download.)\n\n${reply.text}`;
    return reply;
}
/**
 * Inbound message hook — called BEFORE a normal turn (§13.1). Returns null when
 * the message isn't for a browser task (it then becomes a normal turn).
 */
export async function handleBrowserReply(conversationId, text, llm) {
    if (!browserHandsEnabled())
        return null;
    const s = getStore();
    const route = routeReply(s, conversationId, text);
    if (route.kind === 'none')
        return null;
    if (route.kind === 'busy')
        return { text: `I'm in the middle of your errand (${route.task.goal}). I'll get to that next — or say "stop".`, pictures: [] };
    let c;
    try {
        c = await getClient();
    }
    catch {
        s.finish(route.task.id, 'failed', 'the browser is no longer available');
        return { text: 'I lost the browser for that errand, so I stopped it. Want me to start again?', pictures: [] };
    }
    const h = hands(c);
    const task = route.task;
    if (route.kind === 'stop') {
        await h.stop(task);
        return { text: 'Stopped. Nothing else was done.', pictures: [] };
    }
    const model = llm ?? (await defaultLlm());
    // Vodou restarted while this errand waited: its page is gone (§13.2c). A "yes"
    // must not click anything on a page nobody has seen — retire the gate, reopen
    // the page, and let the loop reach the step again; it asks with a fresh summary.
    if (h.needsReattach(task)) {
        if (route.kind === 'gate') {
            if (!task.gate || !s.voidGate(task.id, task.gate.nonce))
                return { text: 'That approval had already been used or had expired, so nothing was done.', pictures: [] };
            if (route.decision === 'deny') {
                await h.stop(task, 'the person said no at the approval');
                return { text: `Okay, I didn't do it. The errand is stopped.`, pictures: [] };
            }
        }
        else {
            s.answerQuestion(task.id);
        }
        const t = s.get(task.id);
        const rs = t.state.recipe;
        if (rs && !rs.fellBack)
            t.state = { ...t.state, recipe: { ...rs, fellBack: 'Vodou restarted' } };
        const re = await h.reattach(t);
        if (re.kind !== 'done') {
            s.finish(t.id, 'failed', 'could not reopen the page after a restart');
            return { text: `Vodou restarted while I was waiting on you, and I couldn't reopen the page, so I stopped. Here it is to finish yourself: ${String(t.state.url ?? '')}`, pictures: [] };
        }
        const note = route.kind === 'gate'
            ? `Vodou restarted and the page was reopened. The person had approved "${task.gate.target}", but nothing was done on the new page: redo the steps and click it again (they will be asked once more).`
            : `Vodou restarted and the page was reopened; redo any earlier choices the page no longer shows. The person answered: ${route.kind === 'option' ? route.choice : route.text}`;
        t.state = { ...t.state, history: [...(t.state.history ?? []), note] };
        const reply = asReply(await drive(h, s, t, model, conversationId));
        reply.text = `(Vodou restarted, so I reopened the page.)\n\n${reply.text}`;
        return reply;
    }
    if (route.kind === 'gate') {
        const r = await h.resumeGate(task, route.decision);
        if (r.kind === 'stale')
            return { text: 'That approval had already been used or had expired, so nothing was done.', pictures: [] };
        if (r.kind === 'gated')
            return { text: r.gate.summary, pictures: r.gate.screenshot ? [r.gate.screenshot] : [] };
        if (route.decision === 'deny') {
            await h.stop(task, 'the person said no at the approval');
            return { text: `Okay, I didn't do it. The errand is stopped.`, pictures: [] };
        }
        const t = s.get(task.id);
        return asReply(await drive(h, s, t, model, conversationId));
    }
    // option or free-text answer to a question
    s.answerQuestion(task.id);
    const t = s.get(task.id);
    const answer = route.kind === 'option' ? route.choice : route.text;
    t.state = { ...t.state, history: [...(t.state.history ?? []), `the person answered: ${answer}`] };
    // A recipe asked (pick_options): an option is its chosen_option; anything else
    // ("something later?") is a conversation the loop is better at.
    const rs = t.state.recipe;
    if (rs && !rs.fellBack) {
        if (route.kind === 'option')
            rs.slots = { ...rs.slots, chosen_option: route.choice };
        else
            rs.fellBack = 'the person answered in their own words';
        t.state = { ...t.state, recipe: rs };
    }
    return asReply(await drive(h, s, t, model, conversationId));
}
export async function browserHandsStatus(recheck = false) {
    return recheck ? checkBrowser() : readStatus();
}
export function browserTaskReceipt(id) {
    const s = getStore();
    const task = s.get(id);
    return task ? { task, steps: s.steps(id) } : null;
}
// Screenshots produced by a reply-path turn (gate summary, proof) that the REST
// /chat early return hands to the phone as toolCalls — the tunnel client's
// picture finder already sends images a tool made this turn (outbound-pictures.ts).
const pendingPictures = new Map();
/** For tryApprovalReply: the reply text, or null. Remembers any pictures for the REST response. */
export async function tryBrowserHandsReply(rawText, conversationId) {
    const r = await handleBrowserReply(conversationId, rawText).catch((e) => ({ text: `Something went wrong with the errand: ${e instanceof Error ? e.message : String(e)}`, pictures: [] }));
    if (!r)
        return null;
    if (r.pictures.length)
        pendingPictures.set(conversationId, r.pictures);
    return r.text;
}
/** For the REST /chat early return: this reply's pictures, as toolCalls the phone's picture finder reads. */
export function takeBrowserHandsToolCalls(conversationId) {
    const pics = pendingPictures.get(conversationId) ?? [];
    pendingPictures.delete(conversationId);
    return pics.map((p) => ({ name: 'browser_task', result: `screenshot: ${p}` }));
}
/** Tests only: drive a fake browser as if it were a freshly started one. */
export function _useClient(c, session) {
    client = c;
    clientSession = session;
}
/** Tests only. */
export function _resetBrowserHands() {
    running.clear();
    client?.close();
    client = null;
    store = null;
}
