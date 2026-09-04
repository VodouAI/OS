import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runQuickCheck, runFullIntegrityCheck, isStructuralIntegrityLine, getDbHealth, sidecarSwapDescription } from '../db-health.js';
// PLAN-GATEWAY-DB-REPAIR H4 — the full check must see what quick_check sees,
// plus FTS5's own verdict, and both must leave the counts on the timeline.
describe('db-health', () => {
    const mk = () => {
        const db = new DatabaseSync(':memory:');
        db.exec(`
      CREATE TABLE gateway_messages (id INTEGER PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT);
      CREATE VIRTUAL TABLE gateway_messages_fts USING fts5(content, content='gateway_messages', content_rowid='id');
      CREATE TRIGGER gateway_messages_fts_ai AFTER INSERT ON gateway_messages BEGIN
        INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      INSERT INTO gateway_messages (conversation_id, role, content) VALUES ('c','user','the quick brown fox');
    `);
        return db;
    };
    it('quick_check ok records freelist and page counts', () => {
        const db = mk();
        const h = runQuickCheck(() => db);
        expect(h.ok).toBe(true);
        expect(h.source).toBe('quick_check');
        expect(typeof h.pageCount).toBe('number');
        expect(typeof h.freelistCount).toBe('number');
    });
    it('full integrity_check ok on a healthy file, including FTS5 integrity-check', () => {
        const db = mk();
        const h = runFullIntegrityCheck(() => db);
        expect(h.fullCheckOk).toBe(true);
        expect(h.ok).toBe(true);
        expect(getDbHealth().fullCheckAt).not.toBeNull();
    });
    /**
     * Confirm-before-latch (2026-08-17). A quick_check that fails ONCE and then
     * reads clean was an unlucky read, not a damaged file.
     *
     * The incident: the tick reported `fts5: corruption found reading blob …` while
     * 2.8 GB of directories were being moved. Six quick_checks, a full
     * integrity_check, an FTS integrity-check and a 16,494-row MATCH were clean
     * minutes later and writes never stopped — but `ok` had latched, so /health said
     * "messages will be LOST" for ten minutes while nothing was. An alarm that cries
     * wolf gets ignored, which is the failure this module exists to prevent.
     *
     * A fake handle is used rather than a corrupted file because the point under
     * test is the DECISION (how many failures before latching), not SQLite's
     * detection. Deliberately corrupting a real b-tree would test SQLite.
     */
    const fakeDb = (verdicts) => {
        let i = 0;
        return () => ({
            prepare: (sql) => ({
                all: () => {
                    if (/quick_check/i.test(sql)) {
                        const v = verdicts[Math.min(i++, verdicts.length - 1)];
                        return [{ quick_check: v }];
                    }
                    // readCounts() asks for freelist/page pragmas — any number will do.
                    return [{ n: 0 }];
                },
                get: () => ({ n: 0 }),
                run: () => ({ changes: 0 }),
            }),
        });
    };
    it('does NOT latch when a failure does not reproduce on re-read', () => {
        // fail once, then clean — the exact shape of the 2026-08-17 false alarm.
        const h = runQuickCheck(fakeDb(['fts5: corruption found reading blob 137438955497', 'ok']));
        expect(h.ok).toBe(true); // no false "messages will be LOST"
        expect(h.error).toBeNull();
        expect(h.transientCount).toBeGreaterThan(0); // but it is NOT swallowed
        expect(h.lastTransientAt).not.toBeNull();
    });
    it('STILL latches when the failure reproduces every time', () => {
        // Real structural damage fails every read. The fix must not make the detector
        // toothless — that would be a worse bug than the false alarm.
        const h = runQuickCheck(fakeDb(['*** in database main *** Page 39133 is never used']));
        expect(h.ok).toBe(false);
        expect(h.error).toContain('39133');
        expect(h.source).toBe('quick_check');
    });
    it('classifies the structural lines that seed cross-linking', () => {
        expect(isStructuralIntegrityLine('Freelist: size is 1861 but should be 1887')).toBe(true);
        expect(isStructuralIntegrityLine('Tree 16 page 42932 cell 7: 2nd reference to page 31248')).toBe(true);
        expect(isStructuralIntegrityLine('Tree 16 page 39133: btreeInitPage() returns error code 11')).toBe(true);
        expect(isStructuralIntegrityLine('Page 30589: never used')).toBe(true);
        expect(isStructuralIntegrityLine('row 5 missing from index idx_foo')).toBe(false);
    });
    // ── the 2026-08-30 false alarm ───────────────────────────────────────────
    //
    // The confirm loop re-read through the SAME handle that had just failed, so it
    // could only ever confirm what that one connection believed. A handle-local
    // fault failed every re-read and latched "CORRUPTION DETECTED — messages will
    // be LOST" while writes kept landing and every out-of-process check passed:
    // quick_check ok, the full integrity_check ok, the FTS integrity-check clean.
    //
    // An alarm built after 46 hours of silent write failure must not cry wolf —
    // the cost of a false positive is that the next real one goes unread.
    describe('a second opinion, on a connection that has not seen the failure', () => {
        const corrupt = 'fts5: corruption found reading blob 1786706395188';
        it('does NOT latch when a fresh connection reads the same file clean', () => {
            const h = runQuickCheck(fakeDb([corrupt, corrupt, corrupt]), () => mk());
            expect(h.ok, 'the file is fine; this handle cannot read it').toBe(true);
            expect(h.error).toBeNull();
            expect(h.transientCount).toBeGreaterThan(0); // recorded, never swallowed
        });
        it('STILL latches when the fresh connection agrees the file is damaged', () => {
            const h = runQuickCheck(fakeDb([corrupt, corrupt, corrupt]), fakeDb([corrupt]));
            expect(h.ok, 'two independent connections agreeing is real damage').toBe(false);
            expect(h.error).toContain('fts5: corruption');
        });
        // "Could not ask" is not "the file is fine". A fresh provider that throws
        // must leave the verdict exactly where the same-handle loop put it.
        it('a fresh provider that throws does not rescue the verdict', () => {
            const h = runQuickCheck(fakeDb([corrupt, corrupt, corrupt]), () => {
                throw new Error('cannot open the database file');
            });
            expect(h.ok).toBe(false);
        });
        it('with NO fresh provider the old behaviour is unchanged', () => {
            const h = runQuickCheck(fakeDb([corrupt, corrupt, corrupt]));
            expect(h.ok).toBe(false);
        });
        // The downgrade is one-directional: a fresh check can clear a failure, never
        // invent one.
        it('a healthy read is never demoted by the fresh check', () => {
            const h = runQuickCheck(() => mk(), fakeDb([corrupt]));
            expect(h.ok).toBe(true);
        });
        // The original transient path still works: a re-read on the SAME handle that
        // clears is a disk hiccup, and must not need a fresh connection to be caught.
        it('a same-handle re-read that clears is still transient', () => {
            const h = runQuickCheck(fakeDb([corrupt, 'ok']));
            expect(h.ok).toBe(true);
            expect(h.transientCount).toBeGreaterThan(0);
        });
    });
    // ── the 2026-09-04 incident, part one: a latch that went quiet ───────────
    //
    // The alarm sat inside `if (state.ok)`, so the FIRST confirmed failure spoke
    // and every one after it was silent. The flag stayed up four and a half hours
    // across twenty-five ticks and one failed full integrity_check, logging
    // nothing — and the verdict moved underneath it, from `2nd reference to page
    // 56933` to `Rowid 687194767425 out of order`, with no record of either.
    //
    // From the log that is indistinguishable from a monitor that died, which is
    // exactly what the operator concluded.
    describe('a latched flag keeps speaking', () => {
        const said = (spy) => spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        const A = '*** in database main *** Tree 44 page 44599 cell 0: 2nd reference to page 56933';
        const B = '*** in database main *** Tree 44 page 44599 cell 291: Rowid 687194767425 out of order';
        it('says so again when the verdict changes underneath the latch', () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            try {
                expect(runQuickCheck(fakeDb([A])).ok).toBe(false);
                expect(said(spy)).toContain('CORRUPTION DETECTED');
                spy.mockClear();
                const second = runQuickCheck(fakeDb([B]));
                expect(second.ok).toBe(false);
                expect(said(spy), 'a moving error is a live process, not a frozen flag').toContain('STILL FAILING');
                expect(said(spy)).toContain('687194767425');
            }
            finally {
                spy.mockRestore();
            }
        });
        // The other half of the fix: repeating an unchanged verdict every ten
        // minutes is a log flood, and a flood is ignored the same way silence is.
        it('does not repeat an unchanged verdict inside the throttle window', () => {
            const C = '*** in database main *** Page 30589: never used';
            runQuickCheck(fakeDb([C])); // latches and arms the throttle
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            try {
                expect(runQuickCheck(fakeDb([C])).ok).toBe(false);
                expect(spy.mock.calls.length).toBe(0);
            }
            finally {
                spy.mockRestore();
            }
        });
    });
    // ── the 2026-09-04 incident, part two: what actually happened ────────────
    //
    // Docker Desktop had the repo file-shared into its Linux VM. A guest SQLite
    // opened gateway.db, could see neither the host's POSIX locks nor its mmap'd
    // WAL-index, decided it was the only connection, and on close deleted -wal and
    // -shm. Three host processes kept writing into files with no names; the file
    // itself stayed perfect (integrity_check ok, FTS clean, 77,900 rows) while the
    // gateway's freelist read 803 against the file's 742.
    //
    // In WAL mode the sidecars are removed only when the LAST connection closes.
    // This process never closes one, so an inode that moves underneath it was
    // removed by somebody who could not see us. There is no benign version.
    describe('a connection stranded by a sidecar swap', () => {
        it('says nothing while the inodes hold', () => {
            const same = { wal: 146979904, shm: 146979905 };
            expect(sidecarSwapDescription(same, { ...same })).toBeNull();
        });
        it('names both sidecars when they are replaced underneath us', () => {
            const d = sidecarSwapDescription({ wal: 146979904, shm: 146979905 }, { wal: 150851813, shm: 150851814 });
            expect(d).toContain('146979904 → 150851813');
            expect(d).toContain('146979905 → 150851814');
        });
        it('reports a sidecar that vanished', () => {
            expect(sidecarSwapDescription({ wal: 1, shm: 2 }, { wal: 1, shm: null }))
                .toBe('-shm: inode 2 → missing');
        });
        // A database nobody has written to has no -wal yet. Arming against that
        // absence and then firing when SQLite creates one would raise a false alarm
        // on every first write — the cry-wolf this whole module exists to avoid.
        it('a sidecar that did not exist when we armed never fires', () => {
            expect(sidecarSwapDescription({ wal: null, shm: null }, { wal: 150851813, shm: 150851814 }))
                .toBeNull();
        });
    });
});
