/**
 * Scripts View — registered scripts + recent jobs
 */
const ScriptsView = {

  async render(container) {
    container.appendChild(Components.pageHeader('Scripts', 'Registered scripts and job runs'));
    container.appendChild(Components.loading());

    try {
      const [scripts, jobsData] = await Promise.all([
        API.get('/api/scripts'),
        API.get('/api/scripts/jobs'),
      ]);
      container.innerHTML = '';

      const scriptsHeader = Components.pageHeader(
        'Scripts',
        `${scripts.length} registered scripts, ${jobsData.total} jobs`
      );
      scriptsHeader.querySelector('.page-title').appendChild(
        Components.helpTip('Background commands Vodou can run \u2014 longer tasks that execute while you continue working.')
      );
      container.appendChild(scriptsHeader);

      // --- Registered Scripts ---
      const regSection = document.createElement('div');
      regSection.className = 'scripts-section';

      const regLabel = document.createElement('h3');
      regLabel.className = 'scripts-section-title';
      regLabel.textContent = 'Registered Scripts';
      regSection.appendChild(regLabel);

      if (scripts.length === 0) {
        regSection.appendChild(Components.emptyState('No scripts registered. Scripts are added when you install servers with background execution support.'));
      } else {
        const table = Components.table(
          [
            { label: 'Server', render: (s) => {
              return Components.badge(s.server_name, 'accent');
            }},
            { label: 'Script', render: (s) => {
              const span = document.createElement('span');
              span.className = 'scripts-name';
              span.textContent = s.script_name;
              return span;
            }},
            { label: 'Command', render: (s) => {
              const span = document.createElement('span');
              span.className = 'scripts-command';
              span.textContent = (s.command || '').substring(0, 60);
              span.title = s.command || '';
              return span;
            }},
            { label: 'Duration', width: '80px', render: (s) => {
              const span = document.createElement('span');
              span.className = 'secondary-text';
              span.textContent = s.estimated_duration ? `~${s.estimated_duration}s` : '—';
              return span;
            }},
            { label: 'BG', width: '50px', render: (s) => {
              return Components.statusDot(!!s.background_execution);
            }},
            { label: 'Description', render: (s) => {
              const span = document.createElement('span');
              span.className = 'secondary-text';
              span.textContent = (s.description || '').substring(0, 80);
              return span;
            }},
            { label: '', width: '70px', render: (s) => {
              const btn = document.createElement('button');
              btn.className = 'btn btn-sm';
              btn.textContent = 'Run';
              btn.classList.add('scripts-run-btn');
              btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                btn.textContent = 'Running...';
                btn.disabled = true;
                btn.classList.add('opacity-60');
                try {
                  const result = await API.post(`/api/scripts/${encodeURIComponent(s.server_name)}/${encodeURIComponent(s.script_name)}/run`);
                  Components.toast(
                    result.success ? `${s.script_name} completed (exit 0)` : `${s.script_name} failed (exit ${result.exitCode})`,
                    result.success ? 'success' : 'error'
                  );
                  // Show output panel
                  this._showOutput(s.script_name, result);
                  // Refresh jobs table
                  const jobsData = await API.get('/api/scripts/jobs');
                  const jobsWrap = document.getElementById('scripts-jobs-wrap');
                  if (jobsWrap) this._renderJobs(jobsWrap, jobsData.jobs || []);
                } catch (err) {
                  Components.toast('Run failed: ' + err.message, 'error');
                  this._showOutput(s.script_name, { success: false, output: err.message, exitCode: -1 });
                }
                btn.textContent = 'Run';
                btn.disabled = false;
                btn.classList.remove('opacity-60');
              });
              return btn;
            }},
          ],
          scripts
        );
        regSection.appendChild(table);
      }
      container.appendChild(regSection);

      // --- Recent Jobs ---
      const jobsSection = document.createElement('div');

      const jobsLabel = document.createElement('h3');
      jobsLabel.className = 'scripts-section-title';
      jobsLabel.textContent = 'Recent Jobs';
      jobsSection.appendChild(jobsLabel);

      const jobsWrap = document.createElement('div');
      jobsWrap.id = 'scripts-jobs-wrap';
      jobsSection.appendChild(jobsWrap);

      this._renderJobs(jobsWrap, jobsData.jobs || []);
      container.appendChild(jobsSection);

    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState('Failed to load scripts: ' + err.message));
    }
  },

  _renderJobs(wrap, jobs) {
    wrap.innerHTML = '';

    if (jobs.length === 0) {
      wrap.appendChild(Components.emptyState('No jobs recorded'));
      return;
    }

    const table = Components.table(
      [
        { label: 'Job ID', render: (j) => {
          const span = document.createElement('span');
          span.className = 'scripts-job-id';
          span.textContent = j.job_id.substring(0, 16);
          span.title = j.job_id;
          return span;
        }},
        { label: 'Script', render: (j) => {
          const span = document.createElement('span');
          span.className = 'scripts-job-name';
          span.textContent = `${j.server_name}/${j.script_name}`;
          return span;
        }},
        { label: 'Status', width: '100px', render: (j) => {
          const colors = {
            running: 'accent',
            completed: 'success',
            failed: 'error',
            stopped: 'default',
          };
          return Components.badge(j.status, colors[j.status] || 'default');
        }},
        { label: 'Exit', width: '60px', render: (j) => {
          const span = document.createElement('span');
          span.className = 'secondary-text';
          span.textContent = j.exit_code !== null ? String(j.exit_code) : '—';
          if (j.exit_code !== null && j.exit_code !== 0) span.classList.add('status-error-text');
          return span;
        }},
        { label: 'Started', width: '150px', render: (j) => {
          const span = document.createElement('span');
          span.className = 'secondary-text text-sm';
          span.textContent = this._formatTime(j.started_at);
          return span;
        }},
        { label: 'Duration', width: '90px', render: (j) => {
          const span = document.createElement('span');
          span.className = 'secondary-text';
          if (j.started_at && j.completed_at) {
            const ms = new Date(j.completed_at) - new Date(j.started_at);
            const secs = Math.round(ms / 1000);
            span.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
          } else if (j.status === 'running') {
            span.textContent = 'running...';
            span.classList.add('text-accent-color');
          } else {
            span.textContent = '—';
          }
          return span;
        }},
      ],
      jobs
    );
    wrap.appendChild(table);
  },

  _showOutput(scriptName, result) {
    // Remove existing output panel
    const existing = document.getElementById('script-output-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'script-output-panel';
    panel.className = 'scripts-output-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'scripts-output-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'scripts-output-title-wrap';
    const statusDot = document.createElement('span');
    statusDot.className = result.success ? 'scripts-output-dot status-ok-dot' : 'scripts-output-dot status-error-dot';
    titleWrap.appendChild(statusDot);
    const title = document.createElement('span');
    title.className = 'scripts-output-title';
    title.textContent = `${scriptName} — ${result.success ? 'Passed' : 'Failed'} (exit ${result.exitCode ?? 'null'})`;
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-sm';
    closeBtn.textContent = 'Close';
    closeBtn.classList.add('scripts-output-close');
    closeBtn.addEventListener('click', () => panel.remove());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Output body
    const body = document.createElement('pre');
    body.className = 'scripts-output-body';

    // Parse the output — if it's wrapped in MCP JSON, extract the text
    let output = result.output || 'No output';
    try {
      if (output.includes('"content"')) {
        const jsonMatch = output.match(/\{[\s\S]*"content"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.content?.[0]?.text) {
            output = parsed.content[0].text;
          }
        }
      }
    } catch {}

    body.textContent = output;
    panel.appendChild(body);

    // Insert after the registered scripts section
    const container = document.getElementById('main-content');
    if (container) container.appendChild(panel);
  },

  _formatTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      const now = new Date();
      const diff = now - d;
      if (diff > 0 && diff < 86400000) {
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        return `${Math.floor(mins / 60)}h ago`;
      }
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return ts;
    }
  },
};
