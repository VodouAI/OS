/**
 * Scripts API — script_registry + script_jobs
 */
import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getDb, getProjectRoot } from '../db.js';
import { freshEnv } from '../executor.js';
export const scriptsRouter = Router();
// GET /api/scripts — list script_registry
scriptsRouter.get('/', (req, res) => {
    try {
        const db = getDb();
        const scripts = db.prepare(`SELECT id, server_name, script_name, command, working_directory, description,
              parameters, auto_discovered, background_execution, estimated_duration,
              created_at, updated_at
       FROM script_registry
       ORDER BY server_name, script_name`).all();
        res.json(scripts);
    }
    catch (err) {
        console.error('[Scripts API] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// GET /api/scripts/jobs — recent script_jobs
scriptsRouter.get('/jobs', (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const status = req.query.status;
        let where = '';
        const params = [];
        if (status) {
            where = ' WHERE status = ?';
            params.push(status);
        }
        const jobs = db.prepare(`SELECT id, job_id, server_name, script_name, command, status,
              pid, started_at, completed_at, exit_code, output_file, error_file, progress
       FROM script_jobs${where}
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`).all(...params, limit, offset);
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM script_jobs${where}`).get(...params);
        res.json({ jobs, total: countRow?.total || 0 });
    }
    catch (err) {
        console.error('[Scripts API] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// POST /api/scripts/:server/:script/run — execute via vodou-core call
scriptsRouter.post('/:server/:script/run', (req, res) => {
    const { server, script } = req.params;
    const db = getDb();
    // Verify script exists
    const entry = db.prepare('SELECT * FROM script_registry WHERE server_name = ? AND script_name = ?').get(server, script);
    if (!entry) {
        res.status(404).json({ error: `Script ${server}/${script} not found` });
        return;
    }
    const bt4Path = path.join(getProjectRoot(), 'vodou-core');
    const args = JSON.stringify({ server_name: server, script_name: script });
    const env = freshEnv();
    // Ensure VODOU_PROJECT_PATH and headless mode are set
    env.VODOU_PROJECT_PATH = env.VODOU_PROJECT_PATH || getProjectRoot();
    env.VODOU_ALLOW_HEADLESS_BRAIN = '1';
    env.VODOU_INTERNAL = '1';
    const proc = spawn(bt4Path, ['call', 'Vodou-script-executor', 'execute_script', args], {
        cwd: getProjectRoot(),
        env,
    });
    const SCRIPT_TIMEOUT_MS = 120000; // 2 minutes for scripts
    const killTimer = setTimeout(() => {
        try {
            proc.kill('SIGKILL');
        }
        catch { }
    }, SCRIPT_TIMEOUT_MS);
    // Don't kill the script when the HTTP request closes — let it finish
    // The client may reconnect or poll for status
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
        clearTimeout(killTimer);
        if (!res.headersSent) {
            res.json({ success: false, output: `Failed to start: ${err.message}`, exitCode: -1, server, script });
        }
    });
    proc.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (res.headersSent)
            return;
        res.json({
            success: code === 0,
            output: stdout.trim() || stderr.trim() || (signal ? `Killed by signal: ${signal}` : 'No output'),
            exitCode: code,
            server,
            script,
        });
    });
    proc.on('error', (err) => {
        clearTimeout(killTimer);
        res.status(500).json({ error: err.message });
    });
});
// GET /api/scripts/jobs/:jobId — single job status
scriptsRouter.get('/jobs/:jobId', (req, res) => {
    try {
        const db = getDb();
        const job = db.prepare('SELECT * FROM script_jobs WHERE job_id = ?').get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: `Job ${req.params.jobId} not found` });
            return;
        }
        res.json(job);
    }
    catch (err) {
        console.error('[Scripts API] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
