/**
 * System API — version, stats, health overview, and update management
 */
import { Router } from 'express';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDb, getMemoryDb, getProjectRoot } from '../db.js';
import { getStats, isConfigured, getAuthType, getCliPoolStats } from '../llm.js';
const router = Router();
const startTime = Date.now();
const RUNTIME_CACHE_TTL_MS = 4000;
let _runtimeCache = null;
let _runtimeInflight = null;
function vodouCoreBin() {
    const root = getProjectRoot();
    const localBin = path.join(root, 'vodou-core');
    return fs.existsSync(localBin) ? localBin : 'vodou-core';
}
function fetchRuntimeOnce() {
    const root = getProjectRoot();
    const bin = vodouCoreBin();
    return new Promise((resolve) => {
        const child = spawn(bin, ['runtime-status', '--json'], {
            cwd: root,
            env: { ...process.env, VODOU_PROJECT_PATH: root },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timeoutMs = 3500;
        const t = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch { }
            resolve(null);
        }, timeoutMs);
        let stdout = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
        });
        child.on('close', () => {
            clearTimeout(t);
            try {
                if (!stdout.trim())
                    resolve(null);
                else
                    resolve(JSON.parse(stdout.trim()));
            }
            catch {
                resolve(null);
            }
        });
        child.on('error', () => {
            clearTimeout(t);
            resolve(null);
        });
    });
}
async function getRuntimeStatusCached() {
    const now = Date.now();
    if (_runtimeCache && now < _runtimeCache.expiresAt)
        return _runtimeCache.value;
    if (!_runtimeInflight) {
        _runtimeInflight = fetchRuntimeOnce()
            .then((value) => {
            _runtimeCache = { value, expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS };
            return value;
        })
            .finally(() => {
            _runtimeInflight = null;
        });
    }
    return _runtimeInflight;
}
// Vodou version — read from package.json or use compile-time constant.
//
// IMPORTANT (2026-04-07): Previously called `execSync vodou-core version` at
// module load time with a 3s timeout. This blocked the entire gateway startup
// when vodou-core was in macOS UE (uninterruptible sleep) state — execSync
// timeout uses SIGTERM by default which UE processes ignore, AND even SIGKILL
// is ignored when the kernel call hasn't returned. The only safe fix is to
// NOT spawn vodou-core at module load.
//
// This constant is updated by the build script when versions change.
// To get the truly-current version, check vodou-core.db `metadata.version`.
const oiVersion = 'v0.5.46';
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        // Row counts for key tables
        const counts = {};
        const tables = [
            'mcp_servers',
            'tools',
            'intent_mappings',
            'skills_registry',
            'scheduled_tasks',
            'script_registry',
            'work_logs',
            'parameter_rules',
            'conversation_sessions',
        ];
        for (const table of tables) {
            try {
                const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
                counts[table] = row?.count ?? 0;
            }
            catch {
                counts[table] = 0;
            }
        }
        // Memory chunks from memory.db
        const memDb = getMemoryDb();
        if (memDb) {
            try {
                const row = memDb.prepare('SELECT COUNT(*) as count FROM memory_chunks').get();
                counts['memory_chunks'] = row?.count ?? 0;
            }
            catch {
                counts['memory_chunks'] = 0;
            }
        }
        // Vodou version: DB metadata > vodou-core binary > fallback
        let version = oiVersion;
        try {
            const row = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get();
            if (row?.value)
                version = row.value;
        }
        catch {
            // metadata table may not have version key
        }
        const gatewayStats = getStats();
        // Update availability (written by background check in brain_loader.rs)
        let updateAvailable = null;
        try {
            const row = db.prepare("SELECT value FROM metadata WHERE key = 'update_available'").get();
            if (row?.value)
                updateAvailable = JSON.parse(row.value);
        }
        catch {
            // not yet cached
        }
        // Recent activity summary (last 7 days)
        let recentActivity = [];
        try {
            const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
            const rows = db.prepare(`SELECT DATE(timestamp) as date, category, COUNT(*) as cnt
         FROM work_logs WHERE timestamp >= ?
         GROUP BY DATE(timestamp), category
         ORDER BY date DESC`).all(sevenDaysAgo);
            const byDate = {};
            for (const row of rows) {
                if (!byDate[row.date])
                    byDate[row.date] = { count: 0, categories: {} };
                byDate[row.date].count += row.cnt;
                byDate[row.date].categories[row.category || 'general'] = row.cnt;
            }
            recentActivity = Object.entries(byDate).map(([date, data]) => ({
                date,
                count: data.count,
                categories: data.categories,
            }));
        }
        catch {
            // work_logs may not exist
        }
        const runtime = await getRuntimeStatusCached();
        res.json({
            version,
            updateAvailable,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            authMode: getAuthType(),
            configured: isConfigured(),
            counts,
            gateway: gatewayStats,
            recentActivity,
            runtime,
        });
    }
    catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
