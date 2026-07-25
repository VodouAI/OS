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

/**
 * A room the channel listens in (Slack/Discord channel id, group id, …).
 * PLAN-MASTER-EXECUTION-ORDER item 2 (S-PRINCIPAL).
 *
 * `vault` scopes what a GUEST in this room may know:
 *   - a vault name → guest recall is limited to that vault's members
 *   - "*"          → guest may ask against the whole brain
 *   - absent       → the install's default guest vault
 * It never affects the owner, who always gets the whole brain.
 */
export interface AllowlistRoom {
  id: string;
  name?: string;
  vault?: string;
}

/**
 * Who is driving this turn.
 *  - 'owner'  — matched the sender list. Full capability, unchanged from before tiers existed.
 *  - 'guest'  — matched only a room. May ask; may NOT cause tool calls, shell, or writes.
 *  - 'denied' — matched nothing.
 *
 * Two tiers only, deliberately. Guest is a permanent class, not an owner who
 * hasn't authenticated — promotion happens by landing on the sender list.
 */
export type Principal = 'owner' | 'guest' | 'denied';

export interface AllowlistConfig {
  mode: 'on' | 'off';
  senders: AllowlistEntry[];
  /** Rooms the channel listens in. Posting here alone makes you a GUEST, not the owner. */
  rooms: AllowlistRoom[];
}

export type HandleNormalizer = (raw: string) => string;

/**
 * PLAN-SECURITY-AUDIT-FINDINGS #1a (2026-07-24) — fail-closed enforcement flag.
 * DARK BY DEFAULT: with the flag unset an unconfigured channel (mode:'off')
 * allows all senders (legacy behavior — live channels keep working). With
 * VODOU_CHANNEL_ALLOWLIST_ENFORCE=1, an unconfigured channel DENIES all senders
 * unless they are explicitly listed under mode:'on' — the ship-hardened posture.
 * Operators flip it on AFTER seeding their own sender IDs, so no live outage.
 */
