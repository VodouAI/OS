/**
 * M3a — the messaging lane of PLAN-VODOU-LOCAL-TUNNEL (2026-09-25).
 *
 * The person texts the Vodou line; the relay, seeing this gateway attached,
 * hands the text DOWN here instead of to its capped demo brain; the turn runs
 * on this machine — the real BrainLoader, the real memory, the person's own
 * LLM — and the reply rides back up to their Messages thread.
 *
 * Transport is an outbound HTTPS long-poll, the gateway's own Telegram shape
 * (telegram.ts: outbound poll, exponential backoff, one poller), NOT a
 * WebSocket: nothing inbound ever opens, all localhost guards stay shut, and
 * the relay's single-poller rule means a restarted gateway never fights its
 * old self. The WS design in the plan remains for the console-mirror lane.
 *
 * Auth is the credentials this install already holds: `Bearer TOKEN:USER_ID`
 * from process.env (kept live by persistVodouCredentials, so connecting an
 * account while running attaches the tunnel without a restart). The relay
 * validates the pair against app.vodou.ai — device keys (#31) included.
 *
 * The inbound text becomes a turn via THIS gateway's own localhost
 * POST /chat (`source: 'relay'`), which is deliberate: it inherits the
 * channel envelope (the text is fenced as untrusted content, never
 * instructions), memory injection, skills, approvals — everything a channel
 * message gets. The reply is the turn's final text; a bare "yes" resolves a
 * parked approval exactly as it does in /simple, because it is the same path.
 *
 * Off by default: VODOU_TUNNEL_ENABLED=1 turns it on; VODOU_RELAY_URL
 * overrides the relay for self-hosters.
 */
import { gatewayPort } from '../gateway-port.js';
import { saveTextedMedia } from './media.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function tunnelEnabled(env = process.env) {
    const v = String(env.VODOU_TUNNEL_ENABLED ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}
/**
 * M3b upstream push — mirror a PAGE-TYPED turn on the relay conversation to
 * the person's phone, so Messages stays a complete copy of the one thread.
 * No-op unless the tunnel client is running (module-level handle set by
 * startTunnelClient). Fire-and-forget by contract: mirroring must never
 * delay or break the turn that already answered in the browser. The
 * double-text guard is STRUCTURAL: phone-originated turns run through
 * runTurn/agent-reply and never call this — only the WS (page) path does.
 */
let _activeNotify = null;
let _activeNotifyAwait = null;
export function tunnelNotifyPhone(userText, replyText) {
    if (_activeNotify)
        _activeNotify(userText, replyText);
}
/**
 * The same push, but AWAITED, with the outcome — for the scheduler's
 * reminders, which must record honestly whether the text actually went
 * out (a run marked delivered that reached nobody is the failure the
 * scheduler's run ledger exists to prevent). 404 from the relay = no phone
 * on file for this account; status 0 = the relay was unreachable.
 */
export async function tunnelNotifyPhoneAwait(userText, replyText) {
    if (!_activeNotifyAwait)
        return { delivered: false, status: 0, reason: 'the texting tunnel is off (VODOU_TUNNEL_ENABLED)' };
    const r = await _activeNotifyAwait(userText, replyText);
    return r.ok
        ? { delivered: true, status: r.status }
        : { delivered: false, status: r.status, reason: r.status === 404 ? 'no phone on file for this account' : r.status === 0 ? 'relay unreachable' : `relay refused (${r.status})` };
}
/**
 * The desk-typed message as the phone should see it in the "You (at your
 * computer): …" mirror: attachment notes ("[Channel attachment: x.png
 * local_path=/private/tmp/… …]") become "(sent a picture)" / "(sent a file)",
 * never a raw local path texted to someone's phone.
 */
