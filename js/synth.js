/*
 * synth.js — synth controller: live playing, take recording / playback, and
 * export (WAV download or straight onto an MPC pad).
 *
 * A "take" is a list of notes { midi, velocity, start, end } in seconds from
 * bar 1, plus its length (whole bars) and the tempo it was recorded at.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const SE = MPC.synthEngine;
  const { clamp } = MPC.util;

  const LS_PATCH = 'mpcstudio.synth.patch';
  const LS_PRESETS = 'mpcstudio.synth.userPresets';

  function lsGet(key, fallback) {
    try { const v = window.localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
  }

  const Synth = {
    patch: SE.normalizePatch(lsGet(LS_PATCH, null) || SE.PRESETS[1]),
    userPresets: lsGet(LS_PRESETS, []),
    octave: 4,              // lower keyboard row starts at C<octave>
    velocity: 0.85,
    quantize: '1/16',
    metronome: true,
    countIn: true,
    overdub: false,
    loop: false,

    take: { notes: [], lengthSec: 0, bpm: 90, beatsPerBar: 4 },

    recording: false,
    playing: false,
    _bus: null,
    _held: new Map(),       // key id -> { voice, midi, recNote }
    _playVoices: [],
    _recT0: 0,
    _recNew: [],
    _clickTimer: null,
    _nextClick: 0,
    _clickBeat: 0,
    _playT0: 0,
    _loopTimer: null,

    /* ------------------------------------------------------------ setup */
    bus() {
      const ctx = MPC.engine.getContext();
      if (!this._bus) this._bus = SE.createBus(ctx, this.patch, MPC.engine.master.input);
      return this._bus;
    },

    setPatch(patch, silent) {
      this.patch = SE.normalizePatch(MPC.util.clone(patch));
      if (this._bus) this._bus.update(this.patch);
      lsSet(LS_PATCH, this.patch);
      if (!silent) MPC.bus.emit('synth:patch');
    },

    // Change one field by path, e.g. ('filter.cutoff', 1200).
    setParam(path, value) {
      const parts = path.split('.');
      let obj = this.patch;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = value;
      if (this._bus) this._bus.update(this.patch);
      lsSet(LS_PATCH, this.patch);
    },

    allPresets() { return SE.PRESETS.concat(this.userPresets); },
    saveUserPreset(name) {
      const p = MPC.util.clone(this.patch);
      p.name = name;
      p.user = true;
      delete p.category;
      this.userPresets = this.userPresets.filter((u) => u.name !== name).concat([p]);
      lsSet(LS_PRESETS, this.userPresets);
      this.patch.name = name;
      this.patch.user = true;
      lsSet(LS_PATCH, this.patch);
      MPC.bus.emit('synth:presets');
    },
    deleteUserPreset(name) {
      this.userPresets = this.userPresets.filter((u) => u.name !== name);
      lsSet(LS_PRESETS, this.userPresets);
      MPC.bus.emit('synth:presets');
    },

    setOctave(o) { this.octave = clamp(o, 0, 7); MPC.bus.emit('synth:octave', this.octave); },

    tempo() {
      const s = MPC.app.state;
      return { bpm: s.bpm, beatsPerBar: s.beatsPerBar, spb: 60 / s.bpm, bar: s.beatsPerBar * 60 / s.bpm };
    },

    /* ---------------------------------------------------------- playing */
    noteOn(keyId, midi, velocity) {
      if (midi < 0 || midi > 127) return;
      if (this._held.has(keyId)) return;
      const ctx = MPC.engine.resumeIfNeeded();
      const bus = this.bus();
      const now = ctx.currentTime;
      const vel = velocity != null ? velocity : this.velocity;
      const voice = SE.startVoice(ctx, this.patch, midi, vel, now, bus.input);
      const held = { voice, midi, recNote: null };
      if (this.recording) {
        held.recNote = { midi, velocity: vel, start: now - this._recT0, end: null };
        this._recNew.push(held.recNote);
      }
      this._held.set(keyId, held);
      MPC.bus.emit('synth:note', { midi, on: true });
    },

    noteOff(keyId) {
      const held = this._held.get(keyId);
      if (!held) return;
      this._held.delete(keyId);
      const ctx = MPC.engine.getContext();
      held.voice.release(ctx.currentTime);
      if (held.recNote) held.recNote.end = ctx.currentTime - this._recT0;
      MPC.bus.emit('synth:note', { midi: held.midi, on: false });
    },

    releaseAll() {
      Array.from(this._held.keys()).forEach((k) => this.noteOff(k));
    },

    /* -------------------------------------------------------- metronome */
    _click(when, accent) {
      const ctx = MPC.engine.getContext();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = accent ? 1760 : 1100;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.2, when + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      osc.connect(g); g.connect(MPC.engine.master.input);
      osc.start(when); osc.stop(when + 0.06);
    },

    _startClicks(firstBeatTime, firstBeatIndex) {
      this._stopClicks();
      const ctx = MPC.engine.getContext();
      this._nextClick = firstBeatTime;
      this._clickBeat = firstBeatIndex;
      const tick = () => {
        const t = this.tempo();
        while (this._nextClick < ctx.currentTime + 0.12) {
          if (this.metronome || this._clickBeat < 0) {
            const beatInBar = ((this._clickBeat % t.beatsPerBar) + t.beatsPerBar) % t.beatsPerBar;
            this._click(this._nextClick, beatInBar === 0);
          }
          this._nextClick += t.spb;
          this._clickBeat++;
        }
      };
      tick();
      this._clickTimer = setInterval(tick, 25);
    },
    _stopClicks() { if (this._clickTimer) clearInterval(this._clickTimer); this._clickTimer = null; },

    /* -------------------------------------------------------- recording */
    async toggleRecord() {
      if (this.recording) { this.stopRecording(); return; }
      await MPC.app.ensureAudio();
      this.stop();
      const ctx = MPC.engine.getContext();
      const t = this.tempo();
      if (!this.overdub || !this.take.notes.length) {
        this.take = { notes: [], lengthSec: 0, bpm: t.bpm, beatsPerBar: t.beatsPerBar };
      } else if (this.take.bpm !== t.bpm) {
        MPC.toast('Tempo changed since this take was recorded — the overdub uses the take’s ' + this.take.bpm + ' BPM grid.', 'info');
      }
      const countIn = this.countIn ? t.beatsPerBar : 0;
      this._recT0 = ctx.currentTime + 0.1 + countIn * t.spb;
      this._recNew = [];
      this.recording = true;
      // Count-in clicks always sound; afterwards only if the metronome is on.
      this._startClicks(this._recT0 - countIn * t.spb, -countIn);
      // Overdub: play the existing take underneath.
      if (this.overdub && this.take.notes.length) this._scheduleTake(this._recT0, false);
      MPC.bus.emit('synth:state');
    },

    stopRecording() {
      if (!this.recording) return;
      const ctx = MPC.engine.getContext();
      // Close notes still held.
      this._held.forEach((h) => { if (h.recNote && h.recNote.end == null) h.recNote.end = ctx.currentTime - this._recT0; h.recNote = null; });
      this.recording = false;
      this._stopClicks();
      this._stopPlayback();

      const t = { bpm: this.take.bpm || this.tempo().bpm, beatsPerBar: this.take.beatsPerBar || this.tempo().beatsPerBar };
      t.spb = 60 / t.bpm; t.bar = t.spb * t.beatsPerBar;
      const q = MPC.const.QUANTIZE_VALUES[this.quantize] || 0;
      const grid = q * 4 * t.spb;   // fraction of a whole note -> seconds

      const fresh = this._recNew
        .filter((n) => n.end != null && n.end > -0.25)
        .map((n) => {
          let start = Math.max(0, n.start);
          let end = Math.max(start + 0.02, n.end);
          if (grid > 0) {
            const qs = Math.round(start / grid) * grid;
            end = qs + Math.max(grid / 2, end - start);
            start = qs;
          }
          return { midi: n.midi, velocity: n.velocity, start, end };
        });
      this._recNew = [];
      if (!fresh.length) {
        MPC.toast('Nothing recorded.');
        MPC.bus.emit('synth:state');
        return;
      }
      const notes = this.take.notes.concat(fresh).sort((a, b) => a.start - b.start);
      const lastEnd = notes.reduce((m, n) => Math.max(m, n.end), 0);
      const bars = Math.max(1, Math.ceil((lastEnd - 0.001) / t.bar));
      this.take = { notes, lengthSec: Math.max(this.take.lengthSec || 0, bars * t.bar), bpm: t.bpm, beatsPerBar: t.beatsPerBar };
      MPC.app.markDirty();
      MPC.bus.emit('synth:take');
      MPC.bus.emit('synth:state');
      MPC.toast('Recorded ' + fresh.length + ' note' + (fresh.length === 1 ? '' : 's') + ' (' + bars + ' bar' + (bars === 1 ? '' : 's') + ').');
    },

    clearTake() {
      this.stop();
      this.take = { notes: [], lengthSec: 0, bpm: this.tempo().bpm, beatsPerBar: this.tempo().beatsPerBar };
      MPC.bus.emit('synth:take');
      MPC.bus.emit('synth:state');
    },

    undoLastNote() {
      if (!this.take.notes.length) return;
      let idx = 0;
      this.take.notes.forEach((n, i) => { if (n.start >= this.take.notes[idx].start) idx = i; });
      this.take.notes.splice(idx, 1);
      MPC.app.markDirty();
      MPC.bus.emit('synth:take');
    },

    transposeTake(semi) {
      this.take.notes.forEach((n) => { n.midi = clamp(n.midi + semi, 0, 127); });
      MPC.app.markDirty();
      MPC.bus.emit('synth:take');
    },

    /* --------------------------------------------------------- playback */
    _scheduleTake(t0, loop) {
      const ctx = MPC.engine.getContext();
      const bus = this.bus();
      this._playT0 = t0;
      this.take.notes.forEach((n) => {
        this._playVoices.push(SE.startVoice(ctx, this.patch, n.midi, n.velocity, t0 + n.start, bus.input, t0 + n.end));
      });
      // drop finished voices so the list doesn't grow forever while looping
      this._playVoices = this._playVoices.filter((v) => v.endsAt > ctx.currentTime);
      if (loop) {
        const next = t0 + this.take.lengthSec;
        const wait = Math.max(0, (next - ctx.currentTime - 0.15) * 1000);
        this._loopTimer = setTimeout(() => { if (this.playing) this._scheduleTake(next, true); }, wait);
      }
    },

    async play() {
      if (!this.take.notes.length) { MPC.toast('Record something first.'); return; }
      await MPC.app.ensureAudio();
      if (this.recording) this.stopRecording();
      this._stopPlayback();
      const ctx = MPC.engine.getContext();
      this.playing = true;
      this._scheduleTake(ctx.currentTime + 0.06, this.loop);
      if (!this.loop) {
        const dur = this.take.lengthSec + Math.max(0.005, this.patch.ampEnv.r);
        this._loopTimer = setTimeout(() => { this.playing = false; MPC.bus.emit('synth:state'); }, dur * 1000 + 100);
      }
      MPC.bus.emit('synth:state');
    },

    _stopPlayback() {
      if (this._loopTimer) clearTimeout(this._loopTimer);
      this._loopTimer = null;
      this._playVoices.forEach((v) => v.kill());
      this._playVoices = [];
      this.playing = false;
    },

    stop() {
      if (this.recording) this.stopRecording();
      this._stopPlayback();
      this._stopClicks();
      MPC.bus.emit('synth:state');
    },

    // Seconds into the take for the playhead, or null when idle.
    position() {
      if (!this.playing && !this.recording) return null;
      const ctx = MPC.engine.getContext();
      const t0 = this.recording ? this._recT0 : this._playT0;
      let p = ctx.currentTime - t0;
      if (this.playing && this.loop && this.take.lengthSec > 0 && p > 0) p = p % this.take.lengthSec;
      return p;
    },

    /* ----------------------------------------------------------- export */
    _baseName() {
      return MPC.util.sanitizeFilename((this.patch.name || 'Synth'));
    },

    async renderTake(opts) {
      opts = opts || {};
      const notes = this.take.notes;
      if (!notes.length) throw new Error('No take recorded yet.');
      const fromFirst = opts.startAt === 'first';
      const offset = fromFirst ? notes.reduce((m, n) => Math.min(m, n.start), Infinity) : 0;
      const minLength = fromFirst ? 0 : this.take.lengthSec;
      return SE.render(this.patch, notes, { offset, minLength, normalize: !!opts.normalize });
    },

    async renderOneShot(midi, holdSec, opts) {
      opts = opts || {};
      return SE.render(this.patch, [{ midi, velocity: opts.velocity || 0.9, start: 0, end: holdSec }], { normalize: !!opts.normalize });
    },

    takeFilename() {
      return this._baseName() + '_melody_' + Math.round(this.take.bpm) + 'bpm.wav';
    },
    oneShotFilename(midi) {
      return this._baseName() + '_' + SE.noteName(midi).replace('#', 's') + '.wav';
    },

    async exportWav(buffer, filename, bitDepth) {
      const blob = MPC.encoders.encodeWav(buffer, bitDepth || 24);
      const ok = await MPC.host.saveFile(filename, blob);
      if (ok) MPC.toast('Exported ' + filename);
      return ok;
    },

    async sendToPad(buffer, filename, padIndex) {
      const blob = MPC.encoders.encodeWav(buffer, 24);
      const file = new File([blob], filename, { type: 'audio/wav' });
      await MPC.app.loadSampleToPad(padIndex, file);
    },

    /* ---------------------------------------------- project persistence */
    serialize() {
      return { patch: MPC.util.clone(this.patch), take: MPC.util.clone(this.take) };
    },
    applySerialized(data) {
      this.stop();
      if (data && data.patch) this.setPatch(data.patch);
      const t = data && data.take;
      this.take = (t && Array.isArray(t.notes))
        ? { notes: t.notes, lengthSec: t.lengthSec || 0, bpm: t.bpm || this.tempo().bpm, beatsPerBar: t.beatsPerBar || 4 }
        : { notes: [], lengthSec: 0, bpm: this.tempo().bpm, beatsPerBar: this.tempo().beatsPerBar };
      MPC.bus.emit('synth:take');
      MPC.bus.emit('synth:state');
    },
  };

  MPC.synth = Synth;
})();