// GET /api/system/cli-pool — Claude CLI subprocess pool counters (localhost dev aid)
router.get('/cli-pool', (_req, res) => {
    try {
        res.json(getCliPoolStats());
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
// GET /api/system/alerts — aggregate system alerts
router.get('/alerts', (req, res) => {
    try {
        const db = getDb();
        const alerts = [];
        // Unhealthy active servers
        try {
            const unhealthy = db.prepare("SELECT name FROM mcp_servers WHERE active = 1 AND health_status IS NOT NULL AND health_status != 'healthy'").all();
            for (const s of unhealthy) {
                alerts.push({ level: 'error', message: `Server '${s.name}' is unhealthy — open to Test or Refresh status`, href: `#/servers/${encodeURIComponent(s.name)}` });
            }
        }
        catch { }
        // Broken skills (active but missing required servers)
        try {
            const activeSkills = db.prepare("SELECT name, required_tools FROM skills_registry WHERE is_active = 1 AND required_tools IS NOT NULL AND required_tools != '[]'").all();
            const activeServers = db.prepare('SELECT name FROM mcp_servers WHERE active = 1').all();
            const activeServerNames = new Set(activeServers.map(s => s.name));
            for (const skill of activeSkills) {
                try {
                    const servers = JSON.parse(skill.required_tools);
                    if (Array.isArray(servers)) {
                        const missing = servers.filter((s) => !activeServerNames.has(s));
                        if (missing.length > 0) {
                            alerts.push({
                                level: 'warning',
                                message: `Skill '${skill.name}' missing server${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
                                href: '#/capabilities?tab=skills',
                            });
                        }
                    }
                }
                catch { }
            }
        }
        catch { }
        // Failed scheduled tasks — check work_logs for recent failures
        try {
            const failedTasks = db.prepare("SELECT DISTINCT st.name FROM scheduled_tasks st JOIN work_logs wl ON wl.message LIKE '%' || st.name || '%' WHERE st.enabled = 1 AND wl.category IN ('scheduler','schedule') AND wl.message LIKE '%fail%' AND wl.timestamp > datetime('now', '-1 day')").all();
            for (const t of failedTasks) {
                alerts.push({ level: 'warning', message: `Scheduled task '${t.name}' failed recently`, href: '#/activity?tab=scheduled' });
            }
        }
        catch { }
        res.json({ alerts });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
function isLoopback(req) {
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
/**
 * POST /api/system/restart-stack — localhost only. Detached bash script stops
 * gateway, daemon, worker, then runs start-vodou-services.sh (restarts gateway + CLI pool).
 */
router.post('/restart-stack', (req, res) => {
    if (!isLoopback(req)) {
        res.status(403).json({ error: 'Only available from this machine (localhost).' });
        return;
    }
    try {
        const root = getProjectRoot();
        const script = path.join(root, 'scripts', 'restart-vodou-stack.sh');
        if (!fs.existsSync(script)) {
            res.status(500).json({ error: `Missing ${script}` });
            return;
        }
        const child = spawn('bash', [script, root], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, VODOU_PROJECT_PATH: root },
        });
        child.unref();
        res.status(202).json({
            ok: true,
            message: 'Full restart scheduled. This tab will lose connection in a few seconds. Wait about 30 seconds, then refresh.',
        });
    }
    catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
// ── Helper: find vodou-core binary ─────────────────────────────────────────
function getBinaryPath() {
    const root = getProjectRoot();
    const local = path.join(root, 'vodou-core');
    if (fs.existsSync(local))
        return local;
    return 'vodou-core'; // fallback: PATH
}
// ── Update endpoints (localhost only) ────────────────────────────────────────
/**
 * POST /api/system/update-check
 * Runs `vodou-core update --check` synchronously, returns result + DB cache.
 */
router.post('/update-check', (req, res) => {
    if (!isLoopback(req)) {
        res.status(403).json({ error: 'Only available from this machine (localhost).' });
        return;
    }
    try {
        const root = getProjectRoot();
        const bin = getBinaryPath();
        const result = spawnSync(bin, ['update', '--check'], {
            cwd: root,
            env: { ...process.env, VODOU_PROJECT_PATH: root },
            timeout: 15000,
            encoding: 'utf8',
        });
        const stdout = (result.stdout || '').trim();
        const stderr = (result.stderr || '').trim();
        // Also read cached update_available from DB (may be fresher from background check)
        let dbCache = null;
        try {
            const db = getDb();
            const row = db.prepare("SELECT value FROM metadata WHERE key = 'update_available'").get();
            if (row?.value)
                dbCache = JSON.parse(row.value);
        }
        catch { }
        const updateAvailable = stdout.includes('Update available:') || dbCache !== null;
        const versionMatch = stdout.match(/Update available:\s*\S+\s*(?:→|->)\s*(\S+)/);
        res.json({
            ok: result.status === 0,
            update_available: updateAvailable,
            available_version: versionMatch?.[1] ?? dbCache?.version ?? null,
            is_forced: dbCache?.is_forced ?? false,
            output: stdout || stderr,
            cached: dbCache,
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
/**
 * POST /api/system/update-install
 * Detached subprocess: vodou-core update --yes
 * Returns 202 — same detached pattern as restart-stack.
 */
router.post('/update-install', (req, res) => {
    if (!isLoopback(req)) {
        res.status(403).json({ error: 'Only available from this machine (localhost).' });
        return;
    }
    try {
        const root = getProjectRoot();
        const bin = getBinaryPath();
        const child = spawn(bin, ['update', '--yes'], {
            cwd: root,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, VODOU_PROJECT_PATH: root },
        });
        child.unref();
        res.status(202).json({
            ok: true,
            message: 'Update started. The system will restart automatically. Wait ~30 seconds, then refresh.',
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
/**
 * POST /api/system/update-rollback
 * Detached subprocess: vodou-core update --rollback
 */
router.post('/update-rollback', (req, res) => {
    if (!isLoopback(req)) {
        res.status(403).json({ error: 'Only available from this machine (localhost).' });
        return;
    }
    try {
        const root = getProjectRoot();
        const bin = getBinaryPath();
        const child = spawn(bin, ['update', '--rollback'], {
            cwd: root,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, VODOU_PROJECT_PATH: root },
        });
        child.unref();
        res.status(202).json({
            ok: true,
            message: 'Rollback started. The system will restart automatically. Wait ~30 seconds, then refresh.',
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
/**
 * POST /api/system/update-components-check
 * Runs `vodou-core update --components --dry-run --json` synchronously.
 * Returns component list as JSON array.
 */
router.post('/update-components-check', (req, res) => {
    if (!isLoopback(req)) {
        res.status(403).json({ error: 'Only available from this machine (localhost).' });
        return;
    }
    try {
        const root = getProjectRoot();
        const bin = getBinaryPath();
        const result = spawnSync(bin, ['update', '--components', '--dry-run', '--json'], {
            cwd: root,
            env: { ...process.env, VODOU_PROJECT_PATH: root },
            timeout: 120000, // may need to download archive
            encoding: 'utf8',
        });
        const stdout = (result.stdout || '').trim();
        // Find the JSON array in stdout (may have progress lines before it)
        const jsonMatch = stdout.match(/(\[[\s\S]*\])/);
        if (!jsonMatch) {
            res.json({ components: [], message: stdout || 'Everything is up to date.' });
            return;
        }
        let components = [];
        try {
            components = JSON.parse(jsonMatch[1]);
        }
        catch {
            res.status(500).json({ error: 'Failed to parse component list', output: stdout });
            return;
        }
        res.json({ components, count: components.length });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
/**
 * POST /api/system/update-components-apply
 * Body: { selected: [1, 2, 3] }
 * Detached: vodou-core update --components --select=1,2,3 --yes
 */
router.post('/update-components-apply', (req, res) => {
    if (!isLoopback(req)) {
        res.status(403).json({ error: 'Only available from this machine (localhost).' });
        return;
    }
    try {
        const root = getProjectRoot();
        const bin = getBinaryPath();
        const selected = Array.isArray(req.body?.selected) ? req.body.selected : [];
        const args = ['update', '--components', '--yes'];
        if (selected.length > 0) {
            args.push(`--select=${selected.join(',')}`);
        }
        else {
            args.push('--all');
        }
        const child = spawn(bin, args, {
            cwd: root,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, VODOU_PROJECT_PATH: root },
        });
        child.unref();
        res.status(202).json({
            ok: true,
            message: `Updating ${selected.length > 0 ? selected.length + ' component(s)' : 'all components'}. Refresh in ~15 seconds.`,
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});
export { router as systemRouter };
