/**
 * "Is the connected Vodou Bridge the latest one?" — answered against the
 * SERVER's record, not against whatever this app build happens to ship.
 *
 * Three facts live in three different places and this module is where they meet:
 *
 *   1. **What is installed** — `bridgeStatus().version` / `.channel`, learned
 *      from the extension's `bridge_ready` handshake (src/vbb/bridge.ts). Only
 *      this process knows it, and only while the extension is connected.
 *   2. **What is latest** — `metadata.extension_latest` in vodou-core.db,
 *      written by the Rust auto-updater from app.vodou.ai/api/version/check
 *      (src/auto_updater.rs::persist_extension_latest). A different process, on
 *      a timer, over the network.
 *   3. **Where to get it** — the `download_url` on that same record,
 *      falling back to the Chrome Web Store listing the UI already knows
 *      (public/js/ext-store.js).
 *
 * WHY NOT COMPARE AGAINST THE SHIPPED MANIFEST: `extension/Store-vodou-bridge/
 * manifest.json` is in this repo, so a local comparison is free — and wrong. It
 * answers "is your bridge older than the app build you installed", which goes
 * stale the moment an extension ships without an app release (Chrome Web Store
 * review runs on Google's clock) and can never report an extension NEWER than
 * the app. The server row is the only thing that stays true between releases.
 *
 * EVERYTHING HERE FAILS SOFT. No record, no connection, unparseable versions —
 * all return "nothing to say" rather than throwing. This decorates a status
 * card; it is not allowed to break one.
 */

import { getDb } from '../db.js';
import { bridgeStatus } from '../vbb/bridge.js';

/** The latest store build, as persisted by the Rust updater. Mirrors ExtensionInfo. */
export interface ExtensionRecord {
  latest_version: string;
  channel: string;
  min_supported_version?: string | null;
  release_notes?: string[];
  download_url?: string;
}

export interface ExtensionVersionStatus {
  /** Version the connected bridge reported, or null when nothing is connected. */
  installed: string | null;
  /** Build lane the connected bridge reported ('store'), from the handshake. */
  channel: string | null;
  /** Server's latest, or null when we have no record. */
  latest: string | null;
  /** installed < latest. False when either side is unknown. */
  update_available: boolean;
  /**
   * installed < min_supported_version — a build old enough that we tell the user
   * something is actually broken, not merely dated. Distinct from
   * `update_available` on purpose: nagging every user on every release is how a
   * notice gets ignored by the time it matters.
   */
  unsupported: boolean;
  /**
   * True when the installed build updates itself — a Chrome Web Store install,
   * which Chrome refreshes within ~24h. The UI then says "Chrome will update
   * this shortly" instead of sending the user to click something they do not
   * need to click. A bridge that reports any other lane (a dev build loaded
   * unpacked) gets the download link instead, because nothing will update it.
   */
  self_updating: boolean;
  download_url: string | null;
  release_notes: string[];
}

/** Nothing known — the shape callers get when any input is missing. */
const UNKNOWN: ExtensionVersionStatus = {
  installed: null,
  channel: null,
  latest: null,
  update_available: false,
  unsupported: false,
  self_updating: false,
  download_url: null,
  release_notes: [],
};

/**
 * Compare two dotted numeric versions. Returns <0, 0, >0 like a comparator, or
 * `null` when either side isn't comparable.
 *
 * Extension versions are Chrome's 4-part dotted-integer format ("0.5.97.75"),
 * NOT semver: no pre-release tags, no leading `v`, and each part is a plain
 * integer up to 65535. That means a lexicographic compare is wrong in the way
 * that bites — "0.5.97.100" sorts BELOW "0.5.97.75" as strings — so parts are
 * compared numerically. Unequal lengths compare as if the shorter were
 * zero-padded, which is what Chrome does ("1.0" == "1.0.0").
 *
 * Returns null (rather than guessing) on anything non-numeric, so a garbage
 * record surfaces as "no opinion" instead of a confident wrong answer.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const trimmed = (v ?? '').trim().replace(/^v/i, '');
    if (!trimmed) return null;
    const parts = trimmed.split('.');
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      nums.push(parseInt(p, 10));
    }
    return nums.length ? nums : null;
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;

  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The server's extension record.
 * Null when the row is absent, malformed, or the DB is unavailable.
 */
export function readExtensionRecord(): ExtensionRecord | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM metadata WHERE key = 'extension_latest'")
      .get() as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof (parsed as ExtensionRecord).latest_version !== 'string') return null;
    return parsed as ExtensionRecord;
  } catch {
    // No row yet (the updater hasn't run), bad JSON, or vodou-core.db locked.
    return null;
  }
}

/**
 * Resolve installed-vs-latest for whatever bridge is connected right now.
 *
 * `bridge` is injectable so tests can drive every combination without a live
 * WebSocket; production callers pass nothing and get the real handshake state.
 */
export function extensionVersionStatus(
  bridge?: { connected?: boolean; version?: string | null; channel?: string | null },
  record?: ExtensionRecord | null,
): ExtensionVersionStatus {
  const b = bridge ?? (bridgeStatus() as { connected?: boolean; version?: string | null; channel?: string | null });
  const installed = b?.version?.trim() || null;

  // A disconnected extension tells us nothing about what the user has installed
  // — the last version we saw could be from a browser they've since updated. The
  // Sources card already says "not connected"; adding a version claim on top of
  // that would be inventing state.
  if (!b?.connected || !installed) return UNKNOWN;

  // Absent channel = a build predating the channel field. Treat as 'store',
  // which is both the common case and the conservative one (its advice is
  // "wait, Chrome handles it" rather than "go download something").
  const channel = b.channel?.trim() || 'store';
  const rec = record === undefined ? readExtensionRecord() : record;

  const self_updating = channel === 'store';

  if (!rec?.latest_version) {
    // We know what's installed but not what's current. Report the installed
    // version — the card can still show it — and claim nothing else.
    return { ...UNKNOWN, installed, channel, self_updating };
  }

  const cmp = compareVersions(installed, rec.latest_version);
  const min = rec.min_supported_version?.trim() || null;
  const cmpMin = min ? compareVersions(installed, min) : null;

  return {
    installed,
    channel,
    latest: rec.latest_version,
    // cmp === null (unparseable either side) must not read as "up to date" OR
    // as "update available" — false is the quiet option, and the version is
    // still shown so a human can eyeball it.
    update_available: cmp !== null && cmp < 0,
    unsupported: cmpMin !== null && cmpMin < 0,
    self_updating,
    download_url: rec.download_url?.trim() || null,
    release_notes: Array.isArray(rec.release_notes) ? rec.release_notes : [],
  };
}
