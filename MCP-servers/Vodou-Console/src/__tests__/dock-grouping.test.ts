/**
 * Dock grouping — which conversations become tabs, and what they're labelled.
 *
 * Three regressions, all found 2026-07-31 with 355 `capture:ide:claude-code`
 * tiles and 8 identical `testchannel` tiles sitting in the Messaging tier while
 * 13 expert personas were missing from the Skills tier entirely:
 *
 *  1. `_isChannelConversationTab` is a denylist (anything not 'web' is a
 *     channel), so capture buffers / BYOK API sessions were filed as messaging.
 *  2. Unknown channels open one conversation PER thread and were all labelled by
 *     raw source, so N threads rendered as N identical tiles.
 *  3. Skills-tier surfacing was client-only state with no recovery path — the
 *     conversations survived in gateway.db but nothing could read them back.
 *
 * The client half is exercised by loading the REAL public/js/views/chat.js in a
 * vm sandbox and calling its actual methods. A re-implementation here would
 * validate intent, not semantics — precisely the trap that shipped a broken
 * query once already.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');

// Point the gateway DB at a throwaway file BEFORE anything imports db.js —
// resolveGatewayDbPath() reads this env var at first connection.
const TMP = mkdtempSync(path.join(tmpdir(), 'vodou-dock-test-'));
process.env.GATEWAY_DB_PATH = path.join(TMP, 'gateway.db');

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Server: GET /api/workbench/skills — the Skills-tier recovery path
// ---------------------------------------------------------------------------

describe('GET /api/workbench/skills (Skills tier recovery)', () => {
  let app: any;
  let request: any;

  beforeAll(async () => {
    const { getGatewayDb } = await import('../db.js');
    const db = getGatewayDb();

    // Personas, deliberately spanning months — the endpoint must NOT age-filter
    // the way conversations_list does (its 7-day window is what hid all 13).
    const rows: Array<[string, string, string, string]> = [
      ['workbench:skill:ai-engineer', 'ai-engineer', 'workbench:skill:ai-engineer', '2026-05-22 14:10:05'],
      ['workbench:skill:fundraising-mindset', 'fundraising-mindset', 'workbench:skill:fundraising-mindset', '2026-07-13 20:37:53'],
      ['workbench:skill:growth-hacker', 'growth-hacker', 'workbench:skill:growth-hacker', '2026-05-09 04:46:43'],
      // Noise that must never come back from this endpoint:
      ['conv-web-1', 'Some Chat', 'web', '2026-07-30 10:00:00'],
      ['env-fix-2', 'Chad', 'testchannel', '2026-07-25 20:17:26'],
      ['cap-1', 'Captured', 'capture:ide:claude-code', '2026-07-31 09:00:00'],
      ['workbench:integration:linear', 'Linear', 'workbench:integration:linear', '2026-07-29 10:00:00'],
    ];
    for (const [id, title, source, updated] of rows) {
      db.prepare(
        'INSERT INTO gateway_conversations (id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, title, source, updated, updated);
    }
    // A soft-deleted persona must stay hidden.
    db.prepare(
      "INSERT INTO gateway_conversations (id, title, source, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('workbench:skill:retired', 'retired', 'workbench:skill:retired', '2026-06-01 00:00:00', '2026-06-01 00:00:00', '2026-06-02 00:00:00');

    const express = (await import('express')).default;
    const { workbenchRouter } = await import('../api/workbench.js');
    app = express();
    app.use(express.json());
    app.use('/api/workbench', workbenchRouter);
    request = (await import('supertest')).default;
  });

  it('returns only workbench:skill:* conversations, newest first', async () => {
    const res = await request(app).get('/api/workbench/skills').expect(200);
    const scopes = res.body.skills.map((s: any) => s.scope);
    expect(scopes).toEqual([
      'workbench:skill:fundraising-mindset', // 2026-07-13
      'workbench:skill:ai-engineer',         // 2026-05-22
      'workbench:skill:growth-hacker',       // 2026-05-09
    ]);
  });

  it('does NOT age-filter — a persona last used in May still comes back', async () => {
    const res = await request(app).get('/api/workbench/skills').expect(200);
    const scopes = res.body.skills.map((s: any) => s.scope);
    // The 7-day window on conversations_list is exactly why all 13 were invisible.
    expect(scopes).toContain('workbench:skill:growth-hacker');
  });

  it('excludes soft-deleted personas, chats, channels, captures and integrations', async () => {
    const res = await request(app).get('/api/workbench/skills').expect(200);
    const scopes = res.body.skills.map((s: any) => s.scope);
    expect(scopes).not.toContain('workbench:skill:retired');
    expect(scopes).not.toContain('conv-web-1');
    expect(scopes).not.toContain('env-fix-2');
    expect(scopes).not.toContain('cap-1');
    expect(scopes).not.toContain('workbench:integration:linear');
  });

  it('carries a usable title for every entry', async () => {
    const res = await request(app).get('/api/workbench/skills').expect(200);
    for (const s of res.body.skills) {
      expect(s.title).toBeTruthy();
      expect(s.title).not.toContain('workbench:skill:'); // name, not raw scope
    }
  });
});

// ---------------------------------------------------------------------------
// Client: the REAL ChatView methods from public/js/views/chat.js
// ---------------------------------------------------------------------------

/** Load the shipped chat.js in a sandbox and hand back its ChatView object. */
function loadChatView(): any {
  const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/views/chat.js'), 'utf8');
  const store = new Map<string, string>();
  const sandbox: any = {
    console: { log() {}, error() {}, warn() {} },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false }),
    requestAnimationFrame: (fn: any) => fn(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // `const ChatView` is lexically scoped to the script, so surface it explicitly.
  vm.runInContext(src + '\n;globalThis.__ChatView = ChatView;', sandbox);
  return sandbox.__ChatView;
}

