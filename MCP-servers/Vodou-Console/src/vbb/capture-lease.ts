/**
 * PLAN-ENGINE-GATED-CAPTURE P2 — the gateway side of the capture lease.
 *
 * The daemon mints a 30-minute lease (P1, `src/capture_lease.rs`); this holds one,
 * renews at half its TTL, and answers the only question the capture path asks:
 * may this turn be stored?
 *
 * Costs one socket round-trip every 15 minutes and nothing per turn.
 *
 * ## Two failure modes that must NOT behave the same
 *
 * 1. **The daemon did not answer** (engine down, restarting, socket busy). The
 *    existing lease KEEPS working until it actually expires. A daemon restart
 *    mid-session is then invisible, and "capture works only while Vodou runs"
 *    degrades over one TTL rather than snapping off at the first missed poll.
 * 2. **The daemon answered "no"** (`no_account`, `invalid_credentials`,
 *    `over_limit`). That is a verdict about the account, not a transport blip, so
 *    the lease is dropped immediately. Nothing is gained by honouring the rest of
 *    a lease whose account we have just been told is invalid.
 *
 * This is why the daemon replies `ok:true` with `granted:false` for a refusal and
 * `ok:false` only when it could not answer — the two are not interchangeable.
 *
 * ## Enforcement is always on
 *
 * It shipped dark behind `VODOU_CAPTURE_REQUIRE_LEASE=1` for the P4 soak, and was
 * hardcoded once that passed. A refused capture is HELD in the extension's retry
 * queue and replayed — never dropped — so enforcement costs nothing when the
 * engine is briefly away. See enforcementOn() for why the flag is gone rather
 * than inverted.
 */

import net from 'net';
import path from 'path';
import { getProjectRoot } from '../db.js';
import { sockConnectTarget } from '../cli-portability.js';

export type LeaseReason =
  | 'no_account'
  | 'invalid_credentials'
  | 'over_limit'
  | 'engine_error'
  | 'engine_unreachable';

export interface LeaseState {
  /** Is capture permitted right now? */
  granted: boolean;
  /** Typed code when it is not. Never prose — the UI maps code → message. */
  reason: LeaseReason | null;
  /** Epoch seconds. 0 when there is no lease. */
  expiresAt: number;
  /** Epoch ms of the last daemon answer of any kind, for diagnostics. */
  lastCheckedAt: number;
}

let state: LeaseState = { granted: false, reason: null, expiresAt: 0, lastCheckedAt: 0 };
let timer: NodeJS.Timeout | null = null;   // setTimeout, re-armed per tick (adaptive cadence)
let inFlight: Promise<LeaseState> | null = null;

/**
 * Enforcement is ALWAYS ON. There is deliberately no way to turn it off.
 *
 * This was `process.env.VODOU_CAPTURE_REQUIRE_LEASE === '1'` during the P4 soak,
 * which was right while we were still proving the held/replay path — revert
 * without a rebuild. It is wrong as a permanent mechanism, and worse than the
 * open-code bypass it sat next to: deleting one line from a user's `.env` needs
 * no code edit, no knowledge, and **survives every upgrade**, whereas a patched
 * check is overwritten on the next install.
 *
 * The rule, going forward: an env var may make enforcement STRICTER, never
 * looser. A `VODOU_CAPTURE_REQUIRE_LEASE=0` escape hatch would be the identical
 * hole wearing different clothes, so the variable is gone rather than inverted.
 * If a dev off-switch is ever genuinely needed it belongs at BUILD time, so a
 * release binary has no such path at all.
 *
 * The honest ceiling is unchanged: this verifier is open TypeScript in the user's
 * own install, so a determined person deletes the check and restarts. Removing
 * the flag raises the floor; it does not move the ceiling. See §4 of
 * PLAN-ENGINE-GATED-CAPTURE.
 */
export function enforcementOn(): boolean {
  return true;
}

const nowSecs = () => Math.floor(Date.now() / 1000);

/**
 * One `capture_lease` round-trip. Resolves to the parsed daemon reply, or null if
 * the daemon could not be reached — which is NOT the same as a refusal.
 */
function askDaemon(): Promise<any | null> {
  const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
  const request = JSON.stringify({ cmd: 'capture_lease' }) + '\n';
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: any | null) => { if (!settled) { settled = true; resolve(v); } };
    let c: net.Socket;
    try {
      c = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
        c.write(request);
      });
    } catch {
      done(null);
      return;
    }
    // Generous: minting reaches the licence server (~400ms measured) and this runs
    // every 15 minutes, off the turn path, so a slow answer is cheaper than a
    // spurious "engine unreachable".
    c.setTimeout(8000);
    let data = '';
    c.on('data', (b) => { data += b.toString(); });
    c.on('end', () => {
      try { done(JSON.parse(data.trim())); } catch { done(null); }
    });
    c.on('error', () => done(null));
    c.on('timeout', () => { try { c.destroy(); } catch { /* noop */ } done(null); });
  });
}

