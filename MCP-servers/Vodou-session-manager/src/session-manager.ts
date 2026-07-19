import { nanoid } from 'nanoid';
import { SessionDatabase, MCPSession } from './database.js';
import { MCPClientManager } from './mcp-client.js';
import { ProcessManager, ProcessInfo } from './process-manager.js';
import { ChildProcess } from 'child_process';

export interface CreateSessionParams {
  server_name: string;
  timeout?: number; // seconds, default 3600
  metadata?: Record<string, any>;
}

export interface CallWithSessionParams {
  session_id: string;
  tool_name: string;
  arguments: Record<string, any>;
  timeout_ms?: number;
}

export class SessionManager {
  private db: SessionDatabase;
  private mcpClients: MCPClientManager;
  private processes: Map<string, ChildProcess> = new Map();

  constructor() {
    this.db = new SessionDatabase();
    this.mcpClients = new MCPClientManager();
  }

  async createSession(params: CreateSessionParams): Promise<{ session_id: string; status: string }> {
    const { server_name, timeout = 3600, metadata = {} } = params;

    // Check for existing active session with running process
    const existing = this.db.findActiveSessionWithProcess(server_name);
    if (existing && existing.pid && existing.port) {
      // Verify process is still alive
      if (ProcessManager.isProcessAlive(existing.pid)) {
        // Reuse existing session and process
        this.db.updateLastUsed(existing.session_id);
        
        // Reconnect to existing process via HTTP/SSE
        try {
          await this.mcpClients.createConnection(
            existing.session_id,
            existing.server_command,
            JSON.parse(existing.server_args || '[]'),
            existing.working_directory,
            existing.port
          );
        } catch (error) {
          console.error(`[Vodou-session-manager] Failed to reconnect to existing process, creating new one:`, error);
          // Fall through to create new session
        }
        
        return {
          session_id: existing.session_id,
          status: 'reused'
        };
      } else {
        // Process is dead, mark session as closed
        this.db.updateSessionStatus(existing.session_id, 'closed');
      }
    }

    // Get server configuration
    const serverConfig = this.db.getServerConfig(server_name);
    if (!serverConfig) {
      throw new Error(`Server ${server_name} not found in database`);
    }

    // Generate session ID
    const sessionId = `session_${nanoid()}`;

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + timeout * 1000).toISOString();

    // Check connection type to determine transport
    const isStdio = serverConfig.connection_type === 'stdio';
    
    let processInfo: ProcessInfo | null = null;
    
    if (isStdio) {
      // For stdio servers, don't spawn detached process
      // The MCP client will manage the process lifecycle through the transport
      // Just create the connection directly - it will spawn the process
      let connection;
      try {
        connection = await this.mcpClients.createConnection(
          sessionId,
          serverConfig.command,
          serverConfig.args,
          serverConfig.working_directory,
          undefined // No port for stdio
        );
      } catch (error: any) {
        console.error(`[Vodou-session-manager] Failed to create stdio connection:`, error);
        throw new Error(`Failed to create stdio connection to ${server_name}: ${error.message}`);
      }
      
      // For stdio, the process is managed by StdioClientTransport internally
      // We can't easily get the PID, but that's okay - the connection maintains it
      // Use a placeholder PID or null - the connection itself is what matters
      const pid = (connection.process as any)?.pid || null;
      
      // Create session in database (no port for stdio, PID may be null)
      this.db.createSession({
        session_id: sessionId,
        server_name: server_name,
        server_command: serverConfig.command,
        server_args: JSON.stringify(serverConfig.args),
        working_directory: serverConfig.working_directory,
        status: 'active',
        expires_at: expiresAt,
        metadata: JSON.stringify(metadata),
        pid: pid,
        port: null
      });
    } else {
      // For HTTP/SSE servers (like Playwright), spawn detached process
      try {
        processInfo = ProcessManager.spawnDetachedMCP(
          serverConfig.command,
          serverConfig.args,
          serverConfig.working_directory
        );
        
        // Wait longer for process to start (Playwright needs time to initialize)
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Verify process is still alive
        if (!ProcessManager.isProcessAlive(processInfo.pid)) {
          throw new Error(`Process died immediately after spawn (PID: ${processInfo.pid}). Check MCP server logs.`);
        }
      } catch (error: any) {
        throw new Error(`Failed to spawn detached MCP process: ${error.message}`);
      }

      // Create MCP client connection via HTTP/SSE
      const connection = await this.mcpClients.createConnection(
        sessionId,
        serverConfig.command,
        serverConfig.args,
        serverConfig.working_directory,
        processInfo.port
      );

      // Create session in database with PID and port
      this.db.createSession({
        session_id: sessionId,
        server_name: server_name,
        server_command: serverConfig.command,
        server_args: JSON.stringify(serverConfig.args),
        working_directory: serverConfig.working_directory,
        status: 'active',
        expires_at: expiresAt,
        metadata: JSON.stringify(metadata),
        pid: processInfo.pid,
        port: processInfo.port
      });
    }

