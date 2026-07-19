/**
 * Task ledger file locking — mirrors Rust LedgerFile::with_locked_mut.
 *
 * Uses the same atomic lockfile pattern (create-exclusive via O_EXCL) so that
 * Rust and Node writers interoperate correctly. Do NOT use proper-lockfile npm
 * package — it uses different underlying primitives that would not block Rust.
 *
 * All gateway mutations to task_ledger.json must go through withLedgerLock.
 */
import * as fs from 'fs';
import * as path from 'path';
const STALE_LOCK_SECS = 30;
const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
function acquireLock(lockPath) {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    while (true) {
        try {
            // O_EXCL + O_CREAT is atomic on POSIX — same semantics as Rust create_new(true)
            const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            return; // lock acquired
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            // Check for stale lock
            try {
                const stat = fs.statSync(lockPath);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs > STALE_LOCK_SECS * 1000) {
                    console.error(`[ledger] stale lock (age ${Math.floor(ageMs / 1000)}s) — removing`);
                    fs.unlinkSync(lockPath);
                    continue; // retry immediately
                }
            }
            catch { }
            if (Date.now() >= deadline) {
                throw new Error(`timed out waiting for task_ledger lock at ${lockPath}`);
            }
            // Busy-wait with backoff
            const until = Date.now() + LOCK_RETRY_MS;
            while (Date.now() < until) { /* spin */ }
        }
    }
}
function releaseLock(lockPath) {
    try {
        fs.unlinkSync(lockPath);
    }
    catch { }
}
/**
 * Atomically read-modify-write task_ledger.json. Concurrent writers (Rust daemon,
 * this gateway) block on the lockfile. Identical semantics to Rust with_locked_mut.
 *
 * @param ledgerPath - absolute path to task_ledger.json
 * @param mutate - callback that receives parsed JSON, mutates it in place, returns void
 */
export function withLedgerLock(ledgerPath, mutate) {
    const lockPath = path.join(path.dirname(ledgerPath), '.task_ledger.lock');
    // Ensure file exists
    if (!fs.existsSync(ledgerPath)) {
        fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
        fs.writeFileSync(ledgerPath, JSON.stringify({ tasks: [], updated_at: '' }));
    }
    acquireLock(lockPath);
    try {
        const raw = fs.readFileSync(ledgerPath, 'utf-8');
        let ledger;
        try {
            ledger = JSON.parse(raw);
        }
        catch {
            ledger = { tasks: [], updated_at: '' };
        }
        mutate(ledger);
        // Write atomically via tmp + rename
        const tmpPath = ledgerPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
        fs.renameSync(tmpPath, ledgerPath);
    }
    finally {
        releaseLock(lockPath);
    }
}
