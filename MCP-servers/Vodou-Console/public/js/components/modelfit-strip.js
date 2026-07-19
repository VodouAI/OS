/**
 * ModelFitStrip — shared hardware-aware local-model recommendation strip.
 *
 * Backed by GET /api/system/model-fit (llmfit). Used by the Settings model
 * panel (Ollama card) and onboarding local panel today; the LM Studio and
 * "Vodou Local" cards (local-runtimes plan) will consume the `mlx`/`gguf`
 * buckets next.
 *
 * Contract: NEVER intrusive. If the endpoint reports { available: false } or
 * the chosen bucket is empty, mount() clears its host and the caller's static
 * text/fallback list stands. It never throws and never blocks its caller.
 *
 * Usage:
 *   ModelFitStrip.mount('modelfit-ollama', {
 *     bucket: 'ollama',                 // 'ollama' | 'mlx' | 'gguf'
 *     current: data.ollama_model,       // highlight the active pick
 *     onSelect: (ref, model) => {...},  // ref = ollama_name, or "repo:quant" for mlx/gguf
 *   });
 */
window.ModelFitStrip = (function () {
  let _cache = null; // Promise<payload> — one fetch shared across onboarding + settings

  function fetchFit() {
    if (!_cache) {
      _cache = fetch('/api/system/model-fit')
        .then((r) => r.json())
        .catch(() => ({ available: false }));
    }
    return _cache;
  }

  /** Force a re-fetch (e.g. after the user pulls a model in Ollama). */
  function invalidate() {
    _cache = null;
  }

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  function esc(s) { return window.VodouSafe.escapeHtml(s); }

  function fitClass(level) {
    const l = String(level || '').toLowerCase();
    if (l === 'perfect') return 'mf-fit-perfect';
    if (l === 'good') return 'mf-fit-good';
    if (l === 'tight' || l === 'marginal') return 'mf-fit-tight';
    return 'mf-fit-other';
  }

  function hardwareLine(sys) {
    if (!sys) return '';
    const parts = [];
    if (sys.cpu_name) parts.push(esc(sys.cpu_name));
    if (sys.total_ram_gb != null) {
      const mem = Math.round(sys.total_ram_gb) + ' GB' + (sys.unified_memory ? ' unified' : '');
      parts.push(mem);
    }
    if (sys.backend) parts.push(esc(sys.backend));
    return parts.join(' · ');
  }

  // Selectable value + display fields differ per bucket.
  function modelRef(m, bucket) {
    if (bucket === 'ollama') return m.ollama_name || '';
    // mlx/gguf → llama.cpp `-hf <repo>:<quant>` style ref
    return m.quant ? `${m.name}:${m.quant}` : m.name;
  }

  function modelLabel(m, bucket) {
    if (bucket === 'ollama') return m.ollama_name || m.name;
    return m.name;
  }

  function modelRow(m, bucket, current) {
    const ref = modelRef(m, bucket);
    const selected = current && ref && current === ref ? ' selected' : '';
    const fit = m.fit_level ? `<span class="mf-badge ${fitClass(m.fit_level)}">${esc(m.fit_level)}</span>` : '';
    const tps = m.estimated_tps != null ? `<span class="mf-meta">~${Math.round(m.estimated_tps)} tok/s est.</span>` : '';
    const size = m.disk_size_gb != null ? `<span class="mf-meta">${m.disk_size_gb.toFixed(1)} GB</span>` : '';
    const installed = m.installed ? `<span class="mf-installed" title="Already installed">✓ installed</span>` : '';
    return `
      <button type="button" class="mf-row${selected}" data-mf-select="${esc(ref)}" title="Use ${esc(modelLabel(m, bucket))}">
        <span class="mf-name">${esc(modelLabel(m, bucket))}</span>
        <span class="mf-tags">${fit}${size}${tps}${installed}</span>
      </button>`;
  }

  async function mount(hostId, opts) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const { bucket = 'ollama', onSelect, current } = opts || {};
    let fit;
    try {
      fit = await fetchFit();
    } catch {
      host.innerHTML = '';
      return;
    }
    if (!fit || !fit.available) {
      host.innerHTML = ''; // static fallback in the caller stands
      return;
    }
    const models =
      bucket === 'ollama'
        ? fit.ollama_models || []
        : (fit.other_models || {})[bucket] || [];
    if (!models.length) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = `
      <div class="modelfit">
        <div class="modelfit-hw">${hardwareLine(fit.system)}</div>
        <div class="modelfit-rows">${models.map((m) => modelRow(m, bucket, current)).join('')}</div>
        <div class="modelfit-note">Matched to your hardware · speeds are estimates</div>
      </div>`;
    host.querySelectorAll('[data-mf-select]').forEach((el) => {
      el.addEventListener('click', () => {
        host.querySelectorAll('[data-mf-select]').forEach((x) => x.classList.remove('selected'));
        el.classList.add('selected');
        const ref = el.getAttribute('data-mf-select');
        if (typeof onSelect === 'function') onSelect(ref, el);
      });
    });
  }

  return { mount, fetchFit, invalidate };
})();
