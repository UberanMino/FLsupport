/*
 * transport.js — the master clock + lookahead scheduler.
 *
 * Two modes:
 *   'loop'        one section length, repeats forever (recording / loop-station).
 *   'arrangement' the whole playlist, start to finish (optionally looped).
 *
 * The transport schedules the metronome itself and calls this.scheduleNotes(from,to)
 * every tick so the app/sequencer can queue pad hits for that context-time window.
 * Position is published on the bus as 'transport:position' via requestAnimationFrame.
 */
(function () {
  'use strict';
  const MPC = window.MPC;

  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.12;

  const Transport = {
    bpm: MPC.const.DEFAULT_BPM,
    beatsPerBar: MPC.const.DEFAULT_BEATS_PER_BAR,
    running: false,
    mode: 'loop',

    metronomeEnabled: true,
    metronomeVolume: 0.5,
    countInBeats: 0,
    loopArrangement: false,

    // runtime
    loopStartTime: 0,   // ctx time of beat 0 of the loop (loop mode)
    loopLength: 0,      // seconds (loop mode)
    beatsPerLoop: 0,
    _startTime: 0,      // ctx time of beat 0 (arrangement mode)
    totalBeats: 0,
    _schedFrom: 0,
    _timer: null,
    _raf: null,
    scheduleNotes: null,   // assigned by app: fn(fromTime, toTime)

    secPerBeat() { return 60 / this.bpm; },

    setTempo(bpm) {
      this.bpm = MPC.util.clamp(Math.round(bpm), 20, 300);
      MPC.bus.emit('transport:tempo', this.bpm);
    },

    // ---- start / stop -----------------------------------------------------
    startLoop(bars, opts) {
      opts = opts || {};
      const ctx = MPC.engine.getContext();
      this.mode = 'loop';
      const spb = this.secPerBeat();
      this.beatsPerLoop = bars * this.beatsPerBar;
      this.loopLength = this.beatsPerLoop * spb;
      const countIn = (opts.countIn ? this.countInBeats : 0) * spb;
      this.loopStartTime = ctx.currentTime + 0.06 + countIn;
      this._schedFrom = ctx.currentTime;
      this._begin();
    },

    startArrangement(totalBeats, opts) {
      opts = opts || {};
      const ctx = MPC.engine.getContext();
      this.mode = 'arrangement';
      this.totalBeats = totalBeats;
      this._startTime = ctx.currentTime + 0.06;
      this._schedFrom = ctx.currentTime;
      this.loopArrangement = !!opts.loop;
      this._begin();
    },

    _begin() {
      if (this._timer) clearInterval(this._timer);
      this.running = true;
      this._tick();
      this._timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
      this._startRaf();
      MPC.bus.emit('transport:start', { mode: this.mode });
    },

    stop() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      const was = this.running;
      this.running = false;
      if (was) MPC.bus.emit('transport:stop', { mode: this.mode });
    },

    // ---- scheduling -------------------------------------------------------
    _tick() {
      const ctx = MPC.engine.getContext();
      const to = ctx.currentTime + SCHEDULE_AHEAD;
      const from = this._schedFrom;
      if (to <= from) return;

      this._scheduleMetronome(from, to);
      if (this.scheduleNotes) {
        try { this.scheduleNotes(from, to); } catch (e) { console.error('scheduleNotes', e); }
      }
      this._schedFrom = to;

      if (this.mode === 'arrangement' && !this.loopArrangement) {
        const endTime = this._startTime + this.totalBeats * this.secPerBeat();
        if (ctx.currentTime >= endTime + 0.05) {
          this.stop();
          MPC.bus.emit('transport:arrangement-end');
        }
      }
    },

    gridOrigin() {
      return this.mode === 'loop' ? this.loopStartTime : this._startTime;
    },

    _scheduleMetronome(from, to) {
      if (!this.metronomeEnabled) return;
      const spb = this.secPerBeat();
      const origin = this.gridOrigin();
      let k = Math.ceil((from - origin) / spb - 1e-6);
      let t = origin + k * spb;
      const beatsPerBar = this.beatsPerBar;
      // In arrangement mode don't click past the end.
      const hardEnd = (this.mode === 'arrangement' && !this.loopArrangement)
        ? origin + this.totalBeats * spb : Infinity;
      while (t < to && t <= hardEnd + 1e-6) {
        if (t >= from - 1e-9) {
          const bar = ((k % beatsPerBar) + beatsPerBar) % beatsPerBar;
          this._click(t, bar === 0);
        }
        k++; t = origin + k * spb;
      }
    },

    _click(time, accent) {
      const ctx = MPC.engine.getContext();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = accent ? 1600 : 1050;
      const vol = this.metronomeVolume * (accent ? 1 : 0.65);
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(vol, time + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      osc.connect(g);
      g.connect(MPC.engine.master.input);
      osc.start(time);
      osc.stop(time + 0.06);
    },

    // ---- position (for UI playhead) --------------------------------------
    _startRaf() {
      const emit = () => {
        if (!this.running) return;
        const ctx = MPC.engine.getContext();
        const now = ctx.currentTime;
        if (this.mode === 'loop') {
          const pos = now - this.loopStartTime;
          const loopPos = ((pos % this.loopLength) + this.loopLength) % this.loopLength;
          MPC.bus.emit('transport:position', {
            mode: 'loop',
            countIn: pos < 0,
            positionSec: pos,
            loopPositionSec: pos < 0 ? 0 : loopPos,
            loopLength: this.loopLength,
            fraction: pos < 0 ? 0 : loopPos / this.loopLength,
          });
        } else {
          const pos = now - this._startTime;
          const total = this.totalBeats * this.secPerBeat();
          MPC.bus.emit('transport:position', {
            mode: 'arrangement',
            positionSec: pos,
            totalSec: total,
            fraction: total > 0 ? MPC.util.clamp(pos / total, 0, 1) : 0,
          });
        }
        this._raf = requestAnimationFrame(emit);
      };
      this._raf = requestAnimationFrame(emit);
    },

    // Current loop-local time in seconds (for capturing live hits).
    loopPositionNow() {
      const now = MPC.engine.now();
      const pos = now - this.loopStartTime;
      if (pos < 0) return -1; // count-in
      return ((pos % this.loopLength) + this.loopLength) % this.loopLength;
    },
  };

  MPC.transport = Transport;
})();