export function phoneSafeUserText(userText) {
    let pictures = 0;
    let files = 0;
    const words = String(userText || '')
        .replace(/\[Channel attachment:[^\]]*\btype=(\w+)[^\]]*\]/g, (_m, type) => {
        if (type === 'image')
            pictures++;
        else
            files++;
        return '';
    })
        .replace(/\[Attachments saved:[^\]]*\]/g, '')
        .trim();
    const notes = [
        pictures ? `(sent ${pictures === 1 ? 'a picture' : `${pictures} pictures`})` : '',
        files ? `(sent ${files === 1 ? 'a file' : `${files} files`})` : '',
    ].filter(Boolean).join(' ');
    return [words, notes].filter(Boolean).join(' ');
}
export function startTunnelClient(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const log = opts.log ?? ((...a) => console.error('[tunnel]', ...a));
    const env = opts.env ?? process.env;
    const pollTimeoutMs = opts.pollTimeoutMs ?? 40_000;
    // Just under the relay's 20-minute reply window (relay/src/tunnel.mjs): real
    // tasks sent by text ("open Spotify and play Prince", "write up the research
    // and update the plan") ran 55–140s, and the old 85s cut them off while the
    // relay's 90s window refused the finished answer.
    const turnTimeoutMs = opts.turnTimeoutMs ?? 19.5 * 60 * 1000;
    const relayBase = String(env.VODOU_RELAY_URL || 'https://relay.vodou.ai').replace(/\/+$/, '');
    let stopped = false;
    let backoffMs = 1_000;
    const bearer = () => {
        const token = String(env.VODOU_TOKEN || '').trim();
        const uid = String(env.VODOU_USER_ID || '').trim();
        return token && uid ? `Bearer ${token}:${uid}` : null;
    };
    const inbox = [];
    let working = false;
    function enqueue(m) {
        inbox.push(m);
        if (!working)
            void drain();
    }
    async function drain() {
        working = true;
        try {
            while (inbox.length && !stopped)
                await runTurn(inbox.shift());
        }
        finally {
            working = false;
        }
    }
    async function runTurn(m) {
        let replyText;
        // A real answer from this computer, as opposed to a snag/timeout notice.
        let answered = false;
        try {
            // Pictures become local files first — /chat only reads attachments from
            // disk (channelAttachments.ts). One that can't be fetched is SAID, so the
            // model never answers as if nothing had been sent.
            const saved = m.media?.length
                ? await saveTextedMedia(m.media, { fetchImpl, env, dir: opts.mediaDir })
                : { attachments: [], failed: 0 };
            let message = m.text;
            if (saved.failed) {
                message += `${message ? '\n\n' : ''}[They also texted ${saved.failed === 1 ? 'a picture or file' : `${saved.failed} pictures or files`} that could not be opened. By text, Vodou can read photos, PDFs and plain-text files (txt, md, csv, json); not Word, Excel, video or audio yet. Say so plainly, and suggest sending a photo, a PDF, or the text itself.]`;
            }
            const res = await fetchImpl(`http://127.0.0.1:${gatewayPort()}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    conversationId: 'workbench:channel:relay',
                    source: 'relay',
                    senderName: 'Your phone',
                    ...(saved.attachments.length ? { attachments: saved.attachments } : {}),
                    // The tapback the relay put on the phone's text, so /simple shows
                    // the same one ('' = it deliberately didn't react).
                    ...(m.reaction !== undefined ? { phoneReaction: m.reaction ?? '' } : {}),
                }),
                signal: AbortSignal.timeout(turnTimeoutMs),
            });
            const data = await res.json().catch(() => null);
            answered = res.ok && typeof data?.response === 'string' && !!data.response.trim();
            replyText = answered
                ? data.response.trim()
                : `I hit a snag answering that on your computer (${data?.error ? String(data.error).slice(0, 120) : `http ${res.status}`}).`;
        }
        catch (e) {
            // The turn outran the window or the gateway hiccuped: say so — the
            // relay's own timeout apology may have gone out already; a late reply
            // is refused up there (410), so this can never double-text.
            replyText = 'Sorry — that didn\'t finish on your computer. Try asking again, maybe in smaller steps.';
            log('local turn failed:', e instanceof Error ? e.message : String(e));
        }
        const auth = bearer();
        if (!auth)
            return;
        try {
            const rep = await fetchImpl(`${relayBase}/agent/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify({ id: m.id, text: replyText }),
                signal: AbortSignal.timeout(15_000),
            });
            if (rep.status === 410) {
                // The relay no longer holds this text: it restarted (its pending
                // replies live in memory only) or the 20-minute window closed. A real
                // answer is still worth having, so send it down the notify lane, which
                // texts the person by account and keeps no pending state. 2026-09-26:
                // a relay deploy mid-task dropped "Spotify's up front now…" for good.
                // A snag/timeout notice is not re-sent: late, it only adds noise.
                if (answered) {
                    const n = await postNotify('', replyText);
                    log('reply arrived after the relay lost the message (id', m.id + ') —', n.ok ? 'delivered via notify' : `notify failed (${n.status})`);
                }
                else {
                    log('reply arrived after the relay\'s timeout (id', m.id + ') — not an answer, not re-sent');
                }
            }
            else if (!rep.ok)
                log('reply refused:', rep.status);
        }
        catch (e) {
            log('reply send failed:', e instanceof Error ? e.message : String(e));
        }
    }
    const postNotify = async (userText, replyText) => {
        const auth = bearer();
        const reply = String(replyText || '').trim();
        if (!auth || !reply)
            return { ok: false, status: 0 };
        try {
            const res = await fetchImpl(`${relayBase}/agent/notify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify({ user_text: phoneSafeUserText(userText).slice(0, 500), reply_text: reply }),
                signal: AbortSignal.timeout(15_000),
            });
            return { ok: res.ok, status: res.status };
        }
        catch (e) {
            log('notify send failed:', e instanceof Error ? e.message : String(e));
            return { ok: false, status: 0 };
        }
    };
    _activeNotifyAwait = postNotify;
    _activeNotify = (userText, replyText) => {
        postNotify(userText, replyText).then((r) => {
            if (r.status === 404)
                log('mirror skipped: no phone on file');
            else if (!r.ok && r.status)
                log('mirror refused:', r.status);
        });
    };
    (async () => {
        log(`messaging lane up — polling ${relayBase} (set VODOU_TUNNEL_ENABLED=0 to disable)`);
        while (!stopped) {
            const auth = bearer();
            if (!auth) {
                await sleep(15_000);
                continue;
            } // account not connected yet; /connect fixes this live
            try {
                const res = await fetchImpl(`${relayBase}/agent/poll`, {
                    headers: { Authorization: auth },
                    signal: AbortSignal.timeout(pollTimeoutMs),
                });
                if (res.status === 401) {
                    // Bad or revoked credentials: no retry storm against auth. Five
                    // minutes also covers "just connected, backend cache still cold".
                    log('credentials rejected by the relay — pausing 5 minutes');
                    await sleep(300_000);
                    continue;
                }
                if (!res.ok)
                    throw new Error(`poll http ${res.status}`);
                const data = await res.json().catch(() => ({}));
                backoffMs = 1_000;
                // Answered in order, one local turn at a time (the process-count
                // discipline) — but the POLL keeps running while a turn works. It used
                // to await each turn inside this loop, so a 2-minute task stopped the
                // polling: after 35s the relay thought the laptop was gone and routed
                // new texts to the demo, and a text it had queued sat unpicked until
                // "couldn't reach your computer". Picking up promptly is also what
                // earns the person the relay's "still on it" instead of that.
                for (const m of Array.isArray(data?.messages) ? data.messages : []) {
                    // Words, pictures, or both — a picture-only text has text '' and was
                    // dropped here as well as at the relay.
                    const media = Array.isArray(m?.media) ? m.media.filter((u) => typeof u === 'string' && u) : [];
                    if (m && typeof m.id === 'string' && typeof m.text === 'string' && (m.text || media.length)) {
                        enqueue({
                            id: m.id, text: m.text,
                            ...(media.length ? { media } : {}),
                            ...(typeof m.reaction === 'string' || m.reaction === null ? { reaction: m.reaction } : {}),
                        });
                    }
                }
            }
            catch (e) {
                if (stopped)
                    break;
                log('poll error:', e instanceof Error ? e.message : String(e));
                await sleep(backoffMs + Math.floor(Math.random() * 250));
                backoffMs = Math.min(backoffMs * 2, 30_000);
            }
        }
    })();
    return { stop() { stopped = true; _activeNotify = null; _activeNotifyAwait = null; } };
}
