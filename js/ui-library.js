/*
 * ui-library.js — sound banks, projects, and the export panel.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs } = MPC.dom;
  const App = MPC.app;

  function fmtDate(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function listItem(entry, opts) {
    const row = el('li', { class: 'lib-item' + (opts.active ? ' active' : '') });
    const main = el('div', { class: 'li-main' }, [
      el('span', { class: 'li-name', text: entry.name }),
      el('span', { class: 'li-date', text: fmtDate(entry.updatedAt) }),
    ]);
    main.addEventListener('click', () => opts.onLoad(entry));
    const del = el('button', { class: 'li-del', title: 'Delete', text: '✕' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await MPC.ui.confirm('Delete “' + entry.name + '”?')) opts.onDelete(entry);
    });
    row.appendChild(main);
    row.appendChild(del);
    return row;
  }

  async function renderBanks() {
    const banks = await MPC.storage.listBanks();
    const list = qs('#banks-list');
    list.innerHTML = '';
    qs('#current-bank').textContent = App.state.bankName || 'Untitled Bank';
    if (!banks.length) { list.appendChild(el('li', { class: 'lib-empty', text: 'No saved banks yet.' })); return; }
    banks.forEach((b) => list.appendChild(listItem(b, {
      active: b.id === App.state.bankId,
      onLoad: (bank) => App.loadBank(bank.id),
      onDelete: (bank) => App.deleteBank(bank.id),
    })));
  }

  async function renderProjects() {
    const projects = await MPC.storage.listProjects();
    const list = qs('#projects-list');
    list.innerHTML = '';
    if (!projects.length) { list.appendChild(el('li', { class: 'lib-empty', text: 'No saved projects yet.' })); return; }
    projects.forEach((p) => list.appendChild(listItem(p, {
      active: p.id === App.state.projectId,
      onLoad: (proj) => App.loadProject(proj.id),
      onDelete: (proj) => App.deleteProject(proj.id),
    })));
  }

  async function renderStorage() {
    const est = await MPC.storage.estimateUsage();
    if (est && est.usage != null) {
      const mb = (est.usage / 1048576).toFixed(1);
      qs('#storage-info').textContent = 'Stored locally: ' + mb + ' MB';
    }
  }

  async function runExport() {
    const btn = qs('#export-btn');
    const choice = {
      stems: qs('#exp-stems').checked,
      sections: qs('#exp-sections').checked,
      master: qs('#exp-master').checked,
    };
    if (!choice.stems && !choice.sections && !choice.master) {
      MPC.toast('Pick at least one export option.', 'error'); return;
    }
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      await App.ensureAudio();
      await MPC.render.exportBundle(choice);
      MPC.toast('Export ready — check your downloads.');
    } catch (err) {
      console.error(err);
      MPC.toast('Export failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Export ZIP';
      qs('#export-progress').textContent = '';
    }
  }

  const UiLibrary = {
    init() {
      // banks
      qs('#bank-save').addEventListener('click', async () => {
        if (App.state.bankId) return App.saveBank();
        const name = await MPC.ui.prompt('Name this sound bank', App.state.bankName);
        if (name) App.saveBank(name);
      });
      qs('#bank-saveas').addEventListener('click', async () => {
        const name = await MPC.ui.prompt('Save bank as', App.state.bankName + ' copy');
        if (name) App.saveBankAsNew(name);
      });

      // projects
      qs('#project-new').addEventListener('click', async () => {
        if (App.state.dirty && !(await MPC.ui.confirm('Discard unsaved changes and start a new project?'))) return;
        App.newProject();
      });
      qs('#project-save').addEventListener('click', async () => {
        if (App.state.projectId) return App.saveProject();
        const name = await MPC.ui.prompt('Name this project', App.state.projectName);
        if (name) App.saveProject(name);
      });
      qs('#project-saveas').addEventListener('click', async () => {
        const name = await MPC.ui.prompt('Save project as', App.state.projectName + ' copy');
        if (name) App.saveProjectAsNew(name);
      });

      // portable project files
      qs('#project-export-file').addEventListener('click', () => App.exportProjectFile());
      const fileInput = qs('#project-file-input');
      qs('#project-import-file').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (f) App.importProjectFile(f);
        fileInput.value = '';
      });

      // export
      qs('#export-btn').addEventListener('click', runExport);
      MPC.bus.on('export:progress', (p) => { qs('#export-progress').textContent = p.label || ''; });
      MPC.bus.on('export:done', () => { qs('#export-progress').textContent = 'Done ✓'; renderStorage(); });

      MPC.bus.on('library:changed', () => { renderBanks(); renderProjects(); renderStorage(); });
      MPC.bus.on('project:changed', renderProjects);

      renderBanks();
      renderProjects();
      renderStorage();
    },
  };

  MPC.uiLibrary = UiLibrary;
})();
