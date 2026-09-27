/**
 * Installed-vs-latest for the Vodou Bridge.
 *
 * The comparator gets the most attention here for one reason: extension
 * versions are Chrome's 4-part dotted integers, and the failure mode of the
 * obvious implementation (string compare) is silent and backwards — it reports
 * "up to date" to exactly the users who are furthest behind, because
 * "0.5.97.100" < "0.5.97.75" lexicographically. That bug would look like the
 * feature working.
 *
 * The rest pins the fail-soft contract: no bridge, no record, or garbage
 * versions must all resolve to "no opinion" rather than a wrong claim or a
 * throw. This decorates a status card and is not allowed to break one.
 */
import { describe, it, expect } from 'vitest';
import { compareVersions, extensionVersionStatus, } from '../api/extension-version.js';
const STORE = {
    latest_version: '0.5.97.80',
    channel: 'store',
    min_supported_version: null,
    release_notes: ['Page memory'],
    download_url: 'https://chromewebstore.google.com/detail/vodou-bridge/abc',
};
const connected = (version, channel = 'store') => ({
    connected: true,
    version,
    channel,
});
describe('compareVersions', () => {
    it('orders 4-part versions numerically, not lexicographically', () => {
        // The regression this whole function exists for.
        expect(compareVersions('0.5.97.100', '0.5.97.75')).toBe(1);
        expect(compareVersions('0.5.97.75', '0.5.97.100')).toBe(-1);
        expect('0.5.97.100' < '0.5.97.75').toBe(true); // string compare disagrees
    });
    it('handles equality and each position', () => {
        expect(compareVersions('0.5.97.75', '0.5.97.75')).toBe(0);
        expect(compareVersions('1.0.0.0', '0.9.9.9')).toBe(1);
        expect(compareVersions('0.5.98.0', '0.5.97.99')).toBe(1);
        expect(compareVersions('0.6.0.0', '0.5.97.75')).toBe(1);
    });
    it('zero-pads unequal lengths the way Chrome does', () => {
        expect(compareVersions('1.0', '1.0.0')).toBe(0);
        expect(compareVersions('1.0', '1.0.1')).toBe(-1);
        expect(compareVersions('1.0.1', '1.0')).toBe(1);
    });
    it('tolerates a leading v', () => {
        expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    });
    it('returns null — never a guess — for anything non-numeric', () => {
        expect(compareVersions('1.2.beta', '1.2.3')).toBeNull();
        expect(compareVersions('', '1.0.0')).toBeNull();
        expect(compareVersions('1.0.0', '')).toBeNull();
        expect(compareVersions('not-a-version', 'also-not')).toBeNull();
    });
});
describe('extensionVersionStatus', () => {
    it('flags an out-of-date bridge and carries the download link', () => {
        const s = extensionVersionStatus(connected('0.5.97.75'), STORE);
        expect(s.installed).toBe('0.5.97.75');
        expect(s.latest).toBe('0.5.97.80');
        expect(s.update_available).toBe(true);
        expect(s.unsupported).toBe(false);
        expect(s.self_updating).toBe(true);
        expect(s.download_url).toContain('chromewebstore');
        expect(s.release_notes).toEqual(['Page memory']);
    });
    it('says nothing when the bridge is current', () => {
        const s = extensionVersionStatus(connected('0.5.97.80'), STORE);
        expect(s.update_available).toBe(false);
        expect(s.installed).toBe('0.5.97.80');
        expect(s.latest).toBe('0.5.97.80');
    });
    it('does not nag a bridge NEWER than the server record', () => {
        // Happens between a Chrome Web Store rollout and the playbook step that
        // publishes the row. A "downgrade" prompt here would be actively wrong.
        const s = extensionVersionStatus(connected('0.5.97.99'), STORE);
        expect(s.update_available).toBe(false);
    });
    it('separates "dated" from "too old to work"', () => {
        const withFloor = { ...STORE, min_supported_version: '0.5.97.70' };
        const dated = extensionVersionStatus(connected('0.5.97.75'), withFloor);
        expect(dated.update_available).toBe(true);
        expect(dated.unsupported).toBe(false); // 75 >= 70 — a pill, not a warning
        const broken = extensionVersionStatus(connected('0.5.97.60'), withFloor);
        expect(broken.update_available).toBe(true);
        expect(broken.unsupported).toBe(true);
    });
    it('claims nothing when no extension is connected', () => {
        const s = extensionVersionStatus({ connected: false, version: '0.5.97.10' }, STORE);
        expect(s.installed).toBeNull();
        expect(s.latest).toBeNull();
        expect(s.update_available).toBe(false);
    });
    it('reports the installed version even with no server record', () => {
        // Fresh install: the updater has not run its first check yet.
        const s = extensionVersionStatus(connected('0.5.97.75'), null);
        expect(s.installed).toBe('0.5.97.75');
        expect(s.latest).toBeNull();
        expect(s.update_available).toBe(false);
        expect(s.unsupported).toBe(false);
    });
    it('goes quiet rather than guessing when a version is unparseable', () => {
        const junk = { ...STORE, latest_version: 'unknown' };
        const s = extensionVersionStatus(connected('0.5.97.75'), junk);
        expect(s.update_available).toBe(false);
        expect(s.unsupported).toBe(false);
        expect(s.installed).toBe('0.5.97.75'); // still shown for a human to read
    });
    it('treats a missing channel as store', () => {
        const s = extensionVersionStatus({ connected: true, version: '0.5.97.75', channel: null }, STORE);
        expect(s.channel).toBe('store');
        expect(s.self_updating).toBe(true);
    });
    it('marks a non-store build as not self-updating', () => {
        // An unpacked dev build: Chrome will never update it, so the UI must offer
        // the link instead of "Chrome will handle it".
        const s = extensionVersionStatus(connected('0.5.97.75', 'sideload'), STORE);
        expect(s.self_updating).toBe(false);
    });
    // The case install_type exists for: the STORE build loaded unpacked from the
    // install folder. It reports channel 'store', and channel alone called it
    // self-updating — the UI said "Chrome updates this automatically" about a copy
    // nothing will ever update.
    it('the Store build loaded unpacked is NOT self-updating, despite channel store', () => {
        const s = extensionVersionStatus({ connected: true, version: '0.5.97.75', channel: 'store', install_type: 'development' }, STORE);
        expect(s.channel).toBe('store');
        expect(s.install_type).toBe('development');
        expect(s.self_updating).toBe(false);
        expect(s.update_available).toBe(true);
    });
    it('a real Web Store install is self-updating', () => {
        const s = extensionVersionStatus({ connected: true, version: '0.5.97.75', channel: 'store', install_type: 'normal' }, STORE);
        expect(s.install_type).toBe('normal');
        expect(s.self_updating).toBe(true);
    });
    it('policy (admin) and installer-registered (sideload) copies are self-updating', () => {
        // `sideload` is what an installer's "external extension" entry produces —
        // Chrome installs it from the Web Store and keeps it updated.
        for (const install_type of ['admin', 'sideload']) {
            const s = extensionVersionStatus({ connected: true, version: '0.5.97.75', channel: 'store', install_type }, STORE);
            expect(s.self_updating, install_type).toBe(true);
        }
        const other = extensionVersionStatus({ connected: true, version: '0.5.97.75', channel: 'store', install_type: 'other' }, STORE);
        expect(other.self_updating).toBe(false);
    });
    it('a bridge that predates install_type keeps the old channel rule', () => {
        // Every store bridge in the field before this change sends no install_type.
        // Flipping them all to "not self-updating" would show a manual update link
        // to people whose Chrome is about to update them anyway.
        const s = extensionVersionStatus(connected('0.5.97.75'), STORE);
        expect(s.install_type).toBeNull();
        expect(s.self_updating).toBe(true);
    });
    it('install_type is carried even with no server record', () => {
        const s = extensionVersionStatus({ connected: true, version: '0.5.97.75', channel: 'store', install_type: 'development' }, null);
        expect(s.install_type).toBe('development');
        expect(s.self_updating).toBe(false);
    });
    it('never throws on a malformed record', () => {
        const bad = { latest_version: '0.5.97.80' };
        expect(() => extensionVersionStatus(connected('0.5.97.75'), bad)).not.toThrow();
        const s = extensionVersionStatus(connected('0.5.97.75'), bad);
        expect(s.update_available).toBe(true);
        expect(s.download_url).toBeNull();
        expect(s.release_notes).toEqual([]);
    });
});
// For a copy Chrome updates, Chrome's answer (it asked Google's update server)
// outranks app.vodou.ai's record. The record was wrong in both directions in the
// field: 0.5.97.78 while the store served .86 (nobody told they were behind), and
// the same script run early would name a build still in review.
describe('extensionVersionStatus — Chrome is the source of truth for copies it updates', () => {
    const NOW = 50_000_000;
    const storeCopy = (version, chrome_update, install_type = 'normal') => ({
        connected: true, version, channel: 'store', install_type, chrome_update,
    });
    const answer = (status, version, for_version, at = NOW - 1000) => ({ status, version, for_version, at });
    const STALE = { ...STORE, latest_version: '0.5.97.78' };
    const EARLY = { ...STORE, latest_version: '0.5.97.90', release_notes: ['still in review'] };
    it('a stale record that says "current" is overruled when Chrome has an update', () => {
        const s = extensionVersionStatus(storeCopy('0.5.97.86', answer('update_available', '0.5.97.88', '0.5.97.86')), STALE, NOW);
        expect(s.latest).toBe('0.5.97.88');
        expect(s.latest_source).toBe('chrome');
        expect(s.update_available).toBe(true);
    });
    it('a record naming a build still in review is overruled when Chrome says no update', () => {
        const s = extensionVersionStatus(storeCopy('0.5.97.88', answer('no_update', null, '0.5.97.88')), EARLY, NOW);
        expect(s.latest).toBe('0.5.97.88');
        expect(s.latest_source).toBe('chrome');
        expect(s.update_available).toBe(false);
        expect(s.release_notes).toEqual([]); // the record's notes describe .90, not what Chrome offers
    });
    it('release notes are kept when the record describes the version Chrome offers', () => {
        const rec = { ...STORE, latest_version: '0.5.97.88', release_notes: ['the .88 notes'] };
        const s = extensionVersionStatus(storeCopy('0.5.97.86', answer('update_available', '0.5.97.88', '0.5.97.86')), rec, NOW);
        expect(s.release_notes).toEqual(['the .88 notes']);
    });
    it('the minimum-supported floor still comes from the record — it is a Vodou decision', () => {
        const rec = { ...STORE, min_supported_version: '0.5.97.87' };
        const s = extensionVersionStatus(storeCopy('0.5.97.86', answer('no_update', null, '0.5.97.86')), rec, NOW);
        expect(s.update_available).toBe(false);
        expect(s.unsupported).toBe(true);
    });
    it('works with no server record at all', () => {
        const s = extensionVersionStatus(storeCopy('0.5.97.86', answer('update_available', '0.5.97.88', '0.5.97.86')), null, NOW);
        expect(s.latest).toBe('0.5.97.88');
        expect(s.update_available).toBe(true);
    });
    it('an answer about a DIFFERENT installed version is ignored', () => {
        // Asked on .86, then the bridge updated itself to .88: ".88 is available" is
        // no longer true, and must not make .88 look behind.
        const s = extensionVersionStatus(storeCopy('0.5.97.88', answer('update_available', '0.5.97.88', '0.5.97.86')), STALE, NOW);
        expect(s.latest_source).toBe('server');
    });
    it('an answer older than the TTL is ignored', () => {
        const old = answer('update_available', '0.5.97.88', '0.5.97.86', NOW - 7 * 60 * 60 * 1000);
        const s = extensionVersionStatus(storeCopy('0.5.97.86', old), STALE, NOW);
        expect(s.latest_source).toBe('server');
        expect(s.latest).toBe('0.5.97.78');
    });
    it('an unpacked copy never uses a Chrome answer — Chrome cannot update it', () => {
        const s = extensionVersionStatus(storeCopy('0.5.97.86', answer('update_available', '0.5.97.88', '0.5.97.86'), 'development'), STALE, NOW);
        expect(s.latest_source).toBe('server');
    });
    it('without an answer, the record is used and labelled as such', () => {
        const s = extensionVersionStatus(storeCopy('0.5.97.75', null), STORE, NOW);
        expect(s.latest).toBe('0.5.97.80');
        expect(s.latest_source).toBe('server');
    });
});
