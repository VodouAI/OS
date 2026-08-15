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
type DbLike = { prepare(sql: string): { all(): unknown[] } };
let dbProvider: (() => DbLike) | null = null;

export interface DbHealth {
  ok: boolean;
  /** epoch ms of the last quick_check, or null if it has not run yet. */
  checkedAt: number | null;
  /** What told us it was bad: a failed write, or the periodic scan. */
  source: 'write' | 'quick_check' | null;
  /** First line of the failure, trimmed — enough to recognise, not a dump. */
  error: string | null;
}

let state: DbHealth = { ok: true, checkedAt: null, source: null, error: null };

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
  state = { ok: false, checkedAt: Date.now(), source: 'write', error: message.slice(0, 300) };
}

/** Run quick_check now and update state. Returns the resulting health. */
export function runQuickCheck(provider?: () => DbLike): DbHealth {
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
    if (healthy) {
      if (!state.ok) {
        console.error('[db-health] gateway.db is clean again (quick_check ok) — clearing the corruption flag.');
      }
      state = { ok: true, checkedAt: Date.now(), source: 'quick_check', error: null };
    } else {
      // quick_check can answer with ONE row holding a hundred lines of btree
      // detail, so slicing rows is not enough — cap the text. The point of the
      // log line is "your database is damaged", not a forensic dump; the full
      // report is one `PRAGMA integrity_check` away and is printed below.
      const raw = rows.map((r) => String(Object.values(r)[0] ?? '')).join('; ');
      const firstLine = raw.split('\n').find((l) => l.trim() && !l.startsWith('***')) ?? raw;
      const detail = firstLine.trim().slice(0, 200);
      const lineCount = raw.split('\n').filter((l) => l.trim()).length;
      if (state.ok) {
        console.error(
          `[db-health] CORRUPTION DETECTED by quick_check (${lineCount} problem line(s)): ${detail}\n` +
          `[db-health] Writes will start failing and messages will be LOST.\n` +
          `[db-health] Full report: sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
        );
      }
      state = { ok: false, checkedAt: Date.now(), source: 'quick_check', error: detail.slice(0, 300) };
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
 * Start the periodic scan. Default 10 minutes: the incident this exists for ran
 * ~46 hours undetected, so anything on a minutes scale is a large win, and the
 * check is ~100ms. Set VODOU_DB_HEALTH_INTERVAL_MS=0 to disable.
 */
export function startDbHealthMonitor(provider: () => DbLike): void {
  dbProvider = provider;
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
}
