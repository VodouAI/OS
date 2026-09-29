/**
 * Browser Hands runner (PLAN-BROWSER-HANDS §3.2, §6, §13): the ONLY path from a
 * decision to a browser action. Every call goes through contract.decide(); a
 * gate suspends the task with a screenshot and a summary composed by CODE from
 * the page (never by the model); an approved gate re-checks the page before it
 * clicks, so a stale "yes" can't approve something else (§13.2).
 *
 * The runner keeps only the LATEST filtered snapshot (§13.4); older ones are
 * dropped, never summarised.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decide, nodesFromSnapshot } from './contract.js';
import { filterSnapshot } from './snapshot-filter.js';
const VERB = {
    book: 'Book', spend: 'Pay', send: 'Send', submit: 'Submit', cancel: 'Cancel', delete: 'Delete', account: 'Change your account',
};
/** Text lines of the page region that describes what's being approved (a dialog if there is one). */
export function summaryDetails(snapshot, maxLines = 6) {
    const lines = snapshot.split('\n');
    const start = lines.findIndex((l) => /\buid=\S+ (dialog|alertdialog)\b/.test(l));
    // No dialog: the first text on a whole page is navigation noise (live on Resy
    // 2026-09-28 it produced "Submit: this step — 2026"); the caller uses the title.
    if (start < 0)
        return [];
    const scope = lines.slice(start + 1);
    const indent = start >= 0 ? (lines[start].match(/^\s*/)?.[0].length ?? 0) : -1;
    const out = [];
    for (const l of scope) {
        if (start >= 0 && (l.match(/^\s*/)?.[0].length ?? 0) <= indent)
            break;
        const m = /uid=\S+ (StaticText|heading) "([^"]+)"/.exec(l);
        if (m && m[2].trim().length > 1 && !out.includes(m[2].trim()))
            out.push(m[2].trim());
        if (out.length >= maxLines)
            break;
    }
    return out;
}
/** The "yes?" text: deterministic, from the page and the target. Never from the model. */
export function composeSummary(category, target, snapshot, host, label) {
    const details = summaryDetails(snapshot);
    const title = /uid=\S+ RootWebArea "([^"]*)"/.exec(snapshot)?.[1] ?? '';
    // No element (Enter in a field, accepting a browser dialog): name the action itself.
    const what = target ? `"${target.name}"` : label ? label.replace(/^key /, 'pressing ') : 'this step';
    const context = details.length ? details.join(' · ') : title;
    return `${VERB[category]}: ${what}${context ? ` — ${context}` : ''} (on ${host}). Reply yes to go ahead, or no.`;
}
const READ_ONLY = new Set(['take_snapshot', 'take_screenshot', 'list_pages', 'hover']);
function pageIdFrom(text) {
    const m = text.match(/^(\d+):.*\[selected\]/m) || text.match(/^(\d+):/m);
    return m ? Number(m[1]) : null;
}
export class Hands {
    store;
    client;
    opts;
    constructor(store, client, 
    // session: which browser process this Hands drives. A task remembers the session
    // that opened its page; after a gateway restart the page (and its id) are gone,
    // and the same pageId can name a DIFFERENT page in the new browser (§13.2c).
    opts = { mediaDir: '.vodou/media/browser' }) {
        this.store = store;
        this.client = client;
        this.opts = opts;
    }
    /**
     * The last UNFILTERED snapshot per task, in memory only (never persisted, never
     * shown to the model). Recipes resolve targets against it — the filter hides
     * links past LINKS_PER_GROUP, and a recipe must still find the 12th restaurant —
     * and the contract classifies against it, so a gate sees the element's full name.
     */
    raw = new Map();
    rawSnapshot(task) {
        return this.raw.get(task.id) ?? String(task.state.snapshot ?? '');
    }
    ctxFor(task) {
        const snap = this.rawSnapshot(task);
        const { nodes, focusedUid } = nodesFromSnapshot(snap);
        return { nodes, focusedUid, allowedHosts: task.state.allowedHosts ?? [], inLoginStep: !!task.state.inLoginStep };
    }
    host(task) {
        try {
            return new URL(String(task.state.url ?? '')).hostname || 'the site';
        }
        catch {
            return 'the site';
        }
    }
    /** Take a fresh snapshot, filter it, store it as the ONLY snapshot the task keeps. */
    async refresh(task) {
        const pageId = Number(task.state.pageId ?? 1);
        const s = await this.client.callTool('take_snapshot', { pageId }, 30_000);
        if (s.isError)
            throw new Error(s.text.slice(0, 200));
        this.raw.set(task.id, s.text);
        const url = /RootWebArea "[^"]*" url="([^"]+)"/.exec(s.text)?.[1];
        const filtered = filterSnapshot(s.text).text;
        task.state = { ...task.state, snapshot: filtered, ...(url ? { url } : {}) };
        this.store.saveProgress(task.id, task.step, task.state);
        return filtered;
    }
    async screenshot(task, label) {
        try {
            fs.mkdirSync(this.opts.mediaDir, { recursive: true });
            // .jpeg, not .jpg: chrome-devtools-mcp 1.10.1 rewrites the extension to match
            // the format, so a .jpg path is saved as .jpeg and the file we asked for never
            // exists. Trust the path it reports; fall back to the one we asked for.
            const file = path.resolve(this.opts.mediaDir, `${task.id.slice(0, 8)}-${task.step}-${label}.jpeg`);
            const r = await this.client.callTool('take_screenshot', { pageId: Number(task.state.pageId ?? 1), format: 'jpeg', quality: 80, filePath: file }, 30_000);
            const saved = /Saved screenshot to (.+?)\.?\s*$/m.exec(r.text)?.[1]?.trim();
            const out = saved && fs.existsSync(saved) ? saved : file;
            return r.isError || !fs.existsSync(out) ? undefined : out;
        }
        catch {
            return undefined;
        }
    }
    /** Open the task's page. */
    async open(task, url) {
        const d = decide('new_page', { url, timeout: 30_000 }, this.ctxFor(task));
        if (d.kind !== 'allow')
            return this.refuse(task, 'new_page', d.kind === 'refuse' ? d.reason : 'not allowed');
        const r = await this.client.callTool('new_page', d.args, 60_000);
        if (r.isError)
            return this.fail(task, 'new_page', r.text);
        task.state = { ...task.state, pageId: pageIdFrom(r.text) ?? 1, url, browserSession: this.opts.session ?? null };
        await this.refresh(task);
        return this.ok(task, 'new_page', url, `opened ${url}`);
    }
    /** The task's page belongs to a browser that is gone (Vodou restarted since it was opened). */
    needsReattach(task) {
        return !!this.opts.session && task.state.browserSession !== this.opts.session;
    }
    /** Reopen the task's last page in this browser. Nothing is clicked: the loop redoes what the page no longer shows. */
    async reattach(task) {
        const url = String(task.state.url ?? '');
        if (!url)
            return this.fail(task, 'new_page', 'no page to reopen');
        return this.open(task, url);
    }
    /** One action, through the contract. A gate suspends the task (the turn ends). */
    async act(task, tool, rawArgs) {
        const args = { ...rawArgs };
        if (tool !== 'new_page' && tool !== 'list_pages')
            args.pageId = Number(task.state.pageId ?? 1);
        const ctx = this.ctxFor(task);
        const d = decide(tool, args, ctx);
        const target = typeof args.uid === 'string' ? ctx.nodes.get(args.uid) ?? null : null;
        const label = target ? `${target.role} "${target.name}"` : undefined;
        if (d.kind === 'refuse')
            return this.refuse(task, tool, d.reason, label);
        if (d.kind === 'gate') {
            task.step += 1;
            const shot = await this.screenshot(task, 'gate');
            const summary = composeSummary(d.category, target, String(task.state.snapshot ?? ''), this.host(task), d.target);
            this.store.recordStep(task.id, { idx: task.step, tool, target: d.target, decision: 'gate', outcome: 'gated', note: summary, screenshot: shot });
            const gate = this.store.suspendAtGate(task.id, { category: d.category, target: d.target, summary, tool, args: d.args, screenshot: shot });
            return { kind: 'gated', gate };
        }
        const r = await this.client.callTool(tool, d.args, 60_000);
        if (r.isError)
            return this.fail(task, tool, r.text, label);
        // Anything that can change the page gets a fresh snapshot (wait_for included: the page it waited for).
        if (!READ_ONLY.has(tool))
            await this.refresh(task);
        return this.ok(task, tool, label, `${tool}${label ? ` ${label}` : ''}: ok`);
    }
    /**
     * The person answered the gate. Approve: consume the gate ONCE, re-check the
     * target is still on the page with the same role and name, then perform it.
     * If the page changed, re-gate with the new summary instead of clicking.
     */
    async resumeGate(task, decision) {
        const gate = task.gate;
        if (!gate)
            return { kind: 'stale' };
        const consumed = this.store.consumeGate(task.id, gate.nonce, decision);
        if (!consumed)
            return { kind: 'stale' };
        task = this.store.get(task.id);
        if (decision === 'deny') {
            this.store.recordStep(task.id, { idx: task.step, tool: gate.tool, target: gate.target, decision: 'gate', outcome: 'denied' });
            return { kind: 'done', obs: { ok: false, note: `the person said no to: ${gate.target}` } };
        }
        // Re-check: is the approved element still there, unchanged?
        const before = String(task.state.snapshot ?? '');
        const fresh = await this.refresh(task);
        const uid = typeof gate.args.uid === 'string' ? gate.args.uid : null;
        if (uid) {
            const was = nodesFromSnapshot(before).nodes.get(uid);
            const now = nodesFromSnapshot(fresh).nodes.get(uid);
            const beforeDetails = summaryDetails(before).join('|');
            const nowDetails = summaryDetails(fresh).join('|');
            if (!now || !was || now.role !== was.role || now.name !== was.name || beforeDetails !== nowDetails) {
                this.store.recordStep(task.id, { idx: task.step, tool: gate.tool, target: gate.target, decision: 'gate', outcome: 'page-changed' });
                return this.act(task, gate.tool, gate.args); // re-gates with the current page's summary
            }
        }
        const r = await this.client.callTool(gate.tool, gate.args, 60_000);
        if (r.isError) {
            // Exactly-once: never click again blindly. The caller must check the page for a confirmation first.
            this.store.recordStep(task.id, { idx: task.step, tool: gate.tool, target: gate.target, decision: 'gate', outcome: 'error', note: r.text.slice(0, 300) });
            await this.refresh(task).catch(() => undefined);
            return { kind: 'done', obs: { ok: false, note: `the approved step reported an error; check the page for a confirmation before trying anything again: ${r.text.slice(0, 160)}` } };
        }
        this.store.recordStep(task.id, { idx: task.step, tool: gate.tool, target: gate.target, decision: 'gate', outcome: 'approved' });
        const snap = await this.refresh(task);
        return { kind: 'done', obs: { ok: true, note: `approved and done: ${gate.target}`, snapshot: snap } };
    }
    async proof(task) {
        return this.screenshot(task, 'proof');
    }
    async stop(task, why = 'stopped by the person') {
        this.store.recordStep(task.id, { idx: task.step, tool: 'stop', decision: 'allow', outcome: 'stopped', note: why });
        this.store.finish(task.id, 'stopped', why);
        const pageId = Number(task.state.pageId ?? 0);
        // Never close by a stale id: after a restart it can name someone else's page.
        if (pageId && !this.needsReattach(task))
            await this.client.callTool('close_page', { pageId }, 15_000).catch(() => undefined);
    }
    ok(task, tool, target, note) {
        task.step += 1;
        this.store.recordStep(task.id, { idx: task.step, tool, target, decision: 'allow', outcome: 'ok' });
        this.store.saveProgress(task.id, task.step, task.state);
        return { kind: 'done', obs: { ok: true, note, snapshot: String(task.state.snapshot ?? '') } };
    }
    refuse(task, tool, reason, target) {
        this.store.recordStep(task.id, { idx: task.step, tool, target, decision: 'refuse', outcome: 'refused', note: reason });
        return { kind: 'refused', reason };
    }
    fail(task, tool, text, target) {
        task.step += 1;
        this.store.recordStep(task.id, { idx: task.step, tool, target, decision: 'allow', outcome: 'error', note: text.slice(0, 300) });
        return { kind: 'done', obs: { ok: false, note: `${tool} failed: ${text.slice(0, 160)}` } };
    }
}
