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
// This package is ESM ("type": "module"): `require` is not defined at runtime,
// and the first two corruption events after this file shipped (2026-09-02
// 19:24Z and 22:24Z) logged "forensic snapshot failed: require is not defined"
// instead of a snapshot — the one moment it was written for.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * Where the file lives, for the forensic snapshot. Set by startDbHealthMonitor;
 * the module still imports nothing from db.ts (see above).
 */
let dbFilePath: string | null = null;

/**
 * Every line this module writes carries a wall-clock stamp. gateway.log has
 * none, and on 2026-09-02 that alone made the corruption window undatable:
 * thirty transients and the detection itself sat in the log with no way to
 * say WHEN, while the daemon log that had timestamps had rotated. Module-local
 * on purpose — a global console patch is a hot-file change with test fallout.
 */
function hlog(msg: string, ...rest: unknown[]): void {
  console.error(`[${new Date().toISOString()}] ${msg}`, ...rest);
}

/**
 * PLAN-GATEWAY-DB-REPAIR addendum 2026-09-02 — the forensic snapshot.
 *
 * Third FTS-shadow corruption in a month. The investigation that followed could
 * name every writer (this process on SQLite 3.51; the Rust daemon, its CLI
 * subprocesses and the MCP server on 3.45), rule out iCloud, sleep, a second
 * SQLite copy in either process, fork-with-open-handle, file watchers and plain
 * open()/close() of the file — and then stopped, because the two facts that
 * would decide it were gone: WHEN it started (this log carries no timestamps,
 * the daemon's had rotated) and WHO held the file at that moment. The 30
 * HANDLE-LOCAL transients that preceded the damage are the earliest signal we
 * have, and they were logged with nothing beside them.
 *
 * So at the first transient, every tenth after it, and at CORRUPTION DETECTED,
 * write to `.vodou/logs/db-forensics.log`: an ISO timestamp, the inode + size of
 * db / -wal / -shm, `lsof` of the three (every process holding them, WITH the
 * inode each fd points at — a process holding a -shm inode that no longer
 * matches the file on disk is the signature of a torn WAL-index, which is the
 * one mechanism that produces cross-linked pages at the growth frontier), and
 * this connection's data_version / freelist / page_count. Best-effort and
 * bounded: lsof is given two seconds and the whole thing is skipped rather than
 * allowed to block the event loop.
 */