    return {
      session_id: sessionId,
      status: 'created'
    };
  }

  async callWithSession(params: CallWithSessionParams): Promise<any> {
    const { session_id, tool_name, arguments: args, timeout_ms } = params;
    const startTime = Date.now();

    // Get session
    const session = this.db.getSession(session_id);
    if (!session) {
      throw new Error(`Session ${session_id} not found`);
    }

    if (session.status !== 'active') {
      throw new Error(`Session ${session_id} is not active (status: ${session.status})`);
    }

    // Check if connection exists, if not, recreate it
    let connection = this.mcpClients.getConnection(session_id);
    if (!connection) {
      // Connection lost, recreate it
      const serverConfig = this.db.getServerConfig(session.server_name);
      if (!serverConfig) {
        throw new Error(`Server ${session.server_name} not found in database`);
      }
      
      const isStdio = serverConfig.connection_type === 'stdio';
      
      // If session has port and process is alive, reconnect via HTTP/SSE
      if (!isStdio && session.port && session.pid && ProcessManager.isProcessAlive(session.pid)) {
        connection = await this.mcpClients.createConnection(
          session_id,
          session.server_command,
          JSON.parse(session.server_args || '[]'),
          session.working_directory,
          session.port
        );
      } else if (isStdio && session.pid && ProcessManager.isProcessAlive(session.pid)) {
        // For stdio, reconnect without port
        connection = await this.mcpClients.createConnection(
          session_id,
          session.server_command,
          JSON.parse(session.server_args || '[]'),
          session.working_directory,
          undefined // No port for stdio
        );
      } else {
        // Process dead, need to spawn new process
        let processInfo: ProcessInfo;
        if (isStdio) {
          processInfo = ProcessManager.spawnStdioMCP(
            serverConfig.command,
            serverConfig.args,
            serverConfig.working_directory
          );
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          processInfo = ProcessManager.spawnDetachedMCP(
            serverConfig.command,
            serverConfig.args,
            serverConfig.working_directory
          );
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Update session with new PID and port
        this.db.updateSessionProcess(session_id, processInfo.pid, isStdio ? 0 : processInfo.port);
        
        // Connect (stdio or HTTP/SSE)
        connection = await this.mcpClients.createConnection(
          session_id,
          serverConfig.command,
          serverConfig.args,
          serverConfig.working_directory,
          isStdio ? undefined : processInfo.port
        );
      }
    }

    // Update last used
    this.db.updateLastUsed(session_id);

    try {
      // Call tool via MCP client (pass timeout if provided)
      const result = await this.mcpClients.callTool(session_id, tool_name, args, timeout_ms);
      const duration = Date.now() - startTime;

      // Record successful call
      this.db.recordCall({
        session_id,
        tool_name,
        arguments: JSON.stringify(args),
        response_status: 'success',
        duration_ms: duration,
        error_message: null
      });

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;

      // Record failed call
      this.db.recordCall({
        session_id,
        tool_name,
        arguments: JSON.stringify(args),
        response_status: 'error',
        duration_ms: duration,
        error_message: error.message
      });

      throw error;
    }
  }

  listSessions(serverName?: string): MCPSession[] {
    return this.db.listSessions(serverName);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Close MCP client connection
    this.mcpClients.closeConnection(sessionId);

    // Kill detached process if PID exists
    if (session.pid) {
      try {
        ProcessManager.killProcess(session.pid);
      } catch (error) {
        console.error(`Error killing process ${session.pid} for session ${sessionId}:`, error);
      }
    }

    // Remove from processes map if tracked
    this.processes.delete(sessionId);

    // Update database
    this.db.closeSession(sessionId);
  }

  getSessionStatus(sessionId: string): MCPSession | undefined {
    return this.db.getSession(sessionId);
  }

  async cleanupIdleSessions(): Promise<number> {
    // Mark idle sessions
    const idleSessions = this.db.listSessions().filter(s => {
      if (s.status !== 'active') return false;
      if (!s.expires_at) return false;
      return new Date(s.expires_at) < new Date();
    });

    for (const session of idleSessions) {
      this.db.updateSessionStatus(session.session_id, 'idle');
    }

    // Close expired sessions
    const closed = this.db.cleanupIdleSessions();
    
    // Kill processes and close MCP connections for closed sessions
    const allSessions = this.db.listSessions();
    for (const session of allSessions) {
      if ((session.status === 'closed' || session.status === 'error') && session.pid) {
        try {
          ProcessManager.killProcess(session.pid);
        } catch (error) {
          console.error(`Error killing process ${session.pid} for session ${session.session_id}:`, error);
        }
        this.mcpClients.closeConnection(session.session_id);
        this.processes.delete(session.session_id);
      }
    }

    return closed;
  }

  shutdown(): void {
    this.mcpClients.closeAllConnections();
    this.db.close();
  }
}

