/*
 * synth-engine.js — a small subtractive polysynth on plain Web Audio.
 *
 * The same voice code runs on the live AudioContext (playing from the
 * keyboard) and on an OfflineAudioContext (rendering a take or a one-shot to
 * WAV), so what you hear is what you export.
 *
 * Voice:  2 oscillators (x unison) -> filter (with its own envelope) -> amp env
 * Bus:    voices -> synth bus -> [dry | delay | reverb] -> volume -> output
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { clamp } = MPC.util;

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(midi) { return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1); }
  function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  /* ----------------------------------------------------------- patches */
  function defaultPatch() {
    return {
      name: 'Init',
      osc1: { wave: 'sawtooth', octave: 0, semi: 0, detune: 0, level: 0.8 },
      osc2: { wave: 'square', octave: -1, semi: 0, detune: 7, level: 0.35 },
      unison: 1,           // voices per oscillator
      spread: 12,          // cents between unison voices
      filter: { type: 'lowpass', cutoff: 2400, q: 2, envAmt: 2.5 }, // envAmt in octaves
      ampEnv: { a: 0.005, d: 0.25, s: 0.7, r: 0.25 },
      filterEnv: { a: 0.005, d: 0.3, s: 0.3, r: 0.3 },
      lfo: { wave: 'sine', rate: 5, pitch: 0, filter: 0 },  // pitch in cents, filter in octaves
      noise: 0,            // white-noise level mixed into the filter
      drive: 0,            // soft saturation on the synth bus (0..1)
      fx: { delayMix: 0, delayTime: 0.375, delayFb: 0.35, reverbMix: 0.15, reverbSize: 1.8 },
      volume: 0.7,
      category: 'Basics',
    };
  }

  function preset(name, changes) {
    const p = defaultPatch();
    p.name = name;
    Object.keys(changes).forEach((k) => {
      if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) Object.assign(p[k], changes[k]);
      else p[k] = changes[k];
    });
    return p;
  }

  const PRESETS = [
    defaultPatch(),
    preset('Pluck', {
      osc1: { wave: 'sawtooth', level: 0.8 }, osc2: { wave: 'triangle', octave: 1, detune: 0, level: 0.25 },
      filter: { cutoff: 700, q: 4, envAmt: 4 }, ampEnv: { a: 0.002, d: 0.35, s: 0, r: 0.25 },
      filterEnv: { a: 0.001, d: 0.18, s: 0, r: 0.2 }, fx: { delayMix: 0.22, delayTime: 0.375, reverbMix: 0.2 },
    }),
    preset('Supersaw Lead', {
      osc1: { wave: 'sawtooth', level: 0.7 }, osc2: { wave: 'sawtooth', octave: 1, detune: -5, level: 0.3 },
      unison: 5, spread: 18, filter: { cutoff: 5200, q: 1, envAmt: 1 },
      ampEnv: { a: 0.01, d: 0.3, s: 0.8, r: 0.3 }, fx: { reverbMix: 0.25, delayMix: 0.15 },
    }),
    preset('Warm Pad', {
      osc1: { wave: 'sawtooth', level: 0.6 }, osc2: { wave: 'triangle', octave: 0, detune: 9, level: 0.5 },
      unison: 3, spread: 14, filter: { cutoff: 900, q: 1.2, envAmt: 1.5 },
      ampEnv: { a: 0.6, d: 1.2, s: 0.8, r: 1.4 }, filterEnv: { a: 0.9, d: 1.5, s: 0.5, r: 1.2 },
      fx: { reverbMix: 0.45, reverbSize: 3.5 },
    }),
    preset('Sub Bass', {
      osc1: { wave: 'sine', octave: -1, level: 0.9 }, osc2: { wave: 'triangle', octave: -1, detune: 0, level: 0.25 },
      filter: { cutoff: 600, q: 0.7, envAmt: 0.5 }, ampEnv: { a: 0.003, d: 0.4, s: 0.85, r: 0.12 },
      fx: { reverbMix: 0, delayMix: 0 }, volume: 0.85,
    }),
    preset('Reese Bass', {
      osc1: { wave: 'sawtooth', octave: -1, level: 0.7 }, osc2: { wave: 'sawtooth', octave: -1, detune: 14, level: 0.7 },
      filter: { cutoff: 450, q: 3, envAmt: 1.2 }, ampEnv: { a: 0.005, d: 0.4, s: 0.9, r: 0.15 },
      fx: { reverbMix: 0.05, delayMix: 0 }, volume: 0.55,
    }),
    preset('Bell', {
      osc1: { wave: 'sine', level: 0.8 }, osc2: { wave: 'sine', octave: 2, semi: 7, detune: 0, level: 0.3 },
      filter: { cutoff: 8000, q: 0.5, envAmt: 0 }, ampEnv: { a: 0.001, d: 1.6, s: 0, r: 1.2 },
      fx: { reverbMix: 0.35, reverbSize: 2.5, delayMix: 0.12 },
    }),
    preset('Chip Square', {
      osc1: { wave: 'square', level: 0.6 }, osc2: { wave: 'square', octave: 1, detune: 3, level: 0.15 },
      filter: { cutoff: 9000, q: 0.5, envAmt: 0 }, ampEnv: { a: 0.001, d: 0.1, s: 0.6, r: 0.06 },
      fx: { reverbMix: 0.08, delayMix: 0 },
    }),

    /* ---- Trip Hop kit: atmospheric hip hop / psychedelic trip hop ---- */
    preset('Dusty Keys', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sine', level: 0.85 }, osc2: { wave: 'triangle', octave: 1, detune: 4, level: 0.22 },
      filter: { cutoff: 1800, q: 0.7, envAmt: 1.2 }, ampEnv: { a: 0.004, d: 1.4, s: 0.25, r: 0.5 },
      filterEnv: { a: 0.002, d: 0.6, s: 0.2, r: 0.4 }, lfo: { rate: 0.6, pitch: 7 }, noise: 0.03, drive: 0.25,
      fx: { reverbMix: 0.25, reverbSize: 2.2, delayMix: 0 }, volume: 0.6,
    }),
    preset('Tape Warble Pad', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sawtooth', level: 0.55 }, osc2: { wave: 'triangle', octave: -1, detune: 6, level: 0.45 },
      unison: 3, spread: 16, filter: { cutoff: 650, q: 1.5, envAmt: 1.2 },
      ampEnv: { a: 0.9, d: 1.5, s: 0.85, r: 2.2 }, filterEnv: { a: 1.4, d: 2, s: 0.6, r: 2 },
      lfo: { rate: 0.45, pitch: 14, filter: 0.3 }, noise: 0.05, drive: 0.2,
      fx: { reverbMix: 0.5, reverbSize: 4.5, delayMix: 0.12, delayTime: 0.5, delayFb: 0.4 },
    }),
    preset('Haze Drone', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sawtooth', octave: -1, level: 0.5 }, osc2: { wave: 'sawtooth', octave: 0, semi: 7, detune: -8, level: 0.35 },
      unison: 5, spread: 22, filter: { type: 'lowpass', cutoff: 420, q: 4, envAmt: 0.6 },
      ampEnv: { a: 2.2, d: 2, s: 0.9, r: 3.5 }, filterEnv: { a: 3, d: 3, s: 0.7, r: 3 },
      lfo: { wave: 'triangle', rate: 0.12, pitch: 4, filter: 1.4 }, noise: 0.12, drive: 0.3,
      fx: { reverbMix: 0.6, reverbSize: 6, delayMix: 0.15, delayTime: 0.75, delayFb: 0.5 },
    }),
    preset('Smoky Sub', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sine', octave: -1, level: 0.95 }, osc2: { wave: 'triangle', octave: 0, detune: 0, level: 0.12 },
      filter: { cutoff: 380, q: 0.8, envAmt: 0.8 }, ampEnv: { a: 0.006, d: 0.8, s: 0.7, r: 0.25 },
      filterEnv: { a: 0.002, d: 0.25, s: 0.1, r: 0.2 }, drive: 0.45,
      fx: { reverbMix: 0, delayMix: 0 }, volume: 0.85,
    }),
    preset('Mellow Bass', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'triangle', octave: -1, level: 0.85 }, osc2: { wave: 'sawtooth', octave: -1, detune: 5, level: 0.3 },
      filter: { cutoff: 260, q: 2.5, envAmt: 2.2 }, ampEnv: { a: 0.004, d: 0.6, s: 0.45, r: 0.18 },
      filterEnv: { a: 0.002, d: 0.22, s: 0.05, r: 0.15 }, drive: 0.35,
      fx: { reverbMix: 0.06, delayMix: 0 }, volume: 0.8,
    }),
    preset('Psych Lead', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'square', level: 0.55 }, osc2: { wave: 'sawtooth', octave: 0, detune: 9, level: 0.35 },
      filter: { cutoff: 1500, q: 6, envAmt: 2 }, ampEnv: { a: 0.02, d: 0.5, s: 0.7, r: 0.4 },
      filterEnv: { a: 0.08, d: 0.7, s: 0.4, r: 0.4 }, lfo: { rate: 5.5, pitch: 22, filter: 0.2 }, drive: 0.4,
      fx: { delayMix: 0.35, delayTime: 0.42, delayFb: 0.55, reverbMix: 0.3, reverbSize: 3 }, volume: 0.5,
    }),
    preset('Ghost Theremin', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sine', level: 0.9 }, osc2: { wave: 'triangle', octave: 1, detune: 0, level: 0.08 },
      filter: { cutoff: 3000, q: 0.5, envAmt: 0 }, ampEnv: { a: 0.35, d: 0.5, s: 0.9, r: 0.9 },
      lfo: { rate: 6, pitch: 35 },
      fx: { reverbMix: 0.45, reverbSize: 4, delayMix: 0.2, delayTime: 0.6, delayFb: 0.45 },
    }),
    preset('Breathy Flute', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'triangle', level: 0.75 }, osc2: { wave: 'sine', octave: 1, detune: 0, level: 0.15 },
      filter: { cutoff: 2200, q: 1, envAmt: 0.8 }, ampEnv: { a: 0.12, d: 0.4, s: 0.8, r: 0.35 },
      filterEnv: { a: 0.1, d: 0.5, s: 0.6, r: 0.3 }, lfo: { rate: 4.8, pitch: 10 }, noise: 0.22,
      fx: { reverbMix: 0.35, reverbSize: 2.8, delayMix: 0.1, delayTime: 0.4 },
    }),
    preset('Lo-fi Strings', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sawtooth', level: 0.6 }, osc2: { wave: 'sawtooth', octave: 1, detune: -6, level: 0.25 },
      unison: 5, spread: 14, filter: { cutoff: 1400, q: 0.8, envAmt: 0.6 },
      ampEnv: { a: 0.45, d: 1, s: 0.85, r: 1.1 }, filterEnv: { a: 0.6, d: 1, s: 0.7, r: 1 },
      lfo: { rate: 0.7, pitch: 9 }, noise: 0.04, drive: 0.15,
      fx: { reverbMix: 0.4, reverbSize: 3.5 },
    }),
    preset('Dream Bell', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sine', level: 0.8 }, osc2: { wave: 'sine', octave: 2, semi: 0, detune: 6, level: 0.28 },
      filter: { cutoff: 5000, q: 0.5, envAmt: 0 }, ampEnv: { a: 0.002, d: 2.2, s: 0, r: 1.8 },
      lfo: { rate: 0.5, pitch: 6 },
      fx: { reverbMix: 0.5, reverbSize: 5, delayMix: 0.3, delayTime: 0.5, delayFb: 0.5 },
    }),
    preset('Echo Pluck', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'square', level: 0.6 }, osc2: { wave: 'triangle', octave: 1, detune: 3, level: 0.3 },
      filter: { cutoff: 500, q: 5, envAmt: 3.5 }, ampEnv: { a: 0.002, d: 0.3, s: 0, r: 0.25 },
      filterEnv: { a: 0.001, d: 0.15, s: 0, r: 0.15 }, drive: 0.2,
      fx: { delayMix: 0.45, delayTime: 0.375, delayFb: 0.6, reverbMix: 0.3, reverbSize: 3 },
    }),
    preset('Space Sweep', {
      category: 'Trip Hop Kit',
      osc1: { wave: 'sawtooth', level: 0.45 }, osc2: { wave: 'square', octave: -1, detune: 12, level: 0.3 },
      unison: 3, spread: 30, filter: { type: 'bandpass', cutoff: 700, q: 2, envAmt: 2.5 },
      ampEnv: { a: 1.5, d: 2.5, s: 0.6, r: 3 }, filterEnv: { a: 3, d: 3, s: 0.2, r: 3 },
      lfo: { wave: 'triangle', rate: 0.2, pitch: 0, filter: 1 }, noise: 0.35,
      fx: { reverbMix: 0.65, reverbSize: 6, delayMix: 0.25, delayTime: 0.66, delayFb: 0.55 }, volume: 1.5,
    }),
  ];

  // Fill any fields missing from an older saved patch.
  function normalizePatch(p) {
    const d = defaultPatch();
    if (!p || typeof p !== 'object') return d;
    const out = Object.assign({}, d, p);
    ['osc1', 'osc2', 'filter', 'ampEnv', 'filterEnv', 'lfo', 'fx'].forEach((k) => { out[k] = Object.assign({}, d[k], p[k] || {}); });
    return out;
  }

  /* --------------------------------------------------- envelope helpers */
  // Linear ADSR so the value at any moment can be computed exactly; that
  // lets an offline render schedule the release without cancelling ramps.
  function envValueAt(env, base, peak, sus, elapsed) {
    const a = Math.max(0.001, env.a);
    const d = Math.max(0.001, env.d);
    if (elapsed <= 0) return base;
    if (elapsed < a) return base + (peak - base) * (elapsed / a);
    if (elapsed < a + d) return peak + (sus - peak) * ((elapsed - a) / d);
    return sus;
  }

  // Schedule attack/decay(/release when `end` is known) on an AudioParam.
  function scheduleEnv(param, env, base, peak, sus, start, end) {
    const a = Math.max(0.001, env.a);
    const d = Math.max(0.001, env.d);
    param.setValueAtTime(base, start);
    if (end == null || end >= start + a + d) {
      param.linearRampToValueAtTime(peak, start + a);
      param.linearRampToValueAtTime(sus, start + a + d);
      if (end != null) param.setValueAtTime(sus, end); // release ramps start here
    } else if (end >= start + a) {
      param.linearRampToValueAtTime(peak, start + a);
      param.linearRampToValueAtTime(envValueAt(env, base, peak, sus, end - start), end);
    } else {
      param.linearRampToValueAtTime(envValueAt(env, base, peak, sus, end - start), end);
    }
  }

  function releaseEnv(param, env, base, peak, sus, start, t, releaseTime) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(envValueAt(env, base, peak, sus, t - start), t);
    }
    param.linearRampToValueAtTime(base, t + releaseTime);
  }

  /* -------------------------------------------------------------- voice */
  // Start one note. `end` (optional) schedules the release up front, which is
  // what offline rendering uses; live playing calls voice.release(t) later.
  function startVoice(ctx, patch, midi, velocity, start, dest, end) {
    const vel = clamp(velocity == null ? 0.9 : velocity, 0, 1);
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = patch.filter.type;
    filter.Q.value = patch.filter.q;
    filter.connect(amp);
    amp.connect(dest);

    const cutoff = clamp(patch.filter.cutoff, 20, 20000);
    const fPeak = clamp(cutoff * Math.pow(2, patch.filter.envAmt), 20, 20000);
    const fSus = clamp(cutoff * Math.pow(2, patch.filter.envAmt * patch.filterEnv.s), 20, 20000);
    const aPeak = vel;
    const aSus = vel * patch.ampEnv.s;

    scheduleEnv(amp.gain, patch.ampEnv, 0, aPeak, aSus, start, end);
    scheduleEnv(filter.frequency, patch.filterEnv, cutoff, fPeak, fSus, start, end);

    const oscs = [];       // every source node, so they all stop together
    const lfo = patch.lfo || {};
    let lfoPitch = null;
    if ((lfo.pitch || 0) > 0 || (lfo.filter || 0) > 0) {
      const lo = ctx.createOscillator();
      lo.type = lfo.wave || 'sine';
      lo.frequency.value = clamp(lfo.rate || 1, 0.01, 30);
      if (lfo.pitch > 0) { lfoPitch = ctx.createGain(); lfoPitch.gain.value = lfo.pitch; lo.connect(lfoPitch); }
      if (lfo.filter > 0) { const lf = ctx.createGain(); lf.gain.value = lfo.filter * 1200; lo.connect(lf); lf.connect(filter.detune); }
      lo.start(start);
      oscs.push(lo);
    }
    if ((patch.noise || 0) > 0) {
      const ns = ctx.createBufferSource();
      ns.buffer = noiseBuffer(ctx);
      ns.loop = true;
      const ng = ctx.createGain();
      ng.gain.value = clamp(patch.noise, 0, 1) * 0.6;
      ns.connect(ng); ng.connect(filter);
      ns.start(start, Math.random() * 1.5);
      oscs.push(ns);
    }
    const n = clamp(Math.round(patch.unison || 1), 1, 7);
    const baseFreq = midiToFreq(midi);
    [patch.osc1, patch.osc2].forEach((o) => {
      if (!o || o.level <= 0) return;
      const level = o.level / Math.sqrt(n);
      for (let u = 0; u < n; u++) {
        const osc = ctx.createOscillator();
        osc.type = o.wave;
        osc.frequency.value = baseFreq * Math.pow(2, (o.octave || 0) + (o.semi || 0) / 12);
        const spreadPos = n === 1 ? 0 : (u / (n - 1)) * 2 - 1;      // -1..1
        osc.detune.value = (o.detune || 0) + spreadPos * (patch.spread || 0);
        if (lfoPitch) lfoPitch.connect(osc.detune);
        const g = ctx.createGain();
        g.gain.value = level;
        osc.connect(g);
        if (n > 1 && ctx.createStereoPanner) {
          const pan = ctx.createStereoPanner();
          pan.pan.value = spreadPos * 0.6;
          g.connect(pan); pan.connect(filter);
        } else {
          g.connect(filter);
        }
        osc.start(start);
        oscs.push(osc);
      }
    });

    const voice = {
      midi, start, oscs, amp, filter, released: false,
      // Release at time t; returns when the voice will be silent.
      release(t) {
        if (voice.released) return voice.endsAt;
        voice.released = true;
        t = Math.max(t, start);
        const r = Math.max(0.005, patch.ampEnv.r);
        releaseEnv(amp.gain, patch.ampEnv, 0, aPeak, aSus, start, t, r);
        releaseEnv(filter.frequency, patch.filterEnv, cutoff, fPeak, fSus, start, t, Math.max(0.005, patch.filterEnv.r));
        voice.endsAt = t + r;
        oscs.forEach((o) => { try { o.stop(t + r + 0.02); } catch (e) { /* already stopped */ } });
        return voice.endsAt;
      },
      // Hard stop (used by panic / stop).
      kill() {
        const t = ctx.currentTime;
        try { amp.gain.cancelScheduledValues(t); amp.gain.setValueAtTime(amp.gain.value, t); amp.gain.linearRampToValueAtTime(0, t + 0.01); } catch (e) { /* ignore */ }
        oscs.forEach((o) => { try { o.stop(t + 0.02); } catch (e) { /* ignore */ } });
        voice.released = true;
      },
    };

    if (end != null) {
      // Offline path: schedule the release directly from exact values.
      const r = Math.max(0.005, patch.ampEnv.r);
      const fr = Math.max(0.005, patch.filterEnv.r);
      amp.gain.linearRampToValueAtTime(0, end + r);
      filter.frequency.linearRampToValueAtTime(cutoff, end + fr);
      oscs.forEach((o) => o.stop(end + r + 0.02));
      voice.released = true;
      voice.endsAt = end + r;
    }
    return voice;
  }

  /* ---------------------------------------------------------- noise/drive */
  const noiseCache = new WeakMap();
  function noiseBuffer(ctx) {
    let buf = noiseCache.get(ctx);
    if (buf) return buf;
    const len = Math.floor(ctx.sampleRate * 2);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const rnd = seededRandom(98765);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
    noiseCache.set(ctx, buf);
    return buf;
  }

  // tanh saturation, gain-compensated so drive mostly adds colour, not volume.
  function driveCurve(amount) {
    const k = 1 + amount * 9;
    const n = 2048;
    const curve = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  /* --------------------------------------------------------------- FX bus */
  // Deterministic noise so the live reverb and the exported one are identical.
  function seededRandom(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function makeImpulse(ctx, seconds) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * clamp(seconds, 0.2, 8)));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      const rnd = seededRandom(1234 + c * 77);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (rnd() * 2 - 1) * Math.pow(1 - t, 3);
      }
    }
    return buf;
  }

  function createBus(ctx, patch, output) {
    const input = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const volume = ctx.createGain();
    const dry = ctx.createGain();
    const delay = ctx.createDelay(2.0);
    const delayFb = ctx.createGain();
    const delayWet = ctx.createGain();
    const convolver = ctx.createConvolver();
    const revWet = ctx.createGain();

    input.connect(shaper);
    shaper.connect(dry); dry.connect(volume);
    shaper.connect(delay); delay.connect(delayFb); delayFb.connect(delay);
    delay.connect(delayWet); delayWet.connect(volume);
    shaper.connect(convolver); convolver.connect(revWet); revWet.connect(volume);
    volume.connect(output);

    let impulseSize = null;
    let driveAmt = null;
    const bus = {
      input,
      output: volume,
      update(p) {
        const fx = p.fx;
        dry.gain.value = 1;
        delay.delayTime.value = clamp(fx.delayTime, 0.01, 2);
        delayFb.gain.value = clamp(fx.delayFb, 0, 0.9);
        delayWet.gain.value = clamp(fx.delayMix, 0, 1);
        revWet.gain.value = clamp(fx.reverbMix, 0, 1);
        if (impulseSize !== fx.reverbSize) {
          impulseSize = fx.reverbSize;
          convolver.buffer = makeImpulse(ctx, fx.reverbSize);
        }
        const drv = clamp(p.drive || 0, 0, 1);
        if (drv !== driveAmt) {
          driveAmt = drv;
          shaper.curve = drv > 0.001 ? driveCurve(drv) : null;
          shaper.oversample = drv > 0.001 ? '2x' : 'none';
          input.gain.value = 1 + drv * 0.5;   // push a little harder into the curve
        }
        volume.gain.value = clamp(p.volume, 0, 1.5);
      },
      disconnect() { try { volume.disconnect(); } catch (e) { /* ignore */ } },
    };
    bus.update(patch);
    return bus;
  }

  // How long sound keeps going after the last voice has faded.
  function fxTail(patch) {
    const fx = patch.fx;
    let tail = 0;
    if (fx.reverbMix > 0.001) tail = Math.max(tail, fx.reverbSize);
    if (fx.delayMix > 0.001 && fx.delayFb > 0) {
      // repeats until ~-60 dB
      const repeats = Math.log(0.001) / Math.log(Math.max(0.01, fx.delayFb));
      tail = Math.max(tail, Math.min(12, fx.delayTime * (repeats + 1)));
    } else if (fx.delayMix > 0.001) {
      tail = Math.max(tail, fx.delayTime);
    }
    return tail;
  }

  /* ------------------------------------------------------ offline render */
  // notes: [{ midi, velocity, start, end }] in seconds.
  // opts: { offset (seconds to shift so the render starts there), minLength,
  //         normalize, sampleRate }
  async function render(patch, notes, opts) {
    opts = opts || {};
    patch = normalizePatch(patch);
    const sr = opts.sampleRate || MPC.const.RENDER_SAMPLE_RATE;
    const offset = opts.offset || 0;
    let lastEnd = 0;
    notes.forEach((n) => { lastEnd = Math.max(lastEnd, n.end - offset + Math.max(0.005, patch.ampEnv.r)); });
    const length = Math.max(opts.minLength || 0, lastEnd + fxTail(patch) + 0.05);
    const frames = Math.max(1, Math.ceil(length * sr));
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(2, frames, sr);
    const bus = createBus(ctx, patch, ctx.destination);
    notes.forEach((n) => {
      const start = Math.max(0, n.start - offset);
      const end = Math.max(start + 0.01, n.end - offset);
      startVoice(ctx, patch, n.midi, n.velocity, start, bus.input, end);
    });
    let buffer = await ctx.startRendering();
    buffer = trimTail(buffer, opts.minLength || 0);
    if (opts.normalize) normalize(buffer, 0.966); // ≈ -0.3 dBFS
    return buffer;
  }

  // Cut trailing near-silence (below -80 dBFS), keeping at least minLength.
  function trimTail(buffer, minLength) {
    const thr = 0.0001;
    let last = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = d.length - 1; i > last; i--) { if (Math.abs(d[i]) > thr) { last = i; break; } }
    }
    const keep = Math.min(buffer.length, Math.max(last + Math.floor(buffer.sampleRate * 0.01), Math.ceil(minLength * buffer.sampleRate), 1));
    if (keep >= buffer.length) return buffer;
    const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: keep, sampleRate: buffer.sampleRate });
    for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(0, keep), c);
    // short fade-out on the cut so it never clicks
    const fade = Math.min(keep, Math.floor(buffer.sampleRate * 0.01));
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < fade; i++) d[keep - 1 - i] *= i / fade;
    }
    return out;
  }

  function peakOf(buffer) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    return peak;
  }

  function normalize(buffer, target) {
    const peak = peakOf(buffer);
    if (peak <= 0) return buffer;
    const g = target / peak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return buffer;
  }

  MPC.synthEngine = {
    NOTE_NAMES, noteName, midiToFreq,
    defaultPatch, normalizePatch, PRESETS,
    startVoice, createBus, render, fxTail, peakOf,
  };
})();
