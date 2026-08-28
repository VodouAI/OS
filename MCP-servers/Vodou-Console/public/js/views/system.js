/**
 * System View — version, stats, health overview (+ home dashboard sections)
 */

const SystemView = {
  destroy() {
    if (typeof HomeView !== 'undefined' && typeof HomeView.destroy === 'function') {
      HomeView.destroy();
    }
  },

  async render(container) {
    container.appendChild(Components.pageHeader('System', 'Vodou overview and stats'));
    container.appendChild(Components.loading());

    try {
      const [data, logsData] = await Promise.all([
        API.get('/api/system'),
        API.get('/api/logs?limit=200').catch(() => ({ logs: [] })),
      ]);
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('System', 'Vodou overview and stats'));

      // Kernel / runtime — daemon, worker, memory path (PLAN-RUNTIME-OBSERVABILITY)
      const runtimeSection = this._renderRuntimeSection(data.runtime);
      container.appendChild(runtimeSection);

      // Updates — above embedded Home dashboard
      const updatesSectionTop = this._renderUpdatesSection(data);
      container.appendChild(updatesSectionTop);

      // PLAN-SELF-HEALING-MEMORY — Memory brain upgrade + health scorecard
      container.appendChild(this._renderMemoryBrainSection(data));

      // PLAN-VODOU-QA — platform QA gets its own section: score, step table,
      // failure tails. Previously one text line inside the memory card, which
      // is exactly where it got scrolled past.
      container.appendChild(this._renderQaSection(data));

      // Note: "Memory Extraction Sources" UI moved to Settings → Memory tab
      // (`/#/settings?tab=memory`). System page is for diagnostics + version
      // + updates, not user preferences.

      if (typeof HomeView !== 'undefined' && HomeView.renderDashboardInto) {
        await HomeView.renderDashboardInto(container, { sysData: data, logsData, embedded: true });
        HomeView._startPolling();
      }

      const diagTitle = document.createElement('h3');
      diagTitle.className = 'section-title';
      diagTitle.classList.add('mt-7');
      diagTitle.textContent = 'Diagnostics';
      container.appendChild(diagTitle);

      // Doctor — run the full scripts/vodou-doctor.sh audit from the web console.
      container.appendChild(this._renderDoctorSection());

      // Info cards grid
      const grid = document.createElement('div');
      grid.className = 'card-grid';

      // Version card
      grid.appendChild(this.infoCard('Version', data.version, 'accent'));
      grid.appendChild(this.infoCard('Auth Mode', data.authMode, 'default'));
      grid.appendChild(this.infoCard('Uptime', this.formatUptime(data.uptime), 'default'));
      grid.appendChild(this.infoCard('Model', data.gateway?.model || 'unknown', 'default'));
      container.appendChild(grid);

      // Counts section
      const countsHeader = document.createElement('h3');
      countsHeader.className = 'section-title';
      countsHeader.textContent = 'Database';
      container.appendChild(countsHeader);

      const countsGrid = document.createElement('div');
      countsGrid.className = 'card-grid';

      const labels = {
        mcp_servers: 'MCP Servers',
        tools: 'Tools',
        intent_mappings: 'Intents',
        skills_registry: 'Skills',
        scheduled_tasks: 'Schedules',
        script_registry: 'Scripts',
        work_logs: 'Work Logs',
        parameter_rules: 'Param Rules',
        conversation_sessions: 'Sessions',
        memory_chunks: 'Memory Chunks',
      };

      for (const [key, label] of Object.entries(labels)) {
        if (data.counts[key] !== undefined) {
          countsGrid.appendChild(this.infoCard(label, String(data.counts[key]), 'default'));
        }
      }
      container.appendChild(countsGrid);

      // Update sidebar version
      const versionLabel = document.getElementById('version-label');
      if (versionLabel) versionLabel.textContent = data.version;

      // Updates section was rendered at the top — no duplicate here.

      // Server Health Grid
      try {
        const rawServers = await API.get('/api/servers');
        const servers = Array.isArray(rawServers) ? rawServers : (rawServers.servers || []);

        const healthHeader = document.createElement('h3');
        healthHeader.className = 'section-title';
        healthHeader.textContent = 'Server Health';
        container.appendChild(healthHeader);

        const healthGrid = document.createElement('div');
        healthGrid.className = 'card-grid';

        for (const srv of servers) {
          const card = document.createElement('div');
          card.className = 'info-card';
          card.classList.add('system-health-card');

          const dot = Components.statusDot(srv.health_status === 'healthy' || srv.active);
          card.appendChild(dot);

          const info = document.createElement('div');
          info.classList.add('system-health-info');

          const name = document.createElement('div');
          name.classList.add('system-health-name');
          name.textContent = srv.name;
          info.appendChild(name);

          const meta = document.createElement('div');
          meta.classList.add('system-health-meta');
          meta.textContent = `${srv.tool_count} tools · ${srv.intent_count} intents`;
          info.appendChild(meta);

          card.appendChild(info);

          const statusText = document.createElement('span');
          statusText.className = srv.active ? 'system-health-status status-ok-text' : 'system-health-status status-error-text';
          statusText.textContent = srv.active ? 'active' : 'inactive';
          card.appendChild(statusText);

          card.addEventListener('click', () => {
            location.hash = '#/servers/' + encodeURIComponent(srv.name);
          });
          healthGrid.appendChild(card);
        }

        container.appendChild(healthGrid);
      } catch (e) {
        // Server health is non-critical, silently skip
      }

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load system info: ' + err.message));
    }
  },

  infoCard(label, value, variant) {
    const card = document.createElement('div');
    card.className = 'info-card';
    // Defense-in-depth: value is server-supplied (version/model/etc.) and lands in
    // innerHTML; all callers pass plain strings, so escaping is a safe no-op for them.
    card.innerHTML = `
      <div class="info-card-value ${variant === 'accent' ? 'accent' : ''}">${window.VodouSafe.escapeHtml(value)}</div>
      <div class="info-card-label">${window.VodouSafe.escapeHtml(label)}</div>
    `;
    return card;
  },

  formatUptime(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  },

  _renderDoctorSection() {
    const wrap = document.createElement('div');
    wrap.className = 'system-doctor-section';
    wrap.style.margin = '8px 0 18px';

    const btnRow = document.createElement('div');
    btnRow.className = 'system-btn-row';

    const quickBtn = document.createElement('button');
    quickBtn.className = 'btn btn-primary';
    quickBtn.textContent = 'Run Doctor (quick)';

    const fullBtn = document.createElement('button');
    fullBtn.className = 'btn btn-secondary';
    fullBtn.textContent = 'Run Full Doctor';

    const hint = document.createElement('span');
    hint.className = 'text-muted';
    hint.style.cssText = 'margin-left:10px;font-size:12px;align-self:center;';
    hint.textContent = 'Health audit: env, binaries, daemon, databases, gateway, MCP, memory.';

    btnRow.appendChild(quickBtn);
    btnRow.appendChild(fullBtn);
    btnRow.appendChild(hint);
    wrap.appendChild(btnRow);

    const panel = document.createElement('div');
    panel.className = 'system-doctor-panel';
    panel.style.cssText = 'margin-top:10px;';
    wrap.appendChild(panel);

    quickBtn.onclick = () => this._runDoctor(panel, quickBtn, true);
    fullBtn.onclick = () => this._runDoctor(panel, fullBtn, false);
    return wrap;
  },

  async _runDoctor(panel, btn, quick) {
    panel.innerHTML = '';
    try {
      // withInflight(btn, asyncFn, { label }) — matches the Primitive-5 signature.
      const data = await Components.withInflight(
        btn,
        () => API.get('/api/system/doctor' + (quick ? '?quick=1' : '')),
        { label: quick ? 'Running…' : 'Running full audit…' },
      );

      const escape = (s) => window.VodouSafe.escapeHtml(s);
      const okClass = data.ok ? 'status-ok-text' : 'status-error-text';
      const icon = data.ok ? '✅' : '❌';

      panel.innerHTML = `
        <div class="system-doctor-summary" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span class="${okClass} fw-600">${icon} ${escape(data.summary || (data.ok ? 'All checks green.' : 'Failures reported.'))}</span>
          <button class="btn btn-secondary system-doctor-copy" style="margin-left:auto;padding:2px 10px;font-size:12px;">Copy report</button>
        </div>
        <details class="system-doctor-details" ${data.ok ? '' : 'open'}>
          <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);user-select:none;">Show full report</summary>
          <pre class="system-doctor-report" style="margin:6px 0 0;padding:10px 12px;background:var(--bg-input);border:1px solid var(--border-primary);border-radius:4px;font-size:11px;line-height:1.5;max-height:420px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;">${escape(data.report) || '(no report output)'}</pre>
        </details>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      `;

      const copyBtn = panel.querySelector('.system-doctor-copy');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          const text = `${data.summary || ''}\n\n${data.report || ''}`.trim();
          try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = 'Copied ✓';
          } catch {
            copyBtn.textContent = 'Copy failed';
          }
          setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500);
        };
      }
    } catch (err) {
      panel.innerHTML = `<span class="status-error-text">Doctor failed: ${err.message}</span>`;
    }
  },

  _renderRuntimeSection(rt) {
    const wrap = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'section-title';
    title.textContent = 'Kernel / Runtime';
    wrap.appendChild(title);

    if (!rt || typeof rt !== 'object') {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = 'Runtime status unavailable — ensure vodou-core is built and run ./vodou-core daemon ensure.';
      wrap.appendChild(p);
      return wrap;
    }

    const overall = rt.overall || 'unknown';
    const row = document.createElement('div');
    row.className = 'runtime-overall-line';
    row.style.marginBottom = '12px';
    const dotClass = overall === 'healthy' ? 'status-ok-dot' : overall === 'degraded' ? 'status-warn-dot' : 'status-error-dot';
    row.innerHTML = `<span class="system-status-dot ${dotClass}"></span> <strong>${overall}</strong> <span class="text-muted" style="margin-left:8px">schema v${rt.schema_version ?? '?'}</span>`;
    wrap.appendChild(row);

    const grid = document.createElement('div');
    grid.className = 'card-grid';
    const c = rt.components || {};

    const daemon = c.daemon || {};
    grid.appendChild(this.infoCard('Daemon', daemon.ok ? 'OK' : 'No', daemon.ok ? 'accent' : 'default'));

    const worker = c.worker || {};
    const wLabel = worker.ok ? 'OK' : (worker.reason || 'down');
    grid.appendChild(this.infoCard('Worker', wLabel, worker.ok ? 'accent' : 'default'));

    const inj = c.memory_injection || {};
    grid.appendChild(this.infoCard('Memory inject', inj.ok ? 'OK' : 'No', inj.ok ? 'accent' : 'default'));

    const mem = c.memory_db || {};
    const memLabel = mem.chunks != null ? String(mem.chunks) + ' chunks' : '—';
    grid.appendChild(this.infoCard('memory.db', memLabel, 'default'));

    // Memory engine: ONNX semantic embeddings vs keyword/FTS-only fallback.
    const eng = c.memory_engine || {};
    const engLabel = eng.engine === 'semantic' ? 'Semantic (ONNX)' : 'Keyword (FTS)';
    const engCard = this.infoCard('Memory engine', engLabel, eng.ok ? 'accent' : 'default');
    if (eng.detail) engCard.title = eng.detail; // hover tooltip shows the reason
    grid.appendChild(engCard);

    const ge = c.gateway_extractor || {};
    const wm = ge.watermark_row_id != null ? String(ge.watermark_row_id) : '—';
    grid.appendChild(this.infoCard('Extractor WM', wm, 'default'));

    const mcp = c.mcp_summary || {};
    grid.appendChild(this.infoCard('MCP healthy', `${mcp.healthy ?? 0} / ${mcp.total_active ?? 0}`, 'default'));

    wrap.appendChild(grid);

    const hints = rt.hints;
    if (Array.isArray(hints) && hints.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'runtime-hints';
      ul.style.marginTop = '10px';
      ul.style.paddingLeft = '1.2em';
      for (const h of hints) {
        const li = document.createElement('li');
        li.textContent = typeof h === 'string' ? h : String(h);
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    return wrap;
  },

  _renderUpdatesSection(data) {
    const wrap = document.createElement('div');

    const title = document.createElement('h3');
    title.className = 'section-title';
    // No top margin: this is now the FIRST section on the System page.
    title.textContent = 'Updates';
    wrap.appendChild(title);

    const card = document.createElement('div');
    card.className = 'info-card';
    card.classList.add('system-updates-card');

    const upd = data.updateAvailable;
    const statusLine = document.createElement('div');
    statusLine.className = 'system-updates-status-line';

    if (upd) {
      statusLine.innerHTML = `
        <span class="system-status-dot status-warn-dot"></span>
        <span class="status-warn-text fw-600">${upd.is_forced ? '🔒 Security update' : 'Update'} available: ${upd.version}</span>`;
    } else {
      statusLine.innerHTML = `
        <span class="system-status-dot status-ok-dot"></span>
        <span class="status-ok-text fw-600">Up to date (${data.version})</span>`;
    }
    card.appendChild(statusLine);

    // Status message area
    const statusMsg = document.createElement('div');
    statusMsg.id = 'update-status-msg';
    statusMsg.className = 'system-status-msg';
    card.appendChild(statusMsg);

    // Binary update buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'system-btn-row';

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn btn-secondary';
    checkBtn.textContent = 'Check Now';
    checkBtn.onclick = () => this._checkUpdate(statusMsg, checkBtn);
    btnRow.appendChild(checkBtn);

    if (upd) {
      const installBtn = document.createElement('button');
      installBtn.className = 'btn btn-primary';
      installBtn.dataset.installUpdate = '1';
      installBtn.textContent = upd.is_forced ? '🔒 Install Security Update' : 'Install Update';
      installBtn.onclick = () => this._installUpdate(statusMsg, installBtn);
      btnRow.appendChild(installBtn);
    }

    const rollbackBtn = document.createElement('button');
    rollbackBtn.className = 'btn btn-secondary';
    rollbackBtn.textContent = 'Rollback';
    rollbackBtn.title = 'Restore databases + binaries from most recent backup';
    rollbackBtn.onclick = () => this._rollbackUpdate(statusMsg, rollbackBtn);
    btnRow.appendChild(rollbackBtn);

    card.appendChild(btnRow);

    // Component updates section
    const compTitle = document.createElement('div');
    compTitle.className = 'system-comp-title';
    compTitle.textContent = 'Component Updates (MCP Servers, Skills, Scripts)';
    card.appendChild(compTitle);

    const compMsg = document.createElement('div');
    compMsg.id = 'comp-status-msg';
    compMsg.className = 'system-comp-msg';
    card.appendChild(compMsg);

    const compBtnRow = document.createElement('div');
    compBtnRow.className = 'system-btn-row';

    const compCheckBtn = document.createElement('button');
    compCheckBtn.className = 'btn btn-secondary';
    compCheckBtn.textContent = 'Check Components';
    compCheckBtn.onclick = () => this._checkComponents(compMsg, compBtnRow, compCheckBtn);
    compBtnRow.appendChild(compCheckBtn);
    card.appendChild(compBtnRow);

    wrap.appendChild(card);
    return wrap;
  },

  /**
   * PLAN-VODOU-QA — Platform QA scorecard section.
   * Reads data.qaHealth from /api/system: `pct`/`tier`/`sparkline` come from
   * qa_health_history, `scorecard` is .vodou/qa/latest.json which the runner
   * rewrites on every run — so this card is current the moment a tier finishes.
   */
  _renderQaSection(data) {
    const wrap = document.createElement('div');
    const qa = data.qaHealth || {};
    const card_ = qa.scorecard || null;

    const title = document.createElement('h3');
    title.className = 'section-title';
    title.style.marginTop = '1.5rem';
    title.textContent = 'Platform QA';
    wrap.appendChild(title);

    const card = document.createElement('div');
    card.className = 'info-card system-updates-card';

    if (qa.pct == null && !card_) {
      const empty = document.createElement('div');
      empty.className = 'system-status-msg';
      empty.textContent = 'No QA run yet. Nightly fires at 03:10; run it now with scripts/qa/qa.sh fast.';
      card.appendChild(empty);
      wrap.appendChild(card);
      return wrap;
    }

    const pct = qa.pct != null ? Math.round(qa.pct) : (card_ && card_.pct != null ? Math.round(card_.pct) : null);
    const dotClass = pct == null ? 'status-warn-dot' : (pct >= 95 ? 'status-ok-dot' : (pct >= 80 ? 'status-warn-dot' : 'status-err-dot'));
    const textClass = pct == null ? 'status-warn-text' : (pct >= 95 ? 'status-ok-text' : (pct >= 80 ? 'status-warn-text' : 'status-err-text'));
    const tier = (card_ && card_.tier) || qa.tier || '—';
    const passed = card_ ? card_.passed : null;
    const failed = card_ ? card_.failed : null;
    const of = card_ ? (card_.steps_run || (card_.steps || []).length) : null;

    const statusLine = document.createElement('div');
    statusLine.className = 'system-updates-status-line';
    statusLine.innerHTML = `
      <span class="system-status-dot ${dotClass}"></span>
      <span class="${textClass} fw-600">${pct == null ? '—' : pct + '%'} — ${tier} tier${
        card_ ? ` · ${passed} passed / ${failed} failed of ${of} steps` : ''
      }</span>`;
    card.appendChild(statusLine);

    const meta = document.createElement('div');
    meta.className = 'system-status-msg';
    const when = card_ && card_.recorded_at_utc ? card_.recorded_at_utc + ' UTC' : '—';
    const dur = card_ && card_.duration_s != null ? ` · ${card_.duration_s}s` : '';
    meta.textContent = `Last run ${when}${dur}   ${qa.sparkline || ''}`;
    card.appendChild(meta);

    if (card_ && Array.isArray(card_.steps) && card_.steps.length) {
      const table = document.createElement('table');
      table.className = 'data-table';
      table.style.marginTop = '0.75rem';
      table.innerHTML = '<thead><tr><th>step</th><th>result</th><th style="text-align:right">secs</th></tr></thead>';
      const tbody = document.createElement('tbody');
      card_.steps.forEach((st) => {
        const tr = document.createElement('tr');
        const ok = st.exit === 0;
        const nameTd = document.createElement('td');
        nameTd.textContent = st.name;
        const resTd = document.createElement('td');
        resTd.className = ok ? 'status-ok-text' : 'status-err-text';
        resTd.textContent = ok ? 'ok' : `FAIL rc=${st.exit}`;
        const secTd = document.createElement('td');
        secTd.style.textAlign = 'right';
        secTd.textContent = st.seconds != null ? String(st.seconds) : '';
        tr.appendChild(nameTd); tr.appendChild(resTd); tr.appendChild(secTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);

      // Failure tails — the part you'd otherwise have to cat the log for.
      const fails = card_.steps.filter((st) => st.exit !== 0);
      fails.forEach((st) => {
        const det = document.createElement('details');
        det.style.marginTop = '0.5rem';
        const sum = document.createElement('summary');
        sum.className = 'status-err-text';
        sum.style.cursor = 'pointer';
        sum.textContent = `${st.name} (rc=${st.exit})`;
        det.appendChild(sum);
        const pre = document.createElement('pre');
        pre.className = 'code-block';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.fontSize = '0.75rem';
        pre.textContent = (st.tail || '(no output captured)') + (st.log ? `\n\n(log: ${st.log})` : '');
        det.appendChild(pre);
        card.appendChild(det);
      });
    }

    const paths = document.createElement('div');
    paths.className = 'system-status-msg';
    paths.style.marginTop = '0.75rem';
    paths.style.opacity = '0.75';
    paths.style.fontSize = '0.75rem';
    paths.textContent = qa.scorecardMdPath
      ? `Scorecard: ${qa.scorecardMdPath}`
      : (qa.scorecardPath ? `Scorecard: ${qa.scorecardPath}` : '');
    if (paths.textContent) card.appendChild(paths);

    const hint = document.createElement('div');
    hint.className = 'system-status-msg';
    hint.style.fontSize = '0.75rem';
    hint.style.opacity = '0.75';
    hint.textContent = 'Runs nightly at 03:10 (task "qa-nightly-runner"); triage skill reports at 04:15. Manual: scripts/qa/qa.sh fast|full|nightly.';
    card.appendChild(hint);

    wrap.appendChild(card);
    return wrap;
  },

  _renderMemoryBrainSection(data) {
    const wrap = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'section-title';
    title.style.marginTop = '1.5rem';
    title.textContent = 'Memory brain';
    wrap.appendChild(title);

    const card = document.createElement('div');
    card.className = 'info-card system-updates-card';

    const brain = data.memoryBrain || {};
    const health = data.memoryHealth || {};
    const tag = brain.memory_model_tag || '—';
    const statusLine = document.createElement('div');
    statusLine.className = 'system-updates-status-line';
    if (brain.upgrade_available) {
      const eta = brain.eta_minutes != null ? ` · ~${brain.eta_minutes} min` : '';
      statusLine.innerHTML = `
        <span class="system-status-dot status-warn-dot"></span>
        <span class="status-warn-text fw-600">Upgrade available — better recall for natural questions${eta} (${brain.chunks || 0} chunks)</span>`;
    } else {
      statusLine.innerHTML = `
        <span class="system-status-dot status-ok-dot"></span>
        <span class="status-ok-text fw-600">Running ${tag}</span>`;
    }
    card.appendChild(statusLine);

    const healthLine = document.createElement('div');
    healthLine.className = 'system-status-msg';
    if (health.pct != null) {
      healthLine.textContent = `Memory health: ${Math.round(health.pct)}% ${health.sparkline || ''}`;
    } else {
      healthLine.textContent = 'Memory health: no nightly score yet (runs when an LLM provider is configured).';
    }
    card.appendChild(healthLine);

    const msg = document.createElement('div');
    msg.id = 'mem-brain-status-msg';
    msg.className = 'system-status-msg';
    card.appendChild(msg);

    const btnRow = document.createElement('div');
    btnRow.className = 'system-btn-row';

    if (brain.upgrade_available) {
      const upBtn = document.createElement('button');
      upBtn.className = 'btn btn-primary';
      upBtn.textContent = 'Upgrade to bge-small';
      upBtn.onclick = () => {
        const chunks = brain.chunks || brain.minilm_chunks || 0;
        const eta = brain.eta_minutes != null ? `~${brain.eta_minutes} minutes` : 'many minutes';
        const ok = confirm(
          `Re-embed memory to bge-small?\n\n` +
          `This rewrites vector embeddings for ~${Number(chunks).toLocaleString()} chunks ` +
          `(estimate ${eta} on this machine). Keep this tab open — you can resume if interrupted.\n\n` +
          `Search quality improves for natural-language questions. Do not close the browser mid-run.`
        );
        if (!ok) return;
        this._runMemSwap('bge-small', msg, upBtn);
      };
      btnRow.appendChild(upBtn);
    }
    if (brain.can_revert) {
      const revBtn = document.createElement('button');
      revBtn.className = 'btn btn-secondary';
      revBtn.textContent = 'Revert to MiniLM';
      revBtn.onclick = () => {
        const chunks = brain.chunks || brain.bge_chunks || 0;
        if (!confirm(
          `Revert memory embeddings to MiniLM?\n\n` +
          `This re-embeds ~${Number(chunks).toLocaleString()} chunks and can take a long time. ` +
          `Recall quality for natural questions will drop. Continue?`
        )) return;
        this._runMemSwap('minilm', msg, revBtn);
      };
      btnRow.appendChild(revBtn);
    }
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = () => location.reload();
    btnRow.appendChild(refreshBtn);

    card.appendChild(btnRow);
    wrap.appendChild(card);
    return wrap;
  },

  async _runMemSwap(target, statusEl, btn) {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Migrating…';
    statusEl.textContent = 'Re-embedding in progress — keep this tab open. You can Resume if interrupted.';
    try {
      let done = false;
      let rounds = 0;
      while (!done && rounds < 40) {
        rounds += 1;
        const data = await API.post('/api/system/mem-swap', { target, max_batches: 40 });
        statusEl.textContent = `Migrated ${data.chunks_migrated || 0} chunks + ${data.keys_migrated || 0} keys · remaining ${data.remaining ?? '?'}`;
        done = !!data.done;
        if (!done) {
          statusEl.textContent += ' — continuing…';
        }
      }
      if (done) {
        statusEl.innerHTML = '<span class="status-ok-text">Done. Restart daemon/worker recommended so all processes pick up the new model.</span>';
      } else {
        statusEl.innerHTML = '<span class="status-warn-text">Partial — click Upgrade again to resume.</span>';
      }
    } catch (e) {
      statusEl.textContent = 'Swap failed: ' + (e.message || e);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  },

  async _checkUpdate(statusEl, btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    statusEl.textContent = '';
    try {
      const data = await API.post('/api/system/update-check', {});
      if (data.update_available) {
        statusEl.innerHTML = `<span class="status-warn-text">Update available: ${data.available_version}${data.is_forced ? ' (security)' : ''}</span>`;
        // Defensive cleanup: nuke ALL existing install buttons in this btnRow
        // before injecting a fresh one. Belt + suspenders for the duplicate-
        // button bug — one path could render via initial-render, another via
        // a previous Check Now, and matching on data-install-update OR on the
        // .btn-primary text "Install Update" catches both.
        const btnRow = btn.parentElement;
        if (btnRow) {
          btnRow.querySelectorAll('[data-install-update], button.btn-primary').forEach((el) => {
            if ((el.textContent || '').includes('Install')) el.remove();
          });
          const installBtn = document.createElement('button');
          installBtn.className = 'btn btn-primary';
          installBtn.dataset.installUpdate = '1';
          installBtn.textContent = data.is_forced ? '🔒 Install Security Update' : 'Install Update';
          installBtn.onclick = () => this._installUpdate(statusEl, installBtn);
          btn.insertAdjacentElement('afterend', installBtn);
        }
      } else {
        statusEl.innerHTML = `<span class="status-ok-text">Up to date. ${data.output || ''}</span>`;
        // Remove every Install button if the check now says we're current.
        const btnRow = btn.parentElement;
        if (btnRow) {
          btnRow.querySelectorAll('[data-install-update]').forEach((el) => el.remove());
        }
      }
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Check failed: ${err.message}</span>`;
    }
    btn.disabled = false;
    btn.textContent = 'Check Now';
  },

  async _installUpdate(statusEl, btn) {
    if (!confirm('Install the update now? The system will restart (~30 seconds).')) return;
    btn.disabled = true;
    btn.textContent = 'Installing…';

    // Replace the static status message with a live progress panel that tails
    // .vodou/update.log so users see exactly what step is running. Each line
    // from the log is a milestone like "downloading 0.5.58 ...", "replacing
    // vodou-core ...", "✓ update complete". Fixed-height + monospace + auto-
    // scroll to bottom mirrors a terminal view.
    statusEl.innerHTML = `
      <div class="update-progress-wrap" style="margin-top:6px;">
        <div class="update-progress-header" style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">
          <span class="update-progress-spinner" style="display:inline-block;width:10px;height:10px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
          <span class="update-progress-label">Update started — page will reload after restart</span>
          <span class="update-progress-elapsed" style="margin-left:auto;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <pre class="update-progress-log" style="margin:0;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border-primary);border-radius:4px;font-size:11px;line-height:1.5;max-height:200px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;">Waiting for update.log to update…</pre>
      </div>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `;
    const logEl = statusEl.querySelector('.update-progress-log');
    const labelEl = statusEl.querySelector('.update-progress-label');
    const elapsedEl = statusEl.querySelector('.update-progress-elapsed');
    const spinnerEl = statusEl.querySelector('.update-progress-spinner');
    const startTime = Date.now();

    // Tick the elapsed counter every second.
    const elapsedTick = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      if (elapsedEl) elapsedEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);

    // Tail the log every 1.5s. Same endpoint survives the gateway restart so
    // we keep polling across the cutover — failed fetches just no-op.
    const logPoll = setInterval(async () => {
      try {
        const r = await fetch('/api/system/update-log?tail=15', { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        if (data && Array.isArray(data.lines) && data.lines.length) {
          if (logEl) {
            logEl.textContent = data.lines.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
          }
          // Update the headline label to the most recent meaningful line
          const last = [...data.lines].reverse().find((l) => /\[update\]/.test(l));
          if (last && labelEl) {
            const m = last.match(/\[update\]\s*(.+)$/);
            if (m) labelEl.textContent = m[1].slice(0, 90);
          }
        }
      } catch {}
    }, 1500);

    // Fire and forget — the gateway will be killed mid-request as part of the
    // service stop, so the awaited POST will reject. That's expected and not
    // an error condition; we just kick off the work, then poll for the
    // gateway to come back up and reload to pick up new dist files.
    API.post('/api/system/update-install', {}).catch(() => {});

    // Poll /api/system until the gateway responds again (launchd respawn on
    // macOS, or start-vodou-services.sh spawned by auto_updater elsewhere).
    // Once it's back AND reports the new version, hard-reload the page so
    // every cached JS/CSS/HTML refreshes.
    const POLL_MS = 3000;
    // 5 min instead of 2 — a constrained VM + cold ONNX warmup + ~210MB
    // archive download + node_modules link can legitimately blow past 120s.
    // We were giving up while the gateway was still booting, then it'd come
    // back a few seconds later and the user saw the "didn't restart" toast
    // alongside a working install.
    const MAX_WAIT_MS = 300_000;
    const started = Date.now();
    let priorVersion = null;
    try {
      const cur = await API.get('/api/system');
      priorVersion = cur && cur.version;
    } catch {}

    const tick = async () => {
      if (Date.now() - started > MAX_WAIT_MS) {
        clearInterval(elapsedTick);
        clearInterval(logPoll);
        if (spinnerEl) spinnerEl.style.animationPlayState = 'paused';
        statusEl.innerHTML = `<span class="status-warn-text">Update applied but gateway didn't come back in 5 min. It usually comes up shortly after — refresh this page to confirm. If still down, run <code>./start-vodou-services.sh</code> in the install dir.</span>`;
        btn.disabled = false;
        btn.textContent = 'Install Update';
        return;
      }
      let data = null;
      try { data = await API.get('/api/system'); } catch {}
      if (data && data.version) {
        // If the version changed, we're on the new build. Reload.
        if (priorVersion && data.version !== priorVersion) {
          clearInterval(elapsedTick);
          clearInterval(logPoll);
          statusEl.innerHTML = `<span class="status-ok-text">✓ Updated to ${data.version} — reloading…</span>`;
          // Bust the SW cache so we get fresh JS/CSS, then reload.
          if ('serviceWorker' in navigator) {
            try {
              const regs = await navigator.serviceWorker.getRegistrations();
              for (const r of regs) await r.unregister();
            } catch {}
          }
          setTimeout(() => location.reload(), 500);
          return;
        }
        // Gateway came back but version still matches — wait one more tick.
      }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  },

  async _rollbackUpdate(statusEl, btn) {
    if (!confirm('Roll back to the previous version? This restores databases and binaries from the last backup.')) return;
    btn.disabled = true;
    btn.textContent = 'Rolling back…';
    statusEl.textContent = 'Rollback started. Page will reconnect after restart…';
    try {
      await API.post('/api/system/update-rollback', {});
    } catch (err) {
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Rollback';
    }
  },

  async _checkComponents(statusEl, btnRow, btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';

    // Mount the same live-progress panel as install — first check downloads
    // ~210MB so the user needs to see the steps. Polls /api/system/update-log.
    statusEl.innerHTML = `
      <div class="update-progress-wrap" style="margin-top:6px;">
        <div class="update-progress-header" style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">
          <span class="update-progress-spinner" style="display:inline-block;width:10px;height:10px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
          <span class="update-progress-label">Downloading release for component comparison…</span>
          <span class="update-progress-elapsed" style="margin-left:auto;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <pre class="update-progress-log" style="margin:0;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border-primary);border-radius:4px;font-size:11px;line-height:1.5;max-height:200px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;">Waiting for update.log…</pre>
      </div>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `;
    const logEl = statusEl.querySelector('.update-progress-log');
    const labelEl = statusEl.querySelector('.update-progress-label');
    const elapsedEl = statusEl.querySelector('.update-progress-elapsed');
    const startTime = Date.now();
    const elapsedTick = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      if (elapsedEl) elapsedEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);
    const logPoll = setInterval(async () => {
      try {
        const r = await fetch('/api/system/update-log?tail=15', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (d && Array.isArray(d.lines) && d.lines.length) {
          if (logEl) {
            logEl.textContent = d.lines.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
          }
          const last = [...d.lines].reverse().find((l) => /\[update\]|\[components\]/.test(l));
          if (last && labelEl) {
            const m = last.match(/\[(?:update|components)\]\s*(.+)$/);
            if (m) labelEl.textContent = m[1].slice(0, 90);
          }
        }
      } catch {}
    }, 1500);
    const stopProgress = () => { clearInterval(elapsedTick); clearInterval(logPoll); };

    try {
      const data = await API.post('/api/system/update-components-check', {});
      stopProgress();
      const components = data.components || [];

      // Version-skew gate hit. Binary version-skew check in component_updater
      // emits its message to stderr + an empty list to stdout; the gateway
      // surfaces stderr in `data.message`/`data.stderr` after stripping its
      // own log marker. Render that as a clear "update binary first" panel
      // instead of a generic "everything up to date" green tick.
      const skewMsg = (data.stderr || data.message || '').match(/Version mismatch:.*?Install the binary update first[^\n]*/);
      if (components.length === 0 && skewMsg) {
        statusEl.innerHTML = `
          <div class="status-warn-text" style="font-weight:600;">⚠ ${skewMsg[0]}</div>
          <div style="margin-top:6px;font-size:12px;color:var(--text-muted);">Click <strong>Install Update</strong> at the top of this page first, then come back here.</div>`;
        btn.disabled = false;
        btn.textContent = 'Re-check';
        return;
      }

      if (components.length === 0) {
        statusEl.innerHTML = `<span class="status-ok-text">All components up to date.</span>`;
        btn.disabled = false;
        btn.textContent = 'Check Components';
        return;
      }

      statusEl.innerHTML = `<strong>${components.length} component${components.length > 1 ? 's' : ''} with changes:</strong>`;

      // Build checkbox list. Each row is a wrapper containing:
      //   <label> — checkbox + name + count, click toggles file list
      //   <ul>    — collapsed-by-default list of component-relative paths
      const listEl = document.createElement('div');
      listEl.className = 'system-comp-list';
      const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
      components.forEach(c => {
        const wrap = document.createElement('div');
        wrap.className = 'system-comp-wrap';
        const filesArr = Array.isArray(c.files) ? c.files : [];
        const moreCount = (c.changed_files || filesArr.length) - filesArr.length;
        const fileList = filesArr.length
          ? `<ul class="system-comp-files">${filesArr.map(f => `<li><code>${escape(f)}</code></li>`).join('')}${
              c.files_truncated || moreCount > 0
                ? `<li class="text-muted-color">… and ${moreCount > 0 ? moreCount : 'more'} more</li>`
                : ''
            }</ul>`
          : '';
        wrap.innerHTML = `<label class="system-comp-row" data-toggle="files">
            <input type="checkbox" data-idx="${c.index}" checked class="m-0">
            <span class="comp-disclosure" aria-hidden="true">▸</span>
            <span class="text-primary-color fw-600">${escape(c.name)}</span>
            <span class="text-muted-color">${escape(c.category)} · ${c.changed_files} file${c.changed_files !== 1 ? 's' : ''}</span>
          </label>${fileList}`;
        // Click anywhere on the row except the checkbox toggles file list
        wrap.querySelector('label').addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          const ul = wrap.querySelector('ul.system-comp-files');
          if (!ul) return;
          const showing = ul.classList.toggle('is-open');
          const dis = wrap.querySelector('.comp-disclosure');
          if (dis) dis.textContent = showing ? '▾' : '▸';
        });
        listEl.appendChild(wrap);
      });
      btnRow.insertBefore(listEl, btn.nextSibling);

      // Apply button
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn btn-primary';
      applyBtn.textContent = 'Apply Selected';
      applyBtn.classList.add('mt-2');
      applyBtn.onclick = () => this._applyComponents(statusEl, applyBtn, listEl);
      btnRow.appendChild(applyBtn);

      btn.disabled = false;
      btn.textContent = 'Re-check';
    } catch (err) {
      stopProgress();
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Check Components';
    }
  },

  async _applyComponents(statusEl, btn, listEl) {
    const checkboxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => parseInt(cb.dataset.idx));
    if (selected.length === 0) {
      statusEl.innerHTML = `<span class="status-warn-text">No components selected.</span>`;
      return;
    }
    if (!confirm(`Apply updates to ${selected.length} component${selected.length > 1 ? 's' : ''}?`)) return;
    btn.disabled = true;
    btn.textContent = 'Applying…';

    // Live progress panel — same shape as core install / Check Components.
    statusEl.innerHTML = `
      <div class="update-progress-wrap" style="margin-top:6px;">
        <div class="update-progress-header" style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">
          <span class="update-progress-spinner" style="display:inline-block;width:10px;height:10px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
          <span class="update-progress-label">Applying component updates…</span>
          <span class="update-progress-elapsed" style="margin-left:auto;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <pre class="update-progress-log" style="margin:0;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border-primary);border-radius:4px;font-size:11px;line-height:1.5;max-height:240px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;">Waiting for update.log…</pre>
      </div>
    `;
    const logEl = statusEl.querySelector('.update-progress-log');
    const labelEl = statusEl.querySelector('.update-progress-label');
    const elapsedEl = statusEl.querySelector('.update-progress-elapsed');
    const spinnerEl = statusEl.querySelector('.update-progress-spinner');
    const startTime = Date.now();
    const elapsedTick = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      if (elapsedEl) elapsedEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);

    let lastSeenTotal = 0;
    let done = false;
    const stop = () => {
      done = true;
      clearInterval(elapsedTick);
      clearInterval(logPoll);
      if (spinnerEl) spinnerEl.style.animationPlayState = 'paused';
    };

    const logPoll = setInterval(async () => {
      try {
        const r = await fetch('/api/system/update-log?tail=80', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (!d || !Array.isArray(d.lines)) return;
        if (logEl) {
          logEl.textContent = d.lines.join('\n');
          logEl.scrollTop = logEl.scrollHeight;
        }
        // Latest [components] / [update] line as the headline label
        const last = [...d.lines].reverse().find((l) => /\[update\]|\[components\]/.test(l));
        if (last && labelEl) {
          const m = last.match(/\[(?:update|components)\]\s*(.+)$/);
          if (m) labelEl.textContent = m[1].slice(0, 90);
        }
        // Sentinel — backend appends "components-apply done code=..." when child exits
        const finish = d.lines.find((l) => /components-apply done /.test(l));
        if (finish) {
          stop();
          const ok = /code=0/.test(finish);
          if (ok) {
            statusEl.insertAdjacentHTML('afterbegin',
              `<div class="status-ok-text" style="margin-bottom:6px;">✓ Component update complete — reloading…</div>`);
            setTimeout(() => location.reload(), 1500);
          } else {
            statusEl.insertAdjacentHTML('afterbegin',
              `<div class="status-error-text" style="margin-bottom:6px;">✗ Component update finished with errors. See log below + .vodou/update.log.</div>`);
            btn.disabled = false;
            btn.textContent = 'Apply Selected';
          }
        }
        lastSeenTotal = d.total || lastSeenTotal;
      } catch {}
    }, 1500);

    // Hard ceiling — if 5 min passes without a sentinel, surface a guidance
    // message rather than spinning forever. Component apply is local rsync
    // + npm install on small servers; should always finish well under 5 min.
    setTimeout(() => {
      if (done) return;
      stop();
      statusEl.insertAdjacentHTML('afterbegin',
        `<div class="status-warn-text" style="margin-bottom:6px;">Apply has been running >5 min. Check .vodou/update.log directly.</div>`);
      btn.disabled = false;
      btn.textContent = 'Apply Selected';
    }, 300_000);

    try {
      await API.post('/api/system/update-components-apply', { selected });
    } catch (err) {
      stop();
      statusEl.innerHTML = `<span class="status-error-text">Failed: ${err.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Apply Selected';
    }
  },

  /**
   * Render the "Memory extraction sources" card — privacy gate for the gateway
   * memory extractor. The web/workbench/skills/automations row is informational
   * (always on); the channels row is the only toggleable surface.
   */
  // Memory Extraction Sources UI moved to Settings → Memory tab in v0.5.71.
  // The privacy toggle + cycle stats live there now alongside the existing
  // extraction-backend override and benchmark controls.
};