describe('ChatView._isDockExcludedSource (real shipped code)', () => {
  const ChatView = loadChatView();

  it('excludes the source families that flooded the Messaging tier', () => {
    for (const src of [
      'capture:ide:claude-code', 'capture:web:chatgpt', 'capture:manual:localhost',
      'import:chatgpt', 'import:claude',
      'openai-compat',
      'curriculum',
    ]) {
      expect(ChatView._isDockExcludedSource(src), src).toBe(true);
    }
  });

  it('keeps real chats, channels and custom SDK channels', () => {
    for (const src of ['web', 'slack', 'telegram', 'testchannel', 'board', 'heartbeat', 'skill-console']) {
      expect(ChatView._isDockExcludedSource(src), src).toBe(false);
    }
  });

  it('treats a missing source as includable (legacy rows default to web)', () => {
    expect(ChatView._isDockExcludedSource(undefined)).toBe(false);
    expect(ChatView._isDockExcludedSource('')).toBe(false);
  });
});

describe('ChatView._isChannelConversationTab (Messaging tier membership)', () => {
  const ChatView = loadChatView();
  const isChannel = (tab: any) => ChatView._isChannelConversationTab.call(ChatView, tab);

  it('no longer files captures / imports / BYOK sessions as messaging', () => {
    expect(isChannel({ source: 'capture:ide:claude-code' })).toBe(false);
    expect(isChannel({ source: 'import:chatgpt' })).toBe(false);
    expect(isChannel({ source: 'openai-compat' })).toBe(false);
  });

  it('still files real and custom channels as messaging', () => {
    expect(isChannel({ source: 'slack' })).toBe(true);
    expect(isChannel({ source: 'testchannel' })).toBe(true);
  });

  it('leaves web / board / heartbeat / skill-console out of messaging', () => {
    for (const source of ['web', 'board', 'heartbeat', 'skill-console']) {
      expect(isChannel({ source }), source).toBe(false);
    }
  });
});

describe('ChatView._hydrateTabsFromDb (real shipped code)', () => {
  const ChatView = loadChatView();

  /** Minimal `this` — the method only needs _tabs plus these three members. */
  function hydrate(conversations: any[]) {
    const ctx: any = {
      _tabs: [],
      _isDockExcludedSource: ChatView._isDockExcludedSource,
      _saveTabs() {},
      _renderTabs() {},
    };
    ChatView._hydrateTabsFromDb.call(ctx, conversations);
    return ctx._tabs;
  }

  const conv = (o: any) => ({ messageCount: 2, title: 'x', project_id: null, ...o });

  it('drops capture / import / BYOK rows instead of making tabs', () => {
    const tabs = hydrate([
      conv({ id: 'cap-1', source: 'capture:ide:claude-code', title: 'Captured' }),
      conv({ id: 'imp-1', source: 'import:chatgpt', title: 'Imported' }),
      conv({ id: 'byok:aider:abc', source: 'openai-compat', title: 'BYOK: aider' }),
      conv({ id: 'real-1', source: 'web', title: 'A Real Chat' }),
    ]);
    expect(tabs.map((t: any) => t.conversationId)).toEqual(['real-1']);
  });

  it('labels unknown-channel threads distinctly instead of N identical tiles', () => {
    // The exact shape of the 8 rows that produced 8 'testchannel' tiles:
    // title === sender_name, so the title does not discriminate.
    const tabs = hydrate([
      conv({ id: 'env-fix-2', source: 'testchannel', title: 'Chad', senderName: 'Chad' }),
      conv({ id: 'envA1', source: 'testchannel', title: 'Chad', senderName: 'Chad' }),
      conv({ id: 'envC1', source: 'testchannel', title: 'Chad', senderName: 'Chad' }),
    ]);
    const titles = tabs.map((t: any) => t.title);
    expect(titles).toEqual(['env-fix-2', 'envA1', 'envC1']);
    expect(new Set(titles).size).toBe(3); // the actual bug: all labels distinct
  });

  it('prefers a DB title that genuinely discriminates', () => {
    const tabs = hydrate([
      conv({ id: 'thread-9f2a', source: 'somechannel', title: 'Deploy failures', senderName: 'Chad' }),
    ]);
    expect(tabs[0].title).toBe('Deploy failures');
  });

  it('still collapses known channels to their friendly name', () => {
    const tabs = hydrate([
      conv({ id: 'workbench:channel:slack', source: 'slack', title: 'Slack · Chad', senderName: 'Chad' }),
    ]);
    expect(tabs[0].title).toBe('Slack');
  });

  it('keeps ordinary web chats on their own title', () => {
    const tabs = hydrate([conv({ id: 'c1', source: 'web', title: 'Dock bug hunt' })]);
    expect(tabs[0].title).toBe('Dock bug hunt');
  });
});

