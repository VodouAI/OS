/**
 * gateway.db corruption watch.
 *
 * Why this exists: on 2026-08-15 the gateway had been unable to save a single
 * message for ~46 hours and nothing said so. `gateway_messages_fts_data` — the
 * FTS5 index shadow table — was structurally corrupt, and because an AFTER
 * INSERT trigger writes that index on every message, every write failed with
 * "database disk image is malformed". Reads were perfect the whole time, so the
 * UI looked fine, /health said ok, and 92 failures scrolled past in a log
 * nobody was tailing. The same thing had happened on 2026-08-04
 * (gateway.db.bak-corrupt-fts-20260804), which makes it a pattern rather than
 * bad luck.
 *
 * Two detectors, because they fail in opposite directions:
 *
 *   1. A write that ACTUALLY failed with a corruption error. Zero cost, zero
 *      false positives, and it fires the instant the damage matters — but only
 *      once someone has already lost a message.
 *   2. A periodic `PRAGMA quick_check`. Costs ~100ms on a 169 MB database and
 *      can catch damage BEFORE a user hits it, but only as often as it runs.
 *
 * Deliberately NOT wired into the `status` field of /health. `src/index.ts`
 * treats `status === 'ok'` as "a healthy gateway owns this port", and a
 * degraded status there would invite the port-reclaim path to kill a gateway
 * that is serving reads perfectly well. Corruption is a data emergency, not a
 * reason to shoot the process — so it gets its own field and a loud log line.
 */

// Deliberately imports NOTHING from db.ts. db.ts reports corruption INTO this
// module (its FTS self-heal is the earliest place damage shows up), so an
// import back the other way would be a cycle. The database handle is injected
// instead — see startDbHealthMonitor.
type DbLike = { prepare(sql: string): { all(): unknown[]; run?(): unknown } };
let dbProvider: (() => DbLike) | null = null;

/**
 * Opens a NEW connection to the same file. Optional, and the reason it exists is
 * the 2026-08-30 false alarm:
 *
 * `quickCheckOnce` re-read through `dbProvider()` — the SAME long-lived handle
 * that had just failed. So the confirm loop, whose entire job is to separate a
 * transient fault from real damage, could only ever confirm what that one
 * connection believed. A fault local to the handle (a stale page in its cache, a
 * WAL snapshot it cannot resolve) failed three times in a row and latched
 * "CORRUPTION DETECTED — messages will be LOST", while writes kept landing and
 * every out-of-process check passed: `PRAGMA quick_check` ok, the full
 * `PRAGMA integrity_check` ok, the FTS `integrity-check` clean.
 *
 * An alarm built after 46 hours of silent write failure must not cry wolf: the
 * cost of a false positive is that the next real one goes unread.
 */
let freshProvider: (() => DbLike) | null = null;

export interface DbHealth {
  ok: boolean;
  /** epoch ms of the last quick_check, or null if it has not run yet. */
  checkedAt: number | null;
  /** What told us it was bad: a failed write, the periodic scan, or the full check. */
  source: 'write' | 'quick_check' | 'integrity_check' | null;
  /** First line of the failure, trimmed — enough to recognise, not a dump. */
  error: string | null;
  /**
   * PLAN-GATEWAY-DB-REPAIR H4 — freelist/page counts from the last scan. A WRONG
   * freelist ("Freelist: size is X but should be Y") is the seed of every
   * corruption we have had: SQLite hands an in-use page to the next writer (the
   * FTS index) and the trees cross-link. The count itself is not an error, but
   * it belongs on the timeline so the next incident can be dated.
   */
  freelistCount: number | null;
  pageCount: number | null;
  /** epoch ms of the last FULL integrity_check (+ FTS5 integrity-check), or null. */
  fullCheckAt: number | null;
  fullCheckOk: boolean | null;
  /**
   * Confirm-before-latch bookkeeping (2026-08-17).
   *
   * A quick_check that fails ONCE and then passes on immediate re-verification was
   * an unlucky read, not a damaged file. Observed that day: the tick reported
   * `fts5: corruption found reading blob …` while 2.8 GB of directories were being
   * moved; six consecutive quick_checks, a full integrity_check, an FTS
   * integrity-check and a 16,494-row MATCH were all clean minutes later, and
   * writes never stopped. But `ok` had latched, so /health told the operator
   * "messages will be LOST" for ten minutes while nothing was lost.
   *
   * An alarm that cries wolf gets ignored, which is the same failure this whole
   * module exists to prevent — so a transient is counted and logged rather than
   * either latched or silently dropped. Repeated transients are their own signal:
   * they mean the file is under stress even if no single check condemns it.
   */
  transientCount: number;
  lastTransientAt: number | null;
}

