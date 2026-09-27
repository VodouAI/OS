// Getting a Chrome Web Store update onto the machine, and keeping it working.
//
// Chrome checks the store every few hours and, when it finds a new version,
// installs it the next time the extension's service worker unloads. This worker
// holds a WebSocket to the gateway open, and an open socket keeps a worker alive
// — so in practice an approved update could sit undelivered until the person
// restarted the browser. Nothing in the extension ever asked Chrome to check, or
// applied what it found.
//
// Three jobs, all here so a Node test can drive them in a vm context:
//
//   1. installType — how this copy was installed. `normal` (Web Store),
//      `admin` (policy) and `sideload` (registered by an installer) are updated
//      by Chrome; `development` is "Load
//      unpacked" (including the Store build loaded from the install folder),
//      which Chrome never updates. The gateway used to assume every `store`
//      channel bridge updated itself; this is how it can tell.
//      chrome.management.getSelf needs no `management` permission.
//
//   2. Apply an update promptly, but never mid-work. On `update_available`
//      (from Chrome's own check, or from a check the gateway asked for) wait
//      until nothing is in flight, then chrome.runtime.reload(). Captured turns
//      are durable — they live in the persisted retry queue — so a reload pauses
//      capture rather than losing it; what it could drop is a request awaiting
//      an answer, which is what isIdle() rules out. Still busy after GIVE_UP_MS:
//      stop trying, and Chrome applies it the next time the worker unloads. A
//      stuck worker must not turn into a reload loop.
//
//   3. Leave a marker across the reload, so the next bridge_ready can say which
//      version it came from — the gateway can then log that the update landed
//      rather than inferring it from a version that changed.
//
// Loaded as a static import from background.js, like capture-heartbeat.js.
globalThis.VodouSelfUpdate = (() => {
  const POLL_MS = 15 * 1000;
  // Install types Chrome itself keeps updated from an update URL (developer.
  // chrome.com/docs/extensions/reference/api/management#type-ExtensionInstallType):
  // `normal` (Web Store), `admin` (policy), `sideload` (another program registered
  // it — the "external extension" file an installer can drop). `development` is
  // Load unpacked, which nothing updates; `other` is not claimed either way.
  const CHROME_UPDATED = ['normal', 'admin', 'sideload'];
  const GIVE_UP_MS = 10 * 60 * 1000;
  // The updater swaps the folder by moving the old one aside and copying the new
  // one in, so for a moment the folder is half-written. A newer manifest seen
  // once might be mid-copy; reloading then would load a half-copied extension,
  // which Chrome can disable. Read it again after this long, and only then act.
  const DISK_SETTLE_MS = 60 * 1000;
  const MARKER_KEY = 'vodou_self_update';

  let deps = null;
  let installType = null;
  let scheduled = null; // { to, source, since }
  let diskSettling = false;

  /**
   * Wire in the platform. background.js passes the real chrome APIs; tests pass
   * fakes. Required: runtime (requestUpdateCheck, reload, getManifest, getURL),
   * fetch (for an unpacked copy's on-disk manifest),
   * management (getSelf), storage (get/set/remove), isIdle, now, setTimeout.
   * Optional: flush (await queued writes before a reload), log.
   */
  function configure(d) { deps = d; }

  async function learnInstallType() {
    try {
      const self = await deps.management.getSelf();
      installType = (self && self.installType) || null;
    } catch (_) {
      installType = null; // unknown is reported as unknown, never guessed
    }
    return installType;
  }

  function getInstallType() { return installType; }

  const log = (m) => { try { deps.log && deps.log(m); } catch (_) { /* logging is best-effort */ } };

  /**
   * The gateway's "is there an update?" nudge. Only a Web Store install can be
   * updated by Chrome, so any other kind answers without calling the API.
   */
  async function checkNow() {
    if (!CHROME_UPDATED.includes(installType)) {
      return { status: 'not_store_install', version: null, install_type: installType };
    }
    let r;
    try {
      r = await deps.runtime.requestUpdateCheck();
    } catch (e) {
      return { status: 'error', version: null, install_type: installType, error: String((e && e.message) || e) };
    }
    // MV3: { status: 'throttled' | 'no_update' | 'update_available', version? }
    const status = (r && r.status) || 'unknown';
    const version = (r && r.version) || null;
    if (status === 'update_available') scheduleReload(version, 'gateway');
    return { status, version, install_type: installType };
  }

  // Chrome's dotted-integer versions ("0.5.97.100" > "0.5.97.75"); null when
  // either side is not one, so garbage never reads as "newer".
  function cmpVersion(a, b) {
    const p = (v) => {
      const parts = String(v || '').trim().split('.');
      if (!parts.length || parts.some((x) => !/^\d+$/.test(x))) return null;
      return parts.map((x) => parseInt(x, 10));
    };
    const x = p(a); const y = p(b);
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /**
   * An unpacked copy is never updated by Chrome — but it IS read from a folder,
   * and the app's updater now refreshes that folder (component_updater's
   * Extension category). Chrome keeps running what it loaded until the
   * extension reloads, so compare the manifest ON DISK with the one running and
   * reload onto the new files once idle. Unpacked extension files are served
   * from the folder, so fetching our own manifest reads what is there now.
   */
  async function readDiskVersion() {
    try {
      const r = await deps.fetch(deps.runtime.getURL('manifest.json'), { cache: 'no-store' });
      return (await r.json()).version || null;
    } catch (_) {
      return undefined; // mid-swap, or unreadable
    }
  }

  function runningVersion() {
    try { return deps.runtime.getManifest().version; } catch (_) { return null; }
  }

  async function checkDiskVersion() {
    if (installType !== 'development') return { status: 'not_unpacked', version: null, source: 'disk' };
    const disk = await readDiskVersion();
    if (disk === undefined) return { status: 'error', version: null, source: 'disk' };
    const running = runningVersion();
    const c = cmpVersion(disk, running);
    if (c === null || c <= 0) return { status: 'no_update', version: running, source: 'disk' };
    if (!diskSettling) {
      diskSettling = true;
      log(`folder has ${disk}, running ${running} — confirming in ${DISK_SETTLE_MS / 1000}s before reloading`);
      deps.setTimeout(async () => {
        diskSettling = false;
        const again = await readDiskVersion();
        const c2 = again === undefined ? null : cmpVersion(again, runningVersion());
        if (c2 !== null && c2 > 0) scheduleReload(again, 'disk');
        else log('folder changed again or became unreadable — not reloading this time');
      }, DISK_SETTLE_MS);
    }
    return { status: 'update_available', version: disk, source: 'disk' };
  }

  /** Returns false when a reload is already pending — one at a time. */
  function scheduleReload(toVersion, source) {
    if (scheduled) return false;
    scheduled = { to: toVersion || null, source: source || 'chrome', since: deps.now() };
    log(`update ${toVersion || '?'} available (${scheduled.source}) — reloading once idle`);
    tick();
    return true;
  }

  async function tick() {
    const s = scheduled;
    if (!s) return;
    if (deps.isIdle()) {
      try { if (deps.flush) await deps.flush(); } catch (_) { /* a failed flush is not a reason to keep an old build */ }
      const from = (() => { try { return deps.runtime.getManifest().version; } catch (_) { return null; } })();
      try {
        await deps.storage.set({ [MARKER_KEY]: { from, to: s.to, source: s.source, at: deps.now() } });
      } catch (_) { /* the marker is informational; the update still matters more */ }
      scheduled = null;
      log(`reloading ${from || '?'} → ${s.to || '?'}`);
      deps.runtime.reload();
      return;
    }
    if (deps.now() - s.since >= GIVE_UP_MS) {
      scheduled = null;
      log(`update ${s.to || '?'} deferred — still busy after ${GIVE_UP_MS / 60000} min; Chrome will apply it when the worker next unloads`);
      return;
    }
    deps.setTimeout(tick, POLL_MS);
  }

  /** Read the pre-reload marker once and clear it, so it is reported exactly once. */
  async function takeMarker() {
    try {
      const got = await deps.storage.get(MARKER_KEY);
      const m = (got && got[MARKER_KEY]) || null;
      if (m) await deps.storage.remove(MARKER_KEY);
      return m;
    } catch (_) {
      return null;
    }
  }

  function pending() { return scheduled ? Object.assign({}, scheduled) : null; }

  // After an update — Chrome's or ours — every open AI tab still runs the OLD
  // isolated-world content script, now orphaned: it can no longer reach the
  // worker, so the panel's probe and insert stop answering. The panel already
  // self-heals one tab at a time when a probe fails (`vodou_ensure_content`);
  // this does the same for every open tab up front.
  //
  // Deliberately the SAME two files as that proven path, and nothing more.
  // `inject.js` runs in the page's MAIN world, which an extension reload does
  // NOT orphan — the old copy is still hooking fetch — so injecting it again
  // would wrap fetch twice and could post every captured turn twice. content.js
  // mount guards are versioned, so re-injecting it is a no-op on a tab that is
  // already current and re-arms one that is not.
  const REINJECT_FILES = ['sites.js', 'content.js'];

  async function reinjectOpenTabs() {
    let matches = [];
    try {
      for (const cs of (deps.runtime.getManifest().content_scripts || [])) {
        if (cs.world === 'MAIN') continue;
        for (const m of (cs.matches || [])) if (!matches.includes(m)) matches.push(m);
      }
    } catch (_) { return { tabs: 0, injected: 0 }; }
    if (!matches.length) return { tabs: 0, injected: 0 };
    let tabs = [];
    try { tabs = await deps.tabs.query({ url: matches }); } catch (_) { return { tabs: 0, injected: 0 }; }
    let injected = 0;
    for (const t of tabs) {
      if (!t || !t.id) continue;
      try {
        await deps.scripting.executeScript({ target: { tabId: t.id }, files: REINJECT_FILES });
        injected++;
      } catch (_) { /* a discarded or restricted tab refuses; the panel's per-tab heal still covers it */ }
    }
    return { tabs: tabs.length, injected };
  }

  return { configure, learnInstallType, getInstallType, checkNow, checkDiskVersion, cmpVersion, scheduleReload, takeMarker, reinjectOpenTabs, pending, POLL_MS, GIVE_UP_MS, DISK_SETTLE_MS, MARKER_KEY, REINJECT_FILES, CHROME_UPDATED };
})();
