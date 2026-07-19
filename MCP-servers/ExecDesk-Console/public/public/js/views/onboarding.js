/**
 * Onboarding View — streamlined 4-step flow (3 if credentials present).
 * Step 0: Connect to Vodou (credentials — always first)
 * Step 1: Connect Your LLM (provider selection)
 * Step 2: About You (name, timezone, context, communication style)
 * Step 3: Your AI (personality presets + customize)
 * Step 4: See It Work (live demo)
 */

const OnboardingView = {
  _container: null,
  _step: 0,
  _data: {},
  _status: {},
  _totalSteps: 4,

  async shouldShow() {
    try {
      const res = await fetch('/api/onboarding/status');
      this._status = await res.json();
      return this._status.needsCredentials === true || this._status.needsOnboarding === true;
    } catch {
      return false;
    }
  },

  show(container) {
    this._container = container || document.getElementById('main-content');
    this._step = 0; // Always start at credentials
    this._data = {};
    this._render();
  },

  _render() {
    const allSteps = [this._stepCredentials, this._stepLLM, this._stepUser, this._stepAI, this._stepDemo];
    const steps = allSteps;
    const stepIndex = this._step;

    const el = this._container;
    el.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'onboarding-wrapper';

    const card = document.createElement('div');
    card.className = 'onboarding-card';

    // Progress dots — clickable to navigate back (not forward past current)
    const progress = document.createElement('div');
    progress.className = 'onboarding-progress';
    steps.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = 'onboarding-dot' + (i <= stepIndex ? ' active' : '');
      // Allow clicking to go back to completed steps (but not forward, and not to demo)
      if (i < stepIndex && i < 4) {
        dot.classList.add('onboarding-dot-clickable');
        dot.title = ['Connect', 'LLM Setup', 'About You', 'Your AI', 'Demo'][i];
        dot.addEventListener('click', () => {
          this._saveFields();
          this._step = i;
          this._render();
        });
      }
      progress.appendChild(dot);
    });
    card.appendChild(progress);

    const body = document.createElement('div');
    body.className = 'onboarding-body';
    body.id = 'onboarding-body';
    card.appendChild(body);

    wrapper.appendChild(card);
    el.appendChild(wrapper);

    allSteps[this._step].call(this, body);
  },

  // ── Step 0: Credentials ──────────────────────────────────────
  _stepCredentials(body) {
    body.innerHTML = `
      <h2>Connect to Vodou</h2>
      <p>First, connect to the Vodou platform to get your keys.</p>
      <p>
        <a href="https://app.vodou.ai" target="_blank" rel="noopener" class="onboarding-link">
          Open app.vodou.ai to get your credentials &rarr;
        </a>
      </p>
      <div class="onboarding-fields onboarding-fields-top">
        <label>Vodou Token<input type="text" id="ob-token" value="" placeholder="Paste your VODOU_TOKEN here" autofocus spellcheck="false" autocomplete="off"></label>
        <label>User ID<input type="text" id="ob-userId" value="" placeholder="Paste your VODOU_USER_ID here" spellcheck="false" autocomplete="off"></label>
      </div>
      <div id="ob-cred-error" class="onboarding-cred-error is-hidden"></div>
      <div class="onboarding-actions">
        <button class="onboarding-btn primary" id="ob-save-creds">Save & Continue</button>
      </div>
    `;
    body.querySelector('#ob-save-creds').addEventListener('click', async () => {
      const token = body.querySelector('#ob-token').value.trim();
      const userId = body.querySelector('#ob-userId').value.trim();
      const errEl = body.querySelector('#ob-cred-error');

      if (!token) {
        errEl.textContent = 'Vodou Token is required';
        errEl.classList.remove('is-hidden');
        body.querySelector('#ob-token').focus();
        return;
      }

      errEl.classList.add('is-hidden');
      try {
        const res = await fetch('/api/onboarding/save-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, userId })
        });
        const result = await res.json();
        if (result.success) {
          this._step = 1;
          this._render();
        } else {
          errEl.textContent = result.error || 'Failed to save credentials';
          errEl.classList.remove('is-hidden');
        }
      } catch (err) {
        errEl.textContent = 'Connection error: ' + err.message;
        errEl.classList.remove('is-hidden');
      }
    });
  },

  // ── Step 1: About You ────────────────────────────────────────
  _stepUser(body) {
    body.innerHTML = `
      <h2>About You</h2>
      <p class="onboarding-hint">The more detail you give, the better I'll be from day one. This goes into your workspace profile &mdash; I'll reference it in every conversation.</p>
      <div class="onboarding-fields">
        <label><span>Your name <span class="ob-required">*</span></span><input type="text" id="ob-userName" value="${this._esc(this._data.userName || '')}" placeholder="e.g. Chad" autofocus></label>
        <label>What should I call you?<input type="text" id="ob-callThem" value="${this._esc(this._data.callThem || '')}" placeholder="Same as name, or a nickname"></label>
        <label>Timezone<input type="text" id="ob-timezone" value="${this._esc(this._data.timezone || '')}" placeholder="e.g. EST, PST, UTC+1"></label>
        <label>What are you working on? <span class="ob-detail-hint">Be specific &mdash; project name, tech stack, goals</span>
          <textarea id="ob-userContext" rows="3" placeholder="e.g. Building an AI orchestration platform in Rust + TypeScript. 10 MCP servers, 80 skills. Competing with Claude Cowork.">${this._esc(this._data.userContext || '')}</textarea>
        </label>
        <label>How should I communicate?
          <input type="text" id="ob-commStyle" value="${this._esc(this._data.commStyle || '')}" placeholder="e.g. Direct and concise, occasional humor, no over-explaining">
        </label>
      </div>
      <div class="onboarding-actions">
        ${this._status.needsCredentials ? '<button class="onboarding-btn" id="ob-back">Back</button>' : ''}
        <button class="onboarding-btn primary" id="ob-next">Next</button>
      </div>
    `;
    if (body.querySelector('#ob-back')) {
      body.querySelector('#ob-back').addEventListener('click', () => { this._saveFields(); this._step = 1; this._render(); });
    }
    body.querySelector('#ob-next').addEventListener('click', () => {
      this._saveFields();
      if (!this._data.userName) { body.querySelector('#ob-userName').focus(); return; }
      this._step = 3; this._render();
    });
  },

  // ── Step 3: Your AI ──────────────────────────────────────────
  _stepAI(body) {
    const suggestions = [
      { name: 'VODOU', vibe: 'Sharp, resourceful, a little scrappy. Digs in before asking.', creature: 'AI teammate', color: '#6B7280', avatar: '/icons/vodou-icon.png' },
      { name: 'Ori', vibe: 'Calm, precise, thoughtful. Measures twice, cuts once.', creature: 'Digital familiar', color: '#6366f1', avatar: '' },
      { name: 'Hex', vibe: 'Fast, bold, no-nonsense. Ships first, polishes later.', creature: 'Code spirit', color: '#f59e0b', avatar: '' },
      { name: 'Sage', vibe: 'Patient, thorough, wise. Explains the why, not just the what.', creature: 'AI mentor', color: '#10b981', avatar: '' },
    ];

    const defaultName = this._data.aiName || 'VODOU';
    const defaultVibe = this._data.aiVibe || suggestions[0].vibe;
    const defaultCreature = this._data.aiCreature || suggestions[0].creature;
    if (!this._data.aiName) {
      this._data.aiAvatarColor = suggestions[0].color;
      this._data.aiAvatarDefault = suggestions[0].avatar || '';
    }

    body.innerHTML = `
      <h2>Your AI</h2>
      <p class="onboarding-hint">Pick a personality preset or create your own. This shapes how your AI communicates and approaches problems.</p>
      <div class="onboarding-presets" id="ob-presets">
        ${suggestions.map((s, i) => `
          <button class="onboarding-preset${i === 0 && !this._data.aiName ? ' selected' : ''}" data-idx="${i}">
            <span class="preset-av${s.avatar ? ' preset-av-image' : ''} preset-${s.name.toLowerCase()}">
              ${s.avatar ? `<img class="preset-av-img" src="${s.avatar}" alt="${s.name} avatar">` : s.name.slice(0, 2)}
            </span>
            <span class="preset-name">${s.name}</span>
            <span class="preset-vibe">${s.vibe}</span>
          </button>
        `).join('')}
      </div>
      <div class="onboarding-fields onboarding-fields-top">
        <label><span>Name <span class="ob-required">*</span></span><input type="text" id="ob-aiName" value="${this._esc(defaultName)}" placeholder="Your AI's name"></label>
        <div class="onboarding-single-grid">
          <label>Creature type<input type="text" id="ob-aiCreature" value="${this._esc(defaultCreature)}" placeholder="e.g. AI teammate"></label>
        </div>
        <label>Vibe &amp; personality <span class="ob-detail-hint">How they think, speak, and approach work</span>
          <textarea id="ob-aiVibe" rows="2" placeholder="e.g. Direct and resourceful with a dash of humor. Reads the room, reads the code, then speaks.">${this._esc(this._data.aiVibe || '')}</textarea>
        </label>
        <label>Rules <span class="ob-detail-hint">Things your AI should always or never do</span>
          <textarea id="ob-alwaysDo" rows="3" placeholder="e.g. Always read the codebase before making changes&#10;Never delete a database without a backup&#10;Suggest improvements, don't just execute">${this._esc(this._data.alwaysDo || '')}</textarea>
        </label>
      </div>
      <div class="onboarding-actions">
        <button class="onboarding-btn" id="ob-back">Back</button>
        <button class="onboarding-btn primary" id="ob-next">Next</button>
      </div>
    `;

    body.querySelectorAll('.onboarding-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = suggestions[parseInt(btn.dataset.idx)];
        body.querySelector('#ob-aiName').value = s.name;
        body.querySelector('#ob-aiVibe').value = s.vibe;
        body.querySelector('#ob-aiCreature').value = s.creature;
        this._data.aiAvatarColor = s.color;
        this._data.aiAvatarDefault = s.avatar || '';
        body.querySelectorAll('.onboarding-preset').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    body.querySelector('#ob-back').addEventListener('click', () => { this._saveFields(); this._step = 2; this._render(); });
    body.querySelector('#ob-next').addEventListener('click', () => {
      this._saveFields();
      if (!this._data.aiName) { body.querySelector('#ob-aiName').focus(); return; }
      // Save workspace files, then show demo
      this._finish();
    });
  },

  // ── Step 3: Connect Your LLM ─────────────────────────────────
  _stepLLM(body) {
    const providers = [
      { id: 'claude-cli', name: 'Claude CLI', icon: '\u{1F7E3}', desc: 'Uses your Anthropic Max subscription. No API costs.', badge: 'Recommended', needsKey: false,
        config: this._renderClaudeCliConfig() },
      { id: 'anthropic', name: 'Anthropic API', icon: '\u{1F511}', desc: 'Claude models via API key (pay-per-use)', needsKey: true, keyPlaceholder: 'sk-ant-...', keyField: 'anthropic_api_key' },
      { id: 'kimi-cli', name: 'Kimi Code CLI', icon: '\u{1F319}', desc: 'Moonshot terminal agent — run kimi login once', needsKey: false },
      { id: 'kimi', name: 'Kimi (Moonshot API)', icon: '\u{1F319}', desc: 'OpenAI-compatible API (platform.moonshot.ai)', needsKey: true, keyPlaceholder: 'sk-...', keyField: 'kimi_api_key' },
      { id: 'openai', name: 'OpenAI', icon: '\u{1F7E2}', desc: 'GPT-4o, o3, and other OpenAI models', needsKey: true, keyPlaceholder: 'sk-...', keyField: 'openai_api_key' },
      { id: 'google', name: 'Google Gemini', icon: '\u{1F48E}', desc: 'Gemini 2.5 Pro, Flash, and Flash Lite', needsKey: true, keyPlaceholder: 'AIza...', keyField: 'google_api_key' },
      { id: 'groq', name: 'Groq', icon: '\u26A1', desc: 'Ultra-fast inference — Llama, Qwen, DeepSeek', needsKey: true, keyPlaceholder: 'gsk_...', keyField: 'groq_api_key' },
      { id: 'deepseek', name: 'DeepSeek', icon: '\u{1F30A}', desc: 'DeepSeek Chat and Reasoner models', needsKey: true, keyPlaceholder: 'sk-...', keyField: 'deepseek_api_key' },
      { id: 'xai', name: 'xAI (Grok)', icon: '\u{1F680}', desc: 'Grok 4, Grok 3, and vision models', needsKey: true, keyPlaceholder: 'xai-...', keyField: 'xai_api_key' },
      { id: 'mistral', name: 'Mistral', icon: '\u{1F32C}', desc: 'Mistral Large, Small, Codestral, Magistral', needsKey: true, keyPlaceholder: 'sk-...', keyField: 'mistral_api_key' },
      { id: 'openrouter', name: 'OpenRouter', icon: '\u{1F500}', desc: 'Many providers behind one API key', needsKey: true, keyPlaceholder: 'sk-or-...', keyField: 'openrouter_api_key' },
      { id: 'ollama', name: 'Ollama (Free, Local)', icon: '\u{1F999}', desc: 'Run models locally — no API key, no cost', needsKey: false,
        config: this._renderOllamaConfig() },
      { id: 'custom', name: 'Custom Endpoint', icon: '\u{1F527}', desc: 'Any OpenAI-compatible API endpoint', needsKey: false,
        config: '<div class="onboarding-fields"><label><span>Base URL</span><input type="text" id="ob-llm-url" placeholder="http://localhost:1234/v1" class="settings-input"></label></div>' },
    ];

    const primaryProviders = providers.slice(0, 4); // Claude CLI, Anthropic, OpenAI, Gemini
    const moreProviders = providers.slice(4);       // Groq, DeepSeek, xAI, Mistral, Ollama, Custom

    let html = `
      <h2>Connect Your AI Model</h2>
      <p class="onboarding-hint">Pick an AI provider. You can change this anytime in Settings.</p>

      <div class="ob-llm-list">
    `;

    // Primary providers — larger cards
    for (const p of primaryProviders) {
      html += `
        <div class="ob-llm-option ob-llm-option-primary" data-provider="${p.id}">
          <div class="ob-llm-head ob-llm-head-primary">
            <span class="ob-llm-icon ob-llm-icon-primary">${p.icon}</span>
            <div class="flex-1">
              <div class="ob-llm-name-row">
                <span class="ob-llm-name ob-llm-name-primary">${p.name}</span>
                ${p.badge ? `<span class="ob-llm-badge">${p.badge}</span>` : ''}
              </div>
              <div class="ob-llm-desc ob-llm-desc-primary">${p.desc}</div>
            </div>
          </div>
          <div class="ob-provider-config ob-provider-config-primary is-hidden"></div>
        </div>
      `;
    }

    // "More providers" collapsible section
    html += `
        <div id="ob-more-toggle" class="ob-more-toggle">
          + ${moreProviders.length} more providers (Groq, DeepSeek, Ollama, etc.)
        </div>
        <div id="ob-more-providers" class="ob-more-providers is-hidden">
    `;

    for (const p of moreProviders) {
      html += `
        <div class="ob-llm-option ob-llm-option-secondary" data-provider="${p.id}">
          <div class="ob-llm-head ob-llm-head-secondary">
            <span class="ob-llm-icon ob-llm-icon-secondary">${p.icon}</span>
            <div class="flex-1">
              <span class="ob-llm-name ob-llm-name-secondary">${p.name}</span>
              <div class="ob-llm-desc ob-llm-desc-secondary">${p.desc}</div>
            </div>
          </div>
          <div class="ob-provider-config ob-provider-config-secondary is-hidden"></div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
      <div id="ob-llm-status" class="ob-llm-status"></div>
      <div class="onboarding-actions">
        <button class="onboarding-btn" id="ob-back">Back</button>
        <button class="onboarding-btn primary" id="ob-next">Finish Setup</button>
      </div>
    `;

    body.innerHTML = html;

    let selectedProvider = null;
    const moreToggle = body.querySelector('#ob-more-toggle');
    const moreProvidersEl = body.querySelector('#ob-more-providers');
    if (moreToggle && moreProvidersEl) {
      moreToggle.addEventListener('click', () => {
        moreProvidersEl.classList.remove('is-hidden');
        moreToggle.classList.add('is-hidden');
      });
    }

    body.querySelectorAll('.ob-llm-option').forEach(card => {
      card.addEventListener('click', (e) => {
        // Don't toggle if clicking inside interactive elements (inputs, buttons, code, copy targets)
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'CODE' || tag === 'PRE') return;
        if (e.target.closest('button, code, pre, .copy-btn, [onclick]')) return;
        if (e.target.classList.contains('copy-btn') || e.target.hasAttribute('onclick')) return;

        const pid = card.dataset.provider;
        const p = providers.find(x => x.id === pid);
        const configDiv = card.querySelector('.ob-provider-config');

        // Collapse all others
        body.querySelectorAll('.ob-llm-option').forEach(c => {
          if (c !== card) {
            c.classList.remove('selected');
            c.querySelector('.ob-provider-config').classList.add('is-hidden');
          }
        });

        // Toggle this one
        const isOpen = !configDiv.classList.contains('is-hidden');
        if (isOpen) {
          configDiv.classList.add('is-hidden');
          card.classList.remove('selected');
          selectedProvider = null;
        } else {
          selectedProvider = pid;
          card.classList.add('selected');
          configDiv.classList.remove('is-hidden');
          configDiv.innerHTML = '';

          if (p.needsKey) {
            configDiv.innerHTML = `
              <div class="onboarding-fields onboarding-fields-zero">
                <label class="onboarding-label-zero"><span>API Key</span>
                  <input type="password" id="ob-llm-key" placeholder="${p.keyPlaceholder}" class="settings-input" autofocus autocomplete="off">
                </label>
              </div>`;
            setTimeout(() => { const inp = configDiv.querySelector('#ob-llm-key'); if (inp) inp.focus(); }, 50);
          } else if (p.config) {
            configDiv.innerHTML = `<div class="text-sm">${p.config}</div>`;
          }
        }
      });
    });

    body.querySelector('#ob-back').addEventListener('click', () => { this._saveFields(); this._step = 0; this._render(); });
    body.querySelector('#ob-next').addEventListener('click', async () => {
      if (!selectedProvider) {
        body.querySelector('#ob-llm-status').innerHTML = '<div class="status-error-text text-sm">Please select an AI model provider above.</div>';
        return;
      }

      const p = providers.find(x => x.id === selectedProvider);
      const saveBody = { provider: selectedProvider };

      // Collect API key if needed
      if (p.needsKey) {
        const keyEl = body.querySelector('#ob-llm-key');
        const key = keyEl?.value?.trim();
        if (!key) {
          body.querySelector('#ob-llm-status').innerHTML = '<div class="status-error-text text-sm">API key is required for this provider.</div>';
          keyEl?.focus();
          return;
        }
        saveBody[p.keyField] = key;
      }

      // Collect custom URL if needed
      if (selectedProvider === 'custom') {
        const urlEl = body.querySelector('#ob-llm-url');
        if (urlEl?.value?.trim()) saveBody.custom_llm_base_url = urlEl.value.trim();
      }
      if (selectedProvider === 'kimi') saveBody.kimi_model = 'kimi-k2.6';
      if (selectedProvider === 'kimi-cli') saveBody.kimi_cli_model = 'kimi-k2.6';
      if (selectedProvider === 'openrouter') saveBody.openrouter_model = 'openai/gpt-4o';

      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(saveBody)
        });
      } catch (e) {
        console.error('Failed to save provider:', e);
      }

      // Move to About You step
      this._step = 2; this._render();
    });
  },

  // ── Step 4: See It Work (Live Demo) ──────────────────────────
  _stepDemo(body) {
    const d = this._data;
    const aiEmoji = d.aiEmoji || '\u{1F916}';
    const aiName = d.aiName || 'Your AI';
    const userName = d.userName || 'there';

    body.innerHTML = `
      <div class="demo-header">
        <span class="demo-ai-emoji">${aiEmoji}</span>
        <h2>Hey ${this._esc(userName)} &mdash; ${this._esc(aiName)} is ready</h2>
        <p class="onboarding-hint">Here's what I can see and do right now.</p>
      </div>
      <div class="demo-grid" id="demo-grid">
        <div class="demo-card" id="demo-system">
          <div class="demo-card-title">Your System</div>
          <div class="demo-card-body demo-loading">Scanning...</div>
        </div>
        <div class="demo-card" id="demo-screen">
          <div class="demo-card-title">Your Apps</div>
          <div class="demo-card-body demo-loading">Looking...</div>
        </div>
        <div class="demo-card demo-wide" id="demo-toolkit">
          <div class="demo-card-title">My Toolkit</div>
          <div class="demo-card-body demo-loading">Loading...</div>
        </div>
      </div>
      ${d.userContext ? `<div class="demo-context" id="demo-context"><em>"${this._esc(d.userContext.substring(0, 120))}"</em> &mdash; I'm ready to help with that.</div>` : ''}
      <div class="onboarding-actions onboarding-actions-lg">
        <button class="onboarding-btn primary onboarding-btn-go" id="ob-go">Start Chatting</button>
      </div>
    `;

    body.querySelector('#ob-go').addEventListener('click', () => {
      location.hash = '#/chat';
      location.reload();
    });

    // Fire all demo calls in parallel
    this._runDemo();
  },

  async _runDemo() {
    // All calls are local — no network dependencies, always work
    const [systemResult, screenResult, toolsResult, workflowsResult] = await Promise.allSettled([
      this._demoCall('mcp-monitor', 'get_cpu_info', {}),
      this._demoCall('vodou-mac-control', 'list_windows', {}),
      fetch('/api/tools').then(r => r.json()),
      fetch('/api/workflows').then(r => r.json()),
    ]);

    // Also get memory info in parallel
    const memResult = await this._demoCall('mcp-monitor', 'get_memory_info', {}).catch(() => null);

    // ── System card ──
    const sysCard = document.querySelector('#demo-system .demo-card-body');
    if (sysCard) {
      try {
        const cpu = this._parseDemoResult(systemResult);
        const mem = memResult ? this._parseBt4Result(memResult) : null;

        const cores = cpu?.core_count || '?';
        const memTotal = mem?.total ? (mem.total / (1024 * 1024 * 1024)).toFixed(0) + ' GB RAM' : '';
        const memUsed = mem?.used_percent ? Math.round(mem.used_percent) + '% used' : '';

        sysCard.className = 'demo-card-body';
        sysCard.innerHTML = `
          <div class="demo-stat"><span class="demo-stat-value">${cores}</span><span class="demo-stat-label">CPU cores</span></div>
          ${memTotal ? `<div class="demo-stat"><span class="demo-stat-value">${memTotal}</span><span class="demo-stat-label">${memUsed}</span></div>` : ''}
        `;
      } catch {
        sysCard.className = 'demo-card-body';
        sysCard.textContent = 'System monitoring ready';
      }
    }

    // ── Screen card ──
    const screenCard = document.querySelector('#demo-screen .demo-card-body');
    if (screenCard) {
      try {
        const windows = this._parseDemoResult(screenResult);
        const windowList = windows?.windows || [];
        const apps = [...new Set(windowList.map(w => w.app))].slice(0, 6);

        screenCard.className = 'demo-card-body';
        if (apps.length > 0) {
          screenCard.innerHTML = `
            <div class="demo-apps-row">
              ${apps.map(a => `<span class="demo-app-badge">${this._esc(a)}</span>`).join(' ')}
              ${windowList.length > 6 ? `<span class="demo-apps-more">+${windowList.length - 6} more</span>` : ''}
            </div>
            <div class="demo-apps-count">${windowList.length} windows visible</div>
          `;
        } else {
          screenCard.textContent = 'Screen control ready';
        }
      } catch {
        screenCard.className = 'demo-card-body';
        screenCard.textContent = 'Mac control available (connect in Settings > Servers)';
      }
    }

    // ── Toolkit card ──
    const toolkitCard = document.querySelector('#demo-toolkit .demo-card-body');
    if (toolkitCard) {
      try {
        const tools = toolsResult.status === 'fulfilled' ? toolsResult.value : {};
        const workflows = workflowsResult.status === 'fulfilled' ? workflowsResult.value : {};
        const toolCount = tools.count || 0;
        const serverCount = tools.tools ? [...new Set(tools.tools.map(t => t.server))].length : 0;
        const workflowCount = workflows.count || 0;

        // Get some tool category examples
        const servers = tools.tools ? [...new Set(tools.tools.map(t => t.server))].slice(0, 8) : [];
        const capabilities = servers.map(s => {
          if (s.includes('monitor')) return 'system monitoring';
          if (s.includes('mac-control') || s.includes('vodou')) return 'Mac control';
          if (s.includes('Thinking')) return 'deep thinking';
          if (s.includes('git')) return 'git operations';
          if (s.includes('channels')) return 'Slack & messaging';
          if (s.includes('gateway')) return 'AI chat';
          if (s.includes('chrome') || s.includes('browser')) return 'browser automation';
          if (s.includes('LLM')) return 'multi-model AI';
          return s.replace(/^(Vodou|OI)-/i, '').replace(/-/g, ' ');
        });
        const uniqueCaps = [...new Set(capabilities)].slice(0, 6);

        toolkitCard.className = 'demo-card-body';
        toolkitCard.innerHTML = `
          <div class="demo-toolkit-stats">
            <div class="demo-stat"><span class="demo-stat-value">${serverCount}</span><span class="demo-stat-label">servers</span></div>
            <div class="demo-stat"><span class="demo-stat-value">${toolCount}</span><span class="demo-stat-label">tools</span></div>
            <div class="demo-stat"><span class="demo-stat-value">${workflowCount}</span><span class="demo-stat-label">workflows</span></div>
          </div>
          ${uniqueCaps.length ? `<div class="demo-toolkit-caps">${uniqueCaps.join(' \u00B7 ')}</div>` : ''}
        `;
      } catch {
        toolkitCard.className = 'demo-card-body';
        toolkitCard.textContent = 'Toolkit loaded';
      }
    }

    // "Try one of these" suggestion buttons removed — they lived at the
    // bottom of the final onboarding screen. Users now just click Start
    // Chatting and compose their own first message.
  },

  // ── Helpers ──────────────────────────────────────────────────

  async _demoCall(server, tool, args) {
    const res = await fetch('/api/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, tool, args })
    });
    return res.json();
  },

  _parseDemoResult(settled) {
    if (settled.status !== 'fulfilled') return null;
    return this._parseBt4Result(settled.value);
  },

  _parseBt4Result(data) {
    if (!data || !data.result) return null;
    // bt4 result is a string containing the tool output — parse nested JSON
    const text = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    // Find the JSON object in the result text (after "Result:" line)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const outer = JSON.parse(jsonMatch[0]);
      // If it has content[0].text, parse that too (MCP response wrapper)
      if (outer.content && outer.content[0] && outer.content[0].text) {
        return JSON.parse(outer.content[0].text);
      }
      return outer;
    } catch { return null; }
  },

  _renderClaudeCliConfig() {
    return `
      <div class="onboarding-cli-step">Step 1 — Install Claude CLI:</div>
      <code class="cli-install-cmd cli-install-cmd-select">curl -fsSL https://claude.ai/install.sh | bash</code>
      <div class="onboarding-cli-step">Step 2 — Add to PATH:</div>
      <code class="cli-install-cmd cli-install-cmd-select">echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc</code>
      <div class="onboarding-cli-note">Then run <code>claude</code> once to authenticate.</div>
    `;
  },

  _renderOllamaConfig() {
    return `
      <code class="cli-install-cmd">brew install ollama && ollama pull llama3</code>
      <div class="onboarding-cli-note">Then <code>ollama serve</code> to start. Needs 16GB+ RAM.</div>
    `;
  },

  _saveFields() {
    const fields = ['userName', 'callThem', 'timezone', 'userContext', 'aiName', 'aiEmoji', 'aiVibe', 'aiCreature', 'commStyle', 'alwaysDo', 'neverDo', 'aiAvatarColor', 'aiAvatarDefault'];
    for (const f of fields) {
      const el = document.getElementById('ob-' + f);
      if (el) this._data[f] = el.value;
    }
  },

  _esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  async _finish() {
    const body = document.getElementById('onboarding-body');
    body.innerHTML = '<div class="onboarding-loading"><p>Setting up your workspace...</p></div>';

    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._data)
      });
      const result = await res.json();

      if (result.success) {
        this._step = 4;
        this._render();
      } else {
        body.innerHTML = `<p class="status-error-text">Error: ${result.error}</p><button class="onboarding-btn" onclick="location.reload()">Retry</button>`;
      }
    } catch (err) {
      body.innerHTML = `<p class="status-error-text">Failed: ${err.message}</p><button class="onboarding-btn" onclick="location.reload()">Retry</button>`;
    }
  }
};
