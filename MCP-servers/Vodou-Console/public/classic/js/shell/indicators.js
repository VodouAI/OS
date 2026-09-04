/**
 * Tiny pub/sub event bus for shell indicators (model / memory / WS).
 *
 * Plan: PLANS/0.5.38/PLAN-VODOU-CONSOLE-MACOS-SHELL.md §0 #5 — picked pub/sub
 * over DOM-mirroring so the menubar can't silently desync from the source.
 *
 * Producers (chat.js, ws code) call IndicatorBus.publish('model', value).
 * Consumers (shell menubar) call IndicatorBus.subscribe('model', fn).
 *
 * For the Phase 1 experiment we don't refactor producers. Instead, shell-init
 * uses a MutationObserver on the existing footer/sidebar indicator DOM and
 * relays into this bus, so the API is in place when we do the proper migration.
 */
(function () {
  'use strict';
  const subs = new Map();
  const last = new Map();
  const Bus = {
    publish(topic, value) {
      last.set(topic, value);
      const fns = subs.get(topic);
      if (!fns) return;
      for (const fn of fns) {
        try { fn(value); } catch (e) { console.warn('[indicators] subscriber threw:', e); }
      }
    },
    subscribe(topic, fn) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(fn);
      if (last.has(topic)) {
        try { fn(last.get(topic)); } catch (e) { console.warn('[indicators] initial fn threw:', e); }
      }
      return () => subs.get(topic)?.delete(fn);
    },
    snapshot(topic) { return last.get(topic); },
  };
  window.IndicatorBus = Bus;
})();
