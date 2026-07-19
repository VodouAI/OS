/**
 * In-process debug snapshots for support (localhost diagnostics, logs).
 * No secrets — only paths, conv ids, error snippets, WS client conversationIds.
 */

export interface StreamNoClientsDiag {
  convId: string;
  seq?: number;
  payloadType?: string;
  at: string;
  clientCount: number;
  /** Each connected WS client's server-side `conversationId` (may mismatch `convId`). */
  clientConversationIds: string[];
}

export interface ChatFailureDiag {
  convId: string;
  turnId?: string;
  error: string;
  at: string;
}

let lastStreamNoClients: StreamNoClientsDiag | null = null;
let lastChatFailure: ChatFailureDiag | null = null;

export function recordStreamNoClients(diag: StreamNoClientsDiag): void {
  lastStreamNoClients = diag;
}

export function recordChatFailure(diag: ChatFailureDiag): void {
  lastChatFailure = diag;
}

export function clearChatFailure(): void {
  lastChatFailure = null;
}

export function getGatewayDebugSnapshot(): {
  last_stream_no_clients: StreamNoClientsDiag | null;
  last_chat_failure: ChatFailureDiag | null;
} {
  return {
    last_stream_no_clients: lastStreamNoClients,
    last_chat_failure: lastChatFailure,
  };
}
