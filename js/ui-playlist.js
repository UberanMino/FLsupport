/*
 * ui-playlist.js — the FL-style timeline grid.
 *
 * Bars run horizontally, lanes vertically. Each recorded section is placed as
 * a clip that shows the rendered waveform of the loop. Clips can be moved,
 * resized, sliced (chopped), duplicated and deleted. A per-clip section mixer
 * (volume + EQ) sits below the grid.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs, qsa } = MPC.dom;
  const App = MPC.app;

  const RULER_H = 26;
  const LANE_H = 66;
  const ZOOMS = [22, 32, 44, 60, 84, 120];

  let pxPerBar = 60;
  let tool = 'select';
  let snap = 'bar';
  let grid, scroll;
  let editorRefs = null;
  let renderQueued = false;
  let drag = null;

  // ---- helpers ----------------------------------------------------------
  function bpb() { return App.state.beatsPerBar; }
  function laneCount() { return MPC.const.NUM_LANES; }

  function snapStart(bars) {
    if (snap === 'off') return Math.max(0, bars);
    const q = snap === 'beat' ? 1 / bpb() : 1;
    return Math.max(0, Math.round(bars / q) * q);
  }
  function snapLen(bars) {
    const q = snap === 'beat' ? 1 / bpb() : 1;
    if (snap === 'off') return Math.max(1 / bpb(), bars);
    return Math.max(q, Math.round(bars / q) * q);
  }
  function snapAbs(bars) {
    if (snap === 'off') return bars;
    const q = snap === 'beat' ? 1 / bpb() : 1;
    return Math.round(bars / q) * q;
  }

  function totalBars() {
    const viewBars = scroll ? Math.ceil(scroll.clientWidth / pxPerBar) : 16;
    return Math.max(16, viewBars, App.totalTimelineBars() + 4);
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // ---- background (lanes, gridlines, ruler) -----------------------------
  function drawBackground(canvas, bars, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--bg').trim() || '#0c0f17';
    const bg2 = css.getPropertyValue('--bg-2').trim() || '#131826';
    const line = css.getPropertyValue('--line').trim() || '#263149';
    const muted = css.getPropertyValue('--muted').trim() || '#8b96ad';

    // lane bands
    for (let l = 0; l < laneCount(); l++) {
      ctx.fillStyle = l % 2 ? bg : bg2;
      ctx.fillRect(0, RULER_H + l * LANE_H, w, LANE_H);
    }
    // beat lines
    const beats = bpb();
    ctx.lineWidth = 1;
    for (let b = 0; b <= bars; b++) {
      for (let k = 0; k < beats; k++) {
        const x = Math.round((b + k / beats) * pxPerBar) + 0.5;
        if (x > w) break;
        ctx.strokeStyle = k === 0 ? line : 'rgba(255,255,255,0.04)';
        ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    // ruler
    ctx.fillStyle = bg2;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const everyN = pxPerBar >= 40 ? 1 : pxPerBar >= 24 ? 2 : 4;
    for (let b = 0; b < bars; b += everyN) {
      const x = b * pxPerBar + 4;
      ctx.fillStyle = muted;
      ctx.fillText(String(b + 1), x, RULER_H / 2);
    }
  }

  // ---- clip waveform -----------------------------------------------------
  function drawClipWave(canvas, section, clip) {
    const peaks = section._peaks;
    const loopSec = section._loopSec || (section.bars * App.barLenSec());
    if (!peaks || !loopSec) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 40, h = canvas.clientHeight || 40;
    if (w < 2) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const buckets = peaks.length / 2;
    const clipDurSec = clip.lenBars * App.barLenSec();
    const mid = h / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      let s = clip.srcOffsetSec + (x / w) * clipDurSec;
      s = ((s % loopSec) + loopSec) % loopSec;
      const bkt = Math.min(buckets - 1, Math.floor((s / loopSec) * buckets));
      const mn = peaks[bkt * 2], mx = peaks[bkt * 2 + 1];
      ctx.moveTo(x + 0.5, mid - mx * mid * 0.9);
      ctx.lineTo(x + 0.5, mid - mn * mid * 0.9);
    }
    ctx.stroke();
  }

  // ---- clip element ------------------------------------------------------
  function buildClip(clip) {
    const section = App.getClipSection(clip);
    const color = section ? section.color : '#54a0ff';
    const node = el('div', {
      class: 'pl-clip', dataset: { id: clip.id },
      style: {
        left: (clip.startBar * pxPerBar) + 'px',
        top: (RULER_H + clip.lane * LANE_H + 3) + 'px',
        width: Math.max(6, clip.lenBars * pxPerBar) + 'px',
        height: (LANE_H - 6) + 'px',
        '--clip-color': color,
      },
    });
    if (App.state.selectedClipId === clip.id) node.classList.add('selected');
    if (section && section.muted) node.classList.add('muted');

    const wave = el('canvas', { class: 'clip-wave' });
    node.appendChild(wave);
    node.appendChild(el('div', { class: 'clip-label', text: section ? section.name : '—' }));
    node.appendChild(el('div', { class: 'clip-resize', title: 'Drag to resize / loop' }));

    node.addEventListener('pointerdown', (e) => onClipPointerDown(e, clip, node));

    // draw the waveform once the section's peaks exist
    if (section) {
      MPC.render.ensureSectionPeaks(section).then(() => {
        // node may have been re-rendered; find current canvas for this clip
        drawClipWave(wave, section, clip);
      }).catch(() => {});
    }
    return node;
  }

  function eventBar(e) {
    const rect = grid.getBoundingClientRect();
    return (e.clientX - rect.left) / pxPerBar;
  }
  function eventLane(e) {
    const rect = grid.getBoundingClientRect();
    return MPC.util.clamp(Math.floor((e.clientY - rect.top - RULER_H) / LANE_H), 0, laneCount() - 1);
  }

  function onClipPointerDown(e, clip, node) {
    e.preventDefault();
    e.stopPropagation();
    App.selectClip(clip.id);

    if (tool === 'slice') {
      const within = snapAbs(eventBar(e)) - clip.startBar;
      App.sliceClip(clip.id, within);
      return;
    }

    const isResize = e.target.classList.contains('clip-resize');
    drag = {
      mode: isResize ? 'resize' : 'move',
      id: clip.id, node,
      startX: e.clientX, startY: e.clientY,
      origStart: clip.startBar, origLen: clip.lenBars, origLane: clip.lane,
      moved: false,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
    refreshSelection();
  }

  function onDragMove(e) {
    if (!drag) return;
    const dBars = (e.clientX - drag.startX) / pxPerBar;
    if (Math.abs(e.clientX - drag.startX) > 2 || Math.abs(e.clientY - drag.startY) > 2) drag.moved = true;
    if (drag.mode === 'move') {
      const newStart = snapStart(drag.origStart + dBars);
      const newLane = MPC.util.clamp(drag.origLane + Math.round((e.clientY - drag.startY) / LANE_H), 0, laneCount() - 1);
      drag.pendStart = newStart; drag.pendLane = newLane;
      drag.node.style.left = (newStart * pxPerBar) + 'px';
      drag.node.style.top = (RULER_H + newLane * LANE_H + 3) + 'px';
    } else {
      const newLen = snapLen(drag.origLen + dBars);
      drag.pendLen = newLen;
      drag.node.style.width = Math.max(6, newLen * pxPerBar) + 'px';
    }
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    if (!drag) return;
    if (drag.mode === 'move' && drag.moved) {
      App.moveClip(drag.id, { startBar: drag.pendStart, lane: drag.pendLane });
    } else if (drag.mode === 'resize' && drag.pendLen != null) {
      App.resizeClip(drag.id, drag.pendLen);
    } else {
      scheduleRender();
    }
    drag = null;
  }

  // ---- playhead ----------------------------------------------------------
  function positionPlayhead(p) {
    const ph = qs('#pl-playhead', grid);
    if (!ph) return;
    if (!p || p.mode !== 'arrangement') { ph.style.opacity = '0'; return; }
    const total = MPC.sequencer._timelineTotalSec || (App.totalTimelineBars() * App.barLenSec());
    let pos = p.positionSec;
    if (MPC.transport.loopArrangement && total > 0) pos = ((pos % total) + total) % total;
    const x = (pos / App.barLenSec()) * pxPerBar;
    ph.style.opacity = '1';
    ph.style.left = x + 'px';
    // gentle auto-follow
    if (scroll) {
      if (x > scroll.scrollLeft + scroll.clientWidth - 80) scroll.scrollLeft = x - scroll.clientWidth + 160;
      else if (x < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, x - 40);
    }
  }

  // ---- render ------------------------------------------------------------
  function render() {
    if (!grid) return;
    const bars = totalBars();
    const w = bars * pxPerBar;
    const h = RULER_H + laneCount() * LANE_H;
    grid.style.width = w + 'px';
    grid.style.height = h + 'px';
    grid.innerHTML = '';

    const bgCanvas = el('canvas', { class: 'pl-bg' });
    grid.appendChild(bgCanvas);
    drawBackground(bgCanvas, bars, w, h);

    App.state.clips.forEach((clip) => grid.appendChild(buildClip(clip)));

    const ph = el('div', { id: 'pl-playhead', class: 'pl-playhead', style: { height: h + 'px' } });
    grid.appendChild(ph);
    if (!(MPC.transport.running && MPC.transport.mode === 'arrangement')) ph.style.opacity = '0';

    if (!App.state.clips.length) {
      grid.appendChild(el('div', { class: 'pl-empty', text: 'Record a loop (● Rec) and it lands here as a clip. Then move, chop and duplicate it.' }));
    }
    renderEditor();
  }

  // ---- section editor (selected clip's section) -------------------------
  const dB = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const Hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz';
  function slider(opts) {
    const value = el('span', { class: 'sl-val' });
    const input = el('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value });
    const wrap = el('div', { class: 'slider' }, [el('div', { class: 'sl-top' }, [el('label', { text: opts.label }), value]), input]);
    const fmt = opts.fmt || ((v) => v);
    input.addEventListener('input', () => { const v = parseFloat(input.value); value.textContent = fmt(v); opts.oninput(v); });
    return { wrap, input, value, set: (v) => { input.value = v; value.textContent = fmt(v); } };
  }

  function selSection() {
    const clip = App.getSelectedClip();
    return clip ? App.getClipSection(clip) : null;
  }

  function buildEditor() {
    const host = qs('#section-editor');
    host.innerHTML = '';
    const title = el('div', { class: 'se-title' });
    const dupBtn = el('button', { class: 'mini', text: '⧉ Duplicate' });
    const delBtn = el('button', { class: 'mini danger', text: '✕ Delete clip' });
    const muteBtn = el('button', { class: 'mini', text: 'Mute' });
    const clearBtn = el('button', { class: 'mini danger', text: 'Clear hits' });
    const nameInput = el('input', { class: 'se-name', value: '' });
    const head = el('div', { class: 'se-head' }, [title, el('div', { class: 'se-head-actions' }, [dupBtn, delBtn])]);
    const row2 = el('div', { class: 'se-head' }, [nameInput, el('div', { class: 'se-head-actions' }, [clearBtn, muteBtn])]);

    nameInput.addEventListener('change', () => { const s = selSection(); if (s) App.updateSection(s.id, { name: nameInput.value.slice(0, 24) }); });
    dupBtn.addEventListener('click', () => { if (App.state.selectedClipId) App.duplicateClip(App.state.selectedClipId); });
    delBtn.addEventListener('click', () => { if (App.state.selectedClipId) App.deleteClip(App.state.selectedClipId); });
    muteBtn.addEventListener('click', () => { const s = selSection(); if (s) App.updateSection(s.id, { muted: !s.muted }); });
    clearBtn.addEventListener('click', () => { const s = selSection(); if (s) App.clearSection(s.id); });

    const vol = slider({ label: 'Volume', min: -24, max: 6, step: 0.5, value: 0, fmt: dB, oninput: (v) => { const s = selSection(); if (s) App.updateSection(s.id, { volumeDb: v }); } });
    const topRow = el('div', { class: 'ctl-row' }, [vol.wrap]);
    const eqLow = slider({ label: 'Low', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => eq('low', { gain: v }) });
    const eqMidFreq = slider({ label: 'Mid Hz', min: 200, max: 6000, step: 10, value: 1000, fmt: Hz, oninput: (v) => eq('mid', { freq: v }) });
    const eqMid = slider({ label: 'Mid', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => eq('mid', { gain: v }) });
    const eqHigh = slider({ label: 'High', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => eq('high', { gain: v }) });
    const eqRow = el('div', {}, [el('div', { class: 'eq-title', text: 'Section EQ' }), el('div', { class: 'ctl-row' }, [eqLow.wrap, eqMidFreq.wrap, eqMid.wrap, eqHigh.wrap])]);
    function eq(band, ch) { const s = selSection(); if (s) App.updateSectionEq(s.id, band, ch); }

    host.appendChild(head);
    host.appendChild(row2);
    host.appendChild(topRow);
    host.appendChild(eqRow);
    editorRefs = { host, title, nameInput, muteBtn, vol, eqLow, eqMidFreq, eqMid, eqHigh, blocks: [head, row2, topRow, eqRow] };
  }

  function renderEditor() {
    if (!editorRefs) buildEditor();
    const s = selSection();
    const show = !!s;
    editorRefs.blocks.forEach((b) => b.style.display = show ? '' : 'none');
    let empty = qs('.se-empty', editorRefs.host);
    if (!show) {
      if (!empty) editorRefs.host.appendChild(el('div', { class: 'se-empty', text: 'Select a clip to mix its section.' }));
      return;
    }
    if (empty) empty.remove();
    const clip = App.getSelectedClip();
    editorRefs.title.textContent = 'Clip · ' + clip.lenBars.toFixed(clip.lenBars % 1 ? 2 : 0) + ' bars';
    editorRefs.title.style.color = s.color;
    editorRefs.nameInput.value = s.name || '';
    editorRefs.muteBtn.classList.toggle('active', !!s.muted);
    editorRefs.vol.set(s.volumeDb || 0);
    editorRefs.eqLow.set(s.eq.low.gain);
    editorRefs.eqMidFreq.set(s.eq.mid.freq);
    editorRefs.eqMid.set(s.eq.mid.gain);
    editorRefs.eqHigh.set(s.eq.high.gain);
  }

  // ---- init --------------------------------------------------------------
  const UiPlaylist = {
    init() {
      grid = qs('#pl-grid');
      scroll = qs('#pl-scroll');

      qs('#pl-play').addEventListener('click', () => {
        if (MPC.transport.running && MPC.transport.mode === 'arrangement') App.stopEverything();
        else App.playArrangement(false);
      });
      qs('#pl-stop').addEventListener('click', () => App.stopEverything());
      qs('#pl-loop').addEventListener('click', () => App.playArrangement(true));

      const setTool = (t) => {
        tool = t;
        qs('#pl-tool-select').classList.toggle('active', t === 'select');
        qs('#pl-tool-slice').classList.toggle('active', t === 'slice');
        grid.classList.toggle('slice-mode', t === 'slice');
      };
      qs('#pl-tool-select').addEventListener('click', () => setTool('select'));
      qs('#pl-tool-slice').addEventListener('click', () => setTool('slice'));
      qs('#pl-snap').addEventListener('change', (e) => { snap = e.target.value; });

      qs('#pl-zoom-in').addEventListener('click', () => zoom(1));
      qs('#pl-zoom-out').addEventListener('click', () => zoom(-1));

      // click empty grid to deselect
      grid.addEventListener('pointerdown', (e) => {
        if (e.target === grid || e.target.classList.contains('pl-bg')) {
          App.state.selectedClipId = null;
          MPC.bus.emit('clip:selected', { clipId: null });
        }
      });

      // delete selected clip with keyboard (when not typing)
      window.addEventListener('keydown', (e) => {
        if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if ((e.key === 'Delete' || e.key === 'Backspace') && App.state.selectedClipId &&
            qs('#tab-playlist').classList.contains('active')) {
          e.preventDefault();
          App.deleteClip(App.state.selectedClipId);
        }
      });

      MPC.bus.on('clips:changed', scheduleRender);
      MPC.bus.on('sections:changed', scheduleRender);
      MPC.bus.on('section:updated', () => { scheduleRender(); });
      MPC.bus.on('clip:selected', () => { refreshSelection(); renderEditor(); });
      MPC.bus.on('settings:changed', scheduleRender);
      MPC.bus.on('pad:changed', scheduleRender);
      MPC.bus.on('pads:changed', scheduleRender);
      MPC.bus.on('tab:changed', (d) => { if (d.tab === 'playlist') scheduleRender(); });
      MPC.bus.on('transport:position', positionPlayhead);
      MPC.bus.on('transport:stop', () => positionPlayhead(null));
      MPC.bus.on('sequencer:arrangement-stop', () => positionPlayhead(null));
      window.addEventListener('resize', scheduleRender);

      render();
    },
  };

  function zoom(dir) {
    let idx = ZOOMS.indexOf(pxPerBar);
    if (idx < 0) idx = 2;
    idx = MPC.util.clamp(idx + dir, 0, ZOOMS.length - 1);
    pxPerBar = ZOOMS[idx];
    render();
  }

  function refreshSelection() {
    qsa('#pl-grid .pl-clip').forEach((n) => n.classList.toggle('selected', n.dataset.id === App.state.selectedClipId));
  }

  MPC.uiPlaylist = UiPlaylist;
})();
