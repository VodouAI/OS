/**
 * The Settings checkbox "Send usage analytics to Vodou" must stop BYOK per-turn
 * usage records, not only the env var.
 *
 * Until 2026-09-16 llm.ts decided the BYOK opt-out from
 * VODOU_USAGE_TELEMETRY=0 alone. The checkbox writes gateway_settings
 * `usage_telemetry_enabled`, which only the Rust engine read, so unticking it
 * left every BYOK turn still POSTing token counts, model and user id to
 * app.vodou.ai/api/usage/track, while vodou.ai said it could be turned off in
 * Settings.
 *
 * getSetting is mocked: this is about the decision, not the database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let setting: string | null = null;
let settingThrows = false;
vi.mock('../db.js', () => ({
  getSetting: (key: string) => {
    if (settingThrows) throw new Error('gateway.db locked');
    return key === 'usage_telemetry_enabled' ? setting : null;
  },
}));

const { isByokUsageTelemetryOptedOut } = await import('../usage-tracking.js');

describe('isByokUsageTelemetryOptedOut', () => {
  const envBefore = process.env.VODOU_USAGE_TELEMETRY;
  beforeEach(() => {
    delete process.env.VODOU_USAGE_TELEMETRY;
    setting = null;
    settingThrows = false;
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env.VODOU_USAGE_TELEMETRY;
    else process.env.VODOU_USAGE_TELEMETRY = envBefore;
  });

  it('defaults to reporting when neither switch is set', () => {
    expect(isByokUsageTelemetryOptedOut()).toBe(false);
  });

  it('honours the Settings checkbox turned off', () => {
    setting = 'false';
    expect(isByokUsageTelemetryOptedOut()).toBe(true);
    setting = '0';
    expect(isByokUsageTelemetryOptedOut()).toBe(true);
  });

  it('keeps reporting when the checkbox is on', () => {
    setting = 'true';
    expect(isByokUsageTelemetryOptedOut()).toBe(false);
  });

  it('still honours VODOU_USAGE_TELEMETRY=0', () => {
    setting = 'true';
    process.env.VODOU_USAGE_TELEMETRY = '0';
    expect(isByokUsageTelemetryOptedOut()).toBe(true);
  });

  it('falls back to the env-only behaviour when settings cannot be read', () => {
    settingThrows = true;
    expect(isByokUsageTelemetryOptedOut()).toBe(false);
  });

  it('is what llm.ts consults for the BYOK record, and hosted turns are still recorded', () => {
    const llm = readFileSync(join(__dirname, '..', 'llm.ts'), 'utf-8');
    expect(llm).toMatch(/const _byokTelemetryOptOut = !isVodouHostedTier && isByokUsageTelemetryOptedOut\(\);/);
    expect(llm).not.toMatch(/_byokTelemetryOptOut = [^;]*process\.env\.VODOU_USAGE_TELEMETRY/);
  });
});
