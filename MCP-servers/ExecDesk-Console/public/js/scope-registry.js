/**
 * ScopeRegistry — plug-in registry for scope types.
 *
 * Each scope type (`integration`, `skill`, `flow`, …) registers an adapter
 * that knows how to turn a raw scope string (`workbench:integration:linear`)
 * into a ScopeDescriptor the ScopedWorkbench component can render.
 *
 * A ScopeDescriptor looks like:
 *   {
 *     scopeType, scopeId, raw,
 *     displayName,       // human label
 *     iconHtml,          // string of HTML for the icon (preset logo, etc.)
 *     toolRail,          // [{ name, description, prefill? }]
 *     emptyStateHint,    // optional — shown when no messages yet
 *   }
 */
const ScopeRegistry = (() => {
  const _adapters = new Map();

  function register(scopeType, adapter) {
    if (!scopeType || typeof adapter?.describe !== 'function') {
      console.error('[ScopeRegistry] invalid adapter for', scopeType);
      return;
    }
    _adapters.set(scopeType, adapter);
  }

  /**
   * Resolve a raw scope string into a descriptor.
   * @param {string} raw — e.g. `workbench:integration:linear`
   * @returns {Promise<object|null>}
   */
  async function resolve(raw) {
    if (!raw || !raw.startsWith('workbench:')) return null;
    const parts = raw.split(':');
    if (parts.length < 3) return null;
    const type = parts[1];
    const id = parts.slice(2).join(':');
    const adapter = _adapters.get(type);
    if (!adapter) {
      console.warn('[ScopeRegistry] no adapter for scope type:', type);
      return null;
    }
    try {
      const descriptor = await adapter.describe(id);
      if (!descriptor) return null;
      // Normalize — ensure every descriptor has these invariants
      descriptor.scopeType = type;
      descriptor.scopeId = id;
      descriptor.raw = raw;
      descriptor.toolRail = descriptor.toolRail || [];
      return descriptor;
    } catch (err) {
      console.error('[ScopeRegistry] adapter error for', raw, err);
      return null;
    }
  }

  function listTypes() {
    return [..._adapters.keys()];
  }

  return { register, resolve, listTypes };
})();

window.ScopeRegistry = ScopeRegistry;
