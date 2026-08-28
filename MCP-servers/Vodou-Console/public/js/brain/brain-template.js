// GENERATED from the brain console markup — PLAN-BRAIN-INTO-CONSOLE P1.1/P1.2.
// Every id carries a `b-` prefix so the graph can live on a page that already
// has a #timeline, #graph, #reading, #tooltip or #searchBtn. app.js resolves
// ids through `$()` with the same prefix, so its call sites are unchanged.
// Canonical copy: MCP-servers/Vodou-Console/public/js/brain/brain-template.js
// (the standalone brain console receives a build copy via vendor-assets.mjs).
globalThis.VodouBrainTemplate = String.raw`
  <header class="hdr">
    <div class="brand">
      <span class="veve" aria-hidden="true">✦</span>
      <h1>Brain</h1>
      <span class="brand-sub">everything Vodou remembers</span>
    </div>
    <button id="b-searchBtn" class="searchbox" type="button">
      <span>Find a memory…</span><kbd>⌘K</kbd>
    </button>
    <div class="hdr-stats" id="b-hdrStats" aria-live="polite"></div>
    <div class="hdr-actions">
      <button id="b-conflictsBtn" class="ghost-btn" type="button">Conflicts <span id="b-conflictBadge" class="badge" hidden></span></button>
      <button id="b-themeBtn" class="ghost-btn" type="button" aria-label="Toggle light/dark theme">☾</button>
    </div>
  </header>

  <main class="frame">
    <aside class="rail rail-left" aria-label="Vaults and filters">
      <section class="rail-sec">
        <h2 class="rail-h">Vaults</h2>
        <p class="rail-hint">Where each memory came from. Trust shapes how brightly it ranks — and how brightly it glows here.</p>
        <div id="b-vaults"></div>
      </section>
      <section class="rail-sec">
        <h2 class="rail-h">Share vaults</h2>
        <p class="rail-hint">Named slices of memory you can hand to someone — the family vault, not the bank vault.</p>
        <div id="b-shareVaults"></div>
        <button id="b-vaultNewBtn" class="ghost-btn vault-new" type="button">＋ New share vault</button>
      </section>
      <section class="rail-sec" id="b-kindSec" hidden>
        <h2 class="rail-h">Who &amp; what</h2>
        <p class="rail-hint">What each name actually is. Junk — capitalized phrases the extractor mistook for names — is hidden until you ask for it.</p>
        <div id="b-kindChips" class="chip-row"></div>
      </section>
      <section class="rail-sec">
        <h2 class="rail-h">Kinds</h2>
        <div id="b-tagChips" class="chip-row"></div>
      </section>
      <section class="rail-sec">
        <h2 class="rail-h">When</h2>
        <div id="b-whenRow" class="when-row" role="radiogroup" aria-label="Recency filter">
          <button class="when-btn active" data-days="0" type="button">All time</button>
          <button class="when-btn" data-days="90" type="button">90d</button>
          <button class="when-btn" data-days="30" type="button">30d</button>
          <button class="when-btn" data-days="7" type="button">7d</button>
        </div>
      </section>
      <section class="rail-sec">
        <h2 class="rail-h">Scope</h2>
        <select id="b-projectSel" class="rail-select" aria-label="Project filter" hidden></select>
        <select id="b-hostSel" class="rail-select" aria-label="Site filter — where a memory came from" title="Where a memory came from (the page axis)" hidden></select>
        <label class="rail-check"><input type="checkbox" id="b-archivedChk"> Include archived history</label>
        <label class="rail-check" title="Overlay embedding-similarity edges — connects memories by meaning (incl. imports the citation graph misses)"><input type="checkbox" id="b-similarChk"> Show similarity edges</label>
      </section>
      <section class="rail-sec rail-legend">
        <h2 class="rail-h">Legend</h2>
        <div class="legend-row"><span class="lg lg-entity">✦</span> person / org / handle</div>
        <div class="legend-row"><span class="lg lg-file">●</span> memory file</div>
        <div class="legend-row"><span class="lg lg-doc">▪</span> cited plan / doc</div>
        <div class="legend-row"><span class="lg lg-conflict">〰</span> conflict</div>
        <div class="legend-row"><span class="lg lg-similar">┄</span> similarity — by meaning (opt-in)</div>
        <div class="legend-row"><span class="lg lg-entity">━</span> named together (Web) — thicker = more often</div>
        <div class="legend-row"><span class="lg lg-entity">→</span> a named relation — founded, signed, works at…</div>
        <div class="legend-row lg-dim">dimmer = imported, brighter = yours</div>
      </section>
    </aside>

    <section class="canvas-wrap">
      <div class="canvas-top">
        <div class="seg" role="tablist" aria-label="Graph layout">
          <button id="b-segLatest" class="seg-btn" type="button" role="tab" aria-selected="false" title="Zoom into the newest memory and everything it touches">◉ Latest</button>
          <button id="b-segConstellation" class="seg-btn active" type="button" role="tab" aria-selected="true">✦ Constellation</button>
          <button id="b-segWeb" class="seg-btn" type="button" role="tab" aria-selected="false">✧ Web of names</button>
          <button id="b-segChronicle" class="seg-btn" type="button" role="tab" aria-selected="false">≡ Chronicle</button>
        </div>
        <div class="crumb" id="b-crumb"></div>
      </div>
      <div id="b-vaultPreviewBar" class="vault-preview-bar" hidden>
        <span id="b-vaultPreviewText"></span>
        <button id="b-vaultPreviewExport" class="ghost-btn" type="button">⇪ Export this vault</button>
        <button id="b-vaultPreviewClear" class="ghost-btn" type="button">✕ Clear preview</button>
      </div>
      <svg id="b-graph" role="img" aria-label="Memory constellation graph"></svg>
      <div class="canvas-controls">
        <button id="b-fitBtn" class="ghost-btn" type="button" title="Fit graph">⌖ Fit</button>
        <div id="b-webCtl" class="web-ctl" hidden>
          <label class="web-ctl-label" for="b-webBySel">linked when</label>
          <select id="b-webBySel" class="rail-select" title="How close two names must be to count as connected">
            <option value="chunk">in the very same memory</option>
            <option value="file">in the same memory file</option>
          </select>
          <label class="web-ctl-label" for="b-webMinSel">only links of</label>
          <select id="b-webMinSel" class="rail-select" title="Hide links weaker than this many shared memories">
            <option value="1">1+ shared memory</option>
            <option value="2">2+ shared</option>
            <option value="3">3+ shared</option>
            <option value="5">5+ shared</option>
          </select>
          <button id="b-webDepthBtn" class="ghost-btn" type="button" title="One hop: who this name appears with. Two hops: and who *those* appear with.">◎ One hop</button>
        </div>
        <div id="b-latestCtl" class="web-ctl" hidden>
          <span class="ring-key"><i class="rk rk-0"></i>the memory</span>
          <span class="ring-key"><i class="rk rk-1"></i>connected</span>
          <span class="ring-key"><i class="rk rk-2"></i>one hop out</span>
          <span class="ring-key"><i class="rk rk-3"></i>the rest of the sky</span>
          <button id="b-latestLiveBtn" class="ghost-btn live-btn on" type="button" title="Follow new memories as they land — the sky dissolves to the newest one">● Live</button>
          <button id="b-latestNewestBtn" class="ghost-btn" type="button" title="Back to the newest memory Vodou saved" hidden>↺ Newest</button>
        </div>
        <button id="b-orderBtn" class="ghost-btn" type="button" title="Flip chronicle date order" hidden>↓ Newest first</button>
        <button id="b-overviewBtn" class="ghost-btn" type="button" title="Back to full graph" hidden>← Back to all</button>
      </div>
      <div id="b-tooltip" class="tooltip" hidden></div>
      <div id="b-emptyState" class="empty-state" hidden>
        <p>Nothing matches these filters.</p>
        <p class="empty-sub">Re-enable a vault or widen the time window.</p>
      </div>
    </section>

    <aside class="rail rail-right" id="b-railRight" aria-label="Reading pane">
      <button id="b-readingClose" class="ghost-btn reading-close" type="button" aria-label="Close reading pane">✕</button>
      <div class="reading-empty" id="b-readingEmpty">
        <span class="veve big" aria-hidden="true">✦</span>
        <p>Click any point of light to read the memory behind it.</p>
        <p class="empty-sub">Double-click to focus its neighborhood.</p>
      </div>
      <div id="b-reading" hidden></div>
    </aside>
  </main>

  <footer class="timeline-wrap" aria-label="Memory timeline">
    <svg id="b-timeline"></svg>
  </footer>

  <div id="b-switcher" class="modal-backdrop" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Find a memory">
      <input id="b-switcherInput" type="text" placeholder="Search everything Vodou remembers…" autocomplete="off" spellcheck="false">
      <div id="b-switcherResults" class="switcher-results"></div>
      <div class="switcher-foot"><kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close</div>
    </div>
  </div>

  <div id="b-vaultEditor" class="overlay" hidden>
    <div class="overlay-inner vault-editor">
      <div class="overlay-head">
        <h2 id="b-vaultEditorTitle">New share vault</h2>
        <p class="rail-hint">A vault is a live rule — memory that matches stays in as your brain grows. Preview before you ever export; nothing leaves this machine until you do.</p>
        <button id="b-vaultEditorClose" class="ghost-btn" type="button">✕ Close</button>
      </div>
      <div class="vault-form">
        <label class="vf-label">Name
          <input id="b-vfName" type="text" placeholder="e.g. Work, Family, Vodou-public" maxlength="60" autocomplete="off">
        </label>
        <div class="vf-label">Sources (scope prefixes — none = all)
          <div id="b-vfScopes" class="chip-row"></div>
        </div>
        <div class="vf-label">Kinds (tags — none = all)
          <div id="b-vfTags" class="chip-row"></div>
        </div>
        <div class="vf-row">
          <label class="vf-label">Only the last
            <select id="b-vfSince" class="rail-select">
              <option value="">all time</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">year</option>
            </select>
          </label>
          <label class="rail-check"><input type="checkbox" id="b-vfImports"> Include imported memory</label>
        </div>
        <div id="b-vfError" class="vf-error" hidden></div>
        <div class="vf-actions">
          <button id="b-vfSave" class="ghost-btn vf-save" type="button">Save vault</button>
        </div>
      </div>
    </div>
  </div>

  <div id="b-conflictsPanel" class="overlay" hidden>
    <div class="overlay-inner">
      <div class="overlay-head">
        <h2>Conflicts</h2>
        <p class="rail-hint">Places where one source of your memory disagrees with another. Keep one side or mark it not a conflict — the other side is superseded (reversible; same-value copies resolve together).</p>
        <button id="b-conflictsClose" class="ghost-btn" type="button">✕ Close</button>
      </div>
      <div id="b-conflictsList"></div>
    </div>
  </div>
`;
