/**
 * PLAN-JOB-FOLLOWUP P1 — "this conversation moved while you were elsewhere"
 * has exactly one spelling.
 *
 * The dock had four near-copies of ensure-a-tab-then-flag-it-unread
 * (board_task_activity, heartbeat_activity, skill_console_created,
 * channel_activity), and they had already drifted: channel_activity created the
 * tab and never flagged it, so an inbound Telegram message into an open-but-
 * unfocused tab looked like nothing had happened. A finished background job
 * would have been the fifth copy.
 *
 * So: one helper (`_surfaceConversationActivity`), one generic server event
 * (`conversation_activity`), and the grep-gate below — written with the
 * refactor, not after the sixth copy appears. Same shape as live-db-gate.
 *
 * The behaviour tests run the REAL shipped `public/js/views/chat.js` in a vm
 * sandbox, like dock-grouping.test.ts. A re-implementation here would assert
 * intent, not semantics.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');
const CHAT_JS = path.join(CONSOLE_ROOT, 'public/js/views/chat.js');

/** A tab element that records whether a badge was appended to it. */
function fakeTabEl() {
  const children: any[] = [];
  return {
    children,
    querySelector: (sel: string) =>
      children.find((c) => sel === '.tab-unread' && c.className === 'tab-unread') ?? null,
    appendChild: (c: any) => { children.push(c); },
    get unread() { return children.some((c) => c.className === 'tab-unread'); },
  };
}

/** Load the shipped chat.js and hand back its ChatView plus the fake DOM. */
function loadChatView(tabEls: Record<string, any>) {
  const src = readFileSync(CHAT_JS, 'utf8');
  const store = new Map<string, string>();
  const sandbox: any = {
    console: { log() {}, error() {}, warn() {} },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: (sel: string) => {
        const m = /\[data-conversation-id="(.+)"\]/.exec(sel);
        return m ? (tabEls[m[1]] ?? null) : null;
      },
      createElement: () => ({ className: '', textContent: '' }),
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false }),
    requestAnimationFrame: (fn: any) => fn(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__ChatView = ChatView;', sandbox);
  return sandbox.__ChatView;
}

/** ChatView wired with just enough state for the helper to run. */
function viewWith(tabs: any[], activeConvId: string, tabEls: Record<string, any>) {
  const ChatView = loadChatView(tabEls);
  return Object.assign(Object.create(ChatView), {
    _tabs: tabs,
    _saveTabs() { /* localStorage write, not under test */ },
    _renderTabs() { /* DOM paint, not under test */ },
    _getConversationId: () => activeConvId,
    _getActiveProjectId: () => 'proj_default',
  });
}

describe('the gate: one place creates an unread badge', () => {
  it('no second copy of the ensure-tab-then-flag-unread block', () => {
    const src = readFileSync(CHAT_JS, 'utf8');
    // The helper owns exactly one creation site: the className assignment.
    const creations = src.match(/className\s*=\s*'tab-unread'/g) ?? [];
    expect(
      creations.length,
      'Creating a `.tab-unread` badge belongs in _surfaceConversationActivity(). '
      + 'A new copy here is how channel_activity silently lost its unread dot. '
      + 'Call the helper (or the `conversation_activity` server event) instead.',
    ).toBe(1);

    const helperIdx = src.indexOf('_surfaceConversationActivity(info)');
    expect(helperIdx, '_surfaceConversationActivity must exist').toBeGreaterThan(-1);
    const creationIdx = src.indexOf("className = 'tab-unread'");
    expect(creationIdx).toBeGreaterThan(helperIdx);
  });
});

