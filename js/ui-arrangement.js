/*
 * ui-arrangement.js — the playlist (ordered sections) and the per-section
 * editor (volume, repeats, EQ). Each section is one recorded loop.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs } = MPC.dom;
  const App = MPC.app;

  const dB = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const Hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz';

  function slider(opts) {
    const value = el('span', { class: 'sl-val' });
    const input = el('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value });
    const wrap = el('div', { class: 'slider' }, [
      el('div', { class: 'sl-top' }, [el('label', { text: opts.label }), value]),
      input,
    ]);
    const fmt = opts.fmt || ((v) => v);
    input.addEventListener('input', () => { const v = parseFloat(input.value); value.textContent = fmt(v); opts.oninput(v); });
    return { wrap, input, value, set: (v) => { input.value = v; value.textContent = fmt(v); } };
  }

  let editorRefs = null;

  function isPreviewing(id) {
    const t = MPC.transport;
    return t.running && t.mode === 'loop' && MPC.sequencer.previewSectionId === id && !MPC.sequencer.recording;
  }

  // ---- list ---------------------------------------------------------------
  function buildRow(section, idx) {
    const row = el('li', { class: 'section-row', dataset: { id: section.id } });

    const name = el('input', { class: 'sr-name', value: section.name });
    name.addEventListener('click', (e) => e.stopPropagation());
    name.addEventListener('change', () => App.updateSection(section.id, { name: name.value.slice(0, 24) }));

    const meta = el('span', { class: 'sr-meta' });

    const mkBtn = (cls, label, title, fn) => {
      const b = el('button', { class: 'sr-btn ' + cls, title, text: label });
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    const playBtn = mkBtn('play', '▶', 'Loop-preview this section', () => {
      if (isPreviewing(section.id)) App.stopEverything();
      else App.previewSection(section.id);
    });
    const dubBtn = mkBtn('dub', '●+', 'Overdub / record more into this section', () => App.overdubSection(section.id));
    const actions = el('div', { class: 'sr-actions' }, [
      playBtn, dubBtn,
      mkBtn('', '▲', 'Move up', () => App.moveSection(section.id, -1)),
      mkBtn('', '▼', 'Move down', () => App.moveSection(section.id, 1)),
      mkBtn('', '⧉', 'Duplicate', () => App.duplicateSection(section.id)),
      mkBtn('danger', '✕', 'Delete', () => App.deleteSection(section.id)),
    ]);

    row.appendChild(el('div', { class: 'sr-main' }, [
      el('span', { class: 'sr-index', text: String(idx + 1) }),
      el('span', { class: 'sr-color', style: { background: section.color } }),
      name, meta,
    ]));
    row.appendChild(actions);

    row.addEventListener('click', () => App.selectSection(section.id));
    updateRow(row, section);
    return row;
  }

  function updateRow(row, section) {
    const meta = qs('.sr-meta', row);
    meta.textContent = section.bars + ' bar' + (section.bars > 1 ? 's' : '') + ' · ' +
      section.events.length + ' hit' + (section.events.length === 1 ? '' : 's') +
      (section.repeats > 1 ? ' · ×' + section.repeats : '') + (section.muted ? ' · muted' : '');
    row.classList.toggle('selected', App.state.selectedSectionId === section.id);
    row.classList.toggle('muted', !!section.muted);
    row.classList.toggle('previewing', isPreviewing(section.id));
    qs('.sr-btn.dub', row).classList.toggle('active', MPC.sequencer.recording && MPC.sequencer.recordingSectionId === section.id);
  }

  function renderList() {
    const list = qs('#sections-list');
    list.innerHTML = '';
    if (!App.state.sections.length) {
      list.appendChild(el('li', { class: 'sections-empty', text: 'No sections yet. Hit ● Rec to record your first loop.' }));
    } else {
      App.state.sections.forEach((s, i) => list.appendChild(buildRow(s, i)));
    }
    renderEditor();
  }

  function refreshRows() {
    MPC.dom.qsa('#sections-list .section-row').forEach((row) => {
      const section = App.state.sections.find((s) => s.id === row.dataset.id);
      if (section) updateRow(row, section);
    });
  }

  // ---- section editor -----------------------------------------------------
  function buildEditor() {
    const host = qs('#section-editor');
    host.innerHTML = '';

    const title = el('div', { class: 'se-title' });
    const muteBtn = el('button', { class: 'mini', text: 'Mute' });
    const clearBtn = el('button', { class: 'mini danger', text: 'Clear hits' });
    const undoBtn = el('button', { class: 'mini', text: 'Undo hit' });
    const head = el('div', { class: 'se-head' }, [title, el('div', { class: 'se-head-actions' }, [undoBtn, clearBtn, muteBtn])]);

    const vol = slider({ label: 'Volume', min: -24, max: 6, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updateSection(current(), { volumeDb: v }) });
    const reps = slider({ label: 'Repeats', min: 1, max: 16, step: 1, value: 1, fmt: (v) => '×' + v, oninput: (v) => App.updateSection(current(), { repeats: v }) });
    const topRow = el('div', { class: 'ctl-row' }, [vol.wrap, reps.wrap]);

    const eqLow = slider({ label: 'Low', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updateSectionEq(current(), 'low', { gain: v }) });
    const eqMidFreq = slider({ label: 'Mid Hz', min: 200, max: 6000, step: 10, value: 1000, fmt: Hz, oninput: (v) => App.updateSectionEq(current(), 'mid', { freq: v }) });
    const eqMid = slider({ label: 'Mid', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updateSectionEq(current(), 'mid', { gain: v }) });
    const eqHigh = slider({ label: 'High', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updateSectionEq(current(), 'high', { gain: v }) });
    const eqRow = el('div', {}, [
      el('div', { class: 'eq-title', text: 'Section EQ' }),
      el('div', { class: 'ctl-row' }, [eqLow.wrap, eqMidFreq.wrap, eqMid.wrap, eqHigh.wrap]),
    ]);

    muteBtn.addEventListener('click', () => { const s = sectionObj(); if (s) App.updateSection(s.id, { muted: !s.muted }); });
    clearBtn.addEventListener('click', () => { const s = sectionObj(); if (s) App.clearSection(s.id); });
    undoBtn.addEventListener('click', () => { const s = sectionObj(); if (s) { MPC.sequencer.undoLast(s); App.markDirty(); } });

    host.appendChild(head);
    host.appendChild(topRow);
    host.appendChild(eqRow);
    editorRefs = { host, title, muteBtn, vol, reps, eqLow, eqMidFreq, eqMid, eqHigh, head, topRow, eqRow };
  }

  function current() { return App.state.selectedSectionId; }
  function sectionObj() { return App.getSelectedSection(); }

  function renderEditor() {
    if (!editorRefs) buildEditor();
    const s = sectionObj();
    const show = !!s;
    [editorRefs.head, editorRefs.topRow, editorRefs.eqRow].forEach((n) => n.style.display = show ? '' : 'none');
    if (!show) {
      editorRefs.host.classList.add('empty');
      if (!qs('.se-empty', editorRefs.host)) editorRefs.host.appendChild(el('div', { class: 'se-empty', text: 'Select a section to mix it.' }));
      return;
    }
    editorRefs.host.classList.remove('empty');
    const emptyMsg = qs('.se-empty', editorRefs.host); if (emptyMsg) emptyMsg.remove();
    editorRefs.title.textContent = s.name;
    editorRefs.title.style.color = s.color;
    editorRefs.muteBtn.classList.toggle('active', !!s.muted);
    editorRefs.vol.set(s.volumeDb || 0);
    editorRefs.reps.set(s.repeats || 1);
    editorRefs.eqLow.set(s.eq.low.gain);
    editorRefs.eqMidFreq.set(s.eq.mid.freq);
    editorRefs.eqMid.set(s.eq.mid.gain);
    editorRefs.eqHigh.set(s.eq.high.gain);
  }

  const UiArrangement = {
    init() {
      renderList();
      MPC.bus.on('sections:changed', renderList);
      MPC.bus.on('section:selected', () => { refreshRows(); renderEditor(); });
      MPC.bus.on('section:updated', (d) => {
        refreshRows();
        if (d && d.sectionId === App.state.selectedSectionId) renderEditor();
      });
      MPC.bus.on('sequencer:record-start', refreshRows);
      MPC.bus.on('sequencer:record-stop', refreshRows);
      MPC.bus.on('sequencer:preview-start', refreshRows);
      MPC.bus.on('sequencer:preview-stop', refreshRows);
      MPC.bus.on('transport:stop', refreshRows);
    },
  };

  MPC.uiArrangement = UiArrangement;
})();
