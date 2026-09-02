/*
 * ui-pads.js — the 4x4 pad grid, drag/drop sample loading, keyboard triggering.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs } = MPC.dom;
  const App = MPC.app;

  const cells = {};   // padIndex -> element
  let fileInputPad = null;

  function isTypingTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function buildCell(index) {
    const pad = App.getPad(index);
    const cell = el('div', {
      class: 'pad',
      dataset: { index: String(index) },
      style: { '--pad-color': pad.color },
    });
    cell.appendChild(el('span', { class: 'pad-key' }));
    cell.appendChild(el('span', { class: 'pad-num' }));
    cell.appendChild(el('span', { class: 'pad-name' }));
    cell.appendChild(el('span', { class: 'pad-badge' }));

    // Trigger + select on press. Fire the sound FIRST (synchronously) so it
    // isn't delayed behind pad-selection / waveform re-rendering.
    cell.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      MPC.engine.resumeIfNeeded();
      MPC.sequencer.triggerPad(index, 0.95);
      if (App.state.selectedPad !== index) App.selectPad(index);
    });

    // Double-click to pick a file.
    cell.addEventListener('dblclick', (e) => { e.preventDefault(); openFileDialog(index); });

    // Drag & drop.
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) App.loadSampleToPad(index, file);
    });

    return cell;
  }

  function openFileDialog(index) {
    if (!fileInputPad) {
      fileInputPad = el('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
      document.body.appendChild(fileInputPad);
    }
    fileInputPad.onchange = () => {
      const file = fileInputPad.files && fileInputPad.files[0];
      if (file) App.loadSampleToPad(fileInputPad._padIndex, file);
      fileInputPad.value = '';
    };
    fileInputPad._padIndex = index;
    fileInputPad.click();
  }

  function updateCell(index) {
    const cell = cells[index];
    if (!cell) return;
    const pad = App.getPad(index);
    cell.style.setProperty('--pad-color', pad.color);
    qs('.pad-key', cell).textContent = (MPC.const.PAD_TO_KEY[index] || '').toUpperCase();
    qs('.pad-num', cell).textContent = index + 1;
    qs('.pad-name', cell).textContent = pad.sample ? pad.name : '—';
    cell.classList.toggle('loaded', !!pad.sample);
    cell.classList.toggle('muted', !!pad.muted);
    const badge = qs('.pad-badge', cell);
    badge.textContent = pad.muted ? 'M' : '';
    cell.classList.toggle('selected', App.state.selectedPad === index);
  }

  function updateAll() { for (let i = 0; i < MPC.const.NUM_PADS; i++) updateCell(i); }

  function flash(index) {
    const cell = cells[index];
    if (!cell) return;
    cell.classList.add('hit');
    setTimeout(() => cell.classList.remove('hit'), 110);
  }

  function render() {
    const grid = qs('#pad-grid');
    grid.innerHTML = '';
    MPC.const.PAD_ROWS.forEach((row) => {
      row.forEach((index) => {
        const cell = buildCell(index);
        cells[index] = cell;
        grid.appendChild(cell);
      });
    });
    updateAll();
  }

  const UiPads = {
    init() {
      render();

      // Keyboard.
      window.addEventListener('keydown', (e) => {
        if (isTypingTarget(e.target)) return;
        const key = e.key.toLowerCase();
        if (key === ' ') { e.preventDefault(); App.stopEverything(); return; }
        const padIndex = MPC.const.KEY_TO_PAD[key];
        if (padIndex != null && !e.repeat) {
          e.preventDefault();
          // Sound first (synchronous), UI after — keeps the hit low-latency.
          MPC.engine.resumeIfNeeded();
          MPC.sequencer.triggerPad(padIndex, 0.95);
          if (App.state.selectedPad !== padIndex) App.selectPad(padIndex);
        }
      });

      MPC.bus.on('pad:hit', (d) => flash(d.padIndex));
      MPC.bus.on('pad:changed', (d) => updateCell(d.padIndex));
      MPC.bus.on('pads:changed', updateAll);
      MPC.bus.on('pad:selected', updateAll);
    },
  };

  MPC.uiPads = UiPads;
})();
