/**
 * The console's issue badge: which skill requirements are really unmet.
 *
 * On 2026-09-21 the badge showed 8 issues, five of them skills whose servers
 * were active and healthy — `/api/system/alerts` compared SKILL.md entries
 * like `Vodou-Board.board_show` to server NAMES, so every `Server.tool` entry
 * read as a missing server. unresolvedSkillRequirements resolves the three
 * ways SKILL.md writes a requirement. In-memory DB only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { unresolvedSkillRequirements } from '../required-tools.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, name TEXT, active INTEGER);
    CREATE TABLE tools (id INTEGER PRIMARY KEY, server_id INTEGER, name TEXT);
    INSERT INTO mcp_servers VALUES (1,'Vodou-Board',1),(2,'Vodou-Enhanced-Thinking',1),(3,'Vodou-script-executor',1),(4,'linear',0),(5,'fresh-server',1);
    INSERT INTO tools (server_id,name) VALUES (1,'board_show'),(1,'board_comment'),
      (2,'start_thinking_session'),(2,'add_thought'),(2,'complete_thinking_session'),(3,'execute_script');
  `);
});

describe('unresolvedSkillRequirements', () => {
  it('Server.tool on an active server with that tool is satisfied (the five false alarms)', () => {
    const r = unresolvedSkillRequirements(db, JSON.stringify([
      'Vodou-Board.board_show', 'Vodou-Board.board_comment',
      'Vodou-Enhanced-Thinking.start_thinking_session', 'Vodou-Enhanced-Thinking.add_thought',
    ]));
    expect(r).toEqual({ missingServers: [], unknownTools: [] });
  });

  it('server/tool (the gateway contract spelling) resolves the same way', () => {
    expect(unresolvedSkillRequirements(db, '["Vodou-Board/board_show"]')).toEqual({ missingServers: [], unknownTools: [] });
  });

  it('a tool its server does not have is an unknown tool, not a missing server', () => {
    // board-blocker-investigator, live: `complete_session` for `complete_thinking_session`.
    const r = unresolvedSkillRequirements(db, '["Vodou-Enhanced-Thinking.complete_session"]');
    expect(r).toEqual({ missingServers: [], unknownTools: ['Vodou-Enhanced-Thinking.complete_session'] });
  });

  it('a bare tool name is satisfied by any active server providing it', () => {
    expect(unresolvedSkillRequirements(db, '["execute_script"]')).toEqual({ missingServers: [], unknownTools: [] });
  });

  it('a bare server name must be active', () => {
    expect(unresolvedSkillRequirements(db, '["Vodou-Board"]').missingServers).toEqual([]);
    expect(unresolvedSkillRequirements(db, '["linear"]').missingServers).toEqual(['linear']);
  });

  it('an inactive or unknown server is reported once, by server name', () => {
    const r = unresolvedSkillRequirements(db, '["linear.create_issue","linear.list_teams","nope.x"]');
    expect(r.missingServers).toEqual(['linear', 'nope']);
    expect(r.unknownTools).toEqual([]);
  });

  it('a server whose tool list was never read is not evidence a tool is missing', () => {
    expect(unresolvedSkillRequirements(db, '["fresh-server.anything"]')).toEqual({ missingServers: [], unknownTools: [] });
  });

  it('declaring nothing, or an unreadable registry, reports nothing', () => {
    expect(unresolvedSkillRequirements(db, '[]')).toEqual({ missingServers: [], unknownTools: [] });
    const broken = new DatabaseSync(':memory:');
    expect(unresolvedSkillRequirements(broken, '["Vodou-Board.board_show"]')).toEqual({ missingServers: [], unknownTools: [] });
  });
});
