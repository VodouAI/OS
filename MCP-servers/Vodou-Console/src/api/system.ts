/**
 * System API — version, stats, health overview, and update management
 */

import { Router, Request, Response } from 'express';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { getDb, getMemoryDb, getProjectRoot, getSetting } from '../db.js';
import { getStats, isConfigured, getAuthType, getCliPoolStats } from '../llm.js';
import { getGatewayDebugSnapshot } from '../gateway-debug.js';
import { sockConnectTarget } from '../cli-portability.js';
import { requireAdmin } from '../admin-auth.js';

const router = Router();
const startTime = Date.now();

/** Talk to the memory daemon over its Unix socket (PLAN-SELF-HEALING-MEMORY). */
function callDaemonJson(cmd: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<any> {
  const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
  const request = JSON.stringify({ cmd, payload }) + '\n';
  return new Promise((resolve) => {
    const c = net.createConnection({ path: sockConnectTarget(sockPath) }, () => {
      c.write(request);
      c.end();
    });
    c.setTimeout(timeoutMs);
    let data = '';
    c.on('data', (b) => { data += b.toString(); });
    c.on('end', () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch {
        resolve({ ok: false, error: 'unparseable daemon response' });
      }
    });
    c.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    c.on('timeout', () => {
      try { c.destroy(); } catch { /* noop */ }
      resolve({ ok: false, error: 'daemon timeout' });
    });
  });
}
// Vodou version — read from Cargo.toml at request time.
//
// IMPORTANT (2026-04-07): Previously called `execSync vodou-core version` at
// module load time with a 3s timeout. That blocked the entire gateway startup
// when vodou-core was in macOS UE (uninterruptible sleep) state — execSync
// timeout uses SIGTERM by default which UE processes ignore. So we don't
// spawn vodou-core. Instead we just read Cargo.toml — a tiny text file —
// at request time. Cached for 5s to avoid hammering the filesystem on busy
// /api/system polling. Falls back to a stale-marker string if Cargo.toml is
// missing (dev mode), which is loud enough that anyone seeing it will fix.
//
// Why this matters: a hardcoded constant here was never being bumped at
// build time, so the gateway always reported v0.5.46. The auto-update flow
// uses /api/system's "version" field to detect "we're now on the new build,
// reload the page" — with a frozen version, every release looked like
// "update available" forever AND the post-install poll never observed a
// change so the page eventually rolled back to a cached old shell.
const VERSION_CACHE_TTL_MS = 5000;
/** Runtime-status polling: avoid hammering vodou-core while pages fetch /api/system in parallel. */
const RUNTIME_CACHE_TTL_MS = 4000;
let _versionCache: { value: string; expiresAt: number } | null = null;
let _versionInflight: Promise<string> | null = null;
let _runtimeCache: { value: Record<string, unknown> | null; expiresAt: number } | null = null;
let _runtimeInflight: Promise<Record<string, unknown> | null> | null = null;

function vodouCoreBin(): string {
  const root = getProjectRoot();
  const localBin = path.join(root, 'vodou-core');
  return fs.existsSync(localBin) ? localBin : 'vodou-core';
}

/** Subprocess fetch — does not block the gateway event loop (spawnSync would stall every HTTP handler). */
function fetchVersionOnce(): Promise<string> {
  const root = getProjectRoot();
  const bin = vodouCoreBin();
  return new Promise((resolve) => {
    const child = spawn(bin, ['version'], {
      cwd: root,
      env: { ...process.env, VODOU_PROJECT_PATH: root },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve('v0.0.0-unknown');
    }, 2000);
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('close', () => {
      clearTimeout(t);
      let value = 'v0.0.0-unknown';
      const m = stdout.match(/(\d+\.\d+\.\d+(?:[\w.+-]*)?)/);
      if (m && m[1]) value = `v${m[1]}`;
      resolve(value);
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve('v0.0.0-unknown');
    });
  });
}

