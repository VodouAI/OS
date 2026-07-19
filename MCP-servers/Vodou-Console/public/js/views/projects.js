/**
 * Projects View — PLAN-GATEWAY-PROJECTS Phase 1.
 *
 * A project is a pointer to a working directory: separate chats, files (Phase 2),
 * and instructions, over one shared Vodou brain. Adding one writes nothing into
 * the directory. Lists projects + create/edit modal with directory validation,
 * instruction auto-detect (CLAUDE.md/AGENTS.md/.vodou/project.md), and opt-in
 * "Save to project" disk-sync.
 */
const ProjectsView = {
  _palette: ['#6b7280', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#ec4899', '#14b8a6'],

  async render(container) {
    container.appendChild(Components.pageHeader('Projects', 'Loading…'));
    try {
      const { projects } = await API.get('/api/projects');
      container.innerHTML = '';

      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'btn btn-primary';
      newBtn.textContent = '+ New project';
      newBtn.onclick = () => this._openEditor(null);
      const header = Components.pageHeader(
        'Projects',
        'Each project is a working directory — separate chats, files, and instructions. One shared Vodou brain.',
        newBtn
      );
      container.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'projects-grid';
      if (!projects.length) {
        grid.appendChild(Components.emptyState('No projects yet. Create one to point Vodou at a directory.'));
      }
      for (const p of projects) grid.appendChild(this._card(p));
      container.appendChild(grid);
      this.refreshNav(projects);
    } catch (e) {
      container.innerHTML = '';
      container.appendChild(Components.pageHeader('Projects', ''));
      container.appendChild(Components.emptyState('Failed to load projects: ' + (e.message || e)));
    }
  },

  _card(p) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const isDefault = p.id === 'proj_default';

    const chip = document.createElement('span');
    chip.className = 'project-chip';
    chip.style.background = p.color || '#6b7280';

    const name = document.createElement('span');
    name.className = 'project-card-name';
    name.textContent = p.name;

    const head = document.createElement('div');
    head.className = 'project-card-head';
    head.append(chip, name);

    const pathEl = document.createElement('div');
    pathEl.className = 'project-card-path';
    pathEl.textContent = p.rootPath;
    pathEl.title = p.rootPath;

    const actions = document.createElement('div');
    actions.className = 'project-card-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-sm';
    openBtn.textContent = 'Open chat';
    openBtn.onclick = () => { location.hash = '#/chat?project=' + encodeURIComponent(p.id); };
    actions.appendChild(openBtn);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => this._openEditor(p);
    actions.appendChild(editBtn);

    if (!isDefault) {
      const archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.className = 'btn btn-sm btn-danger';
      archiveBtn.textContent = 'Archive';
      archiveBtn.onclick = async () => {
        if (!(await Components.confirm(`Archive project "${p.name}"? Its chats stay, but it leaves the list.`))) return;
        try { await API.del('/api/projects/' + encodeURIComponent(p.id)); Components.toast('Project archived'); this.render(document.getElementById('main-content')); }
        catch (e) { Components.toast('Archive failed: ' + (e.message || e), 'error'); }
      };
      actions.appendChild(archiveBtn);
    }

    card.append(head, pathEl, actions);
    return card;
  },

  _openEditor(project) {
    const editing = !!project;
    const isDefault = editing && project.id === 'proj_default';
    const modal = Components.openModal({
      title: editing ? 'Edit project' : 'New project',
      subtitle: 'Pointing at an existing directory is fine — nothing is written into it.',
    });

    const mk = (labelText, hintText) => {
      const wrap = document.createElement('div');
      wrap.className = 'form-field';
      const label = document.createElement('label');
      label.className = 'form-label';
      label.textContent = labelText;
      wrap.appendChild(label);
      if (hintText) {
        const hint = document.createElement('div');
        hint.className = 'form-hint';
        hint.textContent = hintText;
        wrap.appendChild(hint);
      }
      return wrap;
    };

    // Name
    const nameField = mk('Name');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control';
    nameInput.placeholder = 'Client A';
    nameInput.value = editing ? project.name : '';
    nameField.appendChild(nameInput);

    // Directory
    const dirField = mk('Directory', 'Absolute path to an existing folder.');
    const dirInput = document.createElement('input');
    dirInput.type = 'text';
    dirInput.className = 'form-control';
    dirInput.placeholder = '/Users/you/work/client-a';
    dirInput.value = editing ? project.rootPath : '';
    dirInput.disabled = isDefault;
    const dirStatus = document.createElement('div');
    dirStatus.className = 'form-hint';
    dirField.append(dirInput, dirStatus);

    // Instructions
    const instrField = mk('Instructions', 'Per-project guidance, like a CLAUDE.md — injected every turn.');
    const instrInput = document.createElement('textarea');
    instrInput.className = 'form-control';
    instrInput.rows = 6;
    instrInput.value = editing ? (project.instructions || '') : '';
    const instrSource = document.createElement('div');
    instrSource.className = 'form-hint';
    instrSource.textContent = 'Stored in Vodou';
    instrField.append(instrInput, instrSource);

    // Color
    const colorField = mk('Color');
    const swatches = document.createElement('div');
    swatches.className = 'project-swatches';
    let chosen = editing ? (project.color || this._palette[0]) : this._palette[1];
    const paint = () => swatches.querySelectorAll('.project-swatch').forEach((s) => s.classList.toggle('selected', s.dataset.color === chosen));
    for (const c of this._palette) {
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'project-swatch';
      s.dataset.color = c;
      s.style.background = c;
      s.onclick = () => { chosen = c; paint(); };
      swatches.appendChild(s);
    }
    colorField.appendChild(swatches);
    paint();

    // Directory validation + instruction auto-detect
    const detect = async () => {
      const rp = dirInput.value.trim();
      if (!rp) { dirStatus.textContent = ''; return; }
      try {
        const r = await API.get('/api/projects/detect?root_path=' + encodeURIComponent(rp));
        if (!r.valid) { dirStatus.textContent = '✗ not a valid directory'; dirStatus.style.color = 'var(--error)'; return; }
        dirStatus.textContent = '✓ ' + (r.resolved || rp); dirStatus.style.color = 'var(--success)';
        if (r.instructionsSource && !instrInput.value.trim()) {
          instrInput.value = r.instructions || '';
          instrSource.textContent = 'Loaded from ' + r.instructionsSource;
        }
      } catch { dirStatus.textContent = ''; }
    };
    dirInput.addEventListener('blur', detect);
    if (editing && !isDefault) detect();

    // Skills in this project (PLAN-PROJECT-SCOPED-DOCK Phase 1). Curate-down:
    // leave everything unchecked = the dock shows all skills for this project.
    // Only offered when editing a saved non-Default project (needs an id to assign).
    let skillsField = null;
    let getSelectedSkills = () => null; // null = "don't touch assignments"
    if (editing && !isDefault) {
      skillsField = mk('Skills in this project', 'Checked skills appear in this project’s dock. Leave all unchecked to show every skill.');
      const box = document.createElement('div');
      box.className = 'project-skills-list';
      box.textContent = 'Loading…';
      skillsField.appendChild(box);
      getSelectedSkills = () => {
        const checks = box.querySelectorAll('input[type=checkbox]');
        if (!checks.length) return null; // not loaded → leave as-is
        return Array.from(checks).filter((c) => c.checked).map((c) => c.value);
      };
      (async () => {
        try {
          const [all, assigned] = await Promise.all([
            fetch('/api/skills?active=1').then((r) => r.json()),
            API.get('/api/projects/' + encodeURIComponent(project.id) + '/skills'),
          ]);
          const active = (Array.isArray(all) ? all : (all.skills || []))
            .filter((s) => s && s.name && !String(s.name).startsWith('execdesk-'))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
          const checked = new Set(assigned.skills || []);
          box.innerHTML = '';
          for (const s of active) {
            const row = document.createElement('label');
            row.className = 'project-skill-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = s.name;
            cb.checked = checked.has(s.name);
            const txt = document.createElement('span');
            txt.textContent = String(s.name).replace(/-/g, ' ');
            row.append(cb, txt);
            box.appendChild(row);
          }
          if (!active.length) box.textContent = 'No active skills.';
        } catch { box.textContent = 'Could not load skills.'; }
      })();
    }

    // Footer buttons
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = editing ? 'Save' : 'Create project';
    save.onclick = async () => {
      const body = { name: nameInput.value.trim(), root_path: dirInput.value.trim(), instructions: instrInput.value, color: chosen };
      if (!body.name) { Components.toast('Name is required', 'error'); return; }
      if (!body.root_path) { Components.toast('Directory is required', 'error'); return; }
      try {
        if (editing) await API.put('/api/projects/' + encodeURIComponent(project.id), body);
        else await API.post('/api/projects', body);
        // Persist per-project skill set (editing non-Default only; null = untouched).
        if (editing && !isDefault) {
          const sel = getSelectedSkills();
          if (sel !== null) {
            await API.put('/api/projects/' + encodeURIComponent(project.id) + '/skills', { skills: sel });
            try { window.dispatchEvent(new CustomEvent('project:changed', { detail: { id: project.id } })); } catch (_) {}
          }
        }
        Components.toast(editing ? 'Project saved' : 'Project created');
        modal.close();
        this.render(document.getElementById('main-content'));
      } catch (e) { Components.toast('Save failed: ' + (e.message || e), 'error'); }
    };

    if (editing) {
      const saveDisk = document.createElement('button');
      saveDisk.type = 'button';
      saveDisk.className = 'btn';
      saveDisk.textContent = 'Save to project';
      saveDisk.title = 'Writes instructions to the directory so the CLI / Claude Code and other machines share them.';
      saveDisk.onclick = async () => {
        try {
          // persist current edits first, then sync to disk
          await API.put('/api/projects/' + encodeURIComponent(project.id), { instructions: instrInput.value });
          const r = await API.post('/api/projects/' + encodeURIComponent(project.id) + '/save-instructions', {});
          Components.toast('Wrote ' + r.written);
          instrSource.textContent = 'Loaded from ' + r.written;
        } catch (e) { Components.toast('Disk-sync failed: ' + (e.message || e), 'error'); }
      };
      modal.footer.appendChild(saveDisk);
    }

    modal.body.append(nameField, dirField, instrField, colorField);
    if (skillsField) modal.body.appendChild(skillsField);
    modal.footer.appendChild(save);
  },

  /** Populate the sidebar #nav-projects-items list. Accepts an optional pre-fetched list. */
  async refreshNav(projects) {
    const host = document.getElementById('nav-projects-items');
    if (!host) return;
    try {
      const list = projects || (await API.get('/api/projects')).projects;
      host.innerHTML = '';
      for (const p of list) {
        const a = document.createElement('a');
        a.href = '#/chat?project=' + encodeURIComponent(p.id);
        a.className = 'nav-item nav-project-item';
        const chip = document.createElement('span');
        chip.className = 'project-chip';
        chip.style.background = p.color || '#6b7280';
        const label = document.createElement('span');
        label.textContent = p.name;
        a.append(chip, label);
        host.appendChild(a);
      }
    } catch { /* nav is best-effort */ }
  },
};

Router.register('/projects', (el) => ProjectsView.render(el), ProjectsView);
window.addEventListener('load', () => { try { ProjectsView.refreshNav(); } catch (_) {} });
