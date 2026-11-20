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
      fx: { delayMix: 0, delayTime: 0.375, delayFb: 0.35, reverbMix: 0.15, reverbSize: 1.8 },
      volume: 0.7,
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
      fx: { reverbMix: 0.05, delayMix: 0 },
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
  ];

  // Fill any fields missing from an older saved patch.
  function normalizePatch(p) {
    const d = defaultPatch();
    if (!p || typeof p !== 'object') return d;
    const out = Object.assign({}, d, p);
    ['osc1', 'osc2', 'filter', 'ampEnv', 'filterEnv', 'fx'].forEach((k) => { out[k] = Object.assign({}, d[k], p[k] || {}); });
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

    const oscs = [];
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
    const volume = ctx.createGain();
    const dry = ctx.createGain();
    const delay = ctx.createDelay(2.0);
    const delayFb = ctx.createGain();
    const delayWet = ctx.createGain();
    const convolver = ctx.createConvolver();
    const revWet = ctx.createGain();

    input.connect(dry); dry.connect(volume);
    input.connect(delay); delay.connect(delayFb); delayFb.connect(delay);
    delay.connect(delayWet); delayWet.connect(volume);
    input.connect(convolver); convolver.connect(revWet); revWet.connect(volume);
    volume.connect(output);

    let impulseSize = null;
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
