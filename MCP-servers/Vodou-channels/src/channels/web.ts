/**
 * Web Channel Implementation
 * Simple WebSocket-based web interface for Vodou
 */

import express, { Express } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '../types.js';

interface WebClient {
  id: string;
  ws: WebSocket;
  name?: string;
  connectedAt: Date;
}

export class WebChannel implements Channel {
  type = 'web' as const;
  private app: Express | null = null;
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private port: number;
  private clients: Map<string, WebClient> = new Map();
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;

  constructor() {
    // Dedicated port var — do NOT read WEB_PORT. That is the Vodou-Console
    // GATEWAY's port (8765 in .env), which this channel process inherits from the
    // gateway environment. Reading it made the web channel bind 8765 and shadow
    // the gateway over IPv6 (the bare "Vodou Web Interface" page bug, 2026-05-29).
    // Pinned to its own port (8770), away from gateway (8765) and core API (8766).
    this.port = parseInt(process.env.VODOU_WEB_CHANNEL_PORT || '8770', 10);
  }

  async connect(): Promise<void> {
    try {
      this.app = express();

      // Serve simple HTML interface
      this.app.get('/', (req, res) => {
        res.send(this.getHtmlInterface());
      });

      // Health check
      this.app.get('/health', (req, res) => {
        res.json({ status: 'ok', clients: this.clients.size });
      });

      this.server = createServer(this.app);
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on('connection', (ws, req) => {
        const clientId = `web_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const client: WebClient = {
          id: clientId,
          ws,
          connectedAt: new Date(),
        };
        this.clients.set(clientId, client);

        console.error(`[Web] Client connected: ${clientId}`);

        // Send welcome message
        ws.send(JSON.stringify({
          type: 'connected',
          clientId,
          message: 'Connected to Vodou Web Interface',
        }));

        ws.on('message', async (data) => {
          this.lastActivity = new Date();

          try {
            const parsed = JSON.parse(data.toString());

            if (parsed.type === 'message' && parsed.content) {
              const incoming: IncomingMessage = {
                id: `${clientId}_${Date.now()}`,
                channel: 'web',
                sender: clientId,
                senderName: client.name || clientId,
                content: parsed.content,
                timestamp: new Date(),
                raw: parsed,
              };

              if (this.messageHandler) {
                const response = await this.messageHandler(incoming);
                if (response) {
                  ws.send(JSON.stringify({
                    type: 'response',
                    content: response,
                    timestamp: new Date().toISOString(),
                  }));
                }
              }
            } else if (parsed.type === 'setName') {
              client.name = parsed.name;
            }
          } catch (err) {
            console.error('[Web] Error processing message:', err);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Invalid message format',
            }));
          }
        });

        ws.on('close', () => {
          this.clients.delete(clientId);
          console.error(`[Web] Client disconnected: ${clientId}`);
        });

        ws.on('error', (err) => {
          console.error(`[Web] WebSocket error for ${clientId}:`, err);
        });
      });

      await new Promise<void>((resolve, reject) => {
        // Bind 127.0.0.1 explicitly (not the IPv6 wildcard). If the port is ever
        // taken, this fails loudly with EADDRINUSE instead of silently shadowing
        // another service on the IPv6 side of the same port.
        this.server!.listen(this.port, '127.0.0.1', () => {
          this.connected = true;
          this.error = undefined;
          console.error(`[Web] Server running on http://127.0.0.1:${this.port}`);
          resolve();
        }).on('error', reject);
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Connection failed: ${this.error}`);
    }
  }

  async disconnect(): Promise<void> {
    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.app = null;
    this.connected = false;
    console.error('[Web] Disconnected');
  }

  async send(message: OutgoingMessage): Promise<boolean> {
    const client = this.clients.get(message.recipient);

    if (!client) {
      // Broadcast to all if recipient is 'all' or not found
      if (message.recipient === 'all') {
        for (const c of this.clients.values()) {
          c.ws.send(JSON.stringify({
            type: 'message',
            content: message.content,
            timestamp: new Date().toISOString(),
          }));
        }
        this.lastActivity = new Date();
        return true;
      }
      console.error(`[Web] Client not found: ${message.recipient}`);
      return false;
    }

    try {
      client.ws.send(JSON.stringify({
        type: 'message',
        content: message.content,
        timestamp: new Date().toISOString(),
      }));
      this.lastActivity = new Date();
      return true;
    } catch (err) {
      console.error('[Web] Send error:', err);
      return false;
    }
  }

  getStatus(): ChannelStatus {
    return {
      channel: 'web',
      connected: this.connected,
      error: this.error,
      lastActivity: this.lastActivity,
      metadata: {
        port: this.port,
        clientCount: this.clients.size,
        clients: Array.from(this.clients.keys()),
      },
    };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  private getHtmlInterface(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vodou Web Interface</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: #16213e;
      padding: 1rem;
      text-align: center;
      border-bottom: 1px solid #0f3460;
    }
    header h1 { font-size: 1.5rem; color: #e94560; }
    #status { font-size: 0.8rem; color: #888; margin-top: 0.25rem; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .message {
      max-width: 80%;
      padding: 0.75rem 1rem;
      border-radius: 1rem;
      line-height: 1.4;
    }
    .user { background: #0f3460; align-self: flex-end; border-bottom-right-radius: 0.25rem; }
    .assistant { background: #16213e; align-self: flex-start; border-bottom-left-radius: 0.25rem; }
    .system { background: #2a2a4e; align-self: center; font-size: 0.8rem; color: #888; }
    #input-area {
      display: flex;
      padding: 1rem;
      gap: 0.5rem;
      background: #16213e;
      border-top: 1px solid #0f3460;
    }
    #input {
      flex: 1;
      padding: 0.75rem 1rem;
      border: none;
      border-radius: 1.5rem;
      background: #1a1a2e;
      color: #eee;
      font-size: 1rem;
    }
    #input:focus { outline: 2px solid #e94560; }
    #send {
      padding: 0.75rem 1.5rem;
      border: none;
      border-radius: 1.5rem;
      background: #e94560;
      color: white;
      cursor: pointer;
      font-size: 1rem;
    }
    #send:hover { background: #d63651; }
    #send:disabled { background: #555; cursor: not-allowed; }
  </style>
</head>
<body>
  <header>
    <h1>Vodou Web Interface</h1>
    <div id="status">Connecting...</div>
  </header>
  <div id="messages"></div>
  <div id="input-area">
    <input type="text" id="input" placeholder="Type a message..." autocomplete="off">
    <button id="send">Send</button>
  </div>
  <script>
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const status = document.getElementById('status');
    let ws;

    function addMessage(content, type) {
      const div = document.createElement('div');
      div.className = 'message ' + type;
      div.textContent = content;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host);

      ws.onopen = () => {
        status.textContent = 'Connected';
        status.style.color = '#4ade80';
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          addMessage('Connected to Vodou', 'system');
        } else if (data.type === 'response' || data.type === 'message') {
          addMessage(data.content, 'assistant');
        } else if (data.type === 'error') {
          addMessage('Error: ' + data.message, 'system');
        }
      };

      ws.onclose = () => {
        status.textContent = 'Disconnected - Reconnecting...';
        status.style.color = '#ef4444';
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        status.textContent = 'Connection error';
        status.style.color = '#ef4444';
      };
    }

    function sendMessage() {
      const text = input.value.trim();
      if (!text || ws.readyState !== WebSocket.OPEN) return;

      addMessage(text, 'user');
      ws.send(JSON.stringify({ type: 'message', content: text }));
      input.value = '';
    }

    send.onclick = sendMessage;
    input.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };

    connect();
  </script>
</body>
</html>`;
  }
}