/**
 * Fetch (or renew) the lease. Safe to call concurrently — callers share one
 * in-flight request rather than stampeding the daemon.
 */
export async function refreshLease(): Promise<LeaseState> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const reply = await askDaemon();
    const now = nowSecs();

    if (!reply) {
      // Case 1: no answer. Keep whatever lease we hold until it expires.
      state = {
        granted: state.expiresAt > now,
        reason: state.expiresAt > now ? null : 'engine_unreachable',
        expiresAt: state.expiresAt,
        lastCheckedAt: Date.now(),
      };
      if (!state.granted) console.warn('[vbb] capture lease: daemon unreachable and the previous lease has expired');
      return state;
    }

    if (reply?.ok !== true) {
      // The daemon answered but could not process the command — an older engine
      // that predates `capture_lease` lands here. Treat as unreachable, not as a
      // refusal: refusing capture because the binary is out of date would be a
      // silent downgrade, not a policy decision.
      console.warn(`[vbb] capture lease: daemon error (${reply?.error || 'unknown'}) — treating as unreachable`);
      state = {
        granted: state.expiresAt > now,
        reason: state.expiresAt > now ? null : 'engine_unreachable',
        expiresAt: state.expiresAt,
        lastCheckedAt: Date.now(),
      };
      return state;
    }

    const d = reply.data || {};
    if (d.granted === true && d.lease && typeof d.lease.expires_at === 'number') {
      state = { granted: true, reason: null, expiresAt: d.lease.expires_at, lastCheckedAt: Date.now() };
      return state;
    }

    // Case 2: an explicit verdict about the account. Drop the lease now.
    const reason = (typeof d.reason === 'string' ? d.reason : 'engine_error') as LeaseReason;
    console.warn(`[vbb] capture lease REFUSED: ${reason} — capture is held until this clears`);
    state = { granted: false, reason, expiresAt: 0, lastCheckedAt: Date.now() };
    return state;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

/**
 * May a captured turn be stored?
 *
 * Never awaits: this sits on the capture path and must not add latency. It reads
 * the lease the renewal loop maintains, and kicks a refresh in the background if
 * the lease has aged out.
 */
export function captureAllowed(): { ok: boolean; reason: LeaseReason | null } {
  const now = nowSecs();
  if (state.granted && state.expiresAt > now) return { ok: true, reason: null };
  // Expired or never fetched — refresh for next time, but do not block this turn
  // on it. With enforcement off this is purely observational anyway.
  void refreshLease();
  if (!enforcementOn()) return { ok: true, reason: null };
  return { ok: false, reason: state.reason || 'engine_unreachable' };
}

/** Current lease, for /api/vbb/state and diagnostics. */
export function leaseStatus(): LeaseState & { enforcing: boolean } {
  return { ...state, enforcing: enforcementOn() };
}

/** Healthy cadence: renew at half the TTL. */
const RENEW_MS = 15 * 60 * 1000;
/** Ungranted cadence: the engine may return at any second — do not wait 15 minutes. */
const RETRY_MS = 60 * 1000;

/**
 * Start the renewal loop. Idempotent — calling it again does not stack timers.
 *
 * ADAPTIVE, and that is the point. A fixed 15-minute interval means a gateway
 * whose first refresh failed sits leaseless — refusing every capture — for the
 * full interval even after the engine comes back. Measured 2026-07-28: a daemon
 * that was unreachable for ~90 seconds left the gateway refusing for the rest of
 * the window, because nothing retried and no capture arrived to kick one. A
 * 30-second blip must not become a 15-minute outage.
 *
 * So: renew slowly while healthy, poll quickly while not.
 */
export function startLeaseLoop(): void {
  if (timer) return;
  const tick = async () => {
    const s = await refreshLease();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, s.granted ? RENEW_MS : RETRY_MS);
    // Do not hold the process open for a lease renewal.
    if (typeof timer.unref === 'function') timer.unref();
  };
  // Placeholder so a concurrent start() is a no-op while the first tick is in flight.
  timer = setTimeout(() => { /* replaced by tick */ }, RETRY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
}

/** Tests / shutdown. */
export function stopLeaseLoop(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
