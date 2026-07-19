/**
 * In-process debug snapshots for support (localhost diagnostics, logs).
 * No secrets — only paths, conv ids, error snippets, WS client conversationIds.
 */
let lastStreamNoClients = null;
let lastChatFailure = null;
export function recordStreamNoClients(diag) {
    lastStreamNoClients = diag;
}
export function recordChatFailure(diag) {
    lastChatFailure = diag;
}
export function clearChatFailure() {
    lastChatFailure = null;
}
export function getGatewayDebugSnapshot() {
    return {
        last_stream_no_clients: lastStreamNoClients,
        last_chat_failure: lastChatFailure,
    };
}
