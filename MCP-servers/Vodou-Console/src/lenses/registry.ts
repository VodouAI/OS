/**
 * Card registry — dynamic, filesystem-scanned.
 *
 * NO hardcoded imports. The registry scans two directories at boot and
 * imports every `index.js` it finds:
 *
 *   1. <gateway>/dist/lenses/*\/index.js     — built-in cards (this repo)
 *   2. ~/.vodou/lenses/*\/index.js           — user-installed cards
 *
 * To add a card: drop a folder containing `index.js` into either location
 * and call `POST /api/lenses/reload` (or restart the gateway).
 *
 * To remove a card: delete the folder. Reload. Gone.
 *
 * This is the path PLAN-LENSES-MANAGEMENT (0.5.89) builds on with a
 * sidebar + DB-backed install state. The hot-reload primitive is here now.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { LensModule, LensManifest, RouterFacade } from './types.js';
import { urlMatch } from './_lib/urlmatch.js';
import * as metadata from './metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default scan roots — overridable for tests via setScanRoots().
const BUILTIN_LENSES_DIR = __dirname;
const USER_LENSES_DIR = process.env.VODOU_LENSES_DIR
  || path.join(homedir(), '.vodou', 'lenses');

interface LoadError { path: string; error: string }

class LensRegistry implements RouterFacade {
  private byType = new Map<string, LensModule>();
  private all: LensModule[] = [];
  private loadErrors: LoadError[] = [];
  private scanRoots: string[] = [];

  setScanRoots(roots: string[]): void {
    this.scanRoots = roots;
  }

  /** Load (or reload) all cards from configured scan roots. */
  async load(): Promise<{ loaded: number; errors: LoadError[] }> {
    this.byType.clear();
    this.all.length = 0;
    this.loadErrors = [];

    const roots = this.scanRoots.length
      ? this.scanRoots
      : [BUILTIN_LENSES_DIR, USER_LENSES_DIR];

    for (const root of roots) {
      if (!existsSync(root)) continue;
      let entries: string[] = [];
      try { entries = await readdir(root); } catch { continue; }
      for (const entry of entries) {
        const dir = path.join(root, entry);
        try {
          const s = await stat(dir);
          if (!s.isDirectory()) continue;
          // Skip _lib, tests, etc.
          if (entry.startsWith('_') || entry.startsWith('.')) continue;
          // Look for index.js (compiled output) OR index.ts (vitest source mode)
          const idxJs = path.join(dir, 'index.js');
          const idxTs = path.join(dir, 'index.ts');
          const idx = existsSync(idxJs) ? idxJs : existsSync(idxTs) ? idxTs : null;
          if (!idx) continue;
          await this.loadOne(idx);
        } catch (err: any) {
          this.loadErrors.push({ path: dir, error: err?.message || String(err) });
        }
      }
    }

    // Sort registration order: snippet.url (catch-all) goes LAST so pickByUrl
    // returns purpose-built cards first.
    this.all.sort((a, b) => {
      const aIsWild = a.manifest.url_patterns?.includes('*');
      const bIsWild = b.manifest.url_patterns?.includes('*');
      if (aIsWild && !bIsWild) return 1;
      if (bIsWild && !aIsWild) return -1;
      return 0;
    });

    return { loaded: this.all.length, errors: this.loadErrors };
  }

  private async loadOne(modulePath: string): Promise<void> {
    const isBuiltin = modulePath.startsWith(BUILTIN_LENSES_DIR);
    let mod: any;
    try {
      // Use file:// URL so dynamic import is portable
      const url = 'file://' + modulePath + `?t=${Date.now()}`; // bust ESM cache on reload
      mod = await import(url);
    } catch (err: any) {
      this.loadErrors.push({ path: modulePath, error: `import failed: ${err?.message || err}` });
      return;
    }
    const card: LensModule | undefined = mod?.card;
    if (!card || typeof card !== 'object') {
      this.loadErrors.push({ path: modulePath, error: 'no `card` export' });
      return;
    }
    if (!this.validateManifest(card)) {
      this.loadErrors.push({ path: modulePath, error: 'invalid manifest' });
      return;
    }

    // PLAN-LENSES-MANAGEMENT §6 — community lenses consult the metadata
    // sidecar for enable-state + drift check. Built-ins bypass this entirely.
    if (!isBuiltin) {
      let row: any = null;
      try { row = metadata.get(card.manifest.type); } catch { /* DB unavailable in tests */ }
      if (row) {
        if (row.enabled === 0) {
          // Skip disabled lenses entirely.
          return;
        }
        try {
          const frozen = JSON.parse(row.manifest_json);
          const drift = metadata.detectManifestDrift(card.manifest as any, frozen);
          if (drift) {
            this.loadErrors.push({
              path: modulePath,
              error: `manifest drift vs install-time: ${drift.join('; ')}`,
            });
            try { metadata.setHealth(card.manifest.type, 'load_failed'); } catch {}
            return;
          }
        } catch (e: any) {
          this.loadErrors.push({ path: modulePath, error: `drift check failed: ${e?.message || e}` });
          return;
        }
      }
    }

    if (this.byType.has(card.manifest.type)) {
      // Later registration overrides earlier (user lenses shadow built-ins by type)
      const idx = this.all.findIndex(c => c.manifest.type === card.manifest.type);
      if (idx >= 0) this.all.splice(idx, 1);
    }
    this.byType.set(card.manifest.type, card);
    this.all.push(card);
  }

  private validateManifest(card: LensModule): boolean {
    const m = card.manifest;
    if (!m || typeof m.type !== 'string' || !m.type) return false;
    if (typeof m.version !== 'number') return false;
    if (typeof m.motive !== 'string' || !m.motive) return false;
    if (!Array.isArray(m.url_patterns)) return false;
    if (typeof m.ttl_seconds !== 'number') return false;
    if (typeof card.validate !== 'function' || typeof card.fetch !== 'function') return false;
    return true;
  }

  get(type: string): LensModule | null {
    return this.byType.get(type) || null;
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }

  listManifests(): LensManifest[] {
    return this.all.map(c => c.manifest);
  }

  findCardsForUrl(url: string): LensManifest[] {
    return this.all
      .filter(c => c.manifest.url_patterns.some(p => urlMatch(p, url)))
      .map(c => c.manifest);
  }

  pickByUrl(url: string): LensModule | null {
    for (const c of this.all) {
      if (c.manifest.url_patterns.some(p => urlMatch(p, url))) return c;
    }
    return null;
  }

  getLoadErrors() {
    return [...this.loadErrors];
  }

  /** Public hook for testing or fresh state. */
  async reload(): Promise<{ loaded: number; errors: LoadError[] }> {
    return this.load();
  }
}

const registry = new LensRegistry();
let loaded = false;
let loadingPromise: Promise<any> | null = null;

/** Async — guarantees the registry is loaded before returning. */
export async function ensureRegistryLoaded(): Promise<LensRegistry> {
  if (loaded) return registry;
  if (!loadingPromise) {
    loadingPromise = registry.load().then(r => {
      loaded = true;
      console.log(`[lenses] loaded ${r.loaded} cards${r.errors.length ? ` (${r.errors.length} errors)` : ''}`);
      if (r.errors.length) {
        for (const e of r.errors) console.warn(`[lenses] load error: ${e.path}: ${e.error}`);
      }
      return r;
    });
  }
  await loadingPromise;
  return registry;
}

/** Sync — returns the registry, but call ensureRegistryLoaded() first at boot. */
export function getRegistry(): LensRegistry {
  return registry;
}

export async function reloadRegistry(): Promise<{ loaded: number; errors: any[] }> {
  loaded = false;
  loadingPromise = null;
  return ensureRegistryLoaded().then(() => registry.load());
}
