/**
 * Setup Wizard — guided onboarding for new users
 */
const SetupWizard = {
  currentStep: 0,
  steps: ['connect', 'skills', 'explore', 'chat', 'automate'],
  installedServer: null,

  shouldShow() {
    if (localStorage.getItem('onboarding-complete')) return false;
    // Show if no servers registered (checked by caller)
    return true;
  },

  render(container) {
    this.currentStep = parseInt(localStorage.getItem('onboarding-step') || '0');
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'setup-wizard';

    // Header
    const header = document.createElement('div');
    header.className = 'setup-header';
    header.innerHTML = `
      <h2 class="setup-title">Set Up Vodou</h2>
      <p class="setup-subtitle">Let's get you started in a few quick steps.</p>
    `;

    const startOver = document.createElement('a');
    startOver.href = '#';
    startOver.className = 'setup-start-over';
    startOver.id = 'setup-start-over';
    startOver.textContent = 'Start over';
    startOver.classList.toggle('is-hidden', this.currentStep === 0);
    startOver.addEventListener('click', (e) => {
      e.preventDefault();
      this.currentStep = 0;
      localStorage.setItem('onboarding-step', '0');
      this._updateUI();
    });
    header.appendChild(startOver);
    wrapper.appendChild(header);

    // Progress dots
    const progress = document.createElement('div');
    progress.className = 'setup-progress';
    for (let i = 0; i < this.steps.length; i++) {
      const dot = document.createElement('div');
      dot.className = 'setup-dot' + (i === this.currentStep ? ' active' : '') + (i < this.currentStep ? ' done' : '');
      progress.appendChild(dot);
    }
    wrapper.appendChild(progress);

    // Step content
    const content = document.createElement('div');
    content.className = 'setup-content';
    content.id = 'setup-step-content';
    wrapper.appendChild(content);

    container.appendChild(wrapper);
    this._renderStep(content);
  },

  _renderStep(content) {
    content.innerHTML = '';

    switch (this.steps[this.currentStep]) {
      case 'connect': this._renderConnect(content); break;
      case 'skills': this._renderSkills(content); break;
      case 'explore': this._renderExplore(content); break;
      case 'chat': this._renderChat(content); break;
      case 'automate': this._renderAutomate(content); break;
    }
  },

  _renderConnect(content) {
    content.innerHTML = `
      <h3 class="setup-step-title">Connect a Tool</h3>
      <p class="setup-step-desc">Tools give Vodou new abilities. Search for one to install, or skip for now.</p>
    `;

    // Search
    const searchRow = document.createElement('div');
    searchRow.className = 'setup-search-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search for tools... (e.g. filesystem, github, database)';
    input.className = 'setup-search-input';
    searchRow.appendChild(input);

    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn btn-primary';
    searchBtn.textContent = 'Search';
    searchRow.appendChild(searchBtn);
    content.appendChild(searchRow);

    const results = document.createElement('div');
    results.id = 'setup-search-results';
    content.appendChild(results);

    const self = this;
    async function doSearch() {
      const q = input.value.trim();
      if (!q) return;
      results.innerHTML = '';
      results.appendChild(Components.loading());
      searchBtn.disabled = true;
      try {
        const data = await API.get(`/api/servers/search?q=${encodeURIComponent(q)}&limit=5`);
        results.innerHTML = '';
        if (!data.results || data.results.length === 0) {
          results.innerHTML = '<div class="empty-state">No servers found</div>';
          return;
        }
        for (const srv of data.results) {
          const card = document.createElement('div');
          card.className = 'setup-result-card';

          // Install type badge
          const typeBadge = srv.install_type === 'remote' ? ' (remote)' :
            srv.install_type === 'npm' ? ' (npm)' : '';

          card.innerHTML = `
            <div class="setup-result-info">
              <span class="setup-result-name">${srv.name}${typeBadge ? `<span class="setup-type-badge">${typeBadge}</span>` : ''}</span>
              <span class="setup-result-desc">${srv.description || ''}</span>
            </div>
          `;

          // Env var form (hidden by default)
          const requiredEnvVars = (srv.environment_variables || []).filter(v => v.isRequired);
          let envForm = null;
          if (requiredEnvVars.length > 0) {
            envForm = document.createElement('div');
            envForm.className = 'setup-env-form is-hidden';
            envForm.innerHTML = '<p class="setup-env-label">Required credentials:</p>';
            for (const envVar of requiredEnvVars) {
              const row = document.createElement('div');
              row.className = 'setup-env-row';
              row.innerHTML = `
                <label class="setup-env-name">${envVar.name}</label>
                <input type="${envVar.isSecret ? 'password' : 'text'}"
                  class="setup-search-input setup-env-input"
                  placeholder="${envVar.description || envVar.name}"
                  data-env-name="${envVar.name}" />
              `;
              envForm.appendChild(row);
            }
          }

          const installBtn = document.createElement('button');
          installBtn.className = 'btn btn-primary btn-sm';
          installBtn.textContent = srv.install_type === 'remote' ? 'Connect' : 'Install';

          installBtn.addEventListener('click', async () => {
            // If env vars required and form not shown yet, show it
            if (envForm && envForm.classList.contains('is-hidden')) {
              envForm.classList.remove('is-hidden');
              installBtn.textContent = 'Confirm';
              return;
            }

            // Collect env vars from form
            const env = {};
            if (envForm) {
              const inputs = envForm.querySelectorAll('.setup-env-input');
              for (const inp of inputs) {
                const name = inp.getAttribute('data-env-name');
                const val = inp.value.trim();
                if (name && val) env[name] = val;
              }
              // Validate required fields are filled
              for (const envVar of requiredEnvVars) {
                if (!env[envVar.name]) {
                  Components.toast(`${envVar.name} is required`, 'error');
                  return;
                }
              }
            }

            installBtn.textContent = srv.install_type === 'remote' ? 'Connecting...' : 'Installing...';
            installBtn.disabled = true;
            try {
              await API.post('/api/servers/install', {
                name: srv.name,
                install_type: srv.install_type,
                remote_url: srv.remote_url,
                env: Object.keys(env).length ? env : undefined,
              });
              Components.toast(`${srv.name} ${srv.install_type === 'remote' ? 'connected' : 'installed'}`, 'success');
              self.installedServer = srv.name;
              if (window.refreshSidebarCounts) window.refreshSidebarCounts();
              self._next();
            } catch (e) {
              Components.toast('Failed: ' + e.message, 'error');
              installBtn.textContent = srv.install_type === 'remote' ? 'Connect' : 'Install';
              installBtn.disabled = false;
            }
          });

          card.appendChild(installBtn);
          if (envForm) card.appendChild(envForm);
          results.appendChild(card);
        }
      } catch (e) {
        results.innerHTML = '';
        results.appendChild(Components.errorState('Search failed: ' + e.message));
      } finally {
        searchBtn.disabled = false;
      }
    }

    searchBtn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    this._addNav(content, { showSkip: true });
  },

  async _renderSkills(content) {
    content.innerHTML = `
      <h3 class="setup-step-title">Add a Skill</h3>
      <p class="setup-step-desc">Skills are expert workflows Vodou can follow. Enable existing ones or create your own.</p>
    `;

    // Loading state
    content.appendChild(Components.loading());

    try {
      const skills = await API.get('/api/skills');
      content.querySelector('.loading-container')?.remove();

      if (skills.length > 0) {
        const listLabel = document.createElement('p');
        listLabel.className = 'setup-step-desc setup-step-desc-tight';
        listLabel.innerHTML = `<strong>${skills.length}</strong> skills installed — toggle the ones you want active:`;
        content.appendChild(listLabel);

        const skillList = document.createElement('div');
        skillList.className = 'setup-skill-list';

        // Show up to 8 skills to keep it scannable
        const shown = skills.slice(0, 8);
        for (const skill of shown) {
          const row = document.createElement('div');
          row.className = 'setup-skill-row' + (skill.is_active ? '' : ' inactive');

          const info = document.createElement('div');
          info.className = 'setup-skill-info';
          info.innerHTML = `
            <span class="setup-skill-name">${skill.name}</span>
            <span class="setup-skill-desc">${skill.description || ''}</span>
          `;

          const toggleBtn = document.createElement('button');
          toggleBtn.className = 'btn btn-sm' + (skill.is_active ? ' btn-active' : '');
          toggleBtn.textContent = skill.is_active ? 'On' : 'Off';
          toggleBtn.addEventListener('click', async () => {
            toggleBtn.disabled = true;
            try {
              const result = await API.post(`/api/skills/${encodeURIComponent(skill.name)}/toggle`);
              skill.is_active = result.is_active;
              toggleBtn.textContent = result.is_active ? 'On' : 'Off';
              toggleBtn.className = 'btn btn-sm' + (result.is_active ? ' btn-active' : '');
              row.className = 'setup-skill-row' + (result.is_active ? '' : ' inactive');
              Components.toast(`${skill.name} ${result.is_active ? 'enabled' : 'disabled'}`, 'success');
            } catch (e) {
              Components.toast('Toggle failed: ' + e.message, 'error');
            } finally {
              toggleBtn.disabled = false;
            }
          });

          row.appendChild(info);
          row.appendChild(toggleBtn);
          skillList.appendChild(row);
        }

        if (skills.length > 8) {
          const more = document.createElement('p');
          more.className = 'setup-step-desc setup-step-desc-top';
          more.textContent = `+ ${skills.length - 8} more — manage all skills from the Skills page.`;
          skillList.appendChild(more);
        }

        content.appendChild(skillList);
      } else {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No skills installed yet. Create one below!';
        content.appendChild(empty);
      }

      // Create new skill section
      const createSection = document.createElement('div');
      createSection.className = 'setup-create-skill';

      const createToggle = document.createElement('button');
      createToggle.className = 'btn btn-sm';
      createToggle.textContent = '+ Create a Skill';
      createToggle.classList.add('mt-4');

      const createForm = document.createElement('div');
      createForm.className = 'setup-create-form is-hidden';
      createForm.innerHTML = `
        <input type="text" class="setup-search-input setup-input-gap" placeholder="Skill name (e.g. deploy-check)" id="setup-skill-name" />
        <input type="text" class="setup-search-input setup-input-gap" placeholder="Short description" id="setup-skill-desc" />
      `;

      const createBtn = document.createElement('button');
      createBtn.className = 'btn btn-primary btn-sm';
      createBtn.textContent = 'Create';
      createBtn.addEventListener('click', async () => {
        const nameInput = document.getElementById('setup-skill-name');
        const descInput = document.getElementById('setup-skill-desc');
        const name = nameInput.value.trim();
        const desc = descInput.value.trim();
        if (!name) { Components.toast('Name is required', 'error'); return; }
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
        try {
          await API.post('/api/skills', { name, description: desc });
          Components.toast(`"${name}" created`, 'success');
          if (window.refreshSidebarCounts) window.refreshSidebarCounts();
          // Re-render to show the new skill in the list
          this._renderSkills(content);
        } catch (e) {
          Components.toast('Failed: ' + e.message, 'error');
          createBtn.disabled = false;
          createBtn.textContent = 'Create';
        }
      });
      createForm.appendChild(createBtn);

      createToggle.addEventListener('click', () => {
        const visible = !createForm.classList.contains('is-hidden');
        createForm.classList.toggle('is-hidden', visible);
        createToggle.textContent = visible ? '+ Create a Skill' : 'Cancel';
      });

      createSection.appendChild(createToggle);
      createSection.appendChild(createForm);
      content.appendChild(createSection);
    } catch (e) {
      content.querySelector('.loading-container')?.remove();
      content.appendChild(Components.errorState('Could not load skills'));
    }

    this._addNav(content, { showSkip: true });
  },

  async _renderExplore(content) {
    content.innerHTML = `
      <h3 class="setup-step-title">See What's Available</h3>
      <p class="setup-step-desc">Here's what Vodou can do now.</p>
    `;

    content.appendChild(Components.loading());

    try {
      const sysData = await API.get('/api/system');
      const counts = sysData.counts || {};

      // Remove loading
      content.querySelector('.loading-container')?.remove();

      const summary = document.createElement('div');
      summary.className = 'setup-summary';
      summary.innerHTML = `
        <div class="setup-summary-item"><span class="setup-summary-val">${counts.mcp_servers || 0}</span> servers connected</div>
        <div class="setup-summary-item"><span class="setup-summary-val">${counts.tools || 0}</span> tools available</div>
        <div class="setup-summary-item"><span class="setup-summary-val">${counts.intent_mappings || 0}</span> keyword shortcuts active</div>
        <div class="setup-summary-item"><span class="setup-summary-val">${counts.skills_registry || 0}</span> workflow skills</div>
      `;
      content.appendChild(summary);

      if ((counts.mcp_servers || 0) > 0) {
        const hint = document.createElement('p');
        hint.className = 'setup-step-desc setup-step-desc-16';
        hint.textContent = 'Vodou automatically sets up keyword shortcuts when you install servers. Try chatting next!';
        content.appendChild(hint);
      }
    } catch (e) {
      content.querySelector('.loading-container')?.remove();
      content.appendChild(Components.errorState('Could not load system info'));
    }

    this._addNav(content, { showSkip: true });
  },

  _renderChat(content) {
    content.innerHTML = `
      <h3 class="setup-step-title">Try It Out</h3>
      <p class="setup-step-desc">Head over to Chat and try talking to Vodou. Here are some things to try:</p>
    `;

    const suggestions = [
      'What tools do I have?',
      'What can you do?',
      'Search the web for Vodou',
    ];

    const sugList = document.createElement('div');
    sugList.className = 'setup-suggestions';
    for (const s of suggestions) {
      const chip = document.createElement('button');
      chip.className = 'setup-suggestion-chip';
      chip.textContent = s;
      chip.addEventListener('click', () => {
        location.hash = '#/chat';
        // Try to populate chat input
        setTimeout(() => {
          const chatInput = document.getElementById('chat-input');
          if (chatInput) {
            chatInput.value = s;
            chatInput.focus();
          }
        }, 100);
      });
      sugList.appendChild(chip);
    }
    content.appendChild(sugList);

    const chatBtn = document.createElement('button');
    chatBtn.className = 'btn btn-primary';
    chatBtn.classList.add('mt-4');
    chatBtn.textContent = 'Open Chat';
    chatBtn.addEventListener('click', () => { location.hash = '#/chat'; });
    content.appendChild(chatBtn);

    this._addNav(content, { showSkip: true });
  },

  _renderAutomate(content) {
    content.innerHTML = `
      <h3 class="setup-step-title">Set Up Automation</h3>
      <p class="setup-step-desc">Want Vodou to do things automatically? Pick a preset or skip for now.</p>
    `;

    const presets = [
      { label: 'Daily health check', schedule: 'at 09:00', payload: "oi 'health-check'" },
      { label: 'Weekly memory cleanup', schedule: 'every 168h', payload: "oi 'mem promote'" },
    ];

    const presetList = document.createElement('div');
    presetList.className = 'setup-presets';

    for (const preset of presets) {
      const card = document.createElement('div');
      card.className = 'setup-preset-card';

      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-sm';
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Adding...';
        try {
          await API.post('/api/scheduler', {
            name: preset.label.toLowerCase().replace(/\s+/g, '-'),
            schedule: preset.schedule,
            schedule_type: 'interval',
            payload: preset.payload,
          });
          Components.toast(`"${preset.label}" scheduled`, 'success');
          addBtn.textContent = 'Added';
          addBtn.classList.add('btn-success');
          if (window.refreshSidebarCounts) window.refreshSidebarCounts();
        } catch (e) {
          Components.toast('Failed: ' + e.message, 'error');
          addBtn.disabled = false;
          addBtn.textContent = 'Add';
        }
      });

      card.innerHTML = `
        <div class="setup-preset-info">
          <span class="setup-preset-name">${preset.label}</span>
          <span class="setup-preset-schedule">${preset.schedule}</span>
        </div>
      `;
      card.appendChild(addBtn);
      presetList.appendChild(card);
    }
    content.appendChild(presetList);

    // Finish button
    const finishRow = document.createElement('div');
    finishRow.className = 'setup-nav';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn';
    skipBtn.textContent = 'Skip for now';
    skipBtn.addEventListener('click', () => {
      localStorage.setItem('onboarding-complete', '1');
      localStorage.removeItem('onboarding-step');
      location.hash = '#/home';
      const mainContent = document.getElementById('main-content');
      if (mainContent) HomeView.render(mainContent);
    });
    finishRow.appendChild(skipBtn);

    const finishBtn = document.createElement('button');
    finishBtn.className = 'btn btn-primary';
    finishBtn.textContent = 'Finish Setup';
    finishBtn.addEventListener('click', () => {
      localStorage.setItem('onboarding-complete', '1');
      localStorage.removeItem('onboarding-step');
      location.hash = '#/home';
      const mainContent = document.getElementById('main-content');
      if (mainContent) HomeView.render(mainContent);
    });
    finishRow.appendChild(finishBtn);
    content.appendChild(finishRow);
  },

  _addNav(content, opts) {
    const nav = document.createElement('div');
    nav.className = 'setup-nav';

    if (this.currentStep > 0) {
      const backBtn = document.createElement('button');
      backBtn.className = 'btn';
      backBtn.textContent = 'Back';
      backBtn.addEventListener('click', () => this._prev());
      nav.appendChild(backBtn);
    }

    if (opts?.showSkip) {
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn';
      skipBtn.textContent = this.currentStep < this.steps.length - 1 ? 'Skip' : 'Finish';
      skipBtn.addEventListener('click', () => {
        if (this.currentStep >= this.steps.length - 1) {
          localStorage.setItem('onboarding-complete', '1');
          localStorage.removeItem('onboarding-step');
          location.hash = '#/home';
          const mainContent = document.getElementById('main-content');
          if (mainContent) HomeView.render(mainContent);
        } else {
          this._next();
        }
      });
      nav.appendChild(skipBtn);
    }

    if (this.currentStep < this.steps.length - 1) {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn btn-primary';
      nextBtn.textContent = 'Next';
      nextBtn.addEventListener('click', () => this._next());
      nav.appendChild(nextBtn);
    }

    content.appendChild(nav);
  },

  _next() {
    if (this.currentStep < this.steps.length - 1) {
      this.currentStep++;
      localStorage.setItem('onboarding-step', String(this.currentStep));
      this._updateUI();
    }
  },

  _prev() {
    if (this.currentStep > 0) {
      this.currentStep--;
      localStorage.setItem('onboarding-step', String(this.currentStep));
      this._updateUI();
    }
  },

  _updateUI() {
    // Update progress dots
    const dots = document.querySelectorAll('.setup-dot');
    dots.forEach((dot, i) => {
      dot.className = 'setup-dot' + (i === this.currentStep ? ' active' : '') + (i < this.currentStep ? ' done' : '');
    });

    // Toggle start-over link
    const startOverLink = document.getElementById('setup-start-over');
    if (startOverLink) startOverLink.classList.toggle('is-hidden', this.currentStep === 0);

    const content = document.getElementById('setup-step-content');
    if (content) this._renderStep(content);
  },
};
