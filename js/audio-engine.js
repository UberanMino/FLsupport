/*
 * audio-engine.js — the live Web Audio graph.
 *
 * Signal flow:
 *   voice(source+env) -> padChannel(EQ, pan, gain) -> sectionBus(EQ, gain)
 *                     -> master(gain, limiter) -> destination
 *
 * The section bus is a single shared bus used for monitoring. Its parameters
 * mirror whichever section is currently playing back or being edited, so you
 * hear per-section EQ/volume live. Export re-renders sections offline for
 * bit-accurate per-section processing (see render.js).
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { clamp, dbToGain } = MPC.util;

  // ---- EQ helpers, reusable for offline contexts too --------------------
  function createEqChain(ctx, withPanner) {
    const input = ctx.createGain();
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
    const high = ctx.createBiquadFilter(); high.type = 'highshelf';
    const gain = ctx.createGain();
    let tail = high;
    let panner = null;
    input.connect(low); low.connect(mid); mid.connect(high);
    if (withPanner) {
      panner = ctx.createStereoPanner();
      high.connect(panner); panner.connect(gain); tail = panner;
    } else {
      high.connect(gain);
    }
    return { input, low, mid, high, panner, gain, output: gain };
  }

  function applyEq(nodes, eq, when) {
    const t = when || 0;
    const set = (param, val) => {
      if (typeof param.setValueAtTime === 'function' && when != null) param.setValueAtTime(val, t);
      else param.value = val;
    };
    set(nodes.low.frequency, eq.low.freq);
    set(nodes.low.gain, eq.low.gain);
    set(nodes.mid.frequency, eq.mid.freq);
    set(nodes.mid.Q, eq.mid.q);
    set(nodes.mid.gain, eq.mid.gain);
    set(nodes.high.frequency, eq.high.freq);
    set(nodes.high.gain, eq.high.gain);
  }

  const Engine = {
    _ctx: null,
    master: null,
    sectionBus: null,
    padChannels: [],

    getContext() {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('Web Audio API not supported in this browser.');
        this._ctx = new AC({ latencyHint: 'interactive' });
        this._buildGraph();
      }
      return this._ctx;
    },

    // Resume the context (must be called from a user gesture the first time).
    ensure() {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') return ctx.resume().then(() => ctx);
      return Promise.resolve(ctx);
    },

    now() { return this.getContext().currentTime; },

    decode(arrayBuffer) {
      const ctx = this.getContext();
      return new Promise((resolve, reject) => {
        // Callback form for widest compatibility; modern browsers also return a promise.
        const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    },

    _buildGraph() {
      const ctx = this._ctx;

      // Master: gain -> gentle limiter -> destination
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0.9;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      masterGain.connect(limiter);
      limiter.connect(ctx.destination);
      this.master = {
        input: masterGain,
        setVolume: (v) => { masterGain.gain.value = clamp(v, 0, 1.5); },
      };

      // Section monitoring bus.
      const sec = createEqChain(ctx, false);
      sec.output.connect(masterGain);
      this.sectionBus = {
        nodes: sec,
        input: sec.input,
        setEq: (eq) => applyEq(sec, eq),
        setVolume: (v) => { sec.gain.gain.value = clamp(v, 0, 2); },
      };

      // 16 pad channels.
      this.padChannels = [];
      for (let i = 0; i < MPC.const.NUM_PADS; i++) {
        const ch = createEqChain(ctx, true);
        ch.output.connect(sec.input);
        this.padChannels.push({
          nodes: ch,
          input: ch.input,
          setEq: (eq) => applyEq(ch, eq),
          setVolume: (db) => { ch.gain.gain.value = dbToGain(db); },
          setPan: (p) => { if (ch.panner) ch.panner.pan.value = clamp(p, -1, 1); },
        });
      }
    },

    // Push a pad's stored settings into its live channel.
    syncPadChannel(padIndex, pad) {
      const ch = this.padChannels[padIndex];
      if (!ch) return;
      ch.setEq(pad.eq);
      ch.setVolume(pad.muted ? -60 : pad.gainDb);
      ch.setPan(pad.pan);
    },

    // Play one voice of a pad. Returns { src } so it can be stopped early.
    // opts: { when, trimStart, trimEnd, rate, velocity, destination }
    playVoice(padIndex, sample, opts) {
      const ctx = this.getContext();
      if (!sample || !sample.buffer) return null;
      opts = opts || {};
      const when = opts.when != null ? opts.when : ctx.currentTime;
      const rate = opts.rate || 1;
      const velocity = opts.velocity != null ? opts.velocity : 1;
      const dest = opts.destination || (this.padChannels[padIndex] && this.padChannels[padIndex].input);
      if (!dest) return null;

      const trimStart = clamp(opts.trimStart || 0, 0, sample.duration);
      const trimEnd = clamp(opts.trimEnd != null ? opts.trimEnd : sample.duration, trimStart + 0.001, sample.duration);
      const bufDur = trimEnd - trimStart;
      const playDur = bufDur / rate;

      const src = ctx.createBufferSource();
      src.buffer = sample.buffer;
      src.playbackRate.value = rate;

      const env = ctx.createGain();
      const peak = clamp(velocity, 0, 1);
      const fade = Math.min(0.006, playDur / 2);
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(peak, when + fade);
      env.gain.setValueAtTime(peak, Math.max(when + fade, when + playDur - fade));
      env.gain.linearRampToValueAtTime(0, when + playDur);

      src.connect(env);
      env.connect(dest);
      try {
        src.start(when, trimStart, bufDur);
        src.stop(when + playDur + 0.03);
      } catch (e) {
        return null;
      }
      return { src, env, endsAt: when + playDur };
    },

    createEqChain,
    applyEq,
  };

  MPC.engine = Engine;
})();