describe('_surfaceConversationActivity (real shipped code)', () => {
  it('flags an existing tab the user is not looking at', () => {
    const el = fakeTabEl();
    const v = viewWith(
      [{ id: 't1', conversationId: 'conv-a', source: 'web', title: 'A' }],
      'conv-other',
      { 'conv-a': el },
    );
    v._surfaceConversationActivity({ conversationId: 'conv-a' });
    expect(el.unread).toBe(true);
  });

  it('does not flag the tab that is on screen', () => {
    const el = fakeTabEl();
    const v = viewWith(
      [{ id: 't1', conversationId: 'conv-a', source: 'web', title: 'A' }],
      'conv-a',
      { 'conv-a': el },
    );
    v._surfaceConversationActivity({ conversationId: 'conv-a' });
    expect(el.unread).toBe(false);
  });

  it('flags only once, however many events arrive', () => {
    const el = fakeTabEl();
    const v = viewWith(
      [{ id: 't1', conversationId: 'conv-a', source: 'web', title: 'A' }],
      'conv-other',
      { 'conv-a': el },
    );
    v._surfaceConversationActivity({ conversationId: 'conv-a' });
    v._surfaceConversationActivity({ conversationId: 'conv-a' });
    v._surfaceConversationActivity({ conversationId: 'conv-a' });
    expect(el.children.filter((c: any) => c.className === 'tab-unread').length).toBe(1);
  });

  it('reopens a closed tab with the conversation\'s own title and source', () => {
    const el = fakeTabEl();
    const tabs: any[] = [];
    const v = viewWith(tabs, 'conv-other', { 'workbench:skill-console:blog-morning': el });
    v._surfaceConversationActivity({
      conversationId: 'workbench:skill-console:blog-morning',
      title: 'blog-morning',
      source: 'skill-console',
      projectId: 'proj_blog',
    });
    expect(tabs.length).toBe(1);
    expect(tabs[0]).toMatchObject({
      conversationId: 'workbench:skill-console:blog-morning',
      title: 'blog-morning',
      source: 'skill-console',
      projectId: 'proj_blog',        // else the tab pins to Default forever
    });
    expect(el.unread).toBe(true);
  });

  it('keeps the pre-refactor tab shape: Heartbeat first, no invented project', () => {
    // Both of these were regressions in the first cut of the helper. The four
    // call sites it replaced had never set projectId, and defaulting it to the
    // project the user is standing in attaches a GLOBAL surface to that project
    // — it then vanishes on the next project switch. And Heartbeat had always
    // opened at the front of the strip (`unshift`), not the end.
    const tabs: any[] = [{ id: 't0', conversationId: 'conv-existing', source: 'web' }];
    const v = viewWith(tabs, 'conv-other', {});
    v._getActiveProjectId = () => 'proj_something_else';

    v._surfaceConversationActivity({
      conversationId: 'vodou-heartbeat', tabId: 'tab-vodou', title: 'Heartbeat',
      source: 'heartbeat', pinned: true, first: true,
    });
    expect(tabs[0].conversationId).toBe('vodou-heartbeat');       // front, not end
    expect(tabs[0].projectId).toBeUndefined();                    // global, unpinned to any project

    v._surfaceConversationActivity({
      conversationId: 'board-chat', tabId: 'tab-board', title: 'BOARD',
      source: 'board', pinned: true,
    });
    const board = tabs.find((t) => t.conversationId === 'board-chat');
    expect(board.projectId).toBeUndefined();
    expect(tabs[tabs.length - 1].conversationId).toBe('board-chat');  // Board appends, as before
  });

  it('never conjures a tab for a source the dock excludes', () => {
    // A capture/import buffer is owned by the Sources panel. It may flag a tab
    // that is already open; it must not create one.
    const tabs: any[] = [];
    const v = viewWith(tabs, 'conv-other', {});
    v._surfaceConversationActivity({ conversationId: 'cap-1', source: 'capture:ide:claude-code' });
    expect(tabs.length).toBe(0);
  });

  it('ignores an event with no conversation', () => {
    const tabs: any[] = [];
    const v = viewWith(tabs, 'conv-other', {});
    expect(() => v._surfaceConversationActivity({})).not.toThrow();
    expect(tabs.length).toBe(0);
  });
});
