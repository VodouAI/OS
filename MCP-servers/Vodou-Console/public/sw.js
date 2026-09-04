/**
 * Vodou gateway service worker — KILL SWITCH (cutover 2026-09-03).
 *
 * Until 0.6.31 this file cached the console's static assets at scope '/'
 * (version log: `git log -- public/sw.js`, last CACHE_NAME 'vodou-v313'). The
 * redesigned console registers no worker, and the classic tree at /classic/
 * no longer registers this one. A browser that still holds the old worker
 * fetches this file on its next navigation, installs it, and this version
 * deletes every cache, unregisters itself, and reloads its windows — after
 * which nothing intercepts requests. No fetch handler on purpose.
 */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => { clients.forEach((c) => { try { c.navigate(c.url); } catch (_) {} }); })
  );
});