export function allowlistEnforceClosed(): boolean {
  const v = (process.env.VODOU_CHANNEL_ALLOWLIST_ENFORCE || '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Resolve the on-disk path for a channel's allowlist file. */
export function allowlistPathForChannel(projectRoot: string, channel: string): string {
  return join(projectRoot, '.vodou', 'channels', `${channel}-allowlist.json`);
}

/**
 * Predicate: does this legacy allowlist id denote a ROOM rather than a person?
 * Only used to migrate pre-tier files that kept both kinds in `senders`.
 * Channels whose ids are inherently personal (phone numbers, user ids) can omit
 * it — the default treats every legacy entry as a sender, preserving behavior.
 */
export type RoomIdPredicate = (rawId: string) => boolean;

function splitLegacyEntries(
  entries: AllowlistEntry[],
  isRoomId: RoomIdPredicate | undefined,
  channelLabel: string,
): { senders: AllowlistEntry[]; rooms: AllowlistRoom[] } {
  if (!isRoomId) return { senders: entries, rooms: [] };
  const senders: AllowlistEntry[] = [];
  const rooms: AllowlistRoom[] = [];
  for (const e of entries) {
    if (e && typeof e.id === 'string' && isRoomId(e.id)) rooms.push({ id: e.id, name: e.name });
    else senders.push(e);
  }
  if (rooms.length) {
    console.error(
      `[${channelLabel}] allowlist migration: ${rooms.length} legacy entr${rooms.length === 1 ? 'y' : 'ies'} ` +
      `(${rooms.map(r => r.name || r.id).join(', ')}) reclassified as ROOMS — anyone posting there is a GUEST ` +
      `(may ask, no tools). Add your own user id under "senders" to keep full capability there.`,
    );
  }
  return { senders, rooms };
}

/**
 * Read the allowlist file; default to `mode: off` (allow everyone) on any error.
 *
 * Accepts both shapes:
 *   - current: { mode, senders: [...], rooms: [...] }
 *   - legacy:  { mode, senders: [...] }  ← room ids lived here too; split via isRoomId
 */
export function readAllowlist(
  path: string,
  isRoomId?: RoomIdPredicate,
  channelLabel = 'channel',
): AllowlistConfig {
  try {
    if (!existsSync(path)) return { mode: 'off', senders: [], rooms: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const mode = parsed?.mode === 'on' ? 'on' : 'off';
    const rawSenders: AllowlistEntry[] = Array.isArray(parsed?.senders) ? parsed.senders : [];
    // An explicit `rooms` key means the file is already migrated — trust it as-is.
    if (Array.isArray(parsed?.rooms)) {
      return { mode, senders: rawSenders, rooms: parsed.rooms };
    }
    const { senders, rooms } = splitLegacyEntries(rawSenders, isRoomId, channelLabel);
    return { mode, senders, rooms };
  } catch {
    return { mode: 'off', senders: [], rooms: [] };
  }
}

/**
 * AllowlistWatcher — loads the allowlist once, starts an fs.watch on the
 * parent directory so any edit (gateway UI writes, user hand-edits, channel
 * rename) triggers a re-read. Safe to construct before the file exists.
 */
export class AllowlistWatcher {
  private config: AllowlistConfig = { mode: 'off', senders: [], rooms: [] };
  private watcher: FSWatcher | null = null;
  private path: string;
  private filename: string;
  private normalize: HandleNormalizer;
  private channelLabel: string;
  private isRoomId: RoomIdPredicate | undefined;

  constructor(
    projectRoot: string,
    channel: string,
    normalize: HandleNormalizer,
    isRoomId?: RoomIdPredicate,
  ) {
    this.path = allowlistPathForChannel(projectRoot, channel);
    this.filename = `${channel}-allowlist.json`;
    this.normalize = normalize;
    this.channelLabel = channel;
    this.isRoomId = isRoomId;
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
        next = readAllowlist(this.path, this.isRoomId, this.channelLabel);
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
        `(mode=on, ${this.config.senders.length} senders, ${this.config.rooms.length} rooms) ` +
        `instead of failing open to allow-all`,
      );
      return;
    }
    this.config = { mode: 'off', senders: [], rooms: [] };
  }

  /** Current config snapshot (read-only). */
  get(): Readonly<AllowlistConfig> {
    return this.config;
  }

  /** True when the sender passes the allowlist (or mode is off).
   * #1a: when mode is 'off' (unconfigured), fail CLOSED (deny) under the
   * enforce flag, else fail OPEN (allow — legacy). */
  isAllowed(rawSender: string): boolean {
    if (this.config.mode !== 'on') {
      if (allowlistEnforceClosed()) {
        console.error(
          `[${this.channelLabel}] DENY sender=${String(rawSender).slice(0, 40)}: ` +
          `channel has no allowlist configured and VODOU_CHANNEL_ALLOWLIST_ENFORCE is on. ` +
          `Add this sender in Settings → Channels to permit it.`,
        );
        return false;
      }
      return true;
    }
    if (!rawSender) return false;
    const norm = this.normalize(rawSender);
    if (!norm) return false;
    // "Allowed" = permitted to reach the channel at all, so it spans BOTH lists.
    // Capability is a separate question — see classify(). Keeping this union
    // means channels not yet migrated to tiers behave exactly as before.
    return (
      this.config.senders.some(s => this.normalize(s.id) === norm) ||
      this.config.rooms.some(r => this.normalize(r.id) === norm)
    );
  }

  /**
   * Classify a turn into a principal — the core of the owner/guest model
   * (PLAN-MASTER-EXECUTION-ORDER item 2).
   *
   * Callers pass the two kinds of identifier separately, because the SAME id
   * space used to be conflated: `isAnyAllowed([msgChannel, msgUser])` passed if
   * EITHER matched and then handed everything a fully tool-capable agent — so
   * anyone who could post in a listed room drove the agent as the owner.
   *
   * Precedence: sender match wins. Chad posting in a shared room is the owner,
   * not a guest, so his own capability in `#ask-vodou` is unchanged.
   *
   * When mode is not 'on' the channel is unconfigured: honour the existing
   * enforce flag (deny) or legacy allow-all (owner) — no tiering either way,
   * because there is no list to tier against.
   */
  classify(senderIds: (string | null | undefined)[], roomIds: (string | null | undefined)[] = []): Principal {
    if (this.config.mode !== 'on') {
      return this.isAllowed(senderIds.find(Boolean) ? String(senderIds.find(Boolean)) : '')
        ? 'owner'
        : 'denied';
    }
    for (const raw of senderIds) {
      if (!raw) continue;
      const norm = this.normalize(raw);
      if (norm && this.config.senders.some(s => this.normalize(s.id) === norm)) return 'owner';
    }
    for (const raw of roomIds) {
      if (!raw) continue;
      const norm = this.normalize(raw);
      if (norm && this.config.rooms.some(r => this.normalize(r.id) === norm)) return 'guest';
    }
    return 'denied';
  }

  /**
   * The guest-visible memory slice for a room: a vault name, "*" for the whole
   * brain, or undefined to fall back to the install default. Never consulted for
   * the owner, who always gets everything.
   */
  vaultForRoom(roomIds: (string | null | undefined)[]): string | undefined {
    for (const raw of roomIds) {
      if (!raw) continue;
      const norm = this.normalize(raw);
      const hit = this.config.rooms.find(r => this.normalize(r.id) === norm);
      if (hit) return hit.vault;
    }
    return undefined;
  }

  /** Pass an array of candidate identifiers — passes if ANY of them match. */
  isAnyAllowed(rawSenders: (string | null | undefined)[]): boolean {
    if (this.config.mode !== 'on') {
      // Delegate to isAllowed so the enforce-flag deny path (and its log) applies.
      return this.isAllowed(rawSenders.find(Boolean) ? String(rawSenders.find(Boolean)) : '');
    }
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

/**
 * Slack room ids are unambiguous by prefix: `C` public/private channel,
 * `G` legacy private group, `D` direct-message channel. `U` (user) and `W`
 * (Enterprise Grid user) are people.
 *
 * A `D…` DM channel counts as a room, not as the owner: the DM *channel* being
 * listed shouldn't confer capability. Chad still gets owner in his own DM
 * because his `U…` id is on the sender list and sender match wins.
 */
export function isSlackRoomId(raw: string): boolean {
  return /^[cdg]/i.test((raw || '').trim());
}

/**
 * Discord snowflakes are shape-identical for users and channels, so legacy
 * entries cannot be classified by inspection. Treat them as ROOMS — the
 * fail-safe direction (less capability, loudly logged at migration) — and let
 * the operator promote a user id into `senders` explicitly.
 */
export function isDiscordRoomId(_raw: string): boolean {
  return true;
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
