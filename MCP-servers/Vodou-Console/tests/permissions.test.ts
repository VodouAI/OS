import { describe, it, expect } from 'vitest';
import { checkToolPermission, resolvePermissionMode, toolCategory } from '../src/permissions.js';
import type { Scope } from '../src/scope.js';

// Stub settings reader (so we never touch the live gateway DB).
const reader = (m: Record<string, string>) => (k: string): string | null => (k in m ? m[k] : null);
const empty = reader({});

describe('permissions — tool→category map', () => {
  it('maps FS write tools to file_write, bash to bash, reads/core to ungated', () => {
    expect(toolCategory('write_file')).toBe('file_write');
    expect(toolCategory('edit_file')).toBe('file_write');
    expect(toolCategory('multi_edit')).toBe('file_write');
    expect(toolCategory('bash')).toBe('bash');
    expect(toolCategory('read_file')).toBeNull();
    expect(toolCategory('list_dir')).toBeNull();
    expect(toolCategory('vodou_core_call')).toBeNull();
  });
});

describe('permissions — default (no settings) = all auto, no regression', () => {
  it('every tool is allowed under the default profile', () => {
    for (const t of ['write_file', 'edit_file', 'multi_edit', 'bash', 'read_file', 'vodou_core_call']) {
      const d = checkToolPermission(t, null, empty);
      expect(d.allowed).toBe(true);
    }
  });
});

describe('permissions — profiles', () => {
  it('read-only denies file_write/bash but still allows reads (ungated)', () => {
    const r = reader({ perm_profile: 'read-only' });
    expect(checkToolPermission('write_file', null, r).allowed).toBe(false);
    expect(checkToolPermission('write_file', null, r).mode).toBe('deny');
    expect(checkToolPermission('bash', null, r).allowed).toBe(false);
    expect(checkToolPermission('read_file', null, r).allowed).toBe(true);
  });

  it('workspace keeps file_write auto but marks bash ask (→ denied in Phase 1, fail-closed)', () => {
    const r = reader({ perm_profile: 'workspace' });
    expect(checkToolPermission('write_file', null, r).allowed).toBe(true);
    const bash = checkToolPermission('bash', null, r);
    expect(bash.mode).toBe('ask');
    expect(bash.allowed).toBe(false); // approval flow is Phase 2
    expect(bash.reason).toMatch(/approval/i);
  });

  it('an unknown profile name falls back to full (all auto)', () => {
    const r = reader({ perm_profile: 'nonsense' });
    expect(checkToolPermission('write_file', null, r).allowed).toBe(true);
  });
});

describe('permissions — overrides + precedence + fail-closed', () => {
  it('global category override beats the profile', () => {
    const r = reader({ perm_profile: 'full', perm_file_write: 'deny' });
    expect(checkToolPermission('write_file', null, r).allowed).toBe(false);
  });

  it('per-scope override beats the global override', () => {
    const scope: Scope = { type: 'skill', id: 'x', raw: 'workbench:skill:x' };
    const r = reader({ perm_profile: 'read-only', 'perm.workbench:skill:x.file_write': 'auto' });
    // read-only would deny, but the per-scope override re-allows for this scope
    expect(checkToolPermission('write_file', scope, r).allowed).toBe(true);
    // a DIFFERENT scope still inherits read-only's deny
    expect(checkToolPermission('write_file', null, r).allowed).toBe(false);
  });

  it('an explicitly-set INVALID mode fails closed to deny', () => {
    expect(resolvePermissionMode('file_write', null, reader({ perm_file_write: 'banana' }))).toBe('deny');
    expect(checkToolPermission('write_file', null, reader({ perm_file_write: 'banana' })).allowed).toBe(false);
  });

  it('resolvePermissionMode default is auto', () => {
    expect(resolvePermissionMode('file_write', null, empty)).toBe('auto');
    expect(resolvePermissionMode('bash', null, empty)).toBe('auto');
  });
});

describe('permissions — vodou_core_call classification (P1-3)', () => {
  const cc = (server: string, tool: string) =>
    toolCategory('vodou_core_call', { server, tool });

  it('classifies messaging sends as messaging_send', () => {
    expect(cc('Vodou-channels', 'channel_send')).toBe('messaging_send');
    expect(cc('slack', 'send_message')).toBe('messaging_send');
    expect(cc('gmail', 'send_email')).toBe('messaging_send');
    expect(cc('Vodou-channels', 'broadcast')).toBe('messaging_send');
  });

  it('classifies calendar writes and schedule creation', () => {
    expect(cc('google-calendar', 'create_event')).toBe('calendar_write');
    expect(cc('google-calendar', 'delete_event')).toBe('calendar_write');
    expect(cc('vodou-core', 'schedule_create')).toBe('schedule_create');
    expect(cc('vodou-core', 'automation_add')).toBe('schedule_create');
  });

  it('classifies other writes as mcp_mutation, leaves reads ungated', () => {
    expect(cc('notion', 'create_page')).toBe('mcp_mutation');
    expect(cc('linear', 'update_issue')).toBe('mcp_mutation');
    // reads must never be gated (a read-only profile still reads)
    expect(cc('gmail', 'list_messages')).toBeNull();
    expect(cc('google-calendar', 'list_events')).toBeNull();
    expect(cc('slack', 'search_messages')).toBeNull();
    expect(cc('mcp-monitor', 'get_cpu_info')).toBeNull();
  });

  it('read-only profile now actually blocks a messaging send via vodou_core_call', () => {
    const r = reader({ perm_profile: 'read-only' });
    const send = checkToolPermission('vodou_core_call', null, r, { server: 'slack', tool: 'send_message' });
    expect(send.allowed).toBe(false);
    expect(send.category).toBe('messaging_send');
    // …but a read through the same tool still passes
    const read = checkToolPermission('vodou_core_call', null, r, { server: 'slack', tool: 'list_channels' });
    expect(read.allowed).toBe(true);
    expect(read.category).toBeNull();
  });

  it('default (full) profile leaves core-call mutations auto — no behavior change', () => {
    const send = checkToolPermission('vodou_core_call', null, empty, { server: 'slack', tool: 'send_message' });
    expect(send.allowed).toBe(true);
  });

  it('vodou_core_call without input args stays ungated (back-compat)', () => {
    expect(toolCategory('vodou_core_call')).toBeNull();
  });
});