describe('WorkbenchSurfaces.seedSkillsOnce (real shipped code)', () => {
  /** Load the shipped workbench-surfaces.js with a stubbed fetch + localStorage. */
  function loadSurfaces(fetchImpl: any) {
    const src = readFileSync(path.join(CONSOLE_ROOT, 'public/js/workbench-surfaces.js'), 'utf8');
    const store = new Map<string, string>();
    const sandbox: any = {
      console: { log() {}, error() {}, warn() {} },
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
      },
      fetch: fetchImpl,
      addEventListener() {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return { surfaces: sandbox.window.WorkbenchSurfaces, store };
  }

  const okFetch = (skills: any[]) => async () => ({ ok: true, json: async () => ({ skills }) });

  it('surfaces every persona the server reports', async () => {
    const { surfaces } = loadSurfaces(okFetch([
      { scope: 'workbench:skill:ai-engineer', title: 'ai-engineer' },
      { scope: 'workbench:skill:growth-hacker', title: 'growth-hacker' },
    ]));
    await surfaces.seedSkillsOnce();
    const scopes = surfaces.list().map((e: any) => e.scope);
    expect(scopes).toEqual(['workbench:skill:ai-engineer', 'workbench:skill:growth-hacker']);
    expect(surfaces.list()[0].kind).toBe('workbench');
  });

  it('runs ONCE — a persona the user removed does not come back', async () => {
    const { surfaces } = loadSurfaces(okFetch([
      { scope: 'workbench:skill:ai-engineer', title: 'ai-engineer' },
    ]));
    await surfaces.seedSkillsOnce();
    surfaces.remove('workbench:skill:ai-engineer');   // deliberate user choice
    await surfaces.seedSkillsOnce();                  // next page load
    expect(surfaces.list()).toEqual([]);
  });

  it('does not burn its one attempt when the server is down', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return { ok: true, json: async () => ({ skills: [{ scope: 'workbench:skill:ai-engineer', title: 'ai-engineer' }] }) };
    };
    const { surfaces } = loadSurfaces(flaky);
    await surfaces.seedSkillsOnce();            // fails
    expect(surfaces.list()).toEqual([]);
    await surfaces.seedSkillsOnce();            // retries on next load, succeeds
    expect(surfaces.list().map((e: any) => e.scope)).toEqual(['workbench:skill:ai-engineer']);
  });

  it('treats a 404 from an older server as retryable, not as "no skills"', async () => {
    let calls = 0;
    const notThenYes = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ skills: [{ scope: 'workbench:skill:ui-designer', title: 'ui-designer' }] }) };
    };
    const { surfaces } = loadSurfaces(notThenYes);
    await surfaces.seedSkillsOnce();
    expect(surfaces.list()).toEqual([]);
    await surfaces.seedSkillsOnce();
    expect(surfaces.list().map((e: any) => e.scope)).toEqual(['workbench:skill:ui-designer']);
  });

  it('does not duplicate personas already surfaced', async () => {
    const { surfaces } = loadSurfaces(okFetch([
      { scope: 'workbench:skill:ai-engineer', title: 'ai-engineer' },
    ]));
    surfaces.add({ scope: 'workbench:skill:ai-engineer', title: 'ai-engineer', icon: '🧑', kind: 'workbench' });
    await surfaces.seedSkillsOnce();
    expect(surfaces.list().length).toBe(1);
  });
});