let state: DbHealth = {
  ok: true, checkedAt: null, source: null, error: null,
  freelistCount: null, pageCount: null, fullCheckAt: null, fullCheckOk: null,
  transientCount: 0, lastTransientAt: null,
};

/**
 * How many extra quick_checks to run before believing a failure.
 *
 * Deliberately IMMEDIATE re-reads with no sleep: this runs on the gateway's event
 * loop and blocking it to wait out a maybe-transient would trade a false alarm for
 * real latency. An unlucky read caused by contention usually clears on the very
 * next attempt, and a genuinely corrupt b-tree fails every time — so repetition
 * separates them without a delay.
 */
const CONFIRM_ATTEMPTS = 2;

/** One quick_check. Returns null when it could not run at all. */
/**
 * Ask a FRESH connection whether the file is damaged.
 *
 * Returns `null` when there is no fresh provider or the check could not run —
 * "could not ask" is not "the file is fine", and the caller must not read it as
 * an all-clear.
 */
function quickCheckFresh(override?: () => DbLike): boolean | null {
  const open = override ?? freshProvider;
  if (!open) return null;
  let handle: DbLike | null = null;
  try {
    handle = open();
    const rows = handle.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const first = rows.length ? String(Object.values(rows[0])[0] ?? '') : '';
    return rows.length === 1 && first.toLowerCase() === 'ok';
  } catch {
    return null;
  } finally {
    // Never leak a handle per tick. `close` is best-effort: a provider that
    // hands back a shared connection must not be closed out from under it.
    try { (handle as unknown as { close?: () => void } | null)?.close?.(); } catch { /* not ours to close */ }
  }
}

function quickCheckOnce(getDbHandle: () => DbLike): { healthy: boolean; raw: string } | null {
  try {
    const rows = getDbHandle().prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const first = rows.length ? String(Object.values(rows[0])[0] ?? '') : '';
    return {
      healthy: rows.length === 1 && first.toLowerCase() === 'ok',
      raw: rows.map((r) => String(Object.values(r)[0] ?? '')).join('; '),
    };
  } catch {
    return null;
  }
}

/** Lines that mean STRUCTURAL damage even if the rest of the file reads fine. */
export function isStructuralIntegrityLine(line: string): boolean {
  const l = line.toLowerCase();
  return l.startsWith('freelist:') || l.includes('2nd reference to page') || l.includes('btreeinitpage')
    || l.includes('invalid page number') || l.includes('never used') || l.includes('malformed');
}

function readCounts(db: DbLike): { freelist: number | null; pages: number | null } {
  const one = (sql: string): number | null => {
    try {
      const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
      const v = rows.length ? Number(Object.values(rows[0])[0]) : NaN;
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  };
  return { freelist: one('PRAGMA freelist_count'), pages: one('PRAGMA page_count') };
}

/**
 * Does this error mean the FILE is damaged, as opposed to busy/locked/readonly?
 * Only the first kind should latch — a transient SQLITE_BUSY under load must
 * never make the gateway claim its database is corrupt.
 */
export function isCorruptionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('database disk image is malformed') ||
    m.includes('sqlite_corrupt') ||
    m.includes('database corruption') ||
    m.includes('malformed database schema')
  );
}

/**
 * Latch a corruption verdict observed by a real write. Sticky on purpose: the
 * next write may well succeed (the damage is usually in one btree), and a flag
 * that clears itself would hide exactly the intermittent case that took two
 * days to notice. Only a clean quick_check clears it.
 */
