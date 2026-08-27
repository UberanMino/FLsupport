/*
 * ui-mixer.js — the per-pad editor: waveform + trim handles, tune, volume,
 * pan and a 3-band EQ. Built once; values refresh in place so dragging is smooth.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs } = MPC.dom;
  const App = MPC.app;

  let refs = null;
  let currentIndex = 0;
  let dragHandle = null;

  function slider(opts) {
    const value = el('span', { class: 'sl-val' });
    const input = el('input', {
      type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value,
    });
    const wrap = el('div', { class: 'slider' }, [
      el('div', { class: 'sl-top' }, [el('label', { text: opts.label }), value]),
      input,
    ]);
    const fmt = opts.fmt || ((v) => v);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      value.textContent = fmt(v);
      opts.oninput(v);
    });
    return { wrap, input, value, set: (v) => { input.value = v; value.textContent = fmt(v); } };
  }

  const dB = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const Hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz';

  function build() {
    const host = qs('#pad-editor');
    host.innerHTML = '';

    // header
    const nameInput = el('input', { class: 'pad-name-input', value: '' });
    nameInput.addEventListener('change', () => App.updatePad(currentIndex, { name: nameInput.value.slice(0, 24) }));
    const muteBtn = el('button', { class: 'mini', text: 'Mute' });
    muteBtn.addEventListener('click', () => App.updatePad(currentIndex, { muted: !App.getPad(currentIndex).muted }));
    const loadBtn = el('button', { class: 'mini', text: 'Load…' });
    loadBtn.addEventListener('click', () => MPC.uiPads && qs('#pad-grid .pad[data-index="' + currentIndex + '"]').dispatchEvent(new MouseEvent('dblclick')));
    const clearBtn = el('button', { class: 'mini danger', text: 'Clear' });
    clearBtn.addEventListener('click', () => App.clearPad(currentIndex));

    const header = el('div', { class: 'pe-header' }, [
      el('span', { class: 'pe-num' }),
      nameInput,
      el('div', { class: 'pe-head-actions' }, [loadBtn, muteBtn, clearBtn]),
    ]);

    // waveform
    const canvas = el('canvas', { class: 'waveform' });
    const trimInfo = el('div', { class: 'trim-info' });
    const waveWrap = el('div', { class: 'wave-wrap' }, [canvas, trimInfo]);
    bindWaveform(canvas);

    // sound controls
    const tune = slider({ label: 'Tune', min: -24, max: 24, step: 1, value: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' st', oninput: (v) => App.updatePad(currentIndex, { tune: v }) });
    const vol = slider({ label: 'Volume', min: -24, max: 6, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updatePad(currentIndex, { gainDb: v }) });
    const pan = slider({ label: 'Pan', min: -1, max: 1, step: 0.02, value: 0, fmt: (v) => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), oninput: (v) => App.updatePad(currentIndex, { pan: v }) });
    const soundRow = el('div', { class: 'ctl-row' }, [tune.wrap, vol.wrap, pan.wrap]);

    // EQ
    const eqLow = slider({ label: 'Low', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updatePadEq(currentIndex, 'low', { gain: v }) });
    const eqMidFreq = slider({ label: 'Mid Hz', min: 200, max: 6000, step: 10, value: 1000, fmt: Hz, oninput: (v) => App.updatePadEq(currentIndex, 'mid', { freq: v }) });
    const eqMid = slider({ label: 'Mid', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updatePadEq(currentIndex, 'mid', { gain: v }) });
    const eqMidQ = slider({ label: 'Mid Q', min: 0.3, max: 6, step: 0.1, value: 1, fmt: (v) => v.toFixed(1), oninput: (v) => App.updatePadEq(currentIndex, 'mid', { q: v }) });
    const eqHigh = slider({ label: 'High', min: -15, max: 15, step: 0.5, value: 0, fmt: dB, oninput: (v) => App.updatePadEq(currentIndex, 'high', { gain: v }) });
    const eqRow = el('div', {}, [
      el('div', { class: 'eq-title', text: 'Pad EQ' }),
      el('div', { class: 'ctl-row' }, [eqLow.wrap, eqMidFreq.wrap, eqMid.wrap, eqMidQ.wrap, eqHigh.wrap]),
    ]);

    host.appendChild(header);
    host.appendChild(waveWrap);
    host.appendChild(soundRow);
    host.appendChild(eqRow);

    refs = { host, nameInput, muteBtn, header, canvas, trimInfo, tune, vol, pan, eqLow, eqMidFreq, eqMid, eqMidQ, eqHigh };
  }

  // ---- waveform ----------------------------------------------------------
  function drawWaveform() {
    const canvas = refs.canvas;
    const pad = App.getPad(currentIndex);
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 480;
    const h = canvas.clientHeight || 120;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);

    if (!pad.sample || !pad.sample.peaks) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No sample — drop an audio file on this pad (or “Load…”).', w / 2, h / 2);
      return;
    }

    const peaks = pad.sample.peaks;
    const buckets = peaks.length / 2;
    const mid = h / 2;
    ctx.strokeStyle = pad.color || '#54a0ff';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
      const min = peaks[b * 2], max = peaks[b * 2 + 1];
      ctx.moveTo(x + 0.5, mid - max * mid * 0.95);
      ctx.lineTo(x + 0.5, mid - min * mid * 0.95);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // trim overlay
    const dur = pad.sample.duration;
    const sx = (pad.trimStart / dur) * w;
    const ex = ((pad.trimEnd != null ? pad.trimEnd : dur) / dur) * w;
    ctx.fillStyle = 'rgba(6,10,20,0.66)';
    ctx.fillRect(0, 0, sx, h);
    ctx.fillRect(ex, 0, w - ex, h);
    ctx.fillStyle = '#ffd93d';
    ctx.fillRect(sx - 1, 0, 2, h);
    ctx.fillRect(ex - 1, 0, 2, h);
    // handle grips
    ctx.fillStyle = '#ffd93d';
    ctx.fillRect(sx - 4, 0, 8, 10);
    ctx.fillRect(ex - 4, 0, 8, 10);

    const len = (pad.trimEnd != null ? pad.trimEnd : dur) - pad.trimStart;
    refs.trimInfo.textContent = 'Start ' + pad.trimStart.toFixed(3) + 's · End ' +
      (pad.trimEnd != null ? pad.trimEnd : dur).toFixed(3) + 's · Length ' + len.toFixed(3) + 's';
  }

  function bindWaveform(canvas) {
    const pick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const frac = MPC.util.clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const pad = App.getPad(currentIndex);
      if (!pad.sample) return null;
      return frac * pad.sample.duration;
    };
    canvas.addEventListener('pointerdown', (e) => {
      const pad = App.getPad(currentIndex);
      if (!pad.sample) return;
      const rect = canvas.getBoundingClientRect();
      const dur = pad.sample.duration;
      const sx = (pad.trimStart / dur) * rect.width;
      const ex = ((pad.trimEnd != null ? pad.trimEnd : dur) / dur) * rect.width;
      const x = e.clientX - rect.left;
      dragHandle = Math.abs(x - sx) <= Math.abs(x - ex) ? 'start' : 'end';
      canvas.setPointerCapture(e.pointerId);
      applyTrim(pick(e));
    });
    canvas.addEventListener('pointermove', (e) => { if (dragHandle) applyTrim(pick(e)); });
    canvas.addEventListener('pointerup', () => { dragHandle = null; });
    canvas.addEventListener('pointercancel', () => { dragHandle = null; });
    canvas.addEventListener('dblclick', () => {
      const pad = App.getPad(currentIndex);
      if (pad.sample) App.updatePad(currentIndex, { trimStart: 0, trimEnd: pad.sample.duration });
    });
  }

  function applyTrim(t) {
    if (t == null) return;
    const pad = App.getPad(currentIndex);
    const dur = pad.sample.duration;
    if (dragHandle === 'start') {
      App.updatePad(currentIndex, { trimStart: MPC.util.clamp(t, 0, (pad.trimEnd != null ? pad.trimEnd : dur) - 0.01) });
    } else {
      App.updatePad(currentIndex, { trimEnd: MPC.util.clamp(t, pad.trimStart + 0.01, dur) });
    }
  }

  // ---- refresh -----------------------------------------------------------
  function refresh() {
    const pad = App.getPad(currentIndex);
    qs('.pe-num', refs.header).textContent = 'PAD ' + (currentIndex + 1);
    qs('.pe-num', refs.header).style.color = pad.color;
    refs.nameInput.value = pad.name || '';
    refs.muteBtn.classList.toggle('active', !!pad.muted);
    refs.tune.set(pad.tune || 0);
    refs.vol.set(pad.gainDb || 0);
    refs.pan.set(pad.pan || 0);
    refs.eqLow.set(pad.eq.low.gain);
    refs.eqMidFreq.set(pad.eq.mid.freq);
    refs.eqMid.set(pad.eq.mid.gain);
    refs.eqMidQ.set(pad.eq.mid.q);
    refs.eqHigh.set(pad.eq.high.gain);
    drawWaveform();
  }

  const UiMixer = {
    init() {
      build();
      currentIndex = App.state.selectedPad;
      refresh();
      MPC.bus.on('pad:selected', (d) => { currentIndex = d.padIndex; refresh(); });
      MPC.bus.on('pad:changed', (d) => { if (d.padIndex === currentIndex) refresh(); });
      MPC.bus.on('pads:changed', refresh);
      window.addEventListener('resize', () => { if (refs) drawWaveform(); });
    },
  };

  MPC.uiMixer = UiMixer;
})();
