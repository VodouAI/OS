import { spawn, ChildProcess } from 'child_process';
import { randomInt } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ProcessInfo {
  pid: number;
  port: number;
  command: string;
  args: string[];
  workingDirectory?: string | null;
}

export class ProcessManager {
  /**
   * Spawn a detached MCP server process with HTTP/SSE transport
   * Returns process info with PID and port
   */
  static spawnDetachedMCP(
    command: string,
    args: string[],
    workingDirectory?: string | null
  ): ProcessInfo {
    // Find an available port (9000-9999 range)
    const port = this.findAvailablePort();
    
    // Start with existing args
    const finalArgs = [...args];
    
    // Add --port flag if not already present
    if (!finalArgs.includes('--port')) {
      finalArgs.push('--port', port.toString());
    }
    
    // Playwright MCP runs in headed mode by default (no --headless flag)
    // Only add --headless if explicitly requested (which we don't want)
    // So we don't add any headless flag - default is headed mode
    
    // Add --shared-browser-context if not already present (reuse browser context between calls)
    if (!finalArgs.includes('--shared-browser-context')) {
      finalArgs.push('--shared-browser-context');
    }
    
    return this.spawnProcess(command, finalArgs, workingDirectory, port);
  }
  
  /**
   * Spawn a detached MCP server process with stdio transport (no port)
   * Returns process info with PID and port = 0 (stdio doesn't use ports)
   */
  static spawnStdioMCP(
    command: string,
    args: string[],
    workingDirectory?: string | null
  ): ProcessInfo {
    // For stdio servers, don't add --port flag
    const finalArgs = [...args];
    
    return this.spawnProcess(command, finalArgs, workingDirectory, 0);
  }
  
  /**
   * Internal method to spawn process
   */
  private static spawnProcess(
    command: string,
    args: string[],
    workingDirectory: string | null | undefined,
    port: number
  ): ProcessInfo {
    
    // Prepare environment
    const env: Record<string, string> = {};
    for (const key in process.env) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }
    
    // Create log directory if it doesn't exist
    const projectRoot = join(__dirname, '../../..');
    const logDir = join(projectRoot, 'logs');
    try {
      mkdirSync(logDir, { recursive: true });
    } catch (e) {
      // Directory might already exist
    }
    
    // Spawn as detached process
    // Redirect stderr to log file so we can debug issues
    const childProcess = spawn(command, args, {
      cwd: workingDirectory || undefined,
      stdio: ['ignore', 'ignore', 'pipe'], // Capture stderr
      env: env,
      detached: true, // Detach from parent
    });
    
    if (!childProcess.pid) {
      throw new Error('Failed to spawn process');
    }
    
    const logFile = join(logDir, `mcp-server-${childProcess.pid}.log`);
    
    // Write stderr to log file
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        try {
          writeFileSync(logFile, data.toString(), { flag: 'a' });
        } catch (e) {
          // Ignore write errors
        }
      });
    }
    
    // Unref so parent can exit without killing child
    childProcess.unref();
    
    return {
      pid: childProcess.pid,
      port: port,
      command: command,
      args: args,
      workingDirectory: workingDirectory || null
    };
  }
  
  /**
   * Check if a process is still running
   */
  static isProcessAlive(pid: number): boolean {
    try {
      // On Unix systems, kill with signal 0 checks if process exists
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      // ESRCH = process doesn't exist
      return false;
    }
  }
  
  /**
   * Kill a process by PID
   */
  static killProcess(pid: number): boolean {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Find an available port in the 9000-9999 range
   */
  private static findAvailablePort(): number {
    // Simple approach: use random port in range
    // In production, you'd want to check if port is actually available
    return randomInt(9000, 10000);
  }
  
  /**
   * Check if a port is available (basic check)
   */
  static async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();
      
      server.listen(port, () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      
      server.on('error', () => resolve(false));
    });
  }
}