export function reportWriteCorruption(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!isCorruptionError(message)) return;
  if (state.ok) {
    console.error(
      `[db-health] CORRUPTION DETECTED on a write: ${message}\n` +
      `[db-health] gateway.db cannot be written to. Messages are being LOST until this is repaired.\n` +
      `[db-health] Check: sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
    );
  }
  state = { ...state, ok: false, checkedAt: Date.now(), source: 'write', error: message.slice(0, 300) };
}

/** Run quick_check now and update state. Returns the resulting health. */
export function runQuickCheck(provider?: () => DbLike, freshOverride?: () => DbLike): DbHealth {
  const getDbHandle = provider ?? dbProvider;
  if (!getDbHandle) {
    console.error('[db-health] no database provider registered — quick_check skipped');
    return state;
  }
  try {
    const rows = getDbHandle().prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    // A healthy database answers with exactly one row reading "ok".
    const first = rows.length ? String(Object.values(rows[0])[0] ?? '') : '';
    const healthy = rows.length === 1 && first.toLowerCase() === 'ok';
    const counts = readCounts(getDbHandle());
    if (healthy) {
      if (!state.ok) {
        console.error('[db-health] gateway.db is clean again (quick_check ok) — clearing the corruption flag.');
      }
      // One line per tick on purpose: freelist/page counts are the timeline the
      // next incident gets dated against (today's took an hour of log archaeology).
      console.error(`[db-health] quick_check ok · freelist=${counts.freelist ?? '?'} pages=${counts.pages ?? '?'}`);
      state = { ...state, ok: true, checkedAt: Date.now(), source: 'quick_check', error: null,
        freelistCount: counts.freelist, pageCount: counts.pages };
    } else {
      // quick_check can answer with ONE row holding a hundred lines of btree
      // detail, so slicing rows is not enough — cap the text. The point of the
      // log line is "your database is damaged", not a forensic dump; the full
      // report is one `PRAGMA integrity_check` away and is printed below.
      const raw = rows.map((r) => String(Object.values(r)[0] ?? '')).join('; ');
      const firstLine = raw.split('\n').find((l) => l.trim() && !l.startsWith('***')) ?? raw;
      const detail = firstLine.trim().slice(0, 200);
      const lineCount = raw.split('\n').filter((l) => l.trim()).length;

      // CONFIRM BEFORE LATCHING. One failed read is not a damaged file — see the
      // note on `transientCount`. Re-read immediately; a contention-induced miss
      // clears, a broken b-tree does not.
      let confirmed = true;
      for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
        const again = quickCheckOnce(getDbHandle);
        if (again === null) continue;          // could not run — proves nothing
        if (again.healthy) { confirmed = false; break; }
      }

      // SECOND OPINION, on a connection that has never seen this failure.
      //
      // The loop above re-reads through the SAME handle, so it can only confirm
      // what that one connection believes. On 2026-08-30 that latched a false
      // "messages will be LOST" while writes kept landing and every
      // out-of-process check passed. A fresh handle reading the same bytes off
      // the same disk disagreeing with the old one is not evidence of damage —
      // it is evidence about the handle.
      //
      // Only ever DOWNGRADES. A fresh check cannot promote a passing read to a
      // failure, and `null` (no provider, or the open failed) leaves the verdict
      // exactly where the same-handle loop put it: not being able to ask is not
      // an all-clear.
      let handleLocal = false;
      if (confirmed) {
        const fresh = quickCheckFresh(freshOverride);
        if (fresh === true) {
          confirmed = false;
          handleLocal = true;
        }
      }

      if (!confirmed) {
        // Transient. Do NOT latch, do NOT claim data loss — but never swallow it
        // either: this is the only record that the file was under stress.
        const n = state.transientCount + 1;
        if (handleLocal) {
          // Distinct from a re-read that cleared: this one FAILED every time on
          // the live handle and PASSED on a new one. Naming it is the difference
          // between "the disk hiccuped" and "our connection is confused", and
          // only the second tells you where to look.
          console.error(
            `[db-health] HANDLE-LOCAL quick_check failure #${n} — the live connection reports ` +
            `corruption and a FRESH connection to the same file reads clean. The file is not ` +
            `damaged; this handle cannot read it. NOT latching: ${detail}`
          );
        }
        console.error(
          `[db-health] TRANSIENT quick_check failure #${n} (re-read clean, NOT latching): ${detail}\n` +
          `[db-health] The file is fine right now. Repeated transients still mean stress — ` +
          `heavy concurrent I/O, a checkpoint, or an overloaded disk.`
        );
        if (n >= 3) {
          console.error(
            `[db-health] ${n} transients this process — that is a pattern, not luck. ` +
            `Run: sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
          );
        }
        state = { ...state, ok: true, checkedAt: Date.now(), source: 'quick_check', error: null,
          freelistCount: counts.freelist, pageCount: counts.pages,
          transientCount: n, lastTransientAt: Date.now() };
      } else {
        if (state.ok) {
          console.error(
            `[db-health] CORRUPTION DETECTED by quick_check (${lineCount} problem line(s), confirmed by ` +
            `${CONFIRM_ATTEMPTS} re-read(s)): ${detail}\n` +
            `[db-health] Writes will start failing and messages will be LOST.\n` +
            `[db-health] Full report: sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
          );
        }
        state = { ...state, ok: false, checkedAt: Date.now(), source: 'quick_check', error: detail.slice(0, 300),
          freelistCount: counts.freelist, pageCount: counts.pages };
      }
    }
  } catch (e) {
    // The check itself failing to run is not evidence the file is damaged —
    // report it, but do not latch corruption on it.
    const msg = e instanceof Error ? e.message : String(e);
    if (isCorruptionError(msg)) {
      reportWriteCorruption(e);
    } else {
      console.error('[db-health] quick_check could not run (not treated as corruption):', msg);
      state = { ...state, checkedAt: Date.now() };
    }
  }
  return state;
}

