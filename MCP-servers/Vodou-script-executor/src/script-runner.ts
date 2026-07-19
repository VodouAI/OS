import { spawn, ChildProcess } from 'child_process';
import { open as openDb } from './db.js';
import { nanoid } from 'nanoid';
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
function loadEnvFile(projectRoot: string): Record<string, string> {
  const envPath = join(projectRoot, '.env');
  const env: Record<string, string> = {};
  
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // Parse KEY=VALUE format
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        
        env[key] = value;
      }
    }
  }
  
  return env;
}

interface Script {
  server_name: string;
  script_name: string;
  command: string;
  working_directory: string;
  background_execution: number;
  estimated_duration?: number;
}

interface JobResult {
  jobId?: string;
  output?: string;
  status: string;
  message?: string;
}

// Ensure logs directory exists
function ensureLogsDir(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = process.env.VODOU_PROJECT_PATH || join(scriptDir, '../../..');
  const logsDir = join(projectRoot, 'logs', 'scripts');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

// Generate unique job ID
function generateJobId(): string {
  return `job_${nanoid(12)}`;
}

// Resolve working directory to absolute path (relative paths resolve against project root)
function resolveWorkingDir(workDir: string): string {
  if (workDir.startsWith('/')) return workDir;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = process.env.VODOU_PROJECT_PATH || join(scriptDir, '../../..');
  return join(projectRoot, workDir);
}

// Execute script synchronously
async function execScriptSync(
  script: Script,
  params: Record<string, any>,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cwd = resolveWorkingDir(script.working_directory);
    const child = spawn('sh', ['-c', script.command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout || 'Script executed successfully');
      } else {
        reject(new Error(`Script failed with exit code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

// Execute script (sync or background)
export async function executeScript(
  dbPath: string,
  serverName: string,
  scriptName: string,
  params: Record<string, any> = {}
): Promise<JobResult> {
  const db = openDb(dbPath);

  try {
    // Get script from database (routing already handled in index.ts)
    const script = db.prepare(`
      SELECT * FROM script_registry 
      WHERE server_name = ? AND script_name = ?
    `).get(serverName, scriptName) as Script | undefined;

    if (!script) {
      throw new Error(`Script not found: ${serverName}::${scriptName}`);
    }

    // Check if background execution needed
    const needsBackground =
      script.background_execution === 1 ||
      (script.estimated_duration && script.estimated_duration > 300);

    if (needsBackground) {
      // Background execution
      const jobId = generateJobId();
      const logsDir = ensureLogsDir();
      const outputFile = join(logsDir, `${jobId}.out`);
      const errorFile = join(logsDir, `${jobId}.err`);

      // Register job in database
      db.prepare(`
        INSERT INTO script_jobs 
        (job_id, server_name, script_name, command, working_directory, 
         status, output_file, error_file)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        jobId,
        serverName,
        scriptName,
        script.command,
        script.working_directory,
        outputFile,
        errorFile
      );

      // Use wrapper script for truly independent background execution
      // The wrapper handles output capture, .env loading, and database updates
      // Get script directory (dist/script-runner.js -> scripts/)
      const scriptDir = dirname(fileURLToPath(import.meta.url));
      const wrapperScript = join(scriptDir, '../scripts/run-background-job.sh');
      
      // Get database path (go up from dist/ to project root)
      const projectRoot = join(scriptDir, '../../..');
      const dbPath = join(projectRoot, 'vodou-core.db');
      
      // Resolve working directory to absolute path
      // working_directory is relative like "./MCP-servers/Vodou-something"
      // Resolve it relative to project root
      const absoluteWorkingDir = script.working_directory.startsWith('/')
        ? script.working_directory
        : join(projectRoot, script.working_directory);
      
      // Build command for wrapper: job_id, db_path, command, working_dir, output_file, error_file
      // Also pass params as JSON in environment variable
      const paramsJson = JSON.stringify(params);
      const wrapperCommand = `"${wrapperScript}" "${jobId}" "${dbPath}" "${script.command.replace(/"/g, '\\"')}" "${absoluteWorkingDir}" "${outputFile}" "${errorFile}"`;
      
      // Prepare environment with params
      const envWithParams = {
        ...process.env,
        PARAMS_JSON: paramsJson,
      };
      
      // Spawn wrapper as detached process - it handles everything independently
      const child = spawn('sh', ['-c', wrapperCommand], {
        cwd: absoluteWorkingDir,
        stdio: 'ignore', // Wrapper handles all I/O
        detached: true, // Process is completely independent
        env: envWithParams, // Pass params via environment
      });

      // Store PID immediately
      if (child.pid) {
        db.prepare(`
          UPDATE script_jobs SET pid = ? WHERE job_id = ?
        `).run(child.pid, jobId);
      }

      // Unref immediately - process is now independent
      child.unref();

      // Monitor completion (don't wait)
      child.on('exit', (code) => {
        const db = openDb(dbPath);
        db.prepare(`
          UPDATE script_jobs 
          SET status = ?, exit_code = ?, completed_at = CURRENT_TIMESTAMP
          WHERE job_id = ?
        `).run(
          code === 0 ? 'completed' : 'failed',
          code || -1,
          jobId
        );
        db.close();
      });

      child.on('error', (error) => {
        const db = openDb(dbPath);
        db.prepare(`
          UPDATE script_jobs 
          SET status = 'failed', exit_code = -1, completed_at = CURRENT_TIMESTAMP
          WHERE job_id = ?
        `).run(jobId);
        db.close();
        console.error(`Job ${jobId} error:`, error);
      });

      db.close();

      return {
        jobId,
        status: 'running',
        message: `Background job started: ${jobId}`,
      };
    } else {
      // Synchronous execution - also load .env for sync execution
      const projectRoot = join(script.working_directory, '../..');
      const envVars = loadEnvFile(projectRoot);
      const processEnv = { ...process.env, ...envVars };
      
      const output = await execScriptSync(script, params, processEnv);
      db.close();
      return {
        output,
        status: 'completed',
      };
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

// Get script job status
export async function getScriptStatus(
  dbPath: string,
  jobId: string
): Promise<Record<string, any>> {
  const db = openDb(dbPath);

  try {
    const job = db.prepare(`
      SELECT * FROM script_jobs WHERE job_id = ?
    `).get(jobId) as any;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Calculate elapsed time
    const startedAt = new Date(job.started_at);
    const now = new Date();
    const elapsedMs = now.getTime() - startedAt.getTime();
    const elapsedMinutes = Math.floor(elapsedMs / 60000);
    const elapsedSeconds = Math.floor((elapsedMs % 60000) / 1000);

    const result = {
      jobId: job.job_id,
      status: job.status,
      serverName: job.server_name,
      scriptName: job.script_name,
      startedAt: job.started_at,
      completedAt: job.completed_at || null,
      exitCode: job.exit_code || null,
      elapsed: `${elapsedMinutes}m ${elapsedSeconds}s`,
      pid: job.pid || null,
    };

    db.close();
    return result;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Get script output
export async function getScriptOutput(
  dbPath: string,
  jobId: string,
  tailLines: number = 100
): Promise<string> {
  const db = openDb(dbPath);

  try {
    const job = db.prepare(`
      SELECT output_file, error_file, status FROM script_jobs WHERE job_id = ?
    `).get(jobId) as any;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    let output = '';

    // Read stdout
    if (job.output_file && existsSync(job.output_file)) {
      const content = readFileSync(job.output_file, 'utf-8');
      const lines = content.split('\n');
      const tail = lines.slice(-tailLines).join('\n');
      output += `=== STDOUT (last ${Math.min(tailLines, lines.length)} lines) ===\n${tail}\n\n`;
    }

    // Read stderr
    if (job.error_file && existsSync(job.error_file)) {
      const content = readFileSync(job.error_file, 'utf-8');
      if (content.trim()) {
        const lines = content.split('\n');
        const tail = lines.slice(-tailLines).join('\n');
        output += `=== STDERR (last ${Math.min(tailLines, lines.length)} lines) ===\n${tail}\n`;
      }
    }

    if (!output) {
      output = `No output available yet. Status: ${job.status}`;
    }

    db.close();
    return output;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Cancel script job
export async function cancelScript(
  dbPath: string,
  jobId: string
): Promise<Record<string, any>> {
  const db = openDb(dbPath);

  try {
    const job = db.prepare(`
      SELECT pid, status FROM script_jobs WHERE job_id = ?
    `).get(jobId) as any;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'running') {
      return {
        jobId,
        status: job.status,
        message: `Job is not running (current status: ${job.status})`,
      };
    }

    // Try to kill the process
    if (job.pid) {
      try {
        process.kill(job.pid, 'SIGTERM');
        // Give it a moment, then force kill if needed
        setTimeout(() => {
          try {
            process.kill(job.pid, 'SIGKILL');
          } catch {
            // Process already dead
          }
        }, 2000);
      } catch (error) {
        // Process might already be dead
        console.error(`Error killing process ${job.pid}:`, error);
      }
    }

    // Update job status
    db.prepare(`
      UPDATE script_jobs 
      SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(jobId);

    db.close();

    return {
      jobId,
      status: 'cancelled',
      message: 'Job cancellation requested',
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