async function getVodouVersionCached(): Promise<string> {
  const now = Date.now();
  if (_versionCache && now < _versionCache.expiresAt) return _versionCache.value;

  if (!_versionInflight) {
    _versionInflight = fetchVersionOnce()
      .then((value) => {
        _versionCache = { value, expiresAt: Date.now() + VERSION_CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        _versionInflight = null;
      });
  }
  return _versionInflight;
}

function fetchRuntimeOnce(): Promise<Record<string, unknown> | null> {
  const root = getProjectRoot();
  const bin = vodouCoreBin();
  return new Promise((resolve) => {
    const child = spawn(bin, ['runtime-status', '--json'], {
      cwd: root,
      env: { ...process.env, VODOU_PROJECT_PATH: root },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timeoutMs = 3500;
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, timeoutMs);
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('close', () => {
      clearTimeout(t);
      try {
        if (!stdout.trim()) resolve(null);
        else resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

async function getRuntimeStatusCached(): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  if (_runtimeCache && now < _runtimeCache.expiresAt) return _runtimeCache.value;

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

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();

    // Row counts for key tables
    const counts: Record<string, number> = {};
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
        const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any;
        counts[table] = row?.count ?? 0;
      } catch {
        counts[table] = 0;
      }
    }

    // Memory chunks from memory.db
    const memDb = getMemoryDb();
    if (memDb) {
      try {
        const row = memDb.prepare('SELECT COUNT(*) as count FROM memory_chunks').get() as any;
        counts['memory_chunks'] = row?.count ?? 0;
      } catch {
        counts['memory_chunks'] = 0;
      }
    }

    // Vodou version: Cargo.toml (truth) > DB metadata (lags) > unknown
    // Cargo.toml is the canonical source of truth — bumped on every release.
    // Reading it at request time means the gateway always reports the actual
    // installed version, not a stale build-time constant.
    const [versionRaw, runtime] = await Promise.all([
      getVodouVersionCached(),
      getRuntimeStatusCached(),
    ]);
    let version = versionRaw;
    if (!version || version === 'v0.0.0-unknown') {
      try {
        const row = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get() as any;
        if (row?.value) version = row.value;
      } catch { /* fall through */ }
    }

    const gatewayStats = getStats();

    // Update availability (written by background check in brain_loader.rs)
    let updateAvailable: { version: string; is_forced: boolean } | null = null;
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'update_available'").get() as any;
      if (row?.value) updateAvailable = JSON.parse(row.value);
    } catch {
      // not yet cached
    }

    // Recent activity summary (last 7 days)
    let recentActivity: { date: string; count: number; categories: Record<string, number> }[] = [];
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const rows = db.prepare(
        `SELECT DATE(timestamp) as date, category, COUNT(*) as cnt
         FROM work_logs WHERE timestamp >= ?
         GROUP BY DATE(timestamp), category
         ORDER BY date DESC`
      ).all(sevenDaysAgo) as { date: string; category: string; cnt: number }[];

      const byDate: Record<string, { count: number; categories: Record<string, number> }> = {};
      for (const row of rows) {
        if (!byDate[row.date]) byDate[row.date] = { count: 0, categories: {} };
        byDate[row.date].count += row.cnt;
        byDate[row.date].categories[row.category || 'general'] = row.cnt;
      }
      recentActivity = Object.entries(byDate).map(([date, data]) => ({
        date,
        count: data.count,
        categories: data.categories,
      }));
    } catch {
      // work_logs may not exist
    }

    // PLAN-SELF-HEALING-MEMORY — Memory brain + health scorecard for System/One.
    let memoryBrain: Record<string, unknown> | null = null;
    let memoryHealth: { pct: number | null; history: unknown[]; sparkline: string } | null = null;
    try {
      const brain = await callDaemonJson('mem-brain-status', {}, 5000);
      if (brain?.ok && brain.data) memoryBrain = brain.data;
    } catch { /* daemon down — card degrades */ }
    try {
      const memDb = getMemoryDb();
      if (memDb) {
        try {
          memDb.exec(
            `CREATE TABLE IF NOT EXISTS memory_health_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              recorded_at TEXT NOT NULL,
              pct REAL NOT NULL,
              questions INTEGER NOT NULL DEFAULT 0,
              recovered INTEGER NOT NULL DEFAULT 0,
              still_failing INTEGER NOT NULL DEFAULT 0,
              grader_version INTEGER NOT NULL DEFAULT 1
            )`
          );
        } catch { /* already exists */ }
        const hist = memDb.prepare(
          'SELECT id, recorded_at, pct, questions, recovered, still_failing, grader_version FROM memory_health_history ORDER BY id DESC LIMIT 30'
        ).all() as Array<{ pct: number; recorded_at: string }>;
        const bars = '▁▂▃▄▅▆▇█';
        const spark = hist.slice().reverse().map((h) => {
          const i = Math.max(0, Math.min(7, Math.floor((h.pct / 100) * 8)));
          return bars[i];
        }).join('');
        memoryHealth = {
          pct: hist[0]?.pct ?? null,
          history: hist,
          sparkline: spark || '—',
        };
      }
    } catch { /* no history yet */ }

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
      memoryBrain,
      memoryHealth,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// PLAN-SELF-HEALING-MEMORY D1b — Memory brain upgrade / revert
router.get('/mem-brain', async (_req: Request, res: Response) => {
  try {
    const r = await callDaemonJson('mem-brain-status', {}, 8000);
    if (!r?.ok) { res.status(502).json(r); return; }
    res.json(r.data);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// S-AUTH: caller-controlled `target` model drives a full drain + re-embed of the
// memory corpus. Same class as the update/* finding (caller input → heavy
// privileged operation), and this one had no loopback check either. Owner-only.
router.post('/mem-swap', requireAdmin, async (req: Request, res: Response) => {
  try {
    const target = (req.body?.target as string) || 'bge-small';
    const max_batches = Math.max(1, Math.min(500, parseInt(String(req.body?.max_batches || 50), 10) || 50));
    // Long timeout — a full founder vault drain can take minutes per batch window.
    const r = await callDaemonJson('mem-swap-start', { target, max_batches }, 600_000);
    if (!r?.ok) { res.status(502).json(r); return; }
    res.json(r.data);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/system/cli-pool — Claude CLI subprocess pool counters (localhost dev aid)
router.get('/cli-pool', (_req: Request, res: Response) => {
  try {
    res.json(getCliPoolStats());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/system/alerts — aggregate system alerts
router.get('/alerts', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const alerts: { level: string; message: string; href: string }[] = [];

    // Unhealthy active servers
    try {
      const unhealthy = db.prepare(
        "SELECT name FROM mcp_servers WHERE active = 1 AND health_status IS NOT NULL AND health_status != 'healthy'"
      ).all() as { name: string }[];
      for (const s of unhealthy) {
        alerts.push({ level: 'error', message: `Server '${s.name}' is unhealthy — open to Test or Refresh status`, href: `#/servers/${encodeURIComponent(s.name)}` });
      }
    } catch {}

    // Broken skills (active but missing required servers)
    try {
      const activeSkills = db.prepare(
        "SELECT name, required_tools FROM skills_registry WHERE is_active = 1 AND required_tools IS NOT NULL AND required_tools != '[]'"
      ).all() as { name: string; required_tools: string }[];

      const activeServers = db.prepare(
        'SELECT name FROM mcp_servers WHERE active = 1'
      ).all() as { name: string }[];
      const activeServerNames = new Set(activeServers.map(s => s.name));

      for (const skill of activeSkills) {
        try {
          const servers = JSON.parse(skill.required_tools);
          if (Array.isArray(servers)) {
            const missing = servers.filter((s: string) => !activeServerNames.has(s));
            if (missing.length > 0) {
              alerts.push({
                level: 'warning',
                message: `Skill '${skill.name}' missing server${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
                href: '#/capabilities?tab=skills',
              });
            }
          }
        } catch {}
      }
    } catch {}

    // Failed scheduled tasks — check work_logs for recent failures
    try {
      const failedTasks = db.prepare(
        "SELECT DISTINCT st.name FROM scheduled_tasks st JOIN work_logs wl ON wl.message LIKE '%' || st.name || '%' WHERE st.enabled = 1 AND wl.category IN ('scheduler','schedule') AND wl.message LIKE '%fail%' AND wl.timestamp > datetime('now', '-1 day')"
      ).all() as { name: string }[];
      for (const t of failedTasks) {
        alerts.push({ level: 'warning', message: `Scheduled task '${t.name}' failed recently`, href: '#/activity?tab=scheduled' });
      }
    } catch {}

    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function isLoopback(req: Request): boolean {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function gatewayAutoEnsureFromEnv(): boolean {
  const v = process.env.VODOU_GATEWAY_AUTO_ENSURE ?? process.env.OI_GATEWAY_AUTO_ENSURE;
  if (v === undefined || v === '') return true;
  const s = String(v).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(s);
}

/**
 * GET /api/system/diagnostics — localhost only. One JSON blob for support / bug reports
 * (paths, env, process — no secrets). Does not include API keys.
 */
router.get('/diagnostics', async (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const root = getProjectRoot();
    const bin = vodouCoreBin();
    const port = parseInt(process.env.WEB_PORT || '8765', 10);
    const mcpHealthMs = parseInt(
      process.env.VODOU_MCP_HEALTH_INTERVAL_MS || process.env.OI_MCP_HEALTH_INTERVAL_MS || '300000',
      10,
    );
    const version = await getVodouVersionCached();
    const sysLog = path.join(root, '.vodou', 'system.log');
    const vodouCoreResolved = path.isAbsolute(bin) ? bin : path.join(root, bin);
    res.json({
      gateway_pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      project_root: root,
      vodou_project_path: process.env.VODOU_PROJECT_PATH || null,
      web_port: port,
      vodou_core_path: bin,
      vodou_core_resolved: vodouCoreResolved,
      vodou_core_exists: fs.existsSync(vodouCoreResolved),
      vodou_core_version_reported: version,
      gateway_auto_ensure: gatewayAutoEnsureFromEnv(),
      mcp_health_interval_ms: Number.isFinite(mcpHealthMs) ? mcpHealthMs : 300000,
      system_log: sysLog,
      system_log_exists: fs.existsSync(sysLog),
      hints: {
        port_in_use: `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        tail_log: `tail -f ${sysLog}`,
        diagnostics: `curl -sS http://127.0.0.1:${port}/api/system/diagnostics`,
      },
      gateway_debug: getGatewayDebugSnapshot(),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /api/system/doctor?quick=1 — localhost only. Runs the existing
 * scripts/vodou-doctor.sh health audit and returns its result as JSON.
 *
 * Mirrors the spawn-script pattern used by /restart-stack and /reconnect-services
 * (spawn('bash', [script, …])) but PIPED + timed-out like fetchRuntimeOnce() so we
 * can capture output instead of detaching.
 *
 * Output channels of the script (see scripts/vodou-doctor.sh):
 *   - stdout: one-line summary  ("Doctor: N ✅ · N ⚠️ · N ❌  (Ns)")
 *   - stderr: human-readable per-check lines (the report body)
 *   - $REPORT (.vodou/doctor/*.md): full markdown — suppressed here via
 *     VODOU_DOCTOR_NO_REPORT=1 so a web click never litters the report dir.
 *   - exit code: non-zero iff any check FAILED.
 * We therefore return stderr as `report` and stdout as `summary`.
 */
router.get('/doctor', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const root = getProjectRoot();
    // No bash on Windows and no .sh-equivalent yet — return a graceful stub
    // rather than spawning bash (which would fail + flash). S1. Use
    // `vodou-core.exe service status` for a health snapshot on Windows.
    if (process.platform === 'win32') {
      res.json({ ok: true, platform: 'win32', note: 'Full diagnostics (vodou-doctor.sh) is not available on Windows yet — run `vodou-core.exe service status` in the install folder.', sections: [] });
      return;
    }
    const script = path.join(root, 'scripts', 'vodou-doctor.sh');
    if (!fs.existsSync(script)) {
      res.status(500).json({ error: `Missing ${script}` });
      return;
    }
    const quick = String(req.query.quick ?? '') === '1';
    const args = quick ? [script, '--quick'] : [script];

    const child = spawn('bash', args, {
      cwd: root,
      env: { ...process.env, VODOU_PROJECT_PATH: root, VODOU_DOCTOR_NO_REPORT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Quick run skips the slow memory-loop + MCP roundtrip checks, so a 30s cap
    // is plenty; full run can touch the daemon socket + sqlite integrity checks,
    // so give it 120s — same order of magnitude as update-components-check's cap.
    const timeoutMs = quick ? 30_000 : 120_000;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number, body: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      res.status(status).json(body);
    };
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(504, {
        ok: false,
        summary: `Doctor timed out after ${Math.round(timeoutMs / 1000)}s`,
        report: stderr || stdout || '',
      });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      // Strip ANSI colour codes the script emits to a TTY-less pipe.
      const ansi = /\x1b\[[0-9;]*m/g;
      const report = (stderr || '').replace(ansi, '').trim();
      const summary = (stdout || '').replace(ansi, '').trim();
      finish(200, {
        ok: code === 0,
        summary: summary || (code === 0 ? 'All checks green.' : 'Doctor reported failures.'),
        report,
      });
    });
    child.on('error', (err) => {
      finish(500, { ok: false, summary: 'Failed to run doctor', report: String(err) });
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/system/restart-stack — localhost only. Detached bash script stops
 * gateway, daemon, worker, then runs start-vodou-services.sh (restarts gateway + CLI pool).
 */
router.post('/restart-stack', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const root = getProjectRoot();
    // Windows has no bash: restart via the Rust service runner (idempotent —
    // re-ensures daemon + worker + gateway). S1 fix.
    let child;
    if (process.platform === 'win32') {
      child = spawn(path.join(root, 'vodou-core.exe'), ['service', 'start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: root,
        env: { ...process.env, VODOU_PROJECT_PATH: root },
      });
    } else {
      const script = path.join(root, 'scripts', 'restart-vodou-stack.sh');
      if (!fs.existsSync(script)) {
        res.status(500).json({ error: `Missing ${script}` });
        return;
      }
      child = spawn('bash', [script, root], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, VODOU_PROJECT_PATH: root },
      });
    }
    child.on('error', () => {}); // never let a spawn failure crash the gateway
    child.unref();
    res.status(202).json({
      ok: true,
      message:
        'Full restart scheduled. This tab will lose connection in a few seconds. Wait about 30 seconds, then refresh.',
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/system/update-log — tail of .vodou/update.log
 * Returns the last N lines (default 30) of the auto-updater's progress log.
 * Used by the System → Updates UI to surface live update progress to the
 * user during install (so they see "downloading…", "replacing vodou-core…",
 * "✓ update complete" instead of staring at a frozen "Installing…" button).
 * Localhost only — the log can contain version numbers + paths but no creds.
 */
router.get('/update-log', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const tail = Math.min(Math.max(parseInt(String(req.query.tail || '30'), 10) || 30, 5), 500);
    const root = getProjectRoot();
    const logPath = path.join(root, '.vodou', 'update.log');
    if (!fs.existsSync(logPath)) {
      res.json({ lines: [], present: false, mtime: null });
      return;
    }
    const stat = fs.statSync(logPath);
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n').filter((l) => l.trim().length > 0);
    const lines = allLines.slice(-tail);
    res.json({
      lines,
      total: allLines.length,
      present: true,
      mtime: stat.mtime.toISOString(),
      bytes: stat.size,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/system/reconnect-services — localhost only. Idempotent re-run of
 * start-vodou-services.sh which auto-connects all first-party Vodou-* MCP
 * servers (Vodou-Console, Vodou-Enhanced-Thinking, Vodou-LLM-router,
 * Vodou-channels, Vodou-script-executor, Vodou-session-manager, etc.) to
 * vodou-core. Used after a fresh install / restart when the apps nav is
 * empty — the frontend auto-detects the missing-MCP state and calls this
 * endpoint once per session to bootstrap.
 *
 * Unlike restart-stack, this does NOT kill the running gateway or daemon —
 * it just re-runs the connect commands. Safe to call multiple times.
 */
router.post('/reconnect-services', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const root = getProjectRoot();
    // Windows has no bash: reconnect MCP servers via the Rust `reconnect-all`
    // subcommand (same effect as start-vodou-services.sh's MCP-connect step). S1 fix.
    let child;
    if (process.platform === 'win32') {
      child = spawn(path.join(root, 'vodou-core.exe'), ['reconnect-all'], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, VODOU_PROJECT_PATH: root },
      });
    } else {
      const script = path.join(root, 'start-vodou-services.sh');
      if (!fs.existsSync(script)) {
        res.status(500).json({ error: `Missing ${script}` });
        return;
      }
      child = spawn('bash', [script], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, VODOU_PROJECT_PATH: root, START_AIGATEWAY: '0' }, // gateway already running
      });
    }
    child.on('error', () => {});
    child.unref();
    res.status(202).json({
      ok: true,
      message: 'Reconnecting Vodou MCP servers... refresh in 10-15 seconds.',
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ── Helper: find vodou-core binary ─────────────────────────────────────────
function getBinaryPath(): string {
  const root = getProjectRoot();
  const local = path.join(root, 'vodou-core');
  if (fs.existsSync(local)) return local;
  return 'vodou-core'; // fallback: PATH
}

// ── Update endpoints (localhost only) ────────────────────────────────────────

/**
 * POST /api/system/update-check
 * Runs `vodou-core update --check` synchronously, returns result + DB cache.
 */
router.post('/update-check', (req: Request, res: Response) => {
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
    let dbCache: { version: string; is_forced: boolean } | null = null;
    try {
      const db = getDb();
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'update_available'").get() as any;
      if (row?.value) dbCache = JSON.parse(row.value);
    } catch {}

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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/system/update-install
 * Detached subprocess: vodou-core update --yes
 * Returns 202 — same detached pattern as restart-stack.
 */
router.post('/update-install', requireAdmin, (req: Request, res: Response) => {
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/system/update-rollback
 * Detached subprocess: vodou-core update --rollback
 */
router.post('/update-rollback', requireAdmin, (req: Request, res: Response) => {
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/system/update-components-check
 * Runs `vodou-core update --components --dry-run --json` synchronously.
 * Returns component list as JSON array.
 */
router.post('/update-components-check', (req: Request, res: Response) => {
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
      timeout: 300000, // 5 min — first check downloads ~210MB archive on slow connections
      encoding: 'utf8',
    });

    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();

    // Find the JSON array in stdout. The binary writes log lines like
    // "[components] no staging found …" before emitting the actual JSON
    // payload, so a greedy regex would grab from the leading `[components]`
    // log marker to the trailing `[]` and fail to parse. Walk the lines
    // back-to-front and pick the first line whose trimmed form is a
    // bracketed JSON value.
    let jsonStr: string | null = null;
    const lines = stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        jsonStr = t;
        break;
      }
    }
    if (!jsonStr) {
      // No JSON array — non-zero exit means the binary errored. Surface stderr
      // so the user sees the real reason ("No newer release available", etc.)
      // instead of a generic parse failure.
      if (result.status && result.status !== 0) {
        res.status(500).json({
          error: stderr || stdout || 'update --components --json failed with no output',
          stdout,
          stderr,
        });
        return;
      }
      res.json({ components: [], message: stdout || 'Everything is up to date.' });
      return;
    }

    let components: any[] = [];
    try {
      components = JSON.parse(jsonStr);
    } catch {
      res.status(500).json({ error: 'Failed to parse component list', output: stdout, stderr, parsedLine: jsonStr });
      return;
    }

    res.json({ components, count: components.length });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /api/system/update-components-apply
 * Body: { selected: [1, 2, 3] }
 * Detached: vodou-core update --components --select=1,2,3 --yes
 */
router.post('/update-components-apply', requireAdmin, (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const root = getProjectRoot();
    const bin = getBinaryPath();
    const selected: number[] = Array.isArray(req.body?.selected) ? req.body.selected : [];

    const args = ['update', '--components', '--yes'];
    if (selected.length > 0) {
      args.push(`--select=${selected.join(',')}`);
    } else {
      args.push('--all');
    }

    // Pipe stdout/stderr into .vodou/update.log so the frontend's existing
    // live-progress polling (/api/system/update-log) can stream it. Was
    // `stdio: 'ignore'` which threw every line into /dev/null — there was
    // literally nowhere to look when component apply went wrong.
    // Frame the run so the log reader can detect start/finish boundaries.
    const logDir = path.join(root, '.vodou');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'update.log');
    const stamp = new Date().toISOString();
    const header = `\n--- [${stamp}] components-apply selected=${selected.length > 0 ? selected.join(',') : 'all'} ---\n`;
    fs.appendFileSync(logPath, header);
    const out = fs.openSync(logPath, 'a');
    const err = fs.openSync(logPath, 'a');

    const child = spawn(bin, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, VODOU_PROJECT_PATH: root },
    });

    // When the child exits, write a sentinel line so the frontend can stop
    // polling and reload. Closing the inherited fds first is critical —
    // otherwise the OS keeps them open until the orphan tree dies.
    child.on('exit', (code, signal) => {
      try { fs.closeSync(out); } catch {}
      try { fs.closeSync(err); } catch {}
      const stamp2 = new Date().toISOString();
      const status = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
      fs.appendFileSync(logPath, `--- [${stamp2}] components-apply done ${status} ---\n`);
    });
    child.unref();

    res.status(202).json({
      ok: true,
      logPath: '.vodou/update.log',
      message: `Updating ${selected.length > 0 ? selected.length + ' component(s)' : 'all components'} — streaming to .vodou/update.log`,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /api/system/gateway-extractor-settings — read privacy gate state.
 * Returns { channels_enabled: bool }. Default false (opt-in).
 * Localhost only.
 */
router.get('/gateway-extractor-settings', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM gateway_settings WHERE key = 'gateway_extractor_channels_enabled'").get() as any;
    const v = (row?.value ?? '').toString().trim().toLowerCase();
    const channels_enabled = v === 'true' || v === '1';
    res.json({ channels_enabled });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * PUT /api/system/gateway-extractor-settings — flip the privacy gate.
 * Body: { channels_enabled: bool }. Localhost only.
 */
router.put('/gateway-extractor-settings', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const enabled = !!req.body?.channels_enabled;
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO gateway_settings (key, value) VALUES ('gateway_extractor_channels_enabled', ?)"
    ).run(enabled ? 'true' : 'false');
    res.json({ ok: true, channels_enabled: enabled });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /api/system/extractor-log?tail=N — recent extractor cycle JSONL.
 * Localhost only. Returns parsed lines from .vodou/extractor.log.
 */
router.get('/extractor-log', (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Only available from this machine (localhost).' });
    return;
  }
  try {
    const tail = Math.min(Math.max(parseInt(String(req.query.tail || '20'), 10) || 20, 5), 200);
    const root = getProjectRoot();
    const logPath = path.join(root, '.vodou', 'extractor.log');
    if (!fs.existsSync(logPath)) {
      res.json({ cycles: [], present: false });
      return;
    }
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n').filter((l) => l.trim().length > 0);
    const cycles = allLines
      .slice(-tail)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x !== null);
    const stat = fs.statSync(logPath);
    res.json({ cycles, total: allLines.length, mtime: stat.mtime.toISOString() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/system/model-fit — hardware-aware local-model recommendations
//
// Shells out to the `llmfit` binary (MIT, static, `--json` on every subcommand)
// to detect RAM/VRAM/GPU on THIS machine and score local models for fit + speed.
// Primary spawn: `llmfit recommend --json` (Ollama + MLX on Apple Silicon).
// Parallel spawn: `--force-runtime llamacpp --output-llamacpp` fills the GGUF
// bucket for Vodou Local — Apple Silicon otherwise returns MLX-only and the
// Settings strip for llama.cpp stayed empty. Read-only — no spawn-loop hazard.
//
// Resolution ladder (PATH first — a brew-installed copy has a fresher model DB
// than the pinned release bundle): `llmfit` on PATH → `vendor/llmfit/llmfit`
// from the bundle → not available.
//
// This endpoint NEVER errors. Binary absent, timeout, spawn failure, or ANY
// parse error → `{ available: false }` and the UI falls back to its static
// "Requires 16GB+ RAM" text. Defensive parsing tolerates schema drift across
// llmfit's frequent releases (only name+score are required per model).
//
// Cached in-process for 1h: hardware doesn't change; the model DB only changes
// when the binary is upgraded.
// ---------------------------------------------------------------------------
const MODEL_FIT_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const LLMFIT_TIMEOUT_MS = 10000;
let _modelFitCache: { value: Record<string, unknown>; expiresAt: number } | null = null;
let _modelFitInflight: Promise<Record<string, unknown>> | null = null;
let _llmfitBinResolved: string | null | undefined; // undefined = not resolved yet

/** Resolve the llmfit binary once (memoized): PATH → vendored bundle copy → null. */
function resolveLlmfitBin(): string | null {
  if (_llmfitBinResolved !== undefined) return _llmfitBinResolved;
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'llmfit.exe' : 'llmfit';
  // 1. PATH — power users who `brew install llmfit` get the freshest model DB.
  try {
    const probe = spawnSync(isWin ? 'where' : 'which', [binName], { stdio: 'pipe', timeout: 3000 });
    if (probe.status === 0) {
      _llmfitBinResolved = binName; // spawnable directly via PATH
      return _llmfitBinResolved;
    }
  } catch {
    /* fall through to vendored copy */
  }
  // 2. Vendored bundle copy (the everyone-else case on a fresh install).
  const vendorBin = path.join(getProjectRoot(), 'vendor', 'llmfit', binName);
  if (fs.existsSync(vendorBin)) {
    _llmfitBinResolved = vendorBin;
    return _llmfitBinResolved;
  }
  _llmfitBinResolved = null;
  return null;
}

/** Best-effort set of installed Ollama model names (both `name` and bare family). */
async function fetchInstalledOllamaModels(): Promise<Set<string>> {
  const installed = new Set<string>();
  const url = (getSetting('ollama_base_url') || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const resp = await fetch(url + '/api/tags', { signal: AbortSignal.timeout(3000) });
    const data = (await resp.json()) as any;
    for (const m of data?.models || []) {
      if (typeof m?.name === 'string') {
        installed.add(m.name);
        installed.add(m.name.replace(/:latest$/, '')); // ollama omits :latest in some views
      }
    }
  } catch {
    /* ollama not running — fall back to llmfit's own `installed` flag */
  }
  return installed;
}

/** Extract a llama.cpp `-hf <repo>:<quant>` pair from an llmfit model row. */
function ggufHfParts(m: any): { name: string; quant: string } | null {
  const cmd = String(m?.llamacpp_command || '');
  const fromCmd = cmd.match(/-hf\s+(\S+)/);
  if (fromCmd) {
    const full = fromCmd[1];
    const i = full.lastIndexOf(':');
    if (i > 0) return { name: full.slice(0, i), quant: full.slice(i + 1) };
    if (m?.best_quant) return { name: full, quant: String(m.best_quant) };
  }
  const sources = Array.isArray(m?.gguf_sources) ? m.gguf_sources : [];
  if (!sources.length) return null;
  const scoreRepo = (s: any) => {
    const repo = String(s?.repo || '');
    const prov = String(s?.provider || '').toLowerCase();
    if (/mlx/i.test(repo)) return -1;
    if (prov === 'bartowski' || /bartowski/i.test(repo)) return 3;
    if (prov === 'unsloth' || /unsloth/i.test(repo)) return 2;
    if (/GGUF/i.test(repo)) return 1;
    return 0;
  };
  const ranked = [...sources].sort((a, b) => scoreRepo(b) - scoreRepo(a));
  const pick = ranked[0];
  const repo = pick?.repo;
  if (!repo || scoreRepo(pick) < 0) return null;
  return { name: String(repo), quant: String(m?.best_quant || 'Q4_K_M') };
}

/** Shape llmfit's raw JSON into the stable contract consumed by onboarding + settings. */
function postProcessModelFit(
  raw: string,
  installedOllama: Set<string>,
  ggufRaw?: string | null,
): Record<string, unknown> {
  const data = JSON.parse(raw) as any;
  const models: any[] = Array.isArray(data?.models) ? data.models : [];
  const sys = data?.system || {};

  const valid = models.filter((m) => m && typeof m.name === 'string' && typeof m.score === 'number');

  const seen = new Set<string>();
  const ollama_models = valid
    .filter((m) => m.ollama_name)
    .sort((a, b) => b.score - a.score)
    .filter((m) => (seen.has(m.ollama_name) ? false : (seen.add(m.ollama_name), true)))
    .slice(0, 5)
    .map((m) => ({
      name: m.name,
      ollama_name: m.ollama_name,
      score: m.score,
      fit_level: m.fit_level ?? null,
      estimated_tps: m.estimated_tps ?? null,
      memory_required_gb: m.memory_required_gb ?? null,
      disk_size_gb: m.disk_size_gb ?? null,
      installed: !!m.installed || installedOllama.has(m.ollama_name) || installedOllama.has(String(m.ollama_name).replace(/:latest$/, '')),
    }));

  const mlx = valid
    .filter((m) => !m.ollama_name)
    .filter((m) => /mlx/i.test(String(m.best_quant || m.runtime || m.runtime_label || '')))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => ({
      name: m.name,
      quant: m.best_quant ?? null,
      score: m.score,
      fit_level: m.fit_level ?? null,
      estimated_tps: m.estimated_tps ?? null,
      memory_required_gb: m.memory_required_gb ?? null,
      disk_size_gb: m.disk_size_gb ?? null,
    }));

  let ggufModels: any[] = [];
  try {
    const ggufData = ggufRaw ? (JSON.parse(ggufRaw) as any) : data;
    const ggufSrc: any[] = Array.isArray(ggufData?.models) ? ggufData.models : [];
    const seenHf = new Set<string>();
    ggufModels = ggufSrc
      .filter((m) => m && typeof m.name === 'string' && typeof m.score === 'number')
      .sort((a, b) => b.score - a.score)
      .map((m) => {
        const parts = ggufHfParts(m);
        if (!parts) return null;
        const key = `${parts.name}:${parts.quant}`;
        if (seenHf.has(key)) return null;
        seenHf.add(key);
        return {
          name: parts.name,
          quant: parts.quant,
          score: m.score,
          fit_level: m.fit_level ?? null,
          estimated_tps: m.estimated_tps ?? null,
          memory_required_gb: m.memory_required_gb ?? null,
          disk_size_gb: m.disk_size_gb ?? null,
        };
      })
      .filter(Boolean)
      .slice(0, 5) as any[];
  } catch {
    ggufModels = [];
  }

  return {
    available: true,
    system: {
      cpu_name: sys.cpu_name ?? null,
      total_ram_gb: sys.total_ram_gb ?? null,
      gpu_name: sys.gpu_name ?? null,
      backend: sys.backend ?? null,
      unified_memory: sys.unified_memory ?? null,
    },
    ollama_models,
    other_models: { mlx, gguf: ggufModels },
  };
}

/** Spawn `llmfit recommend …` once; resolve stdout string or null. Never rejects. */
function spawnLlmfitRecommend(bin: string, extraArgs: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(bin, ['recommend', '--json', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve(null);
    }, LLMFIT_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(t);
      resolve(stdout.trim() ? stdout : null);
    });
  });
}

/** Run llmfit (primary + GGUF force-runtime); resolve shaped payload or `{ available: false }`. */
function fetchModelFitOnce(): Promise<Record<string, unknown>> {
  const bin = resolveLlmfitBin();
  if (!bin) {
    return Promise.resolve({
      available: false,
      install_hint: 'brew install llmfit  # or scripts/fetch-llmfit.sh',
    });
  }
  return (async () => {
    const [primary, ggufRaw, installed] = await Promise.all([
      spawnLlmfitRecommend(bin, ['-n', '12']),
      spawnLlmfitRecommend(bin, ['-n', '24', '--force-runtime', 'llamacpp', '--output-llamacpp']),
      fetchInstalledOllamaModels(),
    ]);
    if (!primary) {
      return { available: false, error: 'llmfit timed out or spawn failed' };
    }
    try {
      return postProcessModelFit(primary, installed, ggufRaw);
    } catch (err) {
      console.error('[model-fit] parse failed:', err instanceof Error ? err.message : err, '| raw:', primary.slice(0, 500));
      return { available: false, error: 'llmfit output unparseable' };
    }
  })();
}

async function getModelFitCached(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (_modelFitCache && now < _modelFitCache.expiresAt) return _modelFitCache.value;
  if (!_modelFitInflight) {
    _modelFitInflight = fetchModelFitOnce()
      .then((value) => {
        // Cache successes for the full hour; cache failures briefly (60s) so a
        // just-installed binary or a started Ollama is picked up soon.
        const ttl = value.available ? MODEL_FIT_CACHE_TTL_MS : 60 * 1000;
        _modelFitCache = { value, expiresAt: Date.now() + ttl };
        return value;
      })
      .finally(() => { _modelFitInflight = null; });
  }
  return _modelFitInflight;
}

router.get('/model-fit', async (_req: Request, res: Response) => {
  // Never errors: worst case is { available: false } and the UI keeps its static text.
  res.json(await getModelFitCached());
});

export { router as systemRouter };
