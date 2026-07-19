/**
 * Vodou gateway service worker — caches static assets for fast load.
 * Does NOT cache API calls or WebSocket — those need to be live.
 */

const CACHE_NAME = 'vodou-v159';
const STATIC_ASSETS = [
  '/',
  '/icons/vodou-logo.png',
  '/js/lazy.js',
  '/js/api.js',
  '/js/components.js',
  '/js/router.js',
  '/js/chat-helpers.js',
  '/js/chat-composer.js',
  '/js/chat-file-drop.js',
  '/js/workbench-surfaces.js',
  '/js/ws-bus.js',
  '/js/scope-registry.js',
  '/js/scope-adapters/integration.js',
  '/js/scope-adapters/skill.js',
  '/js/scoped-workbench.js',
  '/js/smart-render.js',
  '/js/autocomplete.js',
  '/js/command-palette.js',
  '/js/views/chat.js',
  '/js/views/home.js',
  '/js/views/system.js',
  '/js/views/servers.js',
  '/js/views/skills.js',
  '/js/views/intents.js',
  '/js/views/scheduler.js',
  '/js/views/automations.js',
  '/js/views/scripts.js',
  '/js/views/logs.js',
  '/js/views/capabilities.js',
  '/js/views/activity.js',
  '/js/views/terminal.js',
  '/js/views/memory.js',
  '/js/views/setup.js',
  '/js/views/channels.js',
  '/js/views/onboarding.js',
  '/js/skill-runner.js',
  '/js/inline-forms.js',
  '/js/views/settings.js',
  '/js/views/builder.js',
  '/js/builder/canvas.js',
  '/js/builder/nodes.js',
  '/js/builder/properties.js',
  '/js/builder/serializer.js',
  '/js/builder/deserializer.js',
  '/js/builder/validator.js',
  '/js/builder/tool-browser.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, WebSocket, or POST requests
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  const isHtml = event.request.headers.get('accept')?.includes('text/html');
  const isCss  = url.pathname.endsWith('.css');
  const isJs   = url.pathname.endsWith('.js');

  // Network-first for HTML, CSS, and JS — always get latest, fall back to cache offline.
  // Cache-first only for fonts / icons / images that rarely change.
  if (isHtml || isCss || isJs) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Update the cache as a side-effect so offline still works
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
