/**
 * lazy.js — on-demand script/style loading with per-URL de-duplication.
 * Exposes window.lazyScript(url) and window.lazyStyle(url).
 * Each returns a Promise that resolves when the asset is loaded (or cached).
 */
(function (global) {
  const cache = new Map();

  global.lazyScript = function (url) {
    if (cache.has(url)) return cache.get(url);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        cache.delete(url);
        reject(new Error('Failed to load script: ' + url));
      };
      document.head.appendChild(s);
    });
    cache.set(url, p);
    return p;
  };

  global.lazyStyle = function (url) {
    if (cache.has(url)) return cache.get(url);
    const p = new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = url;
      l.onload = () => resolve();
      l.onerror = () => {
        cache.delete(url);
        reject(new Error('Failed to load stylesheet: ' + url));
      };
      document.head.appendChild(l);
    });
    cache.set(url, p);
    return p;
  };
})(window);