export function getDbHealth(): DbHealth {
  return state;
}

/**
 * PLAN-GATEWAY-DB-REPAIR H4 — the FULL check: `PRAGMA integrity_check` (index
 * ↔ table consistency, freelist, page references — everything quick_check
 * skips) plus FTS5's own `integrity-check` on gateway_messages_fts. ~1–3 s on a
 * 180 MB file, so it runs on its own slower cadence (default 6 h) and once
 * shortly after boot. A structural line here latches the flag exactly like
 * quick_check does; the point is to see the SEED (a wrong freelist) days
 * before it cross-links a tree.
 */
export function runFullIntegrityCheck(provider?: () => DbLike): DbHealth {
  const getDbHandle = provider ?? dbProvider;
  if (!getDbHandle) return state;
  const started = Date.now();
  let problems: string[] = [];
  try {
    const rows = getDbHandle().prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const lines = rows.flatMap((r) => String(Object.values(r)[0] ?? '').split('\n')).map((l) => l.trim()).filter(Boolean);
    if (!(lines.length === 1 && lines[0].toLowerCase() === 'ok')) problems = lines.filter((l) => !l.startsWith('***'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isCorruptionError(msg)) problems.push(msg); else console.error('[db-health] integrity_check could not run:', msg);
  }
  try {
    // FTS5 external-content integrity: index ↔ gateway_messages. Newer SQLite
    // builds fold this into PRAGMA integrity_check; older ones do not — run it
    // explicitly so the verdict does not depend on which build the gateway got.
    const stmt = getDbHandle().prepare("INSERT INTO gateway_messages_fts(gateway_messages_fts) VALUES('integrity-check')");
    if (typeof stmt.run === 'function') stmt.run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // "no such table" (FTS absent) or readonly are not damage; fts5 corruption is.
    if (isCorruptionError(msg) || /fts5:.*corrupt/i.test(msg)) problems.push(`fts5 integrity-check: ${msg}`);
  }
  const counts = readCounts(getDbHandle());
  const ms = Date.now() - started;
  if (problems.length === 0) {
    console.error(`[db-health] integrity_check ok (${ms}ms) · freelist=${counts.freelist ?? '?'} pages=${counts.pages ?? '?'}`);
    state = { ...state, fullCheckAt: Date.now(), fullCheckOk: true, freelistCount: counts.freelist, pageCount: counts.pages };
    return state;
  }
  const structural = problems.filter(isStructuralIntegrityLine);
  const detail = (structural[0] ?? problems[0]).slice(0, 200);
  if (state.ok) {
    console.error(
      `[db-health] CORRUPTION DETECTED by integrity_check (${problems.length} problem line(s), ${structural.length} structural): ${detail}\n` +
      `[db-health] Repair: bash scripts/repair-gateway-db.sh --dry-run   (then without --dry-run; it stops services, recovers into a fresh file, verifies, swaps)`
    );
  }
  state = { ...state, ok: false, checkedAt: Date.now(), source: 'integrity_check', error: detail.slice(0, 300),
    fullCheckAt: Date.now(), fullCheckOk: false, freelistCount: counts.freelist, pageCount: counts.pages };
  return state;
}

/**
 * PLAN-GATEWAY-DB-REPAIR H3 — one quick_check on the way out. Twice the
 * corruption "surfaced across a restart" and the log could not say which side
 * of the restart it happened on. This line settles that next time.
 */
export function checkOnShutdown(): void {
  if (!dbProvider) return;
  try {
    const h = runQuickCheck();
    const counts = readCounts(dbProvider());
    console.error(`[db-health] shutdown quick_check: ${h.ok ? 'ok' : 'NOT OK (' + (h.error ?? '') + ')'} · freelist=${counts.freelist ?? '?'} pages=${counts.pages ?? '?'}`);
  } catch (e) {
    console.error('[db-health] shutdown quick_check could not run:', (e as Error)?.message);
  }
}

/**
 * Start the periodic scan. Default 10 minutes: the incident this exists for ran
 * ~46 hours undetected, so anything on a minutes scale is a large win, and the
 * check is ~100ms. Set VODOU_DB_HEALTH_INTERVAL_MS=0 to disable.
 */
export function startDbHealthMonitor(
  provider: () => DbLike,
  /** Opens a NEW connection to the same file — see `freshProvider`. Optional: a
   *  caller that cannot supply one keeps the old same-handle behaviour rather
   *  than losing the monitor. */
  fresh?: () => DbLike,
): void {
  dbProvider = provider;
  freshProvider = fresh ?? null;
  if (!fresh) {
    console.error('[db-health] no fresh-connection provider — a handle-local fault will latch as corruption');
  }
  const raw = process.env.VODOU_DB_HEALTH_INTERVAL_MS;
  const intervalMs = raw !== undefined ? parseInt(raw, 10) : 600_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.error('[db-health] periodic quick_check disabled (VODOU_DB_HEALTH_INTERVAL_MS=0)');
    return;
  }
  // One scan at boot so a gateway that starts on an already-damaged file says
  // so immediately, rather than after the first interval.
  setTimeout(() => runQuickCheck(), 2000);
  const timer = setInterval(() => runQuickCheck(), intervalMs);
  // Never hold the process open for this.
  if (typeof timer.unref === 'function') timer.unref();
  console.error(`[db-health] gateway.db quick_check every ${Math.round(intervalMs / 1000)}s`);
  // H4 — full integrity_check on its own cadence (default 6h; 0 disables), first one 60s after boot.
  const rawFull = process.env.VODOU_DB_INTEGRITY_INTERVAL_MS;
  const fullMs = rawFull !== undefined ? parseInt(rawFull, 10) : 6 * 3_600_000;
  if (Number.isFinite(fullMs) && fullMs > 0) {
    const t0 = setTimeout(() => runFullIntegrityCheck(), 60_000);
    const tf = setInterval(() => runFullIntegrityCheck(), fullMs);
    if (typeof t0.unref === 'function') t0.unref();
    if (typeof tf.unref === 'function') tf.unref();
    console.error(`[db-health] gateway.db full integrity_check every ${Math.round(fullMs / 3_600_000 * 10) / 10}h`);
  }
}
