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
  _returnNotice: null,
  _returnFocusId: null,
  /** When token already in .env, user clicked "Saved" to open Connect and optionally rotate credentials. */
  _forceCredentialsStep: false,

  async shouldShow() {
    try {
      const res = await fetch('/api/onboarding/status');
      this._status = await res.json();
      const creds = this._status.needsCredentials === true;
      const profile = this._status.needsOnboarding === true;
      const llm = this._status.llmConfigured !== true;
      return creds || profile || llm;
    } catch {
      return false;
    }
  },

  _ensureModalShell() {
    document.body.classList.add('onboarding-modal-active');
    let root = document.getElementById('onboarding-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'onboarding-modal-root';
      root.className = 'onboarding-modal-root';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', 'onboarding-modal-title');
      root.innerHTML = `
        <div class="onboarding-modal-backdrop" aria-hidden="true"></div>
        <div class="onboarding-modal-frame">
          <header class="onboarding-modal-header">
            <img src="/icons/vodou-logo.png" alt="Vodou" class="onboarding-modal-logo" width="160" height="44" decoding="async" />
            <p id="onboarding-modal-title" class="onboarding-modal-sub">Complete the steps below to get started</p>
          </header>
          <div id="onboarding-modal-body" class="onboarding-modal-body"></div>
        </div>
      `;
      document.body.appendChild(root);
    }
    this._container = document.getElementById('onboarding-modal-body');
  },

  destroy() {
    this._stopWebPoll();
    document.body.classList.remove('onboarding-modal-active');
    document.getElementById('onboarding-modal-root')?.remove();
    this._container = null;
    this._returnNotice = null;
    this._returnFocusId = null;
  },

  show(container) {
    this._ensureModalShell();
    this._step = 0;
    this._data = {};
    this._returnNotice = null;
    this._returnFocusId = null;
    this._forceCredentialsStep = false;
    this._container.innerHTML = '<div class="onboarding-wrapper onboarding-wrapper--modal"><div class="onboarding-card"><div class="onboarding-loading"><p>Loading…</p></div></div></div>';
    fetch('/api/onboarding/status')
      .then((r) => r.json())
      .then((json) => {
        this._status = json;
        this._render();
      })
      .catch(() => {
        this._status = {};
        this._render();
      });
  },

  /** Step strip: all five steps visible; click any step to jump. "Saved" opens Connect to edit creds when token already in .env. */
  _renderProgress(card) {
    const stepIndex = this._step;
    const needsCred = this._status?.needsCredentials !== false;
    const labels = ['Connect', 'LLM', 'About you', 'Your AI', 'Memory', 'Demo'];
    const firstColSavedShortcut = !needsCred && stepIndex !== 0 && !this._forceCredentialsStep;

    const progress = document.createElement('div');
    progress.className = 'onboarding-progress';
    progress.setAttribute('role', 'tablist');
    progress.setAttribute('aria-label', 'Onboarding steps');

    for (let i = 0; i < labels.length; i++) {
      const isCurrent = i === stepIndex;
      const isPast = i < stepIndex || (i === 0 && firstColSavedShortcut);

      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'onboarding-progress-col';
      if (isCurrent) col.classList.add('onboarding-progress-col-current');

      if (i === 0 && firstColSavedShortcut) {
        col.classList.add('onboarding-progress-col-skipped', 'onboarding-progress-col-clickable');
        col.title = 'View or update Vodou credentials';
        col.setAttribute('aria-label', 'Credentials saved — click to edit');
        col.addEventListener('click', () => {
          this._saveFields();
          this._forceCredentialsStep = true;
          this._step = 0;
          this._render();
        });
      } else if (isCurrent) {
        col.setAttribute('aria-current', 'step');
      } else {
        col.classList.add('onboarding-progress-col-clickable');
        col.title = `Go to: ${labels[i]}`;
        col.addEventListener('click', () => {
          this._saveFields();
          if (i !== 0) this._forceCredentialsStep = false;
          this._step = i;
          this._render();
        });
      }

      const dot = document.createElement('span');
      dot.className = 'onboarding-dot';
      if (i === 0 && firstColSavedShortcut) dot.classList.add('onboarding-dot-skipped');
      else if (isCurrent) dot.classList.add('onboarding-dot-current');
      else if (isPast) dot.classList.add('onboarding-dot-done');
      else dot.classList.add('onboarding-dot-todo');

      const lab = document.createElement('span');
      lab.className = 'onboarding-progress-label';
      lab.textContent = i === 0 && firstColSavedShortcut ? 'Saved' : labels[i];

      col.appendChild(dot);
      col.appendChild(lab);
      progress.appendChild(col);
    }
    card.appendChild(progress);
  },

  _render() {
    this._stopWebPoll();   // any step change cancels the browser-lane poll
    // Token already in .env — skip Connect unless user opened it from "Saved" or first visit needs creds.
    if (this._step === 0 && this._status && !this._status.needsCredentials && !this._forceCredentialsStep) {
      this._step = 1;
    }
    const allSteps = [this._stepCredentials, this._stepLLM, this._stepUser, this._stepAI, this._stepMemory, this._stepDemo];

    const el = this._container;
    el.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'onboarding-wrapper';

    const card = document.createElement('div');
    card.className = 'onboarding-card';

    this._renderProgress(card);

    const pendingNotice = this._returnNotice;
    const pendingFocus = this._returnFocusId;
    this._returnNotice = null;
    this._returnFocusId = null;

    if (pendingNotice) {
      const notice = document.createElement('div');
      notice.className = 'onboarding-notice';
      notice.setAttribute('role', 'alert');
      notice.textContent = pendingNotice;
      card.appendChild(notice);
    }

    const body = document.createElement('div');
    body.className = 'onboarding-body';
    body.id = 'onboarding-body';
    card.appendChild(body);

    wrapper.appendChild(card);
    el.appendChild(wrapper);

    allSteps[this._step].call(this, body);

    if (pendingFocus) {
      requestAnimationFrame(() => {
        const focusEl = document.getElementById(pendingFocus);
        if (focusEl && typeof focusEl.focus === 'function') {
          focusEl.focus();
          focusEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    }
  },

  // ── Step 0: Credentials ──────────────────────────────────────
  _stepCredentials(body) {
    const editingSaved = !this._status.needsCredentials && this._forceCredentialsStep;
    const appUrl = 'https://app.vodou.ai';
    const appLink = `<a href="${appUrl}" target="_blank" rel="noopener noreferrer" class="onboarding-link-inline">app.vodou.ai</a>`;
    const mode = this._credMode || 'signin'; // 'signin' | 'signup'
    this._credMode = mode;
    const isSignup = mode === 'signup';
    const togglePrompt = isSignup
      ? `Already have an account? <a href="#" id="ob-toggle-mode" class="onboarding-link-inline">Sign in</a>`
      : `New to Vodou? <a href="#" id="ob-toggle-mode" class="onboarding-link-inline">Create an account</a>`;

    body.innerHTML = `
      <h2>Connect to Vodou</h2>
      <p class="onboarding-hint">${isSignup ? 'Create your Vodou account' : 'Sign in to Vodou'} — we'll set everything up automatically. ${togglePrompt}</p>
      <div class="onboarding-fields onboarding-fields-top">
        ${isSignup ? `
        <div class="ob-name-row">
          <label><span>First name <span class="ob-required">*</span></span><input type="text" id="ob-first" autocomplete="given-name" spellcheck="false"></label>
          <label><span>Last name <span class="ob-required">*</span></span><input type="text" id="ob-last" autocomplete="family-name" spellcheck="false"></label>
        </div>` : ''}
        <label><span>Email <span class="ob-required">*</span></span><input type="email" id="ob-email" autocomplete="email" spellcheck="false" autofocus></label>
        <label><span>Password <span class="ob-required">*</span></span><input type="password" id="ob-password" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></label>
        ${isSignup ? `<label><span>Confirm password <span class="ob-required">*</span></span><input type="password" id="ob-password2" autocomplete="new-password"></label>` : ''}
        ${isSignup ? `<p class="onboarding-hint onboarding-hint--small">At least 8 characters, with an uppercase letter, a lowercase letter, and a number.</p>` : ''}
      </div>
      <div id="ob-cred-error" class="onboarding-cred-error is-hidden"></div>
      ${this._status.eulaAccepted ? '' : `
      <label class="onboarding-hint onboarding-hint--small" style="display:flex;align-items:flex-start;gap:8px;margin:4px 0 0;cursor:pointer;">
        <input type="checkbox" id="ob-eula" style="margin-top:3px;">
        <span>I agree to the <a href="https://app.vodou.ai/eula.html" target="_blank" rel="noopener noreferrer" class="onboarding-link-inline">EULA</a>, <a href="https://app.vodou.ai/terms.html" target="_blank" rel="noopener noreferrer" class="onboarding-link-inline">Terms of Service</a>, and <a href="https://app.vodou.ai/privacy.html" target="_blank" rel="noopener noreferrer" class="onboarding-link-inline">Privacy Policy</a></span>
      </label>`}
      <div class="onboarding-actions">
        ${editingSaved ? '<button type="button" class="onboarding-btn" id="ob-cancel-creds">Back</button>' : ''}
        <button class="onboarding-btn primary" id="ob-auth-submit">${isSignup ? 'Create account & continue' : 'Sign in & continue'}</button>
      </div>
      <details class="onboarding-manual-fallback">
        <summary>Have a Vodou token already? Enter it manually</summary>
        <p class="onboarding-hint onboarding-hint--small">Get your keys at ${appLink}, then paste them here.</p>
        <div class="onboarding-fields">
          <label><span>Vodou Token</span><input type="text" id="ob-token" placeholder="Paste your VODOU_TOKEN" spellcheck="false" autocomplete="off"></label>
          <label><span>User ID</span><input type="text" id="ob-userId" placeholder="Paste your VODOU_USER_ID" spellcheck="false" autocomplete="off"></label>
        </div>
        <div class="onboarding-actions"><button class="onboarding-btn" id="ob-save-creds">Save token & continue</button></div>
      </details>
      <p class="onboarding-hint onboarding-hint--small" style="margin-top:16px; opacity:0.6;">
        By connecting, you agree Vodou records usage metadata (token counts, models, and tools used) to operate your account and billing. See our <a href="https://app.vodou.ai/terms.html" target="_blank" rel="noopener noreferrer" class="onboarding-link-inline">Terms</a> and <a href="https://app.vodou.ai/privacy.html" target="_blank" rel="noopener noreferrer" class="onboarding-link-inline">Privacy Policy</a>. BYOK usage telemetry can be disabled with <code>VODOU_USAGE_TELEMETRY=0</code>.
      </p>
    `;

    const errEl = body.querySelector('#ob-cred-error');
    const showErr = (m) => { errEl.innerHTML = m; errEl.classList.remove('is-hidden'); };
    const clearErr = () => errEl.classList.add('is-hidden');
    const onSuccess = async () => {
      this._forceCredentialsStep = false;
      try { const sr = await fetch('/api/onboarding/status'); this._status = await sr.json(); } catch {}
      this._step = 1;
      this._render();
    };

    const toggle = body.querySelector('#ob-toggle-mode');
    if (toggle) toggle.addEventListener('click', (e) => { e.preventDefault(); this._credMode = isSignup ? 'signin' : 'signup'; this._render(); });
    const cancel = body.querySelector('#ob-cancel-creds');
    if (cancel) cancel.addEventListener('click', () => { this._forceCredentialsStep = false; this._step = 1; this._render(); });

    // First-run click-wrap: the EULA checkbox gates BOTH connect paths. Absent
    // from the DOM only when this install already recorded acceptance.
    const eulaOk = () => {
      const el = body.querySelector('#ob-eula');
      if (el && !el.checked) {
        showErr('Please agree to the EULA, Terms of Service, and Privacy Policy to continue');
        return false;
      }
      return true;
    };

    // Primary path: sign in / create account via the gateway (server-side auth → .env)
    body.querySelector('#ob-auth-submit').addEventListener('click', async () => {
      clearErr();
      const email = body.querySelector('#ob-email').value.trim();
      const password = body.querySelector('#ob-password').value;
      if (!email) { showErr('Email is required'); body.querySelector('#ob-email').focus(); return; }
      if (!password) { showErr('Password is required'); body.querySelector('#ob-password').focus(); return; }
      if (!eulaOk()) return;
      let payload = { mode, email, password, eulaAccepted: true };
      if (isSignup) {
        const first = body.querySelector('#ob-first').value.trim();
        const last = body.querySelector('#ob-last').value.trim();
        const pw2 = body.querySelector('#ob-password2').value;
        if (!first || !last) { showErr('First and last name are required'); return; }
        if (password !== pw2) { showErr('Passwords do not match'); return; }
        payload = { ...payload, firstName: first, lastName: last };
      }
      const btn = body.querySelector('#ob-auth-submit'); const prev = btn.textContent;
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const res = await fetch('/api/onboarding/vodou-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (result.ok) {
          // Prefill identity for the About-You step. NOTE: verify these _data keys
          // against _stepUser before relying on them; harmless if they differ.
          if (isSignup) { this._data.userName = `${payload.firstName} ${payload.lastName}`.trim(); }
          this._data.ownerEmail = this._data.ownerEmail || email;
          await onSuccess();
          return;
        }
        if (result.code === 'email_exists') {
          showErr(`That email is already registered. <a href="#" id="ob-switch-signin" class="onboarding-link-inline">Sign in instead</a>.`);
          const s = body.querySelector('#ob-switch-signin');
          if (s) s.addEventListener('click', (e) => { e.preventDefault(); this._credMode = 'signin'; this._render(); });
        } else {
          showErr(result.error || 'Could not connect to Vodou');
        }
      } catch (err) {
        showErr('Connection error: ' + err.message);
      } finally {
        btn.disabled = false; btn.textContent = prev;
      }
    });

    // Fallback path: manual token paste — /save-credentials (also EULA-gated).
    body.querySelector('#ob-save-creds').addEventListener('click', async () => {
      clearErr();
      const token = body.querySelector('#ob-token').value.trim();
      const userId = body.querySelector('#ob-userId').value.trim();
      if (!token) { showErr('VODOU_TOKEN is required'); return; }
      if (!userId) { showErr('VODOU_USER_ID is required'); return; }
      if (!eulaOk()) return;
      try {
        const res = await fetch('/api/onboarding/save-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, userId, eulaAccepted: true })
        });
        const result = await res.json();
        if (result.success) { await onSuccess(); }
        else { showErr(result.error || 'Failed to save credentials'); }
      } catch (err) {
        showErr('Connection error: ' + err.message);
      }
    });
  },

  // ── Step 1: About You ────────────────────────────────────────
  _stepUser(body) {
    body.innerHTML = `
      <h2>About You</h2>
      <p class="onboarding-hint">The more detail you share, the better I can be from day one. It goes into your workspace profile, which you can edit anytime. I&rsquo;ll use it in every new conversation.</p>
      <div class="onboarding-fields">
        <label><span>Your name <span class="ob-required">*</span></span><input type="text" id="ob-userName" value="${this._esc(this._data.userName || '')}" placeholder="e.g. Chad" autofocus required></label>
        <label>What should I call you?<input type="text" id="ob-callThem" value="${this._esc(this._data.callThem || '')}" placeholder="Same as name, or a nickname"></label>
        <label><span>Your email <span class="ob-required">*</span></span>
          <input type="email" id="ob-ownerEmail" value="${this._esc(this._data.ownerEmail || '')}" placeholder="you@company.com" autocomplete="email" required>
        </label>
        <label>Timezone <span class="ob-detail-hint">detected from this browser &mdash; correct it if wrong</span>
          <input type="text" id="ob-timezone" value="${this._esc(this._data.timezone || this._detectTimezone())}" placeholder="e.g. America/Detroit">
        </label>
        <label>What are you working on? <span class="ob-detail-hint">Be specific &mdash; project name, tech stack, goals</span>
          <textarea id="ob-userContext" rows="3" placeholder="e.g. Building an AI orchestration platform in Rust + TypeScript. 10 MCP servers, 80 skills. Competing with Claude Cowork.">${this._esc(this._data.userContext || '')}</textarea>
        </label>
      </div>
      <div id="ob-user-error" class="onboarding-cred-error is-hidden" role="alert"></div>
      <div class="onboarding-actions">
        <button type="button" class="onboarding-btn" id="ob-back">Back</button>
        <button class="onboarding-btn primary" id="ob-next">Next</button>
      </div>
    `;
    body.querySelector('#ob-back').addEventListener('click', () => { this._saveFields(); this._step = 1; this._render(); });
    body.querySelector('#ob-next').addEventListener('click', () => {
      this._saveFields();
      const errEl = body.querySelector('#ob-user-error');
      const emailEl = body.querySelector('#ob-ownerEmail');
      errEl.classList.add('is-hidden');
      errEl.textContent = '';
      if (!this._data.userName?.trim()) {
        errEl.textContent = 'Your name is required';
        errEl.classList.remove('is-hidden');
        body.querySelector('#ob-userName').focus();
        return;
      }
      const rawEmail = (emailEl?.value || '').trim();
      if (!rawEmail) {
        errEl.textContent = 'Your email is required';
        errEl.classList.remove('is-hidden');
        emailEl?.focus();
        return;
      }
      if (emailEl && typeof emailEl.checkValidity === 'function' && !emailEl.checkValidity()) {
        errEl.textContent = 'Enter a valid email address';
        errEl.classList.remove('is-hidden');
        emailEl.focus();
        return;
      }
      const tz = (this._data.timezone || '').trim();
      if (tz && !this._isValidTimezone(tz)) {
        errEl.textContent = `"${tz}" isn't a timezone this machine recognizes — use an IANA name like America/Detroit`;
        errEl.classList.remove('is-hidden');
        body.querySelector('#ob-timezone').focus();
        return;
      }
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
    const s0 = suggestions[0];
    if (!this._data.aiName?.trim()) {
      this._data.aiName = s0.name;
      this._data.aiCreature = s0.creature;
      this._data.aiAvatarColor = s0.color;
      this._data.aiAvatarDefault = s0.avatar || '';
    }
    if (!this._data.aiVibe?.trim()) {
      this._data.aiVibe = s0.vibe;
    }

    const defaultName = this._data.aiName || s0.name;
    const defaultVibe = this._data.aiVibe || s0.vibe;
    const defaultCreature = this._data.aiCreature || s0.creature;
    const selectedIdx = Math.max(
      0,
      suggestions.findIndex((s) => s.name === (this._data.aiName || '').trim()),
    );

    body.innerHTML = `
      <h2>Your AI</h2>
      <p class="onboarding-hint">Pick a personality preset or create your own. This shapes how your AI communicates and approaches problems.</p>
      <div class="onboarding-presets" id="ob-presets">
        ${suggestions.map((s, i) => `
          <button type="button" class="onboarding-preset${i === selectedIdx ? ' selected' : ''}" data-idx="${i}">
            <span class="preset-av${s.avatar ? ' preset-av-image' : ''} preset-${s.name.toLowerCase()}">
              ${s.avatar ? `<img class="preset-av-img" src="${s.avatar}" alt="">` : s.name.slice(0, 2)}
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
          <textarea id="ob-aiVibe" rows="2" placeholder="e.g. Direct and resourceful with a dash of humor. Reads the room, reads the code, then speaks.">${this._esc(defaultVibe)}</textarea>
        </label>
        <label>Rules <span class="ob-detail-hint">Things your AI should always or never do</span>
          <textarea id="ob-alwaysDo" rows="3" placeholder="e.g. Always read the codebase before making changes&#10;Never delete a database without a backup&#10;Suggest improvements, don't just execute">${this._esc(this._data.alwaysDo || '')}</textarea>
        </label>
      </div>
      <div class="onboarding-actions">
        <button type="button" class="onboarding-btn" id="ob-back">Back</button>
        <button type="button" class="onboarding-btn primary" id="ob-next">Next</button>
      </div>
    `;

    body.querySelectorAll('.onboarding-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = suggestions[parseInt(btn.dataset.idx, 10)];
        body.querySelector('#ob-aiName').value = s.name;
        body.querySelector('#ob-aiVibe').value = s.vibe;
        body.querySelector('#ob-aiCreature').value = s.creature;
        this._data.aiAvatarColor = s.color;
        this._data.aiAvatarDefault = s.avatar || '';
        body.querySelectorAll('.onboarding-preset').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    body.querySelector('#ob-back').addEventListener('click', () => { this._saveFields(); this._forceCredentialsStep = false; this._step = 2; this._render(); });
    body.querySelector('#ob-next').addEventListener('click', () => {
      this._saveFields();
      if (!this._data.aiName) { body.querySelector('#ob-aiName').focus(); return; }
      this._finish();
    });
  },

  // ── Step 3: Connect Your LLM ─────────────────────────────────
  _stepLLM(body) {
    const providers = [
      { id: 'claude-cli', name: 'Claude CLI', icon: '\u{1F7E3}', desc: 'Uses your Anthropic Max subscription. No API costs.', badge: 'Recommended', needsKey: false,
        config: this._renderClaudeCliConfig() },
      { id: 'anthropic', name: 'Anthropic API', icon: '\u{1F511}', desc: 'Claude models via API key (pay-per-use)', needsKey: true, keyPlaceholder: 'sk-ant-...', keyField: 'anthropic_api_key' },
      { id: 'kimi-cli', name: 'Kimi Code CLI', icon: '\u{1F319}', desc: (window.VODOU_OS === 'windows' ? 'Not yet available on Windows — use Kimi (Moonshot API) below' : 'Moonshot terminal agent — run kimi login once'), needsKey: false },
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
        config: '<div class="onboarding-fields"><label><span>Base URL</span><input type="text" id="ob-llm-url" placeholder="http://localhost:1234/v1" class="settings-input"></label><label><span>Model name</span><input type="text" id="ob-llm-model" placeholder="e.g. gpt-4o, llama-3.3-70b" class="settings-input"></label></div>' },
    ];

    const primaryProviders = providers.slice(0, 4); // Claude CLI, Anthropic, OpenAI, Gemini
    const moreProviders = providers.slice(4);       // Groq, DeepSeek, xAI, Mistral, Ollama, Custom

    let html = `
      <h2>Connect Your AI Model</h2>
      <p class="onboarding-hint">Pick an AI provider &mdash; <strong>required</strong> for Vodou (chat, skills, workflows). You can change this anytime in Settings.</p>

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
        <button type="button" class="onboarding-btn" id="ob-back">Back</button>
        <button class="onboarding-btn primary" id="ob-next">Finish Setup</button>
      </div>
    `;

    body.innerHTML = html;

    let selectedProvider = null;
    let ollamaModel = null; // set by the llmfit recommendation strip when the user picks one
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
            // Ollama: offer hardware-matched model picks (llmfit). No-ops if unavailable.
            if (pid === 'ollama' && window.ModelFitStrip) {
              ModelFitStrip.mount('modelfit-ollama-onboarding', {
                bucket: 'ollama',
                onSelect: (ref) => { ollamaModel = ref; },
              });
            }
          }
        }
      });
    });

    const obBack = body.querySelector('#ob-back');
    obBack.addEventListener('click', () => {
      this._saveFields();
      if (this._status.needsCredentials) {
        this._forceCredentialsStep = false;
      } else {
        this._forceCredentialsStep = true;
      }
      this._step = 0;
      this._render();
    });
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

      // Collect custom URL + model if needed (backend requires both for 'custom')
      if (selectedProvider === 'custom') {
        const urlEl = body.querySelector('#ob-llm-url');
        const modelEl = body.querySelector('#ob-llm-model');
        if (urlEl?.value?.trim()) saveBody.custom_llm_base_url = urlEl.value.trim();
        if (modelEl?.value?.trim()) saveBody.custom_llm_model = modelEl.value.trim();
      }
      if (selectedProvider === 'ollama' && ollamaModel) saveBody.ollama_model = ollamaModel;
      if (selectedProvider === 'kimi') saveBody.kimi_model = 'kimi-k2.6';
      if (selectedProvider === 'kimi-cli') saveBody.kimi_cli_model = 'kimi-k2.6';
      if (selectedProvider === 'openrouter') saveBody.openrouter_model = 'openai/gpt-4o';

      const statusEl = body.querySelector('#ob-llm-status');
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(saveBody)
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) {
          statusEl.innerHTML = `<div class="status-error-text text-sm">${this._esc(result.error || res.statusText || 'Failed to save provider')}</div>`;
          return;
        }
        const sr = await fetch('/api/onboarding/status');
        const st = await sr.json().catch(() => ({}));
        this._status = { ...this._status, ...st };
        if (st.llmConfigured !== true) {
          statusEl.innerHTML = '<div class="status-error-text text-sm">Settings saved, but no AI model is active yet. Add a missing API key or URL, or pick another provider.</div>';
          return;
        }
      } catch (e) {
        console.error('Failed to save provider:', e);
        statusEl.innerHTML = `<div class="status-error-text text-sm">${this._esc(e.message || 'Connection error')}</div>`;
        return;
      }

      // Move to About You step
      this._step = 2; this._render();
    });
  },

  // ── Step 4: See It Work (Live Demo) ──────────────────────────
  // ── Step 4: Memory — "Should I remember your other AIs?" ─────────────
  // PLAN-MEMORY-EVERYWHERE-FRONTEND P3. Plain-language capture-lane toggles
  // over PUT /api/capture/settings + a drop-your-export offer. Skippable;
  // defaults conservative (everything except BYOK stays off).

  // ── The browser lane in onboarding (PLAN-ONBOARDING-EXTENSION-STEP) ─────────
  //
  // The consent question and the flag it writes already existed. What was missing
  // was any way to ACT on the answer: the row said "needs the Vodou Bridge browser
  // extension" and then offered no link, no store, and no way to tell whether it
  // had arrived.
  //
  // Answering here works before the extension exists — syncCaptureArmedToExtension()
  // runs on every bridge_ready and no-ops when the setting was never written, so
  // "yes" now and install later arms capture on the first handshake with no second
  // visit to settings. That is why this is an affordance, not a gate.

  // The store identity moved to js/ext-store.js — this file claimed to be its ONE
  // place while four other surfaces carried their own copy of the id. These two
  // accessors stay so the call sites below read the same as they always did.
  get _EXT_LISTING_LIVE() { return window.VodouExtStore.LISTING_LIVE; },

  _extInstallUrl() { return window.VodouExtStore.installUrl(); },

  _webExtraHtml(web) {
    if (web.connected) {
      // Connection is not capture. Today's sessions burned hours on states where the
      // socket was fine and nothing was saved — pairing rejections, two installs
      // fighting for the one slot, a stale service worker. So offer proof, not a
      // reassurance.
      return `<span class="ob-web-proof" id="ob-web-proof">Connected. Send a message in any supported chat and it will appear in your memory.</span>`;
    }
    if (!this._EXT_LISTING_LIVE) {
      return `<span class="ob-detail-hint">The extension is awaiting Chrome Web Store review. Tick this now anyway \u2014 capture arms itself the moment the extension connects, with no second trip to settings.</span>`;
    }
    return `<a class="onboarding-btn ob-web-install" id="ob-web-install" href="${this._extInstallUrl()}" target="_blank" rel="noopener noreferrer">Install the extension</a>
            <span class="ob-detail-hint">Opens the Chrome Web Store. Tick this now \u2014 capture arms itself when the extension connects.</span>`;
  },

  // Poll for the extension arriving while the step is open. Reads once at render
  // otherwise, which leaves someone who installs mid-step looking at stale text
  // until they navigate away and back.
  //
  // Deliberately does NOT auto-advance: the user may still be deciding about the
  // other two lanes, and advancing under someone's cursor is its own bug.
  _startWebPoll(body) {
    this._stopWebPoll();
    this._webPoll = setInterval(async () => {
      // The step is gone (navigated, or the modal closed) — stop rather than keep a
      // 2s timer alive on a screen nobody is looking at.
      const slot = body.querySelector('#ob-web-extra');
      if (!slot || !slot.isConnected) { this._stopWebPoll(); return; }
      try {
        const r = await fetch('/api/capture/pair');
        const j = await r.json();
        if (j && j.connected) {
          this._stopWebPoll();
          slot.innerHTML = this._webExtraHtml({ connected: true });
          const hint = body.querySelector('#ob-mem-web')?.closest('.onboarding-mem-row')?.querySelector('.ob-detail-hint');
          if (hint) hint.textContent = 'the Vodou Bridge extension is connected \u2713';
        }
      } catch { /* gateway busy or route unavailable — try again next tick */ }
    }, 2000);
  },

  _stopWebPoll() {
    if (this._webPoll) { clearInterval(this._webPoll); this._webPoll = null; }
  },

  async _stepMemory(body) {
    this._saveFields();
    let lanes = null;
    try {
      const r = await fetch('/api/capture/status');
      lanes = (await r.json())?.lanes || null;
    } catch { /* gateway route unavailable — render with defaults */ }
    const ide = lanes?.ide || { enabled: false, overridden_by_env: false };
    const byok = lanes?.byok || { enabled: true, overridden_by_env: false };
    const web = lanes?.web || { enabled: false, connected: false, overridden_by_env: false };

    // A lane fixed by an environment variable is NOT a control. Rendering it as a
    // greyed checkbox asks the user to do something they cannot do and does not say
    // why — Chad, 2026-08-02: "if you can't change it why show it?". Worth showing,
    // because the lane is on and hiding it would misrepresent what is being captured;
    // not worth pretending it is adjustable. So: state the fact, name the variable,
    // and say where to change it. A dead checkbox becomes an instruction.
    const row = (id, title, desc, checked, locked, envKey) => {
      if (locked) {
        return `
      <div class="onboarding-mem-row onboarding-mem-locked">
        <span class="ob-lane-state ${checked ? 'is-on' : 'is-off'}">${checked ? 'On' : 'Off'}</span>
        <span class="onboarding-mem-text">
          <strong>${title}</strong>
          <span class="ob-detail-hint">${desc}</span>
          <span class="ob-detail-hint">Fixed by <code>${envKey || 'an environment variable'}</code> in your <code>.env</code> — change it there, then restart Vodou.</span>
        </span>
      </div>`;
      }
      return `
      <label class="onboarding-mem-row">
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
        <span class="onboarding-mem-text">
          <strong>${title}</strong>
          <span class="ob-detail-hint">${desc}</span>
        </span>
      </label>`;
    };

    body.innerHTML = `
      <h2>Should I remember your other AIs?</h2>
      <p class="onboarding-hint">Everything you do with any AI can flow into one memory that lives on this machine and belongs to you. Flip on what you want remembered — you can see and delete any memory later, and switch these off anytime.</p>
      <div class="onboarding-fields onboarding-fields-top">
        ${row('ob-mem-ide', `AI coding on ${this._machineNoun()}`, 'Cursor and Claude Code sessions, checked every few minutes', ide.enabled, ide.overridden_by_env, ide.env_key)}
        ${row('ob-mem-web', 'Your AI chats in the browser', web.connected ? 'the Vodou Bridge extension is connected \u2713' : 'ChatGPT, Claude, Gemini, Grok and 18 more \u2014 needs the Vodou Bridge extension', web.enabled, web.overridden_by_env, web.env_key)}
        <div id="ob-web-extra" class="ob-web-extra">${this._webExtraHtml(web)}</div>
        ${row('ob-mem-backfill', 'Also what you said before today',
              'when you open an old chat, file the rest of that conversation too \u2014 no extra requests, only chats you open yourself',
              false, false, '')}
        ${row('ob-mem-byok', 'Apps that use your API key through Vodou', 'anything pointed at your local gateway', byok.enabled, byok.overridden_by_env, byok.env_key)}
      </div>
      <p class="onboarding-hint">Have years of history elsewhere? After setup, drop a ChatGPT or Claude export into <strong>Brain → Sources</strong> and it becomes memory too.</p>
      <div class="onboarding-actions">
        <button type="button" class="onboarding-btn" id="ob-back">Back</button>
        <button type="button" class="onboarding-btn" id="ob-mem-skip">Skip for now</button>
        <button type="button" class="onboarding-btn primary" id="ob-next">Next</button>
      </div>
    `;

    if (!web.connected) this._startWebPoll(body);

    body.querySelector('#ob-back').addEventListener('click', () => { this._step = 3; this._render(); });
    body.querySelector('#ob-mem-skip').addEventListener('click', () => { this._step = 5; this._render(); });
    body.querySelector('#ob-next').addEventListener('click', async () => {
      const settings = {};
      const ideBox = body.querySelector('#ob-mem-ide');
      const webBox = body.querySelector('#ob-mem-web');
      const byokBox = body.querySelector('#ob-mem-byok');
      // A locked lane renders no checkbox, so these are null and the lane is skipped.
      // That is deliberate: writing a setting the environment overrides would store a
      // value that never takes effect and would reappear as a phantom on any later read.
      if (ideBox && !ideBox.disabled) {
        settings['capture.ide.enabled'] = ideBox.checked ? '1' : '0';
        if (ideBox.checked) settings['capture.ide.sources'] = 'all';
      }
      if (webBox && !webBox.disabled) settings['capture.web.armed'] = webBox.checked ? '1' : '0';
      // PLAN-HISTORY-BACKFILL — asked HERE because backfill's whole value is day one,
      // and its only home until now was several clicks deep in the extension panel,
      // where a new install never looks. Stored gateway-side and pushed to the
      // extension on the next bridge_ready, so answering before the extension exists
      // still works — same affordance-not-gate reasoning as the install row above.
      const backfillBox = body.querySelector('#ob-mem-backfill');
      if (backfillBox) settings['capture.web.backfill'] = backfillBox.checked ? '1' : '0';
      if (byokBox && !byokBox.disabled) settings['capture.byok.enabled'] = byokBox.checked ? '1' : '0';
      try {
        await fetch('/api/capture/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });
      } catch { /* settings save is best-effort here — Sources panel can redo it */ }
      this._step = 5;
      this._render();
    });
  },

  async _stepDemo(body) {
    this._saveFields();
    let st = this._status || {};
    try {
      const r = await fetch('/api/onboarding/status');
      st = await r.json();
      this._status = { ...this._status, ...st };
    } catch { /* keep cached */ }
    if (st.needsOnboarding !== false || st.llmConfigured !== true) {
      const goStep = !st.llmConfigured ? 1 : 2;
      body.innerHTML = `
        <h2>Almost there</h2>
        <p class="onboarding-hint">${!st.llmConfigured
          ? 'Connect an <strong>AI model</strong> on the LLM step first &mdash; Vodou needs it for chat and skills.'
          : 'Finish <strong>About you</strong> and <strong>Your AI</strong> before this recap. Use the progress bar above, or continue below.'}</p>
        <div class="onboarding-actions">
          <button type="button" class="onboarding-btn primary" id="ob-demo-continue">Continue setup</button>
        </div>`;
      body.querySelector('#ob-demo-continue').addEventListener('click', () => {
        this._step = goStep;
        this._render();
      });
      return;
    }

    const d = this._data;
    const first = this._demoDisplayFirstName(d);
    const h2 = first ? `Hey ${this._esc(first)} &mdash; I&rsquo;m Alive` : `I&rsquo;m Alive`;

    body.innerHTML = `
      <div class="demo-header">
        <div class="demo-header-brand">
          <img src="/icons/vodou-icon.png" alt="" class="demo-brand-icon" width="64" height="64" decoding="async" />
          <h2>${h2}</h2>
        </div>
        <div id="demo-welcome-blurb" class="demo-welcome-blurb" aria-live="polite">
          <div class="demo-welcome-shimmer">Cooking up something personal for you&hellip;</div>
        </div>
        <div class="demo-pulse-wrap">
          <p class="demo-pulse-line" aria-hidden="true"><span class="demo-pulse-dot"></span> Live snapshot &mdash; pulled from ${this._machineNoun()} right now</p>
        </div>
        <p class="onboarding-hint demo-hint-below">Below is real hardware${this._isMac() ? ', what&rsquo;s on screen,' : ''} and the tools already wired in. This is the same stack that powers chat.</p>
      </div>
      <div class="demo-grid" id="demo-grid">
        <div class="demo-card" id="demo-system">
          <div class="demo-card-title">${this._machineTitle()}</div>
          <div class="demo-card-body demo-loading">Scanning&hellip;</div>
        </div>
        ${this._isMac() ? `<div class="demo-card" id="demo-screen">
          <div class="demo-card-title">On your screen</div>
          <div class="demo-card-body demo-loading">Looking&hellip;</div>
        </div>` : ''}
        <div class="demo-card demo-wide" id="demo-toolkit">
          <div class="demo-card-title">Your live stack</div>
          <div class="demo-card-body demo-loading">Loading...</div>
        </div>
      </div>
      ${d.userContext ? `<div class="demo-context" id="demo-context"><span class="demo-context-label">You said you&rsquo;re building</span> <em>&ldquo;${this._esc(d.userContext.substring(0, 140))}${d.userContext.length > 140 ? '…' : ''}&rdquo;</em> &mdash; <span class="demo-context-tail">that&rsquo;s fair game for the first chat.</span></div>` : ''}
      <div class="onboarding-actions onboarding-actions-lg">
        <button type="button" class="onboarding-btn" id="ob-back-demo">Back</button>
        <button class="onboarding-btn primary onboarding-btn-go" id="ob-go">Start</button>
      </div>
    `;

    body.querySelector('#ob-back-demo').addEventListener('click', () => {
      this._saveFields();
      this._forceCredentialsStep = false;
      this._step = 4;
      this._render();
    });
    body.querySelector('#ob-go').addEventListener('click', async () => {
      this._saveFields();
      try {
        const sr = await fetch('/api/onboarding/status');
        this._status = { ...this._status, ...(await sr.json()) };
      } catch { /* keep cached status */ }
      const miss = this._firstMissingRequirementForChat();
      if (miss) {
        this._returnNotice = miss.message;
        this._returnFocusId = miss.focusId || null;
        this._step = miss.step;
        this._render();
        return;
      }
      this.destroy();
      location.hash = '#/chat';
      const focusHeartbeat = () => {
        if (typeof ChatView === 'undefined' || !Array.isArray(ChatView._tabs)) {
          requestAnimationFrame(focusHeartbeat);
          return;
        }
        const hb = ChatView._tabs.find((t) => t.conversationId === 'vodou-heartbeat');
        if (hb) ChatView._switchTab(hb.id);
      };
      focusHeartbeat();
    });

    // Fire welcome copy + toolkit cards in parallel
    this._loadWelcomeBlurb();
    this._runDemo();
  },

  _demoDisplayFirstName(d) {
    const call = String(d.callThem || '').trim();
    const name = String(d.userName || '').trim();
    const t = (call || name).trim();
    if (!t || /^there$/i.test(t)) return '';
    return t;
  },

  _obEmailValid(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
  },

  /**
   * First blocking requirement for leaving onboarding to chat (same order as steps).
   * @returns {{ step: number, message: string, focusId: string | null } | null}
   */
  _firstMissingRequirementForChat() {
    const d = this._data;
    const st = this._status || {};
    if (st.needsCredentials === true) {
      return {
        step: 0,
        message: 'Add your Vodou token and User ID on Connect before starting chat.',
        focusId: 'ob-token',
      };
    }
    if (st.llmConfigured !== true) {
      return {
        step: 1,
        message: 'Pick and save an AI provider on the LLM step — Vodou needs a model for chat.',
        focusId: null,
      };
    }
    if (!String(d.userName || '').trim()) {
      return {
        step: 2,
        message: 'Enter your name on About you (required).',
        focusId: 'ob-userName',
      };
    }
    const email = String(d.ownerEmail || '').trim();
    if (!email) {
      return {
        step: 2,
        message: 'Enter your email on About you (required).',
        focusId: 'ob-ownerEmail',
      };
    }
    if (!this._obEmailValid(email)) {
      return {
        step: 2,
        message: 'Enter a valid email address on About you.',
        focusId: 'ob-ownerEmail',
      };
    }
    if (!String(d.aiName || '').trim()) {
      return {
        step: 3,
        message: 'Give your AI a name on the Your AI step (required).',
        focusId: 'ob-aiName',
      };
    }
    return null;
  },

  _loadWelcomeBlurb() {
    const el = document.getElementById('demo-welcome-blurb');
    if (!el) return;
    const d = this._data;
    const first = this._demoDisplayFirstName(d);
    const a = (d.aiName || 'VODOU').trim() || 'VODOU';
    const fallback = first
      ? `${first} — ${a} is live. Vodou lines up skills, parallel MCP tools, and workspace memory so you can ship with less thrash. Say the messy goal in chat when you're ready — we'll route the grunt work and keep receipts.`
      : `${a} is live on ${this._machineNoun()}. You haven't filled in a name yet — that's fine. Vodou still lines up skills, parallel MCP tools, and workspace memory; say what you're chasing in chat when you're ready and we'll route the grunt work.`;

    fetch('/api/onboarding/welcome-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(120_000) : undefined,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        let raw = String(j.text || '').trim();
        raw = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        if (!raw) {
          el.innerHTML = `<p class="demo-welcome-p">${this._esc(fallback)}</p>`;
          return;
        }
        const parts = raw.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length === 0) {
          el.innerHTML = `<p class="demo-welcome-p">${this._esc(fallback)}</p>`;
          return;
        }
        el.innerHTML = parts.map((p) => `<p class="demo-welcome-p">${this._esc(p)}</p>`).join('');
      })
      .catch(() => {
        el.innerHTML = `<p class="demo-welcome-p">${this._esc(fallback)}</p>`;
      });
  },

  /** Server OS helpers — VODOU_OS comes from platform.js (server-authoritative). */
  _isMac() { return (window.VODOU_OS || 'mac') === 'mac'; },
  _machineNoun() { const os = window.VODOU_OS || 'mac'; return os === 'mac' ? 'this Mac' : os === 'windows' ? 'this PC' : 'this machine'; },
  _machineTitle() { const os = window.VODOU_OS || 'mac'; return os === 'mac' ? 'Your Mac' : os === 'windows' ? 'Your PC' : 'Your machine'; },
  _osLabel(ver) {
    const os = window.VODOU_OS || 'mac';
    const name = os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux';
    return ver ? `${name} ${ver}` : name;
  },

  async _runDemo() {
    const [systemResult, screenResult, toolsResult, workflowsResult, diskResult, hostResult, memResult] = await Promise.allSettled([
      this._demoCall('mcp-monitor', 'get_cpu_info', {}),
      // Screen card is mac-only (vodou-mac-control ships only on macOS)
      this._isMac() ? this._demoCall('vodou-mac-control', 'list_windows', {}) : Promise.resolve(null),
      fetch('/api/tools').then((r) => r.json()),
      fetch('/api/workflows').then((r) => r.json()),
      this._demoCall('mcp-monitor', 'get_disk_info', { path: window.VODOU_OS === 'windows' ? 'C:\\' : '/' }),
      this._demoCall('mcp-monitor', 'get_host_info', {}),
      this._demoCall('mcp-monitor', 'get_memory_info', {}),
    ]);

    // ── System card (CPU + memory + disk + host — all work on macOS via mcp-monitor) ──
    const sysCard = document.querySelector('#demo-system .demo-card-body');
    if (sysCard) {
      try {
        const cpu = this._parseDemoResult(systemResult);
        const mem = this._parseDemoResult(memResult);
        const disk = this._parseDemoResult(diskResult);
        const host = this._parseDemoResult(hostResult);

        const modelName = (cpu?.info && cpu.info[0] && cpu.info[0].modelName) ? String(cpu.info[0].modelName).trim() : '';
        const arch = host?.info?.kernelArch ? String(host.info.kernelArch) : '';
        const macVer = host?.info?.platformVersion ? String(host.info.platformVersion) : '';
        const heroParts = [];
        if (modelName) heroParts.push(modelName);
        if (macVer) heroParts.push(this._osLabel(macVer));
        if (arch) heroParts.push(arch);
        const heroLine = heroParts.length ? heroParts.join(' · ') : this._machineTitle().replace('Your', 'This');

        const cores = cpu?.core_count != null ? cpu.core_count : '?';
        const loadPct =
          Array.isArray(cpu?.usage_percent) && cpu.usage_percent.length && typeof cpu.usage_percent[0] === 'number'
            ? Math.round(cpu.usage_percent[0])
            : null;

        const vmem = mem?.virtual;
        const memTotalGb = vmem?.total ? (vmem.total / (1024 * 1024 * 1024)).toFixed(0) : '';
        const memUsedPct = vmem?.used_percent != null ? Math.round(vmem.used_percent) : '';

        const usage = disk?.usage;
        let diskGbFree = '';
        let diskPct = '';
        if (usage && typeof usage.free === 'number' && usage.total) {
          diskGbFree = (usage.free / (1024 * 1024 * 1024)).toFixed(0);
          if (usage.usedPercent != null) diskPct = `${Math.round(usage.usedPercent)}% disk used`;
        }

        const hn = host?.info?.hostname ? String(host.info.hostname) : '';
        const shortHost = this._demoShortHost(hn);
        const uptimeStr = this._demoFormatUptime(typeof host?.uptime === 'number' ? host.uptime : null);
        const nproc = host?.info?.procs != null ? Number(host.info.procs) : null;

        const statsHtml = [];
        statsHtml.push(
          `<div class="demo-stat"><span class="demo-stat-value">${this._esc(String(cores))}</span><span class="demo-stat-label">CPU cores</span></div>`,
        );
        if (loadPct != null) {
          statsHtml.push(
            `<div class="demo-stat"><span class="demo-stat-value">${loadPct}%</span><span class="demo-stat-label">CPU load</span></div>`,
          );
        }
        if (memTotalGb) {
          const sub = memUsedPct !== '' ? `${memUsedPct}% RAM used` : 'RAM';
          statsHtml.push(
            `<div class="demo-stat"><span class="demo-stat-value">${this._esc(memTotalGb)} GB</span><span class="demo-stat-label">${this._esc(sub)}</span></div>`,
          );
        }
        if (diskGbFree) {
          statsHtml.push(
            `<div class="demo-stat"><span class="demo-stat-value">${this._esc(diskGbFree)} GB</span><span class="demo-stat-label">${diskPct ? this._esc(diskPct) : 'free on disk'}</span></div>`,
          );
        }

        const metaBits = [];
        if (shortHost) metaBits.push(shortHost);
        if (uptimeStr) metaBits.push(uptimeStr);
        if (nproc != null && !Number.isNaN(nproc)) metaBits.push(`${nproc} processes running`);
        const metaLine = metaBits.join(' · ');

        sysCard.className = 'demo-card-body';
        sysCard.innerHTML = `
          <div class="demo-system-hero">${this._esc(heroLine)}</div>
          <div class="demo-system-stats">${statsHtml.join('')}</div>
          ${metaLine ? `<div class="demo-system-meta">${this._esc(metaLine)}</div>` : ''}
        `;
      } catch {
        sysCard.className = 'demo-card-body';
        // mcp-monitor ships on macOS today; cross-platform binary is in progress.
        sysCard.textContent = this._isMac() ? 'System monitoring ready' : 'Live hardware stats coming soon on ' + this._osLabel();
      }
    }

    // ── Screen card ──
    const screenCard = document.querySelector('#demo-screen .demo-card-body');
    if (screenCard) {
      try {
        const windows = this._parseDemoResult(screenResult);
        const windowList = windows?.windows || [];
        const maxBadges = 14;
        const uniqueApps = [...new Set(windowList.map((w) => w.app).filter(Boolean))];
        const apps = uniqueApps.slice(0, maxBadges);
        const moreApps = uniqueApps.length > maxBadges ? uniqueApps.length - maxBadges : 0;

        screenCard.className = 'demo-card-body';
        if (apps.length > 0) {
          screenCard.innerHTML = `
            <div class="demo-card-kicker">Live window list from ${this._machineNoun()}</div>
            <div class="demo-apps-row">
              ${apps.map((app) => `<span class="demo-app-badge">${this._esc(app)}</span>`).join(' ')}
              ${moreApps > 0 ? `<span class="demo-apps-more">+${moreApps} more apps</span>` : ''}
            </div>
            <div class="demo-apps-count">${windowList.length} windows across ${uniqueApps.length} apps &mdash; context I can use when you ask</div>
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
          <div class="demo-toolkit-wow">Skills, MCP tools, and memory work together &mdash; describe a goal once and I fan out in parallel.</div>
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

  _demoShortHost(hostname) {
    if (!hostname) return '';
    let h = String(hostname).replace(/\.local\.?$/i, '').trim();
    if (h.length > 32) h = `${h.slice(0, 30)}…`;
    return h;
  },

  _demoFormatUptime(seconds) {
    if (seconds == null || Number.isNaN(seconds) || seconds < 60) return '';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h up`;
    if (h > 0) return `${h}h ${m}m up`;
    return `${m}m up`;
  },

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
    const os = window.VODOU_OS || 'mac';
    if (os === 'windows') {
      return `
        <div class="onboarding-cli-step">Step 1 — Install Claude CLI (PowerShell):</div>
        <code class="cli-install-cmd cli-install-cmd-select">irm https://claude.ai/install.ps1 | iex</code>
        <div class="onboarding-cli-step">Step 2 — Open a <strong>new</strong> PowerShell window (PATH refresh), then authenticate:</div>
        <code class="cli-install-cmd cli-install-cmd-select">claude</code>
        <div class="onboarding-cli-note">Requires a Claude Pro/Max account. Sign in via the browser window that opens.</div>
      `;
    }
    const rc = os === 'mac' ? '~/.zshrc' : '~/.bashrc';
    return `
      <div class="onboarding-cli-step">Step 1 — Install Claude CLI:</div>
      <code class="cli-install-cmd cli-install-cmd-select">curl -fsSL https://claude.ai/install.sh | bash</code>
      <div class="onboarding-cli-step">Step 2 — Add to PATH:</div>
      <code class="cli-install-cmd cli-install-cmd-select">echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc} && source ${rc}</code>
      <div class="onboarding-cli-note">Then run <code>claude</code> once to authenticate.</div>
    `;
  },

  _renderOllamaConfig() {
    const os = window.VODOU_OS || 'mac';
    const install = os === 'mac'
      ? '<code class="cli-install-cmd">brew install ollama && ollama pull llama3</code>'
      : os === 'windows'
        ? '<div class="onboarding-cli-note">Download the installer from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a>, then <code>ollama pull llama3</code>.</div>'
        : '<code class="cli-install-cmd">curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3</code>';
    return `
      ${install}
      <div class="onboarding-cli-note">Then <code>ollama serve</code> to start. Needs 16GB+ RAM.</div>
      <div id="modelfit-ollama-onboarding" class="modelfit-host"></div>
    `;
  },

  // IANA timezone, straight from the browser — nobody should ever TYPE a
  // timezone; the machine knows. Free text is how we ended up with "EST"
  // in one placeholder and "America/New_York" in the other.
  _detectTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch { return ''; }
  },

  _isValidTimezone(tz) {
    try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
    catch { return false; }
  },

  _saveFields() {
    const fields = ['userName', 'callThem', 'ownerEmail', 'timezone', 'userContext', 'aiName', 'aiEmoji', 'aiVibe', 'aiCreature', 'alwaysDo', 'neverDo', 'aiAvatarColor', 'aiAvatarDefault'];
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
        if (result.continuityBootstrap && !result.continuityBootstrap.ok) {
          console.warn('[Onboarding] continuity bootstrap:', result.continuityBootstrap.detail);
        }
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