function forensicSnapshot(reason: string, detail: string): void {
  if (!dbFilePath) return;
  try {
    const files = [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`];
    const lines: string[] = [`=== ${new Date().toISOString()} pid=${process.pid} ${reason}`, `detail: ${detail.slice(0, 300)}`];
    for (const f of files) {
      try {
        const st = fs.statSync(f);
        lines.push(`stat ${path.basename(f)}: inode=${st.ino} size=${st.size} mtime=${st.mtime.toISOString()}`);
      } catch (e) {
        lines.push(`stat ${path.basename(f)}: ${(e as Error).message}`);
      }
    }
    try {
      const out = execFileSync('lsof', ['-w', '-n', ...files], { encoding: 'utf8', timeout: 2000 });
      lines.push('lsof:');
      for (const l of out.split('\n').filter(Boolean)) lines.push(`  ${l}`);
    } catch (e) {
      lines.push(`lsof: ${(e as Error).message.split('\n')[0]}`);
    }
    try {
      const db = dbProvider?.();
      if (db) {
        const one = (sql: string) => String(Object.values((db.prepare(sql).all() as Array<Record<string, unknown>>)[0] ?? {})[0] ?? '?');
        lines.push(`live handle: data_version=${one('PRAGMA data_version')} freelist=${one('PRAGMA freelist_count')} pages=${one('PRAGMA page_count')} journal=${one('PRAGMA journal_mode')}`);
      }
    } catch (e) {
      lines.push(`live handle: ${(e as Error).message.slice(0, 120)}`);
    }
    const dir = path.join(path.dirname(dbFilePath), '..', '..', '.vodou', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'db-forensics.log'), lines.join('\n') + '\n\n');
    hlog(`[db-health] forensic snapshot written (${reason}) → .vodou/logs/db-forensics.log`);
  } catch (e) {
    hlog(`[db-health] forensic snapshot failed: ${(e as Error).message.slice(0, 120)}`);
  }
}

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
  /**
   * PLAN-GATEWAY-DB-REPAIR addendum 2026-09-04 — when this process's -wal/-shm
   * were replaced underneath it. Sticky: a connection whose sidecars were
   * deleted is stranded until it is restarted, and a later clean read does not
   * un-strand it. `null` means it has not happened in this process.
   *
   * Separate from `ok` on purpose. `ok:false` says THE FILE is damaged and wants
   * a repair; this says THE PROCESS is orphaned and wants a restart, and the two
   * ask for opposite things — running the repair script against a healthy file
   * is how you lose the rows only the live WAL still has.
   */
  strandedAt: number | null;
}

let state: DbHealth = {
  ok: true, checkedAt: null, source: null, error: null,
  freelistCount: null, pageCount: null, fullCheckAt: null, fullCheckOk: null,
  transientCount: 0, lastTransientAt: null, strandedAt: null,
};

/** Inodes of the two WAL sidecars, as this process last saw them. */
export interface SidecarInodes { wal: number | null; shm: number | null }

/**
 * PLAN-GATEWAY-DB-REPAIR addendum 2026-09-04 — the stranded-connection detector.
 *
 * The fourth incident in a month was not damage at all. Docker Desktop had this
 * repo file-shared into its Linux VM; a guest SQLite opened gateway.db, could
 * see neither the host's POSIX locks nor its mmap'd WAL-index, concluded it was
 * the only connection, checkpointed, and on close DELETED -wal and -shm. New
 * inodes appeared at 07:02. Three host processes went on writing into files that
 * no longer had names, and at 07:10 quick_check condemned a database that every
 * out-of-process check found perfect: full integrity_check ok, FTS5
 * integrity-check clean, 77,900 messages present. What HAD diverged was the
 * freelist — 742 on disk against the gateway handle's 803, two disjoint WAL
 * worlds over one main file, which is the documented way to cross-link a tree.
 *
 * The mechanism was already written down, one comment up: "a process holding a
 * -shm inode that no longer matches the file on disk is the signature of a torn
 * WAL-index". Nothing checked for it. This does, in two stat() calls.
 *
 * Why the check is sound rather than merely suggestive: in WAL mode -wal and
 * -shm are removed only when the LAST connection closes. This process holds one
 * open continuously, so an inode that changes underneath it was removed by
 * somebody who could not see us. There is no benign version of that.
 *
 * It buys two things the corruption flag cannot. It dates the event at the swap
 * instead of at the first cross-linked page — 07:02, not 07:10 — and it points
 * at the right repair. `ok:false` means the file is damaged and wants
 * repair-gateway-db.sh; this means the file is fine and the PROCESS must be
 * restarted, and running the first prescription on the second problem discards
 * whatever rows only the live WAL still holds.
 */
export function sidecarSwapDescription(was: SidecarInodes, now: SidecarInodes): string | null {
  const swapped: string[] = [];
  for (const k of ['wal', 'shm'] as const) {
    const before = was[k];
    const after = now[k];
    // Only a sidecar we actually saw can go missing on us. `before === null`
    // means it had not been created when we armed — the ordinary state of a
    // database nobody has written to yet, and not evidence of anything.
    if (before === null) continue;
    if (after === null) swapped.push(`-${k}: inode ${before} → missing`);
    else if (after !== before) swapped.push(`-${k}: inode ${before} → ${after}`);
  }
  return swapped.length ? swapped.join(', ') : null;
}

/** What this process armed against. Null until the first sidecar exists. */
let sidecarsAtOpen: SidecarInodes | null = null;

function readSidecarInodes(): SidecarInodes | null {
  if (!dbFilePath) return null;
  const ino = (f: string): number | null => {
    try { return fs.statSync(f).ino; } catch { return null; }
  };
  return { wal: ino(`${dbFilePath}-wal`), shm: ino(`${dbFilePath}-shm`) };
}

/**
 * Arm on first sighting, then compare on every tick. Runs whether or not
 * quick_check passed: the swap is the earliest observable moment, and on
 * 2026-09-04 it preceded the first failing check by eight minutes.
 *
 * Re-arms after reporting so a second swap is also caught, but `strandedAt`
 * stays latched — this connection does not recover by being looked at again.
 */
function noteSidecarSwap(): void {
  const now = readSidecarInodes();
  if (!now) return;
  if (!sidecarsAtOpen) {
    if (now.wal !== null || now.shm !== null) sidecarsAtOpen = now;
    return;
  }
  const swap = sidecarSwapDescription(sidecarsAtOpen, now);
  sidecarsAtOpen = now;
  if (!swap) return;
  state = { ...state, strandedAt: state.strandedAt ?? Date.now() };
  forensicSnapshot('SIDECAR SWAP — this connection is stranded', swap);
  hlog(
    `[db-health] STRANDED CONNECTION — gateway.db ${swap}. In WAL mode those files are removed ` +
    `only when the LAST connection closes, and this process never closed one, so something that ` +
    `cannot see our locks replaced them: a container or VM with this directory shared in, a second ` +
    `SQLite build, or a backup tool.\n` +
    `[db-health] The FILE is probably fine — check it out of process. THIS PROCESS is now writing ` +
    `into an orphaned WAL that nobody else can read, and its freelist has already diverged from the file's.\n` +
    `[db-health] Fix: stop whatever else holds the file, then RESTART this process with kill -9 — NOT a ` +
    `graceful stop. A clean close checkpoints the orphaned WAL into a main file that has moved on, ` +
    `which turns a healthy database into a damaged one.`
  );
}

/**
 * While the flag stays latched, how often to say so again.
 *
 * On 2026-09-04 this module spent four and a half hours in the confirmed-failure
 * branch with `state.ok` already false. Twenty-five ticks; every one of them
 * logged NOTHING, because the alarm sat inside `if (state.ok)`. The 10:26 full
 * integrity_check failed into the same silence. The verdict even moved
 * underneath — `2nd reference to page 56933` became `Rowid 687194767425 out of
 * order` — and neither was snapshotted.
 *
 * From the log, a latch that goes quiet is indistinguishable from a monitor that
 * died, and the first thing the operator did was assume the timer was dead. So:
 * repeat on a slow cadence, and always speak when the verdict CHANGES — a moving
 * error is a live process, not a frozen flag.
 */
const RELATCH_LOG_INTERVAL_MS = 30 * 60_000;
const lastAlarm = new Map<string, { at: number; detail: string }>();
/** When the flag last went from ok to not-ok. The "how long has this been true?"
 *  the 2026-09-04 log could not answer. */
let latchedSince: number | null = null;

/** Human duration for a log line: the operator reads hours, not epoch millis. */
function describeAge(since: number | null): string {
  if (since === null) return 'an unknown time';
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 360) / 10}h`;
}

/**
 * True when a still-latched failure has earned another line (and a snapshot).
 * Keyed by source: quick_check every 10 minutes and integrity_check every 6 hours
 * are separate verdicts, and sharing one slot would make each look like a change
 * of the other and defeat the throttle entirely.
 */
function alarmIsDue(key: string, detail: string): boolean {
  const prev = lastAlarm.get(key);
  if (!prev || prev.detail !== detail || Date.now() - prev.at >= RELATCH_LOG_INTERVAL_MS) {
    lastAlarm.set(key, { at: Date.now(), detail });
    return true;
  }
  return false;
}

/** Clearing the flag also clears the repeat throttle, so the next alarm is instant. */
function resetAlarmThrottle(): void {
  lastAlarm.clear();
  latchedSince = null;
}

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
    forensicSnapshot('CORRUPTION DETECTED on a write', message);
    hlog(
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
    hlog('[db-health] no database provider registered — quick_check skipped');
    return state;
  }
  // Before reading anything: has somebody replaced our -wal/-shm? This is the
  // earliest observable moment of the 2026-09-04 failure and it ran eight
  // minutes ahead of the first quick_check that noticed. Inert with no file path
  // (unit tests, in-memory databases).
  noteSidecarSwap();
  try {
    const rows = getDbHandle().prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    // A healthy database answers with exactly one row reading "ok".
    const first = rows.length ? String(Object.values(rows[0])[0] ?? '') : '';
    const healthy = rows.length === 1 && first.toLowerCase() === 'ok';
    const counts = readCounts(getDbHandle());
    if (healthy) {
      if (!state.ok) {
        hlog(
          `[db-health] gateway.db is clean again (quick_check ok) — clearing the corruption flag ` +
          `after ${describeAge(latchedSince)}.`
        );
        resetAlarmThrottle();
      }
      // One line per tick on purpose: freelist/page counts are the timeline the
      // next incident gets dated against (today's took an hour of log archaeology).
      hlog(`[db-health] quick_check ok · freelist=${counts.freelist ?? '?'} pages=${counts.pages ?? '?'}`);
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
        if (n === 1 || n % 10 === 0) forensicSnapshot(`transient #${n}${handleLocal ? ' (handle-local)' : ''}`, detail);
        if (handleLocal) {
          // Distinct from a re-read that cleared: this one FAILED every time on
          // the live handle and PASSED on a new one. Naming it is the difference
          // between "the disk hiccuped" and "our connection is confused", and
          // only the second tells you where to look.
          hlog(
            `[db-health] HANDLE-LOCAL quick_check failure #${n} — the live connection reports ` +
            `corruption and a FRESH connection to the same file reads clean. The file is not ` +
            `damaged; this handle cannot read it. NOT latching: ${detail}`
          );
        }
        hlog(
          `[db-health] TRANSIENT quick_check failure #${n} (re-read clean, NOT latching): ${detail}\n` +
          `[db-health] The file is fine right now. Repeated transients still mean stress — ` +
          `heavy concurrent I/O, a checkpoint, or an overloaded disk.`
        );
        if (n >= 3) {
          hlog(
            `[db-health] ${n} transients this process — that is a pattern, not luck. ` +
            `Run: sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
          );
        }
        state = { ...state, ok: true, checkedAt: Date.now(), source: 'quick_check', error: null,
          freelistCount: counts.freelist, pageCount: counts.pages,
          transientCount: n, lastTransientAt: Date.now() };
      } else {
        // A latched flag is not a reason to go quiet — see RELATCH_LOG_INTERVAL_MS.
        // First failure always speaks; after that, on a change of verdict or the
        // slow cadence, so the log can tell "still broken" from "monitor died".
        const first = state.ok;
        if (first) latchedSince = Date.now();
        // `alarmIsDue` is called unconditionally so the throttle is armed by the
        // first line too — otherwise the second tick, ten minutes later, would
        // read as "changed" and repeat immediately.
        const due = alarmIsDue('quick_check', detail);
        if (first || due) {
          forensicSnapshot(first ? 'CORRUPTION DETECTED by quick_check' : 'STILL FAILING quick_check', detail);
          hlog(
            `[db-health] ${first ? 'CORRUPTION DETECTED by' : 'STILL FAILING —'} quick_check ` +
            `(${lineCount} problem line(s), confirmed by ${CONFIRM_ATTEMPTS} re-read(s))` +
            `${first ? '' : `, latched ${describeAge(latchedSince)} ago`}: ${detail}\n` +
            (state.strandedAt
              // Stranded is a different diagnosis with a different repair, and
              // saying "messages will be LOST" here sends the operator to the
              // repair script — at a file that is not damaged.
              ? `[db-health] This connection is STRANDED (its -wal/-shm were replaced at ` +
                `${new Date(state.strandedAt).toISOString()}), so this verdict is about OUR VIEW, not the file. ` +
                `Verify out of process, then restart with kill -9 — never a graceful stop.\n`
              : `[db-health] Writes will start failing and messages will be LOST.\n`) +
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
      hlog('[db-health] quick_check could not run (not treated as corruption):', msg);
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
    if (isCorruptionError(msg)) problems.push(msg); else hlog('[db-health] integrity_check could not run:', msg);
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
    hlog(`[db-health] integrity_check ok (${ms}ms) · freelist=${counts.freelist ?? '?'} pages=${counts.pages ?? '?'}`);
    state = { ...state, fullCheckAt: Date.now(), fullCheckOk: true, freelistCount: counts.freelist, pageCount: counts.pages };
    return state;
  }
  const structural = problems.filter(isStructuralIntegrityLine);
  const detail = (structural[0] ?? problems[0]).slice(0, 200);
  const firstFull = state.ok;
  if (firstFull) latchedSince = Date.now();
  // Same silence, same cause: on 2026-09-04 this branch ran with `ok` already
  // false and said nothing, so the ONE full check of the incident — the check
  // that would have settled whether the file was damaged — left no trace at all.
  const fullDue = alarmIsDue('integrity_check', detail);
  if (firstFull || fullDue) {
    hlog(
      `[db-health] ${firstFull ? 'CORRUPTION DETECTED by' : 'STILL FAILING —'} integrity_check ` +
      `(${problems.length} problem line(s), ${structural.length} structural)` +
      `${firstFull ? '' : `, latched ${describeAge(latchedSince)} ago`}: ${detail}\n` +
      (state.strandedAt
        ? `[db-health] This connection is STRANDED (its -wal/-shm were replaced at ` +
          `${new Date(state.strandedAt).toISOString()}). Do NOT run the repair script on this verdict — ` +
          `re-check the file out of process first; if it is clean, the fix is a kill -9 restart.\n`
        : `[db-health] Repair: bash scripts/repair-gateway-db.sh --dry-run   (then without --dry-run; it stops services, recovers into a fresh file, verifies, swaps)`)
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
  // A stranded connection is at its most dangerous here. Closing it cleanly
  // invites SQLite to checkpoint an orphaned WAL into a main file that other
  // processes have moved on from — the one action that converts "this process
  // is confused" into "this database is damaged". We cannot stop the close that
  // is already happening; we can make sure the next operator knows not to use
  // one, and that the forensic record says a graceful exit occurred.
  if (state.strandedAt !== null) {
    hlog(
      `[db-health] GRACEFUL SHUTDOWN OF A STRANDED CONNECTION — its -wal/-shm were replaced at ` +
      `${new Date(state.strandedAt).toISOString()} and it may now checkpoint an orphaned WAL into ` +
      `the live file. Verify out of process before restarting: ` +
      `sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;". ` +
      `Next time, stop a stranded gateway with kill -9.`
    );
    forensicSnapshot('graceful shutdown while stranded', `stranded since ${new Date(state.strandedAt).toISOString()}`);
  }
  try {
    const h = runQuickCheck();
    const counts = readCounts(dbProvider());
    hlog(`[db-health] shutdown quick_check: ${h.ok ? 'ok' : 'NOT OK (' + (h.error ?? '') + ')'} · freelist=${counts.freelist ?? '?'} pages=${counts.pages ?? '?'}`);
  } catch (e) {
    hlog('[db-health] shutdown quick_check could not run:', (e as Error)?.message);
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
  /** Path of the file, for the forensic snapshot (stat + lsof). Optional. */
  filePath?: string,
): void {
  dbProvider = provider;
  freshProvider = fresh ?? null;
  dbFilePath = filePath ?? null;
  if (!fresh) {
    hlog('[db-health] no fresh-connection provider — a handle-local fault will latch as corruption');
  }
  const raw = process.env.VODOU_DB_HEALTH_INTERVAL_MS;
  const intervalMs = raw !== undefined ? parseInt(raw, 10) : 600_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    hlog('[db-health] periodic quick_check disabled (VODOU_DB_HEALTH_INTERVAL_MS=0)');
    return;
  }
  // One scan at boot so a gateway that starts on an already-damaged file says
  // so immediately, rather than after the first interval.
  setTimeout(() => runQuickCheck(), 2000);
  const timer = setInterval(() => runQuickCheck(), intervalMs);
  // Never hold the process open for this.
  if (typeof timer.unref === 'function') timer.unref();
  hlog(`[db-health] gateway.db quick_check every ${Math.round(intervalMs / 1000)}s`);
  // H4 — full integrity_check on its own cadence (default 6h; 0 disables), first one 60s after boot.
  const rawFull = process.env.VODOU_DB_INTEGRITY_INTERVAL_MS;
  const fullMs = rawFull !== undefined ? parseInt(rawFull, 10) : 6 * 3_600_000;
  if (Number.isFinite(fullMs) && fullMs > 0) {
    const t0 = setTimeout(() => runFullIntegrityCheck(), 60_000);
    const tf = setInterval(() => runFullIntegrityCheck(), fullMs);
    if (typeof t0.unref === 'function') t0.unref();
    if (typeof tf.unref === 'function') tf.unref();
    hlog(`[db-health] gateway.db full integrity_check every ${Math.round(fullMs / 3_600_000 * 10) / 10}h`);
  }
}
