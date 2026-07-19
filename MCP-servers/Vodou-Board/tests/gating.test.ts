/**
 * Verifies the VODOU_BOARD_TASK env-var gate behaves correctly:
 *   - returns false when unset
 *   - returns true when set
 *   - currentTaskId() throws helpfully when unset
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isWorkerSession,
  currentTaskId,
  currentRunId,
  currentWriteToken,
  currentWorkspace,
  currentProfile,
  currentTenant,
} from '../src/gating.js';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.VODOU_BOARD_TASK;
  delete process.env.VODOU_BOARD_RUN_ID;
  delete process.env.VODOU_BOARD_WRITE_TOKEN;
  delete process.env.VODOU_BOARD_WORKSPACE;
  delete process.env.VODOU_PROFILE;
  delete process.env.VODOU_TENANT;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('gating', () => {
  it('isWorkerSession() returns false when VODOU_BOARD_TASK unset', () => {
    expect(isWorkerSession()).toBe(false);
  });

  it('isWorkerSession() returns true when VODOU_BOARD_TASK set', () => {
    process.env.VODOU_BOARD_TASK = 't_abc';
    expect(isWorkerSession()).toBe(true);
  });

  it('isWorkerSession() returns false when set to empty string', () => {
    process.env.VODOU_BOARD_TASK = '';
    expect(isWorkerSession()).toBe(false);
  });

  it('currentTaskId() throws when unset', () => {
    expect(() => currentTaskId()).toThrow(/VODOU_BOARD_TASK/);
  });

  it('currentTaskId() returns id when set', () => {
    process.env.VODOU_BOARD_TASK = 't_xyz';
    expect(currentTaskId()).toBe('t_xyz');
  });

  it('currentRunId() returns null when unset', () => {
    expect(currentRunId()).toBe(null);
  });

  it('currentWriteToken() returns null when unset', () => {
    expect(currentWriteToken()).toBe(null);
  });

  it('currentWorkspace() falls back to cwd when unset', () => {
    expect(currentWorkspace()).toBe(process.cwd());
  });

  it('currentProfile() returns null when unset', () => {
    expect(currentProfile()).toBe(null);
  });

  it('currentTenant() defaults to "self" when unset', () => {
    expect(currentTenant()).toBe('self');
  });

  it('all env getters return their values when set', () => {
    process.env.VODOU_BOARD_TASK = 't_full';
    process.env.VODOU_BOARD_RUN_ID = 'r_full';
    process.env.VODOU_BOARD_WRITE_TOKEN = 'tk_full';
    process.env.VODOU_BOARD_WORKSPACE = '/tmp/full';
    process.env.VODOU_PROFILE = 'researcher';
    process.env.VODOU_TENANT = 'acme';

    expect(currentTaskId()).toBe('t_full');
    expect(currentRunId()).toBe('r_full');
    expect(currentWriteToken()).toBe('tk_full');
    expect(currentWorkspace()).toBe('/tmp/full');
    expect(currentProfile()).toBe('researcher');
    expect(currentTenant()).toBe('acme');
  });
});
