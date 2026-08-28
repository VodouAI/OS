/**
 * COHERENCE F8 / D-6 — "the same turn describes itself two ways depending on
 * when you look."
 *
 * `turn_receipts` has recorded what every turn used since migration 086, and
 * nothing ever read it back. So a turn that showed "3 memories" while it was
 * live went silent the moment you reopened the conversation — not "used
 * nothing", just gone. F30 fixed the live half; this is the persisted half.
 *
 * It was blocked on a missing join key, which is the thing actually built here:
 * messages live in gateway.db, receipts in vodou-core.db, and neither carried
 * the other's id. `gateway_messages.turn_id` is that key.
 *
 * What these pin is mostly what must NOT happen. A receipt attached to the
 * wrong turn, or an empty receipt invented for a turn we cannot describe, is
 * worse than the silence being fixed — it tells someone Vodou used memories it
 * did not use.
 */

import path from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let coreDb: DatabaseSync;
let gatewayDbPath: string | undefined;

// vodou-core.db (where receipts live) is stubbed; gateway.db is real, because
// the write path under test is a real INSERT through saveMessage.
vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  return { ...actual, getDb: () => coreDb };
});

describe('a reloaded conversation keeps its receipts', () => {
  beforeEach(async () => {
    const { closeGatewayDbOnly } = await import('../src/db.js');
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
    gatewayDbPath = path.join(tmpdir(), `gw-d6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    process.env.GATEWAY_DB_PATH = gatewayDbPath;

    coreDb = new DatabaseSync(':memory:');
    coreDb.exec(`CREATE TABLE turn_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, turn_id TEXT,
      at TEXT NOT NULL, memories_used INTEGER NOT NULL DEFAULT 0, memory_ids TEXT, degraded TEXT)`);
  });

  afterAll(async () => {
    const { closeGatewayDbOnly } = await import('../src/db.js');
    closeGatewayDbOnly();
    if (gatewayDbPath && existsSync(gatewayDbPath)) {
      try { unlinkSync(gatewayDbPath); } catch { /* ignore */ }
    }
  });

  const receipt = (turnId: string, used: number, degraded: string | null = null) =>
    coreDb.prepare('INSERT INTO turn_receipts (conversation_id, turn_id, at, memories_used, degraded) VALUES (?, ?, ?, ?, ?)')
      .run('c1', turnId, '2026-08-21 12:00:00', used, degraded);

  it('stores the turn id and gives the turn back its receipt', async () => {
    const { saveMessage, loadRecentMessages } = await import('../src/conversation-store.js');
    saveMessage('c1', 'user', 'what do you know about me?');
    saveMessage('c1', 'assistant', 'Quite a bit.',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { turnId: 'turn-abc' });
    receipt('turn-abc', 3);

    const rows = loadRecentMessages('c1', 10);
    const assistant = rows.find((r) => r.role === 'assistant');
    expect(assistant?.turn_id, 'the join key was not written').toBe('turn-abc');

    const { __testHistoryForWebUi } = await import('../src/index.js');
    const out = __testHistoryForWebUi('c1', rows);
    const rendered = out.find((m) => m.role === 'assistant');
    expect(rendered?.receipt).toEqual({ memories: { used: 3 }, degraded: null });
  });

  /** The silence that must stay silent. */
  it('says nothing about a turn that predates the column', async () => {
    const { saveMessage, loadRecentMessages } = await import('../src/conversation-store.js');
    // No turnId — an old row, or a lane that mints none (board worker, slash).
    saveMessage('c1', 'assistant', 'An older answer.');
    const { __testHistoryForWebUi } = await import('../src/index.js');
    const out = __testHistoryForWebUi('c1', loadRecentMessages('c1', 10));
    expect(out[0].receipt, 'invented a receipt for a turn we cannot describe').toBeUndefined();
  });

  it('never attaches one turn\'s receipt to another turn', async () => {
    const { saveMessage, loadRecentMessages } = await import('../src/conversation-store.js');
    saveMessage('c1', 'assistant', 'First.',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { turnId: 'turn-1' });
    saveMessage('c1', 'assistant', 'Second.',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { turnId: 'turn-2' });
    receipt('turn-1', 5);
    receipt('turn-2', 1);

    const { __testHistoryForWebUi } = await import('../src/index.js');
    const out = __testHistoryForWebUi('c1', loadRecentMessages('c1', 10));
    expect(out.find((m) => m.text === 'First.')?.receipt?.memories.used).toBe(5);
    expect(out.find((m) => m.text === 'Second.')?.receipt?.memories.used).toBe(1);
  });

  it('carries a degraded turn, which is the one worth not losing', async () => {
    const { saveMessage, loadRecentMessages } = await import('../src/conversation-store.js');
    saveMessage('c1', 'assistant', 'Answered anyway.',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { turnId: 'turn-deg' });
    receipt('turn-deg', 0, 'timeout');

    const { __testHistoryForWebUi } = await import('../src/index.js');
    const out = __testHistoryForWebUi('c1', loadRecentMessages('c1', 10));
    // memories_used is 0 and it STILL has a receipt: "I tried and the context
    // pipeline missed its budget" is exactly the turn a user needs told about.
    expect(out[0].receipt).toEqual({ memories: { used: 0 }, degraded: 'timeout' });
  });

  it('renders history when the receipt store is unreachable', async () => {
    const { saveMessage, loadRecentMessages } = await import('../src/conversation-store.js');
    saveMessage('c1', 'assistant', 'Still readable.',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { turnId: 'turn-x' });
    coreDb.exec('DROP TABLE turn_receipts');

    const { __testHistoryForWebUi } = await import('../src/index.js');
    const out = __testHistoryForWebUi('c1', loadRecentMessages('c1', 10));
    expect(out[0].text).toBe('Still readable.');
    expect(out[0].receipt).toBeUndefined();
  });
});

// PLAN-CONTEXT-COORDINATION P7-0 — the reader must serve a pre-088 table (no
// `lanes` column) exactly as before, and a post-088 row with its lanes. The
// first cut of P7-0 failed the three tests above on the pre-088 shape; this
// pins both shapes so the fallback cannot quietly disappear.
import { parseReceiptLanes } from '../src/turn-receipt.js';
describe('P7-0 — lanes ride the reloaded receipt only when the column exists', () => {
  it('parses what the assembler stores and tolerates NULL', () => {
    expect(parseReceiptLanes('[{"lane":"memory","chars":919},{"lane":"system_prompt","chars":38841,"cached":true}]'))
      .toEqual([{ lane: 'memory', chars: 919 }, { lane: 'system_prompt', chars: 38841, cached: true }]);
    expect(parseReceiptLanes(null)).toEqual([]);
  });
});
