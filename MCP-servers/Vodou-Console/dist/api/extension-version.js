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
/**
 * Install types Chrome itself keeps updated (chrome.management ExtensionInstallType):
 * `normal` = Web Store, `admin` = policy, `sideload` = registered by another
 * program (an installer's "external extension" entry). `development` (Load
 * unpacked) and `other` are not.
 */
export const CHROME_UPDATED_INSTALL_TYPES = new Set(['normal', 'admin', 'sideload']);
/**
 * How long Chrome's answer is trusted. The gateway asks hourly (ext-update-nudge);
 * past this, the answer is too old to overrule the server's record.
 */
export const CHROME_ANSWER_TTL_MS = 6 * 60 * 60 * 1000;
/** Nothing known — the shape callers get when any input is missing. */
const UNKNOWN = {
    installed: null,
    channel: null,
    latest: null,
    latest_source: null,
    update_available: false,
    unsupported: false,
    self_updating: false,
    install_type: null,
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
export function compareVersions(a, b) {
    const parse = (v) => {
        const trimmed = (v ?? '').trim().replace(/^v/i, '');
        if (!trimmed)
            return null;
        const parts = trimmed.split('.');
        const nums = [];
        for (const p of parts) {
            if (!/^\d+$/.test(p))
                return null;
            nums.push(parseInt(p, 10));
        }
        return nums.length ? nums : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb)
        return null;
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d < 0 ? -1 : 1;
    }
    return 0;
}
/**
 * The server's extension record.
 * Null when the row is absent, malformed, or the DB is unavailable.
 */
export function readExtensionRecord() {
    try {
        const row = getDb()
            .prepare("SELECT value FROM metadata WHERE key = 'extension_latest'")
            .get();
        if (!row?.value)
            return null;
        const parsed = JSON.parse(row.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        if (typeof parsed.latest_version !== 'string')
            return null;
        return parsed;
    }
    catch {
        // No row yet (the updater hasn't run), bad JSON, or vodou-core.db locked.
        return null;
    }
}
export function extensionVersionStatus(bridge, record, now = Date.now()) {
    const b = bridge ?? bridgeStatus();
    const installed = b?.version?.trim() || null;
    // A disconnected extension tells us nothing about what the user has installed
    // — the last version we saw could be from a browser they've since updated. The
    // Sources card already says "not connected"; adding a version claim on top of
    // that would be inventing state.
    if (!b?.connected || !installed)
        return UNKNOWN;
    // Absent channel = a build predating the channel field. Treat as 'store',
    // which is both the common case and the conservative one (its advice is
    // "wait, Chrome handles it" rather than "go download something").
    const channel = b.channel?.trim() || 'store';
    const rec = record === undefined ? readExtensionRecord() : record;
    const install_type = b.install_type?.trim() || null;
    const chromeUpdated = install_type !== null && CHROME_UPDATED_INSTALL_TYPES.has(install_type);
    // Only a Web Store install is updated by Chrome. The Store build loaded
    // unpacked from the install folder reports channel `store` and never updates,
    // which `channel === 'store'` alone used to call self-updating — so the UI
    // told those users "Chrome updates this automatically" about a copy nothing
    // would ever touch. A bridge that predates install_type keeps the old rule.
    const self_updating = channel === 'store' && (install_type === null ? true : chromeUpdated);
    // The minimum-supported floor is a Vodou decision, not a store fact: it always
    // comes from the server record.
    const min = rec?.min_supported_version?.trim() || null;
    const cmpMin = min ? compareVersions(installed, min) : null;
    const unsupported = cmpMin !== null && cmpMin < 0;
    const download_url = rec?.download_url?.trim() || null;
    // For a copy Chrome updates, Chrome is the source of truth: it asked Google's
    // update server. That also answers the case the server record gets wrong in
    // both directions — a row published before the store approved the build
    // ("update available" to a version nobody can install yet), and a row nobody
    // updated after it did (every user told they are current while an update
    // sits waiting). Only a recent answer about THIS installed version counts.
    const ca = chromeUpdated && b.chrome_update
        && b.chrome_update.for_version === installed
        && now - b.chrome_update.at <= CHROME_ANSWER_TTL_MS
        ? b.chrome_update : null;
    const chromeLatest = ca
        ? (ca.status === 'update_available' ? (ca.version?.trim() || null) : installed)
        : null;
    if (chromeLatest) {
        const cmp = compareVersions(installed, chromeLatest);
        return {
            installed,
            channel,
            latest: chromeLatest,
            latest_source: 'chrome',
            update_available: cmp !== null && cmp < 0,
            unsupported,
            self_updating,
            install_type,
            download_url,
            // The server's notes describe the server's version; attach them only when
            // that is the version Chrome is offering.
            release_notes: rec?.latest_version === chromeLatest && Array.isArray(rec?.release_notes)
                ? rec.release_notes : [],
        };
    }
    if (!rec?.latest_version) {
        // We know what's installed but not what's current. Report the installed
        // version — the card can still show it — and claim nothing else.
        return { ...UNKNOWN, installed, channel, self_updating, install_type };
    }
    const cmp = compareVersions(installed, rec.latest_version);
    return {
        installed,
        channel,
        latest: rec.latest_version,
        latest_source: 'server',
        // cmp === null (unparseable either side) must not read as "up to date" OR
        // as "update available" — false is the quiet option, and the version is
        // still shown so a human can eyeball it.
        update_available: cmp !== null && cmp < 0,
        unsupported,
        self_updating,
        install_type,
        download_url,
        release_notes: Array.isArray(rec.release_notes) ? rec.release_notes : [],
    };
}
