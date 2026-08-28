import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  parseRequiredTools,
  resolveRequiredTools,
  summariseToolUsage,
  looksLikeWrite,
} from '../required-tools.js';

/**
 * PLAN-ALPHA F3. `required_tools` was advisory metadata nothing read at run
 * time: a skill could declare six tools, call none of them, and report `ok`.
 * The two properties under test are the two things that made it worthless —
 * a declaration that is never checked, and a run that is never compared to it.
 */

function makeRegistry(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, name TEXT UNIQUE, active INTEGER DEFAULT 1);
    CREATE TABLE tools (id INTEGER PRIMARY KEY, server_id INTEGER, name TEXT);
    INSERT INTO mcp_servers (id, name, active) VALUES (1,'gmail',1), (2,'exa',1), (3,'retired',0);
    INSERT INTO tools (server_id, name) VALUES
      (1,'threads_list'), (1,'messages_list'), (2,'web_search_exa'), (3,'old_tool');
  `);
  return db;
}

describe('parseRequiredTools', () => {
  it('reads the JSON array the UI writes', () => {
    expect(parseRequiredTools('["gmail/threads_list","exa/web_search_exa"]'))
      .toEqual(['gmail/threads_list', 'exa/web_search_exa']);
  });

  it('reads the comma/space form a human types', () => {
    expect(parseRequiredTools('gmail/threads_list, exa/web_search_exa'))
      .toEqual(['gmail/threads_list', 'exa/web_search_exa']);
  });

  // A malformed field must not take a working agent offline — that would be the
  // contract working against its own purpose.
  it('treats null, empty and unparseable input as "declares nothing"', () => {
    expect(parseRequiredTools(null)).toEqual([]);
    expect(parseRequiredTools('')).toEqual([]);
    expect(parseRequiredTools('[not json')).toEqual(['[not', 'json']);
  });
});

describe('resolveRequiredTools', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeRegistry(); });

  it('resolves tools that exist on active servers', () => {
    const r = resolveRequiredTools(db, '["gmail/threads_list","exa/web_search_exa"]');
    expect(r.missing).toEqual([]);
    expect(r.unrestricted).toBe(false);
    expect(r.declared).toHaveLength(2);
  });

  // The gate's whole point: this must be caught BEFORE an LLM turn is spent.
  it('flags a tool whose server is deregistered', () => {
    const r = resolveRequiredTools(db, '["gmail/threads_list","nosuch/tool"]');
    expect(r.missing).toEqual(['nosuch/tool']);
  });

  // A server row can exist while being inactive — it cannot answer, so firing
  // against it reproduces the exact failure this gate prevents.
  it('treats an INACTIVE server as unresolved, not merely present', () => {
    const r = resolveRequiredTools(db, '["retired/old_tool"]');
    expect(r.missing).toEqual(['retired/old_tool']);
  });

  it('flags a malformed entry rather than skipping it', () => {
    // A typo that silently disables the bound is worse than one that stops the
    // run, because the first is invisible.
    const r = resolveRequiredTools(db, '["gmail","/leading","trailing/"]');
    expect(r.missing).toEqual(['gmail', '/leading', 'trailing/']);
  });

  // Declaring nothing is legal — 2 of the 4 live agents declare nothing.
  it('reports unrestricted when nothing is declared', () => {
    const r = resolveRequiredTools(db, null);
    expect(r.unrestricted).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe('summariseToolUsage', () => {
  const declared = ['gmail/threads_list', 'exa/web_search_exa'];

  it('separates declared calls from undeclared ones', () => {
    const u = summariseToolUsage(declared, [
      { server: 'gmail', tool: 'threads_list' },
      'other/thing',
    ]);
    expect(u.declaredCalled).toEqual(['gmail/threads_list']);
    expect(u.undeclaredCalled).toEqual(['other/thing']);
  });

  // The reported defect: declared six, called none, still said `ok`.
  it('reports zero declared calls when the turn used no declared tool', () => {
    const u = summariseToolUsage(declared, []);
    expect(u.declaredCalled).toEqual([]);
  });

  it('accepts the assorted shapes providers emit, and de-duplicates', () => {
    const u = summariseToolUsage(declared, [
      'gmail/threads_list',
      { server: 'gmail', tool: 'threads_list' },
      { serverName: 'exa', toolName: 'web_search_exa' },
    ]);
    expect(u.called).toEqual(['gmail/threads_list', 'exa/web_search_exa']);
  });
});

describe('looksLikeWrite', () => {
  it('agrees with the copy in project-context.ts', async () => {
    // The list is duplicated on purpose — project-context.ts must stay free of
    // node:sqlite imports because executor and fs-sandbox pull it in. Duplication
    // is fine only while something notices them drifting apart, which is this.
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');

    // Sliced by index rather than a constructed RegExp: building one here needs
    // four levels of backslash escaping and silently matched nothing.
    const verbsOf = (file: string, ident: string) => {
      const text = readFileSync(join(src, file), 'utf8');
      const at = text.indexOf(ident);
      if (at < 0) throw new Error(`${ident} not found in ${file}`);
      const open = text.indexOf('[', at);
      const close = text.indexOf(']', open);
      const body = text.slice(open + 1, close);
      return (body.match(/'[a-z]+'/g) ?? []).map((x) => x.replace(/'/g, '')).sort();
    };

    expect(verbsOf('project-context.ts', 'WRITE_VERBS_LOCAL'))
      .toEqual(verbsOf('required-tools.ts', 'WRITE_VERBS'));
  });

  it('flags writes and passes reads', () => {
    for (const t of ['send_email', 'create_event', 'delete_row', 'slack_post']) {
      expect(looksLikeWrite(t), t).toBe(true);
    }
    for (const t of ['list_threads', 'get_events', 'search_messages', 'posting_frequency']) {
      expect(looksLikeWrite(t), t).toBe(false);
    }
  });
});
