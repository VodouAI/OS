/**
 * Shared per-channel allowlist — the "Apple-style" allow-any / restrict-to-list
 * toggle used by iMessage, WhatsApp, Slack, and any future messaging channel.
 *
 * File layout:  `.vodou/channels/<channel>-allowlist.json`
 *   { "mode": "off" | "on", "senders": [{ "id": "...", "name": "..." }, ...] }
 *
 *   - mode: "off"  → allow everyone (default, matches what users expect after install)
 *   - mode: "on"   → only senders whose normalized id matches one in the list pass
 *
 * The gateway UI manages this file; channels read + fs.watch it for live updates
 * (no restart needed when the user toggles mode or adds/removes senders).
 *
 * Each channel supplies its own `normalize` fn (phones want digits-only, emails
 * want lowercase-trim, Slack wants raw channel/user IDs, etc.) — the allowlist
 * helper is payload-agnostic.
 */

import { watch, existsSync, readFileSync, mkdirSync, FSWatcher } from 'fs';
import { join, dirname } from 'path';

export interface AllowlistEntry {
  id: string;
  name?: string;
}

export interface AllowlistConfig {
  mode: 'on' | 'off';
  senders: AllowlistEntry[];
}

export type HandleNormalizer = (raw: string) => string;

/** Resolve the on-disk path for a channel's allowlist file. */
export function allowlistPathForChannel(projectRoot: string, channel: string): string {
  return join(projectRoot, '.vodou', 'channels', `${channel}-allowlist.json`);
}

/** Read the allowlist file; default to `mode: off` (allow everyone) on any error. */
export function readAllowlist(path: string): AllowlistConfig {
  try {
    if (!existsSync(path)) return { mode: 'off', senders: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      mode: parsed?.mode === 'on' ? 'on' : 'off',
      senders: Array.isArray(parsed?.senders) ? parsed.senders : [],
    };
  } catch {
    return { mode: 'off', senders: [] };
  }
}

/**
 * AllowlistWatcher — loads the allowlist once, starts an fs.watch on the
 * parent directory so any edit (gateway UI writes, user hand-edits, channel
 * rename) triggers a re-read. Safe to construct before the file exists.
 */
export class AllowlistWatcher {
  private config: AllowlistConfig = { mode: 'off', senders: [] };
  private watcher: FSWatcher | null = null;
  private path: string;
  private filename: string;
  private normalize: HandleNormalizer;
  private channelLabel: string;

  constructor(projectRoot: string, channel: string, normalize: HandleNormalizer) {
    this.path = allowlistPathForChannel(projectRoot, channel);
    this.filename = `${channel}-allowlist.json`;
    this.normalize = normalize;
    this.channelLabel = channel;
    this.reload();
    this.startWatching();
  }

  /** Force a re-read from disk. Called internally by the watcher.
   *
   * Security: an allowlist is a *deny* control, so it must not fail open. The
   * gateway turns the allowlist off by WRITING `mode:'off'` — it never deletes
   * the file — so a missing or corrupt file at reload time is data loss (a
   * crashed/truncated write, an accidental rm), NOT an intentional "off". If we
   * are currently enforcing `mode:'on'`, retain the last-good config rather than
   * silently reverting to allow-everyone. */
  reload(): void {
    let next: AllowlistConfig | null = null;
    let reason: 'missing' | 'unreadable' = 'missing';
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
        next = {
          mode: parsed?.mode === 'on' ? 'on' : 'off',
          senders: Array.isArray(parsed?.senders) ? parsed.senders : [],
        };
      }
    } catch {
      reason = 'unreadable';
    }

    if (next) {
      this.config = next;
      return;
    }

    if (this.config.mode === 'on') {
      console.error(
        `[${this.channelLabel}] allowlist file ${reason} — retaining last-good config ` +
        `(mode=on, ${this.config.senders.length} senders) instead of failing open to allow-all`,
      );
      return;
    }
    this.config = { mode: 'off', senders: [] };
  }

  /** Current config snapshot (read-only). */
  get(): Readonly<AllowlistConfig> {
    return this.config;
  }

  /** True when the sender passes the allowlist (or mode is off). */
  isAllowed(rawSender: string): boolean {
    if (this.config.mode !== 'on') return true;
    if (!rawSender) return false;
    const norm = this.normalize(rawSender);
    if (!norm) return false;
    return this.config.senders.some(s => this.normalize(s.id) === norm);
  }

  /** Pass an array of candidate identifiers — passes if ANY of them match. */
  isAnyAllowed(rawSenders: (string | null | undefined)[]): boolean {
    if (this.config.mode !== 'on') return true;
    for (const s of rawSenders) {
      if (s && this.isAllowed(s)) return true;
    }
    return false;
  }

  dispose(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
  }

  private startWatching(): void {
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) {
        try { mkdirSync(dir, { recursive: true }); } catch {}
      }
      if (!existsSync(dir)) return; // gateway will create lazily when user first opens the UI
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === this.filename) {
          this.reload();
          console.error(
            `[${this.channelLabel}] allowlist reloaded: mode=${this.config.mode} senders=${this.config.senders.length}`
          );
        }
      });
    } catch {
      // fs.watch is optional; isAllowed still works via the initial reload
    }
  }
}

