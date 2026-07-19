/**
 * Cards framework — per-type frontend renderers.
 *
 * Each renderer takes (renderModel, ctx) and returns either:
 *   { title, body }  — title goes in the shell header; body is HTMLElement or html string
 *   or just an HTMLElement/string (no custom title)
 *
 * Renderers are PURE: no fetches, no async work, no state. The shell
 * handles loading state, errors, consent, refresh.
 */
(function () {
  'use strict';
  const esc = (window.LensShell && window.LensShell.esc)
    || (window.VodouSafe && window.VodouSafe.escapeHtml)
    || ((s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])));

  // -------------------- debug.echo --------------------
  function renderDebugEcho(model) {
    const div = document.createElement('pre');
    div.className = 'vodou-lens-debug';
    div.textContent = JSON.stringify(model, null, 2);
    // Shell already adds the manifest icon next to the title — don't duplicate.
    return { title: 'debug.echo', body: div };
  }

  // -------------------- recipe.allrecipes --------------------
  function renderRecipe(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-recipe';
    div.innerHTML = `
      ${model.image ? `<div class="vodou-recipe-hero"><img src="${esc(model.image)}" alt="${esc(model.title)}" loading="lazy"></div>` : ''}
      <div class="vodou-recipe-meta">
        ${model.total_time ? `<span class="vodou-pill">⏱ ${esc(model.total_time)}</span>` : ''}
        ${model.servings ? `<span class="vodou-pill">🍽 ${esc(model.servings)}</span>` : ''}
      </div>
      <h4>Ingredients</h4>
      <ul class="vodou-recipe-ingredients">
        ${(model.ingredients || []).map(i => `<li>${esc(i)}</li>`).join('')}
      </ul>
      <h4>Steps</h4>
      <ol class="vodou-recipe-steps">
        ${(model.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}
      </ol>
    `;
    return { title: model.title || 'Recipe', body: div };
  }

  // -------------------- image.preview --------------------
  function renderImage(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-image';
    const dims = (model.width && model.height) ? ` (${model.width}×${model.height})` : '';
    div.innerHTML = `
      <img src="${esc(model.url)}" alt="${esc(model.alt || 'image')}" loading="lazy"
           onclick="ChatView && ChatView._openLightbox && ChatView._openLightbox(this.src)">
      ${model.caption ? `<div class="vodou-image-caption">${esc(model.caption)}${dims}</div>` : ''}
    `;
    return { title: `Image${dims}`, body: div };
  }

  // -------------------- map.directions --------------------
  function renderMap(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-map';
    div.innerHTML = `
      <iframe src="${esc(model.embed_url)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups"
              referrerpolicy="no-referrer-when-downgrade"
              style="width:100%; min-height:280px; border:0; border-radius:8px;"></iframe>
      <div class="vodou-map-route">
        <span>${esc(model.origin)}</span>
        <span class="vodou-map-arrow">→</span>
        <span>${esc(model.destination)}</span>
        <span class="vodou-pill vodou-pill-sm">${esc(model.mode)}</span>
      </div>
    `;
    return { title: 'Directions', body: div };
  }

  // -------------------- github.pr --------------------
  function renderGithubPR(model, ctx) {
    const stateClass =
      model.merged ? 'merged' :
      model.state === 'closed' ? 'closed' :
      model.draft ? 'draft' : 'open';
    const stateLabel =
      model.merged ? 'Merged' :
      model.state === 'closed' ? 'Closed' :
      model.draft ? 'Draft' : 'Open';

    const div = document.createElement('div');
    div.className = 'vodou-lens-pr';
    div.innerHTML = `
      <div class="vodou-pr-headline">
        <span class="vodou-pr-state vodou-pr-state-${stateClass}">${stateLabel}</span>
        ${model.author_avatar ? `<img class="vodou-pr-avatar" src="${esc(model.author_avatar)}" alt="${esc(model.author)}">` : ''}
        <span class="vodou-pr-author">${esc(model.author)}</span>
        <span class="vodou-pr-repo">${esc(model.repo)} #${esc(model.number)}</span>
      </div>
      <div class="vodou-pr-stats">
        <span class="vodou-pill vodou-pill-green">+${esc(model.additions || 0)}</span>
        <span class="vodou-pill vodou-pill-red">−${esc(model.deletions || 0)}</span>
        ${model.changed_files ? `<span class="vodou-pill">${esc(model.changed_files)} files</span>` : ''}
        ${model.comments ? `<span class="vodou-pill">💬 ${esc(model.comments)}</span>` : ''}
        ${model.source === 'cheerio' ? `<span class="vodou-pill vodou-pill-warning" title="Limited data — install Vodou Bridge for full session access">public only</span>` : ''}
      </div>
      ${(model.top_reviews && model.top_reviews.length) ? `
        <div class="vodou-pr-reviews">
          <strong>Recent reviews:</strong>
          ${model.top_reviews.map(r => `
            <div class="vodou-pr-review">
              <span class="vodou-pr-review-state">${esc(r.state || '')}</span>
              <span class="vodou-pr-review-author">${esc(r.author)}</span>
              <span class="vodou-pr-review-body">${esc(r.body)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="vodou-pr-actions">
        <button class="vodou-btn vodou-btn-primary" data-action="approve" ${model.state !== 'open' ? 'disabled' : ''}>✓ Approve</button>
        <button class="vodou-btn vodou-btn-secondary" data-action="request_changes" ${model.state !== 'open' ? 'disabled' : ''}>✗ Request changes</button>
      </div>
    `;

    div.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const actionId = btn.getAttribute('data-action');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = '...';
        try {
          // First attempt — server tells us if consent is needed
          let res = await ctx.runAction(actionId, {});
          if (!res.ok && res.error?.code === 'CONSENT_REQUIRED') {
            const consent = await window.LensShell.confirmConsent({
              cardLabel: 'github.pr',
              actionLabel: res.error.detail?.label || actionId,
              domain: res.error.detail?.domain || 'github.com',
            });
            if (!consent) {
              btn.disabled = false;
              btn.textContent = originalText;
              return;
            }
            res = await ctx.runAction(actionId, { consent_granted: true });
          }
          if (res.ok) {
            btn.textContent = '✓ ' + (res.data?.message || 'done');
            btn.classList.add('vodou-btn-success');
          } else {
            btn.disabled = false;
            btn.textContent = originalText;
            alert(res.error?.message || 'Action failed');
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = originalText;
          alert(err?.message || 'Action failed');
        }
      });
    });

    return { title: model.title || 'Pull Request', body: div };
  }

  // -------------------- _default (generic fallback) --------------------
  function renderDefault(model) {
    const div = document.createElement('pre');
    div.className = 'vodou-lens-default';
    div.textContent = JSON.stringify(model, null, 2);
    return { body: div };
  }

  // -------------------- wikipedia.article --------------------
  function renderWikipedia(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-wiki';
    div.innerHTML = `
      ${model.thumbnail_url ? `<img class="vodou-wiki-thumb" src="${esc(model.thumbnail_url)}" alt="${esc(model.title)}" loading="lazy">` : ''}
      ${model.description ? `<p class="vodou-wiki-desc">${esc(model.description)}</p>` : ''}
      <p class="vodou-wiki-extract">${esc(model.extract || '')}</p>
    `;
    return { title: model.title || 'Wikipedia', body: div };
  }

  // -------------------- youtube.video --------------------
  function renderYoutube(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-yt';
    div.innerHTML = `
      <div class="vodou-yt-frame-wrap">
        <iframe src="${esc(model.embed_url)}" loading="lazy"
                sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
                allowfullscreen
                referrerpolicy="no-referrer-when-downgrade"
                style="width:100%; aspect-ratio:16/9; border:0; border-radius:6px;"></iframe>
      </div>
      ${model.author ? `<div class="vodou-yt-author">by ${esc(model.author)}</div>` : ''}
    `;
    return { title: model.title || 'YouTube', body: div };
  }

  // -------------------- hackernews.item --------------------
  function renderHN(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-hn';
    div.innerHTML = `
      <div class="vodou-hn-meta">
        <span class="vodou-pill">▲ ${esc(model.score || 0)}</span>
        <span class="vodou-pill">💬 ${esc(model.comment_count || 0)}</span>
        <span class="vodou-pill">by ${esc(model.author || '')}</span>
        ${model.url ? `<a href="${esc(model.url)}" target="_blank" rel="noopener" class="vodou-pill">link ↗</a>` : ''}
      </div>
      ${(model.top_comments && model.top_comments.length) ? `
        <div class="vodou-hn-comments">
          ${model.top_comments.map(c => `
            <div class="vodou-hn-comment">
              <span class="vodou-hn-cby">${esc(c.by)}:</span>
              <span class="vodou-hn-ctext">${esc(c.text)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
    return { title: model.title || 'HN', body: div };
  }

  // -------------------- arxiv.paper --------------------
  function renderArxiv(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-arxiv';
    div.innerHTML = `
      <div class="vodou-arxiv-meta">
        <span class="vodou-pill">${esc(model.primary_category || 'arXiv')}</span>
        ${model.published ? `<span class="vodou-pill">${esc(String(model.published).slice(0, 10))}</span>` : ''}
        ${model.pdf_url ? `<a href="${esc(model.pdf_url)}" target="_blank" rel="noopener" class="vodou-pill">PDF ↗</a>` : ''}
      </div>
      <p class="vodou-arxiv-authors">${(model.authors || []).slice(0, 6).map(esc).join(', ')}${model.authors && model.authors.length > 6 ? ' et al.' : ''}</p>
      <p class="vodou-arxiv-abstract">${esc(model.abstract || '')}</p>
    `;
    return { title: model.title || 'arXiv paper', body: div };
  }

  // -------------------- npm.package --------------------
  function renderNpmPackage(model) {
    const fmtCount = (n) => {
      if (n == null) return null;
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
      return String(n);
    };
    const div = document.createElement('div');
    div.className = 'vodou-lens-npm';
    const dl = fmtCount(model.weekly_downloads);
    const repoLabel = (model.repository || '').replace(/^https?:\/\/(www\.)?/, '');
    div.innerHTML = `
      <div class="vodou-pr-stats" style="margin-bottom:8px;">
        <span class="vodou-pill">v${esc(model.version)}</span>
        <span class="vodou-pill">${esc(model.license || 'UNKNOWN')}</span>
        ${model.author ? `<span class="vodou-pill">by ${esc(model.author)}</span>` : ''}
        ${dl ? `<span class="vodou-pill vodou-pill-green">⬇ ${esc(dl)}/wk</span>` : ''}
        ${typeof model.dependency_count === 'number' ? `<span class="vodou-pill">${esc(model.dependency_count)} deps</span>` : ''}
      </div>
      ${model.description ? `<p class="vodou-snippet-text" style="margin:8px 0;">${esc(model.description)}</p>` : ''}
      ${(model.keywords && model.keywords.length) ? `
        <div class="vodou-pr-stats" style="margin-top:8px;">
          ${model.keywords.slice(0, 8).map(k => `<span class="vodou-pill">#${esc(k)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="vodou-pr-stats" style="margin-top:10px;">
        ${model.homepage ? `<a href="${esc(model.homepage)}" target="_blank" rel="noopener" class="vodou-pill">homepage ↗</a>` : ''}
        ${repoLabel ? `<a href="${esc(model.repository)}" target="_blank" rel="noopener" class="vodou-pill">${esc(repoLabel)} ↗</a>` : ''}
        <a href="https://www.npmjs.com/package/${esc(model.name)}" target="_blank" rel="noopener" class="vodou-pill">npm ↗</a>
      </div>
    `;
    return { title: model.name || 'npm package', body: div };
  }

  // -------------------- gmail.unread --------------------
  function renderGmailUnread(model) {
    const messages = Array.isArray(model.messages) ? model.messages : [];
    const div = document.createElement('div');
    div.className = 'vodou-lens-gmail';
    if (messages.length === 0) {
      div.innerHTML = `<p class="vodou-snippet-text">No unread messages found in your inbox.</p>`;
      return { title: 'Gmail inbox', body: div };
    }
    // Default inbox URL when a row didn't carry a thread URL (older Gmail
    // variants, or the extractor missed it). Clicking still does *something*
    // useful — opens Gmail at the inbox where they can find it.
    const inboxUrl = 'https://mail.google.com/mail/u/0/#inbox';
    const rows = messages.map((m, i) => {
      const sender = esc(m.sender || '(unknown)');
      const subject = esc(m.subject || '(no subject)');
      const snippet = esc(m.snippet || '');
      const time = esc(m.time || '');
      const href = esc(m.thread_url || inboxUrl);
      const borderRule = i < messages.length - 1 ? 'border-bottom:1px solid var(--border-subtle,#eee);' : '';
      return `
        <div class="vodou-gmail-row" data-href="${href}" role="link" tabindex="0"
             style="display:flex;gap:10px;padding:8px;${borderRule}border-radius:6px;cursor:pointer;transition:background .15s;"
             onmouseover="this.style.background='var(--bg-hover,#f5f5f5)'"
             onmouseout="this.style.background='transparent'">
          <div style="flex:0 0 30%;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${sender}</div>
          <div style="flex:1;min-width:0;">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${subject}</div>
            ${snippet ? `<div style="color:var(--text-muted,#888);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">${snippet}</div>` : ''}
          </div>
          <div style="flex:0 0 auto;color:var(--text-muted,#888);font-size:11px;white-space:nowrap;align-self:flex-start;">${time}</div>
        </div>
      `;
    }).join('');
    const cacheNote = model._source === 'cache'
      ? `<div style="font-size:11px;color:var(--text-muted,#888);margin-top:8px;">Served from cache · ${Math.round((model._cache_age_ms || 0) / 1000)}s ago</div>`
      : '';
    div.innerHTML = `
      <div style="font-size:13px;color:var(--text-muted,#888);margin-bottom:6px;">${esc(model.count || messages.length)} unread</div>
      ${rows}
      ${cacheNote}
    `;
    // Click handler — POST to /api/lenses/action so the gateway tells the
    // Bridge to navigate the existing Gmail tab in place. Falls back to a
    // window.open (new tab) if the Bridge call fails.
    div.addEventListener('click', async (e) => {
      const row = e.target.closest('.vodou-gmail-row');
      if (!row) return;
      const url = row.getAttribute('data-href');
      if (!url) return;
      try {
        const r = await fetch('/api/lenses/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'gmail.unread',
            action_id: 'open_thread',
            source_url: url,
            payload: { url },
            consent_granted: true,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) throw new Error(j.error?.message || 'action failed');
      } catch (err) {
        // Fallback: just open a new tab.
        window.open(url, '_blank', 'noopener');
      }
    });
    return { title: 'Gmail · unread', body: div };
  }

  // -------------------- snippet.url --------------------
  function renderSnippet(model) {
    const div = document.createElement('div');
    div.className = 'vodou-lens-snippet';
    div.innerHTML = `
      ${model.image ? `<img class="vodou-snippet-hero" src="${esc(model.image)}" alt="${esc(model.title)}" loading="lazy">` : ''}
      <p class="vodou-snippet-text">${esc(model.snippet || model.description || '')}</p>
      <p class="vodou-snippet-domain">${esc(model.domain || '')}</p>
    `;
    return { title: model.title || 'Page', body: div };
  }

  window.LensRenderers = {
    'debug.echo': renderDebugEcho,
    'recipe.allrecipes': renderRecipe,
    'image.preview': renderImage,
    'map.directions': renderMap,
    'github.pr': renderGithubPR,
    'wikipedia.article': renderWikipedia,
    'youtube.video': renderYoutube,
    'hackernews.item': renderHN,
    'arxiv.paper': renderArxiv,
    'npm.package': renderNpmPackage,
    'gmail.unread': renderGmailUnread,
    'snippet.url': renderSnippet,
    '_default': renderDefault,
  };
})();
