import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ChildProcess } from 'child_process';

export interface MCPClientConnection {
  client: Client;
  process: ChildProcess | null;
  sessionId: string;
  port?: number; // HTTP port for SSE transport
}

export class MCPClientManager {
  private connections: Map<string, MCPClientConnection> = new Map();

  async createConnection(
    sessionId: string,
    command: string,
    args: string[],
    workingDirectory?: string | null,
    port?: number
  ): Promise<MCPClientConnection> {
    // If port is provided, use HTTP/SSE transport (process already running)
    if (port) {
      const url = `http://localhost:${port}/sse`;
      const transport = new SSEClientTransport(new URL(url));
      
      const client = new Client({
        name: 'Vodou-session-manager',
        version: '0.1.0'
      }, {
        capabilities: {}
      });
      
      await client.connect(transport);
      
      const connection: MCPClientConnection = {
        client,
        process: null, // Process is detached, we don't track it
        sessionId,
        port
      };
      
      this.connections.set(sessionId, connection);
      console.error(`[Vodou-session-manager] Connected to existing process via HTTP/SSE on port ${port} for session ${sessionId}`);
      
      return connection;
    }
    
    // Otherwise, use stdio transport (spawn new process)
    const env: Record<string, string> = {};
    for (const key in process.env) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }
    
    const transport = new StdioClientTransport({
      command: command,
      args: args,
      env: env
    });

    const client = new Client({
      name: 'Vodou-session-manager',
      version: '0.1.0'
    }, {
      capabilities: {}
    });

    try {
      await client.connect(transport);
    } catch (error: any) {
      console.error(`[Vodou-session-manager] Client connect failed:`, error);
      // Re-throw with more context
      throw new Error(`Failed to connect MCP client: ${error.message || error}`);
    }

    const connection: MCPClientConnection = {
      client,
      process: null as any,
      sessionId
    };

    this.connections.set(sessionId, connection);
    
    console.error(`[Vodou-session-manager] Created stdio connection for session ${sessionId}, total connections: ${this.connections.size}`);

    return connection;
  }

  getConnection(sessionId: string): MCPClientConnection | undefined {
    return this.connections.get(sessionId);
  }

  async callTool(
    sessionId: string,
    toolName: string,
    args: Record<string, any>,
    timeoutMs?: number
  ): Promise<any> {
    console.error(`[Vodou-session-manager] Looking for session ${sessionId}, available sessions: ${Array.from(this.connections.keys()).join(', ')}`);
    const connection = this.connections.get(sessionId);
    if (!connection) {
      throw new Error(`Session ${sessionId} not found. Available sessions: ${Array.from(this.connections.keys()).join(', ') || 'none'}`);
    }

    try {
      const requestOptions = timeoutMs ? { timeout: timeoutMs } : undefined;
      if (timeoutMs) {
        console.error(`[Vodou-session-manager] Using timeout ${timeoutMs}ms for ${toolName}`);
      }
      const result = await connection.client.callTool({
        name: toolName,
        arguments: args
      }, undefined, requestOptions);

      return result;
    } catch (error: any) {
      throw new Error(`Tool call failed: ${error.message}`);
    }
  }

  closeConnection(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      try {
        connection.client.close();
        // Process is managed by transport, closing client will handle it
      } catch (error) {
        console.error(`Error closing connection ${sessionId}:`, error);
      }
      this.connections.delete(sessionId);
    }
  }

  closeAllConnections(): void {
    for (const sessionId of this.connections.keys()) {
      this.closeConnection(sessionId);
    }
  }
}

