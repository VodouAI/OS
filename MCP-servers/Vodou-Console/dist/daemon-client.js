/**
 * Minimal daemon socket client.
 *
 * The daemon holds the embedder and cross-encoder in memory; `runCore` spawns a
 * process that loads both COLD on every call. For a one-shot CLI that is fine.
 * For `/api/library/match`, which the extension panel fires on every tab
 * activation, it is the difference between ~0.3s and 6-10s.
 *
 * Modelled on `ground-truth.ts`, which already talks to this socket: never
 * rejects, carries a reason for logging, and lets the caller decide whether to
 * fall back. The fallback is what keeps this safe — the daemon being down must
 * degrade latency, never correctness, so every caller keeps its `runCore` path.
 */
import * as net from 'net';
import * as path from 'path';
import { getProjectRoot } from './db.js';
import { sockConnectTarget } from './cli-portability.js';
/**
 * One request/response against the daemon socket.
 *
 * `timeoutMs` bounds the whole exchange. A daemon that is up but wedged is
 * indistinguishable from one that is down, and both must fall back rather than
 * hang the HTTP request that is waiting on this.
 */
export function daemonRequest(command, payload, timeoutMs = 15_000) {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    // The daemon reads the operation from `cmd`, NOT `command` — it dispatches on
    // `request.get("cmd")` and answers `unknown command: ` (blank) for anything
    // else, which is what a wrong field name looks like from out here.
    const body = JSON.stringify({ cmd: command, payload });
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => {
            if (!settled) {
                settled = true;
                resolve(r);
            }
        };
        try {
            const client = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
                client.write(body);
                client.end();
            });
            client.setTimeout(timeoutMs);
            let data = '';
            client.on('data', (chunk) => {
                data += chunk.toString();
            });
            client.on('end', () => {
                try {
                    const resp = JSON.parse(data.trim());
                    if (resp?.ok) {
                        finish({ ok: true, data: resp.data });
                    }
                    else {
                        // A daemon-reported error is NOT a silent fallback: the caller logs
                        // it, because "the warm path is broken" and "the daemon is not
                        // running" need different fixes and look identical from here.
                        finish({ ok: false, reason: resp?.error ?? 'daemon returned ok=false' });
                    }
                }
                catch {
                    finish({ ok: false, reason: 'daemon response unparseable' });
                }
            });
            client.on('error', (err) => {
                finish({ ok: false, reason: `socket error (${err?.message ?? 'unknown'})` });
            });
            client.on('timeout', () => {
                client.destroy();
                finish({ ok: false, reason: `timed out at ${timeoutMs}ms` });
            });
        }
        catch (err) {
            finish({ ok: false, reason: `connect threw (${err?.message ?? 'unknown'})` });
        }
    });
}
