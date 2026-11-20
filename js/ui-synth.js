/*
 * ui-synth.js — the 🎹 Synth tab: patch controls, the typing keyboard
 * (FL-Studio-style two-row layout), on-screen piano, take recorder with a
 * mini piano roll, and WAV / pad export.
 *
 * Keys are matched by physical position (KeyboardEvent.code), so the layout
 * works the same on QWERTY, QWERTZ and AZERTY keyboards.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs } = MPC.dom;
  const SE = MPC.synthEngine;
  const Synth = MPC.synth;

  // Physical key -> semitone offset from C<octave>.
  const LOWER_ROW = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM',
    'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash'];
  const UPPER_ROW = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU',
    'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP', 'BracketLeft', 'Equal', 'BracketRight'];
  const CODE_TO_SEMI = {};
  LOWER_ROW.forEach((c, i) => { CODE_TO_SEMI[c] = i; });
  UPPER_ROW.forEach((c, i) => { CODE_TO_SEMI[c] = 12 + i; });

  // US-layout fallback labels; replaced by the real layout when the browser
  // exposes navigator.keyboard.getLayoutMap() (Chromium only).
  const LABELS = {
    KeyZ: 'Z', KeyS: 'S', KeyX: 'X', KeyD: 'D', KeyC: 'C', KeyV: 'V', KeyG: 'G', KeyB: 'B', KeyH: 'H', KeyN: 'N', KeyJ: 'J', KeyM: 'M',
    Comma: ',', KeyL: 'L', Period: '.', Semicolon: ';', Slash: '/',
    KeyQ: 'Q', Digit2: '2', KeyW: 'W', Digit3: '3', KeyE: 'E', KeyR: 'R', Digit5: '5', KeyT: 'T', Digit6: '6', KeyY: 'Y', Digit7: '7', KeyU: 'U',
    KeyI: 'I', Digit9: '9', KeyO: 'O', Digit0: '0', KeyP: 'P', BracketLeft: '[', Equal: '=', BracketRight: ']',
  };

  const KEY_SPAN = 32;          // on-screen keys: C<oct> .. G<oct+2>
  const WAVES = [['sine', 'Sine'], ['triangle', 'Tri'], ['sawtooth', 'Saw'], ['square', 'Sqr']];

  let active = false;
  const pianoKeys = {};         // semitone offset -> element
  const controls = [];          // { sync() } for refreshing from the patch
  let roll = null;
  let rafId = null;

  /* ---------------------------------------------------------- helpers */
  const fmtSec = (v) => (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s');
  const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + ' Hz';
  const fmtPct = (v) => Math.round(v * 100) + '%';
  const fmtCents = (v) => (v > 0 ? '+' : '') + Math.round(v) + ' ct';
  const fmtSigned = (v) => (v > 0 ? '+' : '') + v;

  // Logarithmic mapping for time / frequency sliders (slider runs 0..1000).
  function logMap(min, max) {
    const lmin = Math.log(min), lmax = Math.log(max);
    return {
      toUi: (v) => Math.round(((Math.log(Math.max(min, v)) - lmin) / (lmax - lmin)) * 1000),
      fromUi: (u) => Math.exp(lmin + (u / 1000) * (lmax - lmin)),
    };
  }

  function getPath(path) {
    return path.split('.').reduce((o, k) => (o ? o[k] : undefined), Synth.patch);
  }

  // A labelled slider bound to a patch path.
  function param(label, path, o) {
    o = o || {};
    const map = o.log ? logMap(o.min, o.max) : null;
    const value = el('span', { class: 'sl-val' });
    const input = el('input', map
      ? { type: 'range', min: 0, max: 1000, step: 1 }
      : { type: 'range', min: o.min, max: o.max, step: o.step || 0.01 });
    const fmt = o.fmt || ((v) => v);
    const show = (v) => { value.textContent = fmt(v); };
    input.addEventListener('input', () => {
      const v = map ? map.fromUi(parseFloat(input.value)) : parseFloat(input.value);
      Synth.setParam(path, v);
      show(v);
    });
    input.addEventListener('change', () => input.blur());
    const sync = () => {
      const v = getPath(path);
      input.value = map ? map.toUi(v) : v;
      show(v);
    };
    controls.push({ sync });
    sync();
    return el('div', { class: 'slider' }, [el('div', { class: 'sl-top' }, [el('label', { text: label }), value]), input]);
  }

  function waveButtons(path) {
    const wrap = el('div', { class: 'wave-btns' });
    const btns = WAVES.map(([w, label]) => {
      const b = el('button', { class: 'mini', text: label, title: w });
      b.addEventListener('click', () => { Synth.setParam(path, w); sync(); b.blur(); });
      wrap.appendChild(b);
      return [w, b];
    });
    const sync = () => btns.forEach(([w, b]) => b.classList.toggle('active', getPath(path) === w));
    controls.push({ sync });
    sync();
    return wrap;
  }

  function selectParam(path, options) {
    const s = el('select', { class: 'syn-select' }, options.map(([v, l]) => el('option', { value: v, text: l })));
    s.addEventListener('change', () => { Synth.setParam(path, s.value); s.blur(); });
    controls.push({ sync: () => { s.value = getPath(path); } });
    s.value = getPath(path);
    return s;
  }

  function card(title, children, extraHead) {
    return el('div', { class: 'syn-card' }, [
      el('div', { class: 'syn-card-head' }, [el('div', { class: 'eq-title', text: title }), extraHead || null].filter(Boolean)),
      el('div', { class: 'syn-card-body' }, children),
    ]);
  }

  function toggleBtn(text, title, getter, setter) {
    const b = el('button', { class: 'toggle', text, title });
    const sync = () => b.classList.toggle('active', !!getter());
    b.addEventListener('click', () => { setter(!getter()); sync(); b.blur(); });
    sync();
    return { el: b, sync };
  }

  function syncAll() { controls.forEach((c) => c.sync()); }

  /* ---------------------------------------------------------- presets */
  let presetSelect = null;
  function buildPresetSelect() {
    presetSelect.innerHTML = '';
    const all = Synth.allPresets();
    const groups = new Map();   // category -> optgroup, in first-seen order
    all.forEach((p, i) => {
      const cat = p.user ? 'My presets' : (p.category || 'Basics');
      if (!groups.has(cat)) groups.set(cat, el('optgroup', { label: cat }));
      groups.get(cat).appendChild(el('option', { value: String(i), text: p.name }));
    });
    const mine = groups.get('My presets');
    groups.forEach((g, cat) => { if (cat !== 'My presets') presetSelect.appendChild(g); });
    if (mine) presetSelect.appendChild(mine);
    const idx = all.findIndex((p) => p.name === Synth.patch.name && !!p.user === !!Synth.patch.user);
    presetSelect.value = idx >= 0 ? String(idx) : '';
  }

  /* ------------------------------------------------------------ piano */
  function midiForSemi(semi) { return (Synth.octave + 1) * 12 + semi; }

  function keyLabel(code) { return LABELS[code] || ''; }

  function buildPiano() {
    const piano = el('div', { class: 'syn-piano', id: 'syn-piano' });
    let whiteIndex = 0;
    for (let s = 0; s < KEY_SPAN; s++) {
      const pc = s % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      const k = el('div', { class: 'pkey ' + (black ? 'black' : 'white'), dataset: { semi: String(s) } }, [
        el('span', { class: 'pk-label' }),
        el('span', { class: 'pk-note' }),
      ]);
      if (black) k.style.left = 'calc(' + whiteIndex + ' * var(--wk) - var(--bk) / 2)';
      else whiteIndex++;
      const id = 'mouse-' + s;
      k.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        k.setPointerCapture && k.setPointerCapture(e.pointerId);
        Synth.noteOn(id, midiForSemi(s));
      });
      const up = () => Synth.noteOff(id);
      k.addEventListener('pointerup', up);
      k.addEventListener('pointercancel', up);
      k.addEventListener('lostpointercapture', up);
      pianoKeys[s] = k;
      piano.appendChild(k);
    }
    piano.style.setProperty('--whites', String(whiteIndex));
    return piano;
  }

  function refreshPianoLabels() {
    for (let s = 0; s < KEY_SPAN; s++) {
      const k = pianoKeys[s];
      // Where the rows overlap (C+1 .. E+1) both keys play the same note.
      const labels = [];
      if (s < LOWER_ROW.length) labels.push(keyLabel(LOWER_ROW[s]));
      if (s >= 12 && s - 12 < UPPER_ROW.length) labels.push(keyLabel(UPPER_ROW[s - 12]));
      qs('.pk-label', k).textContent = labels.join(' ');
      qs('.pk-note', k).textContent = (s % 12 === 0) ? SE.noteName(midiForSemi(s)) : '';
    }
    const oct = qs('#syn-octave-val');
    if (oct) oct.textContent = 'C' + Synth.octave;
  }

  function lightKey(midi, on) {
    const s = midi - (Synth.octave + 1) * 12;
    const k = pianoKeys[s];
    if (k) k.classList.toggle('down', on);
  }

  /* ------------------------------------------------------- piano roll */
  function drawRoll() {
    if (!roll) return;
    const canvas = roll;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // After a free jam (and no take yet), the roll shows the jam in free time.
    const showJam = !Synth._previewLoop && ((Synth.recording && Synth.jamMode) || (!Synth.recording && !Synth.take.notes.length && Synth.jam));
    const take = showJam && !Synth.recording ? { notes: Synth.jam.notes, lengthSec: Synth.jam.durationSec, bpm: 60, beatsPerBar: 4 } : Synth.take;
    const t = Synth.tempo();
    const bpm = take.notes.length ? take.bpm : t.bpm;
    const bpb = take.notes.length ? take.beatsPerBar : t.beatsPerBar;
    const spb = 60 / bpm;
    const barLen = spb * bpb;
    const pos = Synth.position();
    let length = Math.max(take.lengthSec || 0, barLen * 2);
    if (Synth.recording && pos != null) length = Math.max(length, Math.ceil(Math.max(pos, 0.001) / barLen) * barLen);
    const pxs = w / length;

    // grid (seconds when showing a free jam, beats/bars otherwise)
    if (showJam) {
      for (let sec = 0, x; (x = sec * pxs) <= w + 1; sec++) {
        g.fillStyle = sec % 5 === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)';
        g.fillRect(Math.round(x), 0, 1, h);
        if (sec % 5 === 0) { g.fillStyle = 'rgba(139,150,173,0.9)'; g.font = '10px monospace'; g.fillText(MPC.util.formatTime(sec), Math.round(x) + 3, 11); }
      }
    }
    for (let b = 0, x; !showJam && (x = b * spb * pxs) <= w + 1; b++) {
      g.fillStyle = b % bpb === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      g.fillRect(Math.round(x), 0, 1, h);
      if (b % bpb === 0) {
        g.fillStyle = 'rgba(139,150,173,0.9)';
        g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
        g.fillText(String(b / bpb + 1), Math.round(x) + 3, 11);
      }
    }

    const notes = (Synth.recording && Synth.jamMode ? [] : take.notes).concat(Synth.recording ? Synth._recNew.map((n) => ({
      midi: n.midi, start: Math.max(0, n.start), end: n.end != null ? n.end : (pos || 0), live: true,
    })) : []);
    if (!notes.length) {
      g.fillStyle = 'rgba(139,150,173,0.7)';
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(Synth.recording ? 'Recording… play some notes' : 'No take yet — press ● Rec and play', w / 2, h / 2 + 4);
      g.textAlign = 'left';
    } else {
      let lo = 127, hi = 0;
      notes.forEach((n) => { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); });
      lo -= 2; hi += 2;
      const rowH = Math.max(3, Math.min(14, (h - 16) / (hi - lo + 1)));
      const top = 16 + ((h - 16) - rowH * (hi - lo + 1)) / 2;
      notes.forEach((n) => {
        const x = n.start * pxs;
        const nw = Math.max(2, (n.end - n.start) * pxs);
        const y = top + (hi - n.midi) * rowH;
        g.fillStyle = n.live ? '#ff6b81' : '#54a0ff';
        g.fillRect(x, y, nw, rowH - 1);
      });
    }

    if (pos != null && pos >= 0) {
      g.fillStyle = Synth.recording ? '#ff4d5e' : '#2ed573';
      g.fillRect(Math.round(pos * pxs), 0, 2, h);
    }

    const info = qs('#syn-take-info');
    if (info) {
      const bars = take.lengthSec ? Math.round(take.lengthSec / barLen) : 0;
      info.textContent = showJam && Synth.jam && !Synth.recording
        ? 'last jam · ' + Synth.jam.notes.length + ' notes · ' + MPC.util.formatTime(Synth.jam.durationSec)
        : take.notes.length
        ? take.notes.length + ' notes · ' + bars + ' bar' + (bars === 1 ? '' : 's') + ' · ' + Math.round(take.bpm) + ' BPM'
        : 'empty';
    }
  }

  function animate() {
    drawRoll();
    if (Synth.playing || Synth.recording) rafId = requestAnimationFrame(animate);
    else rafId = null;
  }
  function kick() { if (!rafId) rafId = requestAnimationFrame(animate); }

  /* ------------------------------------------------------------ build */
  function build() {
    const host = qs('#tab-synth');
    host.innerHTML = '';

    // --- header: preset, octave, velocity
    presetSelect = el('select', { class: 'syn-select wide', title: 'Preset' });
    presetSelect.addEventListener('change', () => {
      const p = Synth.allPresets()[parseInt(presetSelect.value, 10)];
      if (p) { Synth.setPatch(p); }
      presetSelect.blur();
    });
    buildPresetSelect();
    const savePreset = el('button', { class: 'mini', text: 'Save preset…' });
    savePreset.addEventListener('click', async () => {
      const name = await MPC.ui.prompt('Preset name', Synth.patch.user ? Synth.patch.name : Synth.patch.name + ' copy');
      if (name) { Synth.saveUserPreset(name); MPC.toast('Saved preset “' + name + '”'); }
    });
    const delPreset = el('button', { class: 'mini danger', text: 'Delete', title: 'Delete this user preset' });
    delPreset.addEventListener('click', async () => {
      if (!Synth.patch.user) { MPC.toast('Factory presets can’t be deleted.'); return; }
      if (await MPC.ui.confirm('Delete preset “' + Synth.patch.name + '”?')) Synth.deleteUserPreset(Synth.patch.name);
    });

    const octDown = el('button', { class: 'mini', text: '−', title: 'Octave down (↓)' });
    const octUp = el('button', { class: 'mini', text: '+', title: 'Octave up (↑)' });
    octDown.addEventListener('click', () => { Synth.releaseAll(); Synth.setOctave(Synth.octave - 1); octDown.blur(); });
    octUp.addEventListener('click', () => { Synth.releaseAll(); Synth.setOctave(Synth.octave + 1); octUp.blur(); });

    const velVal = el('span', { class: 'sl-val' });
    const vel = el('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: Synth.velocity });
    const showVel = () => { velVal.textContent = Math.round(Synth.velocity * 127); };
    vel.addEventListener('input', () => { Synth.velocity = parseFloat(vel.value); showVel(); });
    vel.addEventListener('change', () => vel.blur());
    showVel();

    const head = el('div', { class: 'syn-head' }, [
      el('div', { class: 'syn-group' }, [el('span', { class: 'pl-label', text: 'Preset' }), presetSelect, savePreset, delPreset]),
      el('div', { class: 'syn-group' }, [el('span', { class: 'pl-label', text: 'Octave' }), octDown, el('span', { class: 'syn-oct', id: 'syn-octave-val' }), octUp]),
      el('div', { class: 'syn-group syn-vel' }, [el('span', { class: 'pl-label', text: 'Velocity' }), vel, velVal]),
      el('div', { class: 'syn-group' }, [param('Volume', 'volume', { min: 0, max: 1.2, step: 0.01, fmt: fmtPct })]),
    ]);

    // --- patch cards
    const osc = (n) => card('Osc ' + n, [
      waveButtons('osc' + n + '.wave'),
      el('div', { class: 'ctl-row' }, [
        param('Octave', 'osc' + n + '.octave', { min: -2, max: 2, step: 1, fmt: fmtSigned }),
        param('Semi', 'osc' + n + '.semi', { min: -12, max: 12, step: 1, fmt: fmtSigned }),
      ]),
      el('div', { class: 'ctl-row' }, [
        param('Detune', 'osc' + n + '.detune', { min: -50, max: 50, step: 1, fmt: fmtCents }),
        param('Level', 'osc' + n + '.level', { min: 0, max: 1, step: 0.01, fmt: fmtPct }),
      ]),
    ]);

    const voiceCard = card('Unison', [
      param('Voices', 'unison', { min: 1, max: 7, step: 1 }),
      param('Spread', 'spread', { min: 0, max: 50, step: 1, fmt: (v) => Math.round(v) + ' ct' }),
    ]);

    const filterCard = card('Filter', [
      selectParam('filter.type', [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass']]),
      param('Cutoff', 'filter.cutoff', { log: true, min: 20, max: 20000, fmt: fmtHz }),
      el('div', { class: 'ctl-row' }, [
        param('Reso', 'filter.q', { min: 0.1, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) }),
        param('Env amt', 'filter.envAmt', { min: 0, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) + ' oct' }),
      ]),
    ]);

    const env = (title, prefix) => card(title, [
      el('div', { class: 'ctl-row' }, [
        param('A', prefix + '.a', { log: true, min: 0.001, max: 5, fmt: fmtSec }),
        param('D', prefix + '.d', { log: true, min: 0.001, max: 5, fmt: fmtSec }),
      ]),
      el('div', { class: 'ctl-row' }, [
        param('S', prefix + '.s', { min: 0, max: 1, step: 0.01, fmt: fmtPct }),
        param('R', prefix + '.r', { log: true, min: 0.005, max: 8, fmt: fmtSec }),
      ]),
    ]);

    const lfoCard = card('LFO · wobble', [
      selectParam('lfo.wave', [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square'], ['sawtooth', 'Saw']]),
      param('Rate', 'lfo.rate', { log: true, min: 0.05, max: 20, fmt: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)) + ' Hz' }),
      el('div', { class: 'ctl-row' }, [
        param('Pitch', 'lfo.pitch', { min: 0, max: 100, step: 1, fmt: (v) => Math.round(v) + ' ct' }),
        param('Filter', 'lfo.filter', { min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) + ' oct' }),
      ]),
    ]);

    const colorCard = card('Noise · drive', [
      param('Noise', 'noise', { min: 0, max: 1, step: 0.01, fmt: fmtPct }),
      param('Drive', 'drive', { min: 0, max: 1, step: 0.01, fmt: fmtPct }),
    ]);

    const delayCard = card('Delay', [
      el('div', { class: 'ctl-row' }, [
        param('Mix', 'fx.delayMix', { min: 0, max: 1, step: 0.01, fmt: fmtPct }),
        param('Time', 'fx.delayTime', { log: true, min: 0.02, max: 1.5, fmt: fmtSec }),
      ]),
      param('Feedback', 'fx.delayFb', { min: 0, max: 0.9, step: 0.01, fmt: fmtPct }),
    ]);

    const reverbCard = card('Reverb', [
      param('Mix', 'fx.reverbMix', { min: 0, max: 1, step: 0.01, fmt: fmtPct }),
      param('Size', 'fx.reverbSize', { min: 0.3, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) + ' s' }),
    ]);

    const cards = el('div', { class: 'syn-cards' }, [
      osc(1), osc(2), voiceCard, filterCard, env('Amp envelope', 'ampEnv'), env('Filter envelope', 'filterEnv'), lfoCard, colorCard, delayCard, reverbCard,
    ]);

    // --- keyboard
    const piano = buildPiano();
    const kbHint = el('p', { class: 'hint' }, [
      'Play with your computer keyboard: bottom row ', el('code', { text: 'Z S X D C V …' }),
      ' and top row ', el('code', { text: 'Q 2 W 3 E R …' }),
      ' (one octave apart, keys matched by position so QWERTZ works too). ',
      el('code', { text: '↑ ↓' }), ' octave · ', el('code', { text: 'Enter' }), ' record · ',
      el('code', { text: 'Space' }), ' play/stop · ', el('code', { text: 'Esc' }), ' all notes off.',
    ]);

    // --- recorder
    const recBtn = el('button', { class: 'tbtn record', text: '● Rec', title: 'Record a take (Enter)' });
    const playBtn = el('button', { class: 'tbtn play', text: '▶ Play', title: 'Play the take (Space)' });
    const stopBtn = el('button', { class: 'tbtn', text: '■', title: 'Stop' });
    recBtn.addEventListener('click', () => { Synth.toggleRecord(); recBtn.blur(); });
    playBtn.addEventListener('click', () => { if (Synth.playing) Synth.stop(); else Synth.play(); playBtn.blur(); });
    stopBtn.addEventListener('click', () => { Synth.stop(); stopBtn.blur(); });
    const loopT = toggleBtn('↻ Loop', 'Loop playback', () => Synth.loop, (v) => { Synth.loop = v; });
    const dubT = toggleBtn('Overdub', 'Add to the existing take instead of replacing it', () => Synth.overdub, (v) => { Synth.overdub = v; });
    const clickT = toggleBtn('🎵 Click', 'Metronome while recording (uses the project BPM)', () => Synth.metronome, (v) => { Synth.metronome = v; });
    const jamT = toggleBtn('🌀 Jam', 'Free jam: record without click, count-in or tempo, then find the loops in it', () => Synth.jamMode, (v) => {
      Synth.jamMode = v;
      [dubT.el, clickT.el, countT.el, quant].forEach((n) => { n.disabled = v; });
    });
    const countT = toggleBtn('Count-in', 'One bar count-in before recording', () => Synth.countIn, (v) => { Synth.countIn = v; });
    const quant = el('select', { class: 'syn-select', title: 'Quantize note starts when recording stops' },
      ['off', '1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'].map((q) => el('option', { value: q, text: q === 'off' ? 'Off' : q })));
    quant.value = Synth.quantize;
    quant.addEventListener('change', () => { Synth.quantize = quant.value; quant.blur(); });

    const tightVal = el('span', { class: 'sl-val' });
    const tight = el('input', { id: 'syn-tightness', type: 'range', min: 0, max: 1, step: 0.05, value: Synth.tightness, title: 'How much timing gets corrected. Low keeps your feel; notes only move when they are clearly off. Note lengths always stay as played.' });
    const showTight = () => { const v = Synth.tightness; tightVal.textContent = v === 0 ? 'as played' : v >= 1 ? 'grid' : Math.round(v * 100) + '%'; };
    tight.addEventListener('input', () => { Synth.setTightness(parseFloat(tight.value)); showTight(); });
    tight.addEventListener('change', () => tight.blur());
    showTight();

    const undoBtn = el('button', { class: 'mini', text: 'Undo note', title: 'Remove the last note of the take' });
    undoBtn.addEventListener('click', () => Synth.undoLastNote());
    const trDown = el('button', { class: 'mini', text: '−1', title: 'Transpose take down a semitone' });
    const trUp = el('button', { class: 'mini', text: '+1', title: 'Transpose take up a semitone' });
    trDown.addEventListener('click', () => Synth.transposeTake(-1));
    trUp.addEventListener('click', () => Synth.transposeTake(1));
    const clearBtn = el('button', { class: 'mini danger', text: 'Clear', title: 'Delete the take' });
    clearBtn.addEventListener('click', async () => { if (await MPC.ui.confirm('Clear the recorded take?')) Synth.clearTake(); });

    roll = el('canvas', { class: 'syn-roll', id: 'syn-roll' });

    const recorder = el('div', { class: 'syn-recorder' }, [
      el('div', { class: 'syn-rec-bar' }, [
        el('div', { class: 'syn-group' }, [recBtn, playBtn, stopBtn, loopT.el, dubT.el, jamT.el]),
        el('div', { class: 'syn-group' }, [clickT.el, countT.el, el('span', { class: 'pl-label', text: 'Quantize' }), quant,
          el('span', { class: 'pl-label', text: 'Tightness' }), tight, tightVal]),
        el('div', { class: 'syn-group' }, [el('span', { class: 'pl-label', text: 'Take' }), el('span', { class: 'syn-take-info', id: 'syn-take-info' }), undoBtn, el('span', { class: 'pl-label', text: 'Transpose' }), trDown, trUp, clearBtn]),
      ]),
      roll,
    ]);

    // --- export
    const startAt = el('select', { class: 'syn-select', title: 'Where the exported melody starts' }, [
      el('option', { value: 'bar', text: 'Bar 1 (grid-aligned)' }),
      el('option', { value: 'first', text: 'First note (trimmed)' }),
    ]);
    const bits = el('select', { class: 'syn-select', title: 'WAV bit depth' }, [
      el('option', { value: '24', text: '24-bit' }), el('option', { value: '16', text: '16-bit' }),
    ]);
    const normCb = el('input', { type: 'checkbox', checked: 'checked' });
    [startAt, bits].forEach((s) => s.addEventListener('change', () => s.blur()));

    const padLabel = () => 'pad ' + (MPC.app.state.selectedPad + 1);
    const busy = async (btn, fn) => {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Rendering…';
      try { await MPC.app.ensureAudio(); await fn(); } catch (err) { console.error(err); MPC.toast(err.message || String(err), 'error'); }
      btn.disabled = false; btn.textContent = label;
      updatePadButtons();
    };

    const expTake = el('button', { class: 'primary', text: '⬇ Melody WAV' });
    expTake.addEventListener('click', () => busy(expTake, async () => {
      const buf = await Synth.renderTake({ startAt: startAt.value, normalize: normCb.checked });
      await Synth.exportWav(buf, Synth.takeFilename(), parseInt(bits.value, 10));
    }));
    const takeToPad = el('button', { class: 'mini syn-topad' });
    takeToPad.addEventListener('click', () => busy(takeToPad, async () => {
      const buf = await Synth.renderTake({ startAt: startAt.value, normalize: normCb.checked });
      await Synth.sendToPad(buf, Synth.takeFilename(), MPC.app.state.selectedPad);
    }));

    // one-shot
    const noteSel = el('select', { class: 'syn-select', title: 'Note to render' });
    for (let m = 24; m <= 96; m++) noteSel.appendChild(el('option', { value: String(m), text: SE.noteName(m) + '  (MIDI ' + m + ')' }));
    noteSel.value = '60';
    const holdVal = el('span', { class: 'sl-val' });
    const hold = el('input', { type: 'range', min: 0.05, max: 4, step: 0.05, value: 1 });
    const showHold = () => { holdVal.textContent = parseFloat(hold.value).toFixed(2) + ' s'; };
    hold.addEventListener('input', showHold);
    hold.addEventListener('change', () => hold.blur());
    noteSel.addEventListener('change', () => noteSel.blur());
    showHold();
    const expShot = el('button', { class: 'primary', text: '⬇ One-shot WAV' });
    expShot.addEventListener('click', () => busy(expShot, async () => {
      const midi = parseInt(noteSel.value, 10);
      const buf = await Synth.renderOneShot(midi, parseFloat(hold.value), { normalize: normCb.checked, velocity: Synth.velocity });
      await Synth.exportWav(buf, Synth.oneShotFilename(midi), parseInt(bits.value, 10));
    }));
    const shotToPad = el('button', { class: 'mini syn-topad' });
    shotToPad.addEventListener('click', () => busy(shotToPad, async () => {
      const midi = parseInt(noteSel.value, 10);
      const buf = await Synth.renderOneShot(midi, parseFloat(hold.value), { normalize: normCb.checked, velocity: Synth.velocity });
      await Synth.sendToPad(buf, Synth.oneShotFilename(midi), MPC.app.state.selectedPad);
    }));

    function updatePadButtons() {
      takeToPad.textContent = '→ Load onto MPC ' + padLabel();
      shotToPad.textContent = '→ Load onto MPC ' + padLabel();
    }
    updatePadButtons();
    MPC.bus.on('pad:selected', updatePadButtons);

    // --- Google Drive (claude.ai build only; hidden until the connector bridge answers)
    const driveFolder = el('input', { id: 'syn-drive-folder', class: 'syn-text', type: 'text', value: MPC.drive.folderName(), title: 'Drive folder name (created in My Drive if missing)' });
    driveFolder.addEventListener('change', () => { const v = driveFolder.value.trim(); if (v) MPC.drive.setFolderName(v); else driveFolder.value = MPC.drive.folderName(); });
    const driveStatus = el('p', { class: 'syn-note syn-drive-status', 'aria-live': 'polite' });
    const toDrive = (btn, render, filename) => busy(btn, async () => {
      const folder = driveFolder.value.trim() || MPC.drive.folderName();
      driveStatus.textContent = 'Uploading ' + filename() + ' to “' + folder + '”…';
      try {
        const buf = await render();
        let depth = parseInt(bits.value, 10);
        let blob = MPC.encoders.encodeWav(buf, depth);
        // If this view can't send a file this big, 16-bit halves it.
        if (depth === 24 && blob.size > await MPC.drive.maxBytes()) { depth = 16; blob = MPC.encoders.encodeWav(buf, 16); }
        const name = filename();
        const res = await MPC.drive.saveWav(blob, name, folder);
        driveStatus.textContent = 'Saved ' + name + (depth !== parseInt(bits.value, 10) ? ' (as 16-bit to fit the upload limit)' : '') + ' to “' + folder + '”. ';
        if (res.url) driveStatus.appendChild(el('a', { href: res.url, target: '_blank', rel: 'noopener', text: 'Open in Drive' }));
        MPC.toast('Saved to Google Drive');
      } catch (err) {
        driveStatus.textContent = err.message || String(err);
        throw err;
      }
    });
    const takeToDrive = el('button', { class: 'mini syn-drive', text: '☁ Save to Drive', hidden: 'hidden' });
    takeToDrive.addEventListener('click', () => toDrive(takeToDrive,
      () => Synth.renderTake({ startAt: startAt.value, normalize: normCb.checked }), () => Synth.takeFilename()));
    const shotToDrive = el('button', { class: 'mini syn-drive', text: '☁ Save to Drive', hidden: 'hidden' });
    shotToDrive.addEventListener('click', () => toDrive(shotToDrive,
      () => Synth.renderOneShot(parseInt(noteSel.value, 10), parseFloat(hold.value), { normalize: normCb.checked, velocity: Synth.velocity }),
      () => Synth.oneShotFilename(parseInt(noteSel.value, 10))));
    const driveCard = card('Google Drive', [
      el('label', { class: 'syn-field', for: 'syn-drive-folder' }, [el('span', { class: 'pl-label', text: 'Folder' }), driveFolder]),
      el('p', { class: 'syn-note', text: '“☁ Save to Drive” uploads into this folder in My Drive (loops as WAV + MIDI). The folder is created if it doesn’t exist.' }),
      driveStatus,
    ]);
    driveCard.hidden = true;
    MPC.drive.available().then((ok) => {
      if (!ok) return;
      driveCard.hidden = false; takeToDrive.hidden = false; shotToDrive.hidden = false;
    });

    // --- jam → loops
    const jamInfo = el('span', { class: 'syn-take-info' });
    const findBtn = el('button', { class: 'primary', text: '✨ Find loops' });
    const scriptBtn = el('button', { class: 'mini', text: 'Quick find (no Claude)', title: 'Use the built-in loop finder instead of Claude', hidden: 'hidden' });
    const jamStatus = el('p', { class: 'syn-note', 'aria-live': 'polite' });
    const loopList = el('div', { class: 'syn-loops' });
    const jamPanel = el('div', { class: 'syn-jam' }, [
      el('div', { class: 'syn-group' }, [el('span', { class: 'pl-label', text: 'Last jam' }), jamInfo, findBtn, scriptBtn]),
      jamStatus,
      loopList,
    ]);
    jamPanel.hidden = true;
    MPC.jamAnalyzer.claudeAvailable().then((ok) => {
      if (ok) { findBtn.textContent = '✨ Find loops with Claude'; scriptBtn.hidden = false; }
    });

    function drawMiniRoll(canvas, loop) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 260, h = canvas.clientHeight || 56;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const spb = 60 / loop.bpm;
      const css = getComputedStyle(document.documentElement);
      for (let b = 0; b <= loop.bars * loop.beatsPerBar; b++) {
        g.fillStyle = b % loop.beatsPerBar === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
        g.fillRect(Math.round((b * spb / loop.lengthSec) * (w - 1)), 0, 1, h);
      }
      let lo = 127, hi = 0;
      loop.notes.forEach((n) => { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); });
      const rows = hi - lo + 3, rh = h / rows;
      g.fillStyle = css.getPropertyValue('--accent').trim() || '#54a0ff';
      loop.notes.forEach((n) => {
        g.fillRect((n.start / loop.lengthSec) * w, (hi + 1 - n.midi) * rh, Math.max(2, ((n.end - n.start) / loop.lengthSec) * w - 1), Math.max(2, rh - 1));
      });
    }

    async function loopFiles(loop) {
      const base = Synth.loopBaseName(loop);
      const buf = await Synth.renderLoop(loop, { normalize: normCb.checked });
      const wav = MPC.encoders.encodeWav(buf, parseInt(bits.value, 10));
      const mid = MPC.midi.toBlob(loop, { name: loop.name });
      return { base, buf, wav, mid };
    }

    function renderLoops(result) {
      loopList.innerHTML = '';
      const loops = result.loops;
      if (!loops.length) {
        jamStatus.textContent = (result.note ? result.note + ' ' : '') + 'No loop stood out in this jam. Try repeating an idea two or three times.';
        return;
      }
      jamStatus.textContent = (result.note ? result.note + ' ' : '') +
        (result.source === 'claude' ? 'Claude picked these loops.' : 'The built-in loop finder picked these.') +
        ' Your timing and note lengths are kept; the Tightness slider sets how much off-beat notes get nudged.';
      loops.forEach((loop) => {
        const roll = el('canvas', { class: 'syn-mini-roll' });
        const prev = el('button', { class: 'mini', text: '▶ Preview' });
        const use = el('button', { class: 'mini', text: 'Use as take', title: 'Load into the recorder to edit, play or export' });
        const dl = el('button', { class: 'mini', text: '⬇ WAV + MIDI' });
        const drv = el('button', { class: 'mini syn-drive', text: '☁ Save to Drive', hidden: 'hidden' });
        const status = el('p', { class: 'syn-note' });
        prev.addEventListener('click', () => {
          prev.blur();
          if (Synth._previewLoop === loop) { Synth.stop(); return; }
          Synth.previewLoop(loop);
        });
        const syncPrev = () => { const on = Synth._previewLoop === loop && Synth.playing; prev.textContent = on ? '■ Stop' : '▶ Preview'; prev.classList.toggle('active', on); };
        MPC.bus.on('synth:state', syncPrev);
        use.addEventListener('click', () => { Synth.useLoopAsTake(loop); MPC.toast('Loaded “' + loop.name + '” as the take (' + loop.bpm + ' BPM).'); });
        dl.addEventListener('click', () => busy(dl, async () => {
          const f = await loopFiles(loop);
          const zipBlob = MPC.encoders.zip([
            { name: f.base + '.wav', bytes: new Uint8Array(await f.wav.arrayBuffer()) },
            { name: f.base + '.mid', bytes: new Uint8Array(await f.mid.arrayBuffer()) },
          ]);
          await MPC.host.saveFile(f.base + '.zip', zipBlob);
        }));
        drv.addEventListener('click', () => busy(drv, async () => {
          const folder = driveFolder.value.trim() || MPC.drive.folderName();
          status.textContent = 'Uploading to “' + folder + '”…';
          try {
            const f = await loopFiles(loop);
            let wav = f.wav, note = '';
            if (parseInt(bits.value, 10) === 24 && wav.size > await MPC.drive.maxBytes()) { wav = MPC.encoders.encodeWav(f.buf, 16); note = ' (WAV as 16-bit to fit the upload limit)'; }
            const a = await MPC.drive.saveFile(wav, f.base + '.wav', folder, 'audio/wav');
            await MPC.drive.saveFile(f.mid, f.base + '.mid', folder, 'audio/midi');
            status.textContent = 'Saved WAV + MIDI to “' + folder + '”' + note + '. ';
            if (a.url) status.appendChild(el('a', { href: a.url, target: '_blank', rel: 'noopener', text: 'Open in Drive' }));
          } catch (err) { status.textContent = err.message || String(err); throw err; }
        }));
        MPC.drive.available().then((ok) => { drv.hidden = !ok; });
        const cardEl = el('div', { class: 'syn-card syn-loop' }, [
          el('div', { class: 'syn-card-head' }, [
            el('div', { class: 'syn-loop-name', text: loop.name }),
            el('span', { class: 'syn-take-info', text: loop.bars + ' bar' + (loop.bars === 1 ? '' : 's') + ' · ' + loop.bpm + ' BPM · ' + loop.beatsPerBar + '/4 · at ' + MPC.util.formatTime(loop.startInJam) }),
          ]),
          roll,
          loop.reason ? el('p', { class: 'syn-note', text: loop.reason }) : null,
          el('div', { class: 'syn-group' }, [prev, use, dl, drv]),
          status,
        ].filter(Boolean));
        loopList.appendChild(cardEl);
        requestAnimationFrame(() => drawMiniRoll(roll, loop));
        MPC.bus.on('synth:feel', () => { if (roll.isConnected) drawMiniRoll(roll, loop); });
      });
    }

    let analyzing = null;
    async function analyze(useClaude) {
      if (!Synth.jam) return;
      if (analyzing) { analyzing.abort(); return; }
      analyzing = new AbortController();
      const btn = useClaude ? findBtn : scriptBtn;
      const label = btn.textContent;
      btn.textContent = useClaude ? 'Stop' : 'Finding…';
      jamStatus.textContent = useClaude ? 'Claude is listening through your jam… (this can take up to a minute)' : 'Finding loops…';
      loopList.innerHTML = '';
      try {
        const res = await MPC.jamAnalyzer.analyze(Synth.jam, { tightness: Synth.tightness, useClaude, signal: analyzing.signal, onProgress: (t) => { jamStatus.textContent = t; } });
        Synth.loops = res.loops;
        renderLoops(res);
      } catch (err) {
        jamStatus.textContent = err && err.code === 'cancelled' ? 'Stopped.' : 'Finding loops failed: ' + ((err && err.message) || err);
      }
      btn.textContent = label;
      analyzing = null;
    }
    findBtn.addEventListener('click', () => { findBtn.blur(); analyze(true); });
    scriptBtn.addEventListener('click', () => { scriptBtn.blur(); analyze(false); });

    MPC.bus.on('synth:jam', () => {
      const j = Synth.jam;
      jamPanel.hidden = !j;
      if (!j) return;
      jamInfo.textContent = j.notes.length + ' notes · ' + MPC.util.formatTime(j.durationSec);
      loopList.innerHTML = '';
      drawRoll();
      jamPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      // Go straight on to finding the loops.
      analyze(true);
    });

    const exportBox = el('div', { class: 'syn-export' }, [
      card('Export melody', [
        el('div', { class: 'syn-group' }, [el('span', { class: 'pl-label', text: 'Start at' }), startAt]),
        el('div', { class: 'syn-group' }, [expTake, takeToPad, takeToDrive]),
      ]),
      card('Export one-shot', [
        el('div', { class: 'syn-group' }, [el('span', { class: 'pl-label', text: 'Note' }), noteSel]),
        el('div', { class: 'slider' }, [el('div', { class: 'sl-top' }, [el('label', { text: 'Hold' }), holdVal]), hold]),
        el('div', { class: 'syn-group' }, [expShot, shotToPad, shotToDrive]),
      ]),
      card('Format', [
        el('div', { class: 'syn-group' }, [bits]),
        el('label', { class: 'checkbox' }, [normCb, ' Normalize to −0.3 dBFS']),
        el('p', { class: 'syn-note', text: '44.1 kHz stereo WAV. Effect tails are included and trailing silence is trimmed.' }),
      ]),
      driveCard,
    ]);

    host.appendChild(head);
    host.appendChild(el('div', { class: 'syn-keys' }, [piano, kbHint]));
    host.appendChild(recorder);
    host.appendChild(jamPanel);
    host.appendChild(cards);
    host.appendChild(exportBox);

    // keep the recorder buttons in sync
    const syncState = () => {
      recBtn.classList.toggle('recording', Synth.recording);
      playBtn.classList.toggle('active', Synth.playing);
      playBtn.textContent = Synth.playing ? '■ Stop' : '▶ Play';
      kick();
      drawRoll();
    };
    MPC.bus.on('synth:state', syncState);
    MPC.bus.on('synth:take', () => drawRoll());
    MPC.bus.on('synth:patch', () => { syncAll(); buildPresetSelect(); });
    MPC.bus.on('synth:presets', buildPresetSelect);
    MPC.bus.on('synth:octave', refreshPianoLabels);
    MPC.bus.on('synth:note', (d) => { lightKey(d.midi, d.on); if (Synth.recording) kick(); });
    MPC.bus.on('settings:changed', drawRoll);
    window.addEventListener('resize', drawRoll);
    refreshPianoLabels();
    syncState();
  }

  /* ------------------------------------------------------- keyboard */
  function isTextTarget(t) {
    if (!t) return false;
    if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
    if (t.tagName === 'SELECT') return true;
    if (t.tagName === 'INPUT') return !['range', 'checkbox', 'button', 'radio'].includes((t.type || '').toLowerCase());
    return false;
  }

  function onKeyDown(e) {
    if (!active || isTextTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (qs('#modal-host').children.length) return;
    const semi = CODE_TO_SEMI[e.code];
    if (semi != null) {
      e.preventDefault();
      if (!e.repeat) Synth.noteOn('key-' + e.code, midiForSemi(semi));
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      if (e.target && e.target.type === 'range') return;
      e.preventDefault();
      Synth.releaseAll();
      Synth.setOctave(Synth.octave + (e.code === 'ArrowUp' ? 1 : -1));
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (Synth.playing || Synth.recording) Synth.stop(); else Synth.play();
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (!e.repeat) Synth.toggleRecord();
    } else if (e.code === 'Escape') {
      Synth.releaseAll();
      Synth.stop();
    }
  }

  function onKeyUp(e) {
    if (CODE_TO_SEMI[e.code] != null) Synth.noteOff('key-' + e.code);
  }

  const UiSynth = {
    isActive() { return active; },
    init() {
      build();
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', () => Synth.releaseAll());
      MPC.bus.on('tab:changed', (d) => {
        active = d.tab === 'synth';
        if (!active) Synth.releaseAll();
        else requestAnimationFrame(drawRoll);
      });
      // Show the real key caps for non-US layouts where the browser allows it.
      if (navigator.keyboard && typeof navigator.keyboard.getLayoutMap === 'function') {
        navigator.keyboard.getLayoutMap().then((map) => {
          Object.keys(LABELS).forEach((code) => { const v = map.get(code); if (v) LABELS[code] = v.toUpperCase(); });
          refreshPianoLabels();
        }).catch(() => { /* not allowed here (e.g. in an iframe) */ });
      }
    },
  };

  MPC.uiSynth = UiSynth;
})();
