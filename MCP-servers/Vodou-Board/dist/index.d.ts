#!/usr/bin/env node
/**
 * Vodou-Board MCP server entrypoint.
 *
 * 14 board_* tools. Gated on VODOU_BOARD_TASK env var — visible only in
 * worker sessions. Workers spawned by the dispatcher have it set; chat
 * sessions don't.
 *
 * Reads route directly through src/db.ts (board.db + ATTACHed core + mem).
 * Writes route through src/gateway-client.ts (POST /api/board/* with
 * VODOU_BOARD_WRITE_TOKEN bearer auth, offline orphan-event fallback).
 *
 * Mirrors MCP-servers/Vodou-Enhanced-Thinking/src/index.ts shape.
 */
export {};