// ── Normalizers for each channel ──────────────────────────────────────────

/** iMessage: phones → digits only (strip +, spaces, parens, dashes).
 *  Emails → lowercased + trimmed. */
export function normalizeImessageHandle(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim().toLowerCase();
  if (/^\+?\d/.test(trimmed) && !/@/.test(trimmed)) {
    return trimmed.replace(/\D/g, '');
  }
  return trimmed;
}

/** WhatsApp: JIDs look like `15551234567@s.whatsapp.net` or `<groupid>@g.us`.
 *  For matching, use the digits before `@` for user JIDs. Users may enter
 *  phones as `+15551234567` or `(555) 123-4567` — normalize to digits-only.
 *  For group JIDs (contain only digits + `-` before `@g.us`) leave intact. */
export function normalizeWhatsappHandle(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.includes('@g.us')) return trimmed; // group JID — keep as-is
  // Strip the @suffix if present and digit-normalize the user portion.
  const userPart = trimmed.split('@')[0];
  return userPart.replace(/\D/g, '');
}

/** Slack: IDs are opaque (`U01XXXX`, `C01XXXX`, `D01XXXX`). Lowercase for
 *  consistency but otherwise leave as-is. */
export function normalizeSlackHandle(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

/** Discord: snowflake IDs (18-19 digit numeric strings) for users/channels/guilds.
 *  Users may enter `@username` or `username#1234` — we accept either but match
 *  primarily on the numeric ID (what the API returns). Strip leading `@` and
 *  lowercase for case-insensitive name matching. */
export function normalizeDiscordHandle(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/^@/, '').toLowerCase();
  // If it's a pure snowflake (all digits), keep as-is.
  if (/^\d{15,25}$/.test(trimmed)) return trimmed;
  // Otherwise keep the raw username; strip discriminator if present.
  return trimmed.split('#')[0];
}

/** Telegram: numeric user/chat IDs (positive for users, negative for groups).
 *  Users may enter `@username` (Telegram handle) — keep lowercase without `@`.
 *  Numeric IDs are kept as-is (the bot API returns them as numbers). */
export function normalizeTelegramHandle(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/^@/, '').toLowerCase();
  // Numeric Telegram IDs (may be negative for groups/channels)
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  return trimmed;
}

/** Teams: Azure AD user id, conversation id, or tenant id — opaque strings, trim + lowercase. */
export function normalizeTeamsHandle(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

/** Google Chat: `users/…` resource names and opaque IDs — trim + lowercase. */
export function normalizeGoogleChatHandle(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

/** Signal: phone-like strings → digits-only; opaque group ids / UUIDs → trim + lowercase. */
export function normalizeSignalHandle(raw: string): string {
  if (!raw) return '';
  const t = raw.trim();
  if (/^[\d+\-().\s]+$/.test(t) && t.replace(/\D/g, '').length >= 10) return t.replace(/\D/g, '');
  return t.toLowerCase();
}
