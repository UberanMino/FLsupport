/*
 * sequencer.js — recording, quantization and note scheduling.
 *
 * Recording is loop-station style: the transport loops one section length and
 * live pad hits are captured (quantized) into the active section. Overdubbing
 * layers new hits over prior passes. Arrangement playback walks every section
 * in order, applying each section's volume + EQ on the shared section bus.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { clamp, semitonesToRate, dbToGain } = MPC.util;

  const Sequencer = {
    recording: false,
    recordingSectionId: null,
    previewSectionId: null,
    _arrangement: null,   // { placements[], startTime, spb }

    // ---- helpers ----------------------------------------------------------
    quantizeTime(t, loopLen) {
      const st = MPC.app.state;
      const value = MPC.const.QUANTIZE_VALUES[st.quantize] || 0;
      if (!value) return clamp(t, 0, loopLen);
      const spb = MPC.transport.secPerBeat();
      const gridSec = value * 4 * spb; // value is a fraction of a whole note (=4 beats)
      let q = Math.round(t / gridSec) * gridSec;
      if (q >= loopLen - 1e-6) q = 0; // snap the tail onto the downbeat
      return clamp(q, 0, loopLen);
    },

    activePlaybackSection() {
      const st = MPC.app.state;
      const id = this.recording ? this.recordingSectionId : this.previewSectionId;
      return st.sections.find((s) => s.id === id) || null;
    },

    resolvePad(padIndex) {
      const pad = MPC.app.state.pads[padIndex];
      if (!pad || !pad.sample || !pad.sample.buffer) return null;
      return pad;
    },

    // ---- live trigger -----------------------------------------------------
    // Play a pad immediately (keyboard / click) and record it if armed.
    triggerPad(padIndex, velocity) {
      const pad = this.resolvePad(padIndex);
      if (!pad) return false;
      velocity = velocity == null ? 0.9 : velocity;
      if (!pad.muted) {
        const when = MPC.engine.now() + 0.004;
        this._voice(pad, padIndex, when, velocity);
      }
      if (this.recording) this._capture(padIndex, velocity);
      MPC.bus.emit('pad:hit', { padIndex, velocity });
      return true;
    },

    _voice(pad, padIndex, when, velocity, destination) {
      const rate = semitonesToRate(pad.tune || 0);
      const trimEnd = pad.trimEnd != null ? pad.trimEnd : pad.sample.duration;
      MPC.engine.playVoice(padIndex, pad.sample, {
        when, rate, velocity,
        trimStart: pad.trimStart || 0,
        trimEnd,
        destination,
      });
    },

    _capture(padIndex, velocity) {
      const section = this.activePlaybackSection();
      if (!section) return;
      const tp = MPC.transport;
      const t = tp.loopPositionNow();
      if (t < 0) return; // during count-in
      const qt = this.quantizeTime(t, tp.loopLength);
      // Absolute context time of this hit's occurrence on the current record pass;
      // the scheduler skips exactly this occurrence so it isn't double-triggered
      // over the live monitor. Absolute time never collides with later
      // preview/overdub passes (which start from a fresh loopStartTime).
      const loopIdx = Math.floor((MPC.engine.now() - tp.loopStartTime) / tp.loopLength);
      const skipTime = tp.loopStartTime + loopIdx * tp.loopLength + qt;
      section.events.push({ padIndex, time: qt, rawTime: t, velocity, _skipTime: skipTime });
      MPC.bus.emit('section:updated', { sectionId: section.id });
    },

    // ---- recording control ------------------------------------------------
    startRecording(section) {
      const st = MPC.app.state;
      this.recording = true;
      this.recordingSectionId = section.id;
      this.previewSectionId = section.id;
      MPC.engine.sectionBus.setEq(section.eq);
      MPC.engine.sectionBus.setVolume(dbToGain(section.volumeDb || 0));
      MPC.transport.beatsPerBar = st.beatsPerBar;
      MPC.transport.setTempo(st.bpm);
      MPC.transport.scheduleNotes = (from, to) => this._scheduleLoop(from, to);
      MPC.transport.startLoop(section.bars, { countIn: st.countIn });
      MPC.bus.emit('sequencer:record-start', { sectionId: section.id });
    },

    stopRecording() {
      this.recording = false;
      MPC.transport.stop();
      MPC.transport.scheduleNotes = null;
      MPC.bus.emit('sequencer:record-stop', { sectionId: this.recordingSectionId });
    },

    // Loop-preview a section (no recording).
    previewSection(section) {
      const st = MPC.app.state;
      this.recording = false;
      this.previewSectionId = section.id;
      MPC.engine.sectionBus.setEq(section.eq);
      MPC.engine.sectionBus.setVolume(dbToGain(section.volumeDb || 0));
      MPC.transport.beatsPerBar = st.beatsPerBar;
      MPC.transport.setTempo(st.bpm);
      MPC.transport.scheduleNotes = (from, to) => this._scheduleLoop(from, to);
      MPC.transport.startLoop(section.bars, { countIn: false });
      MPC.bus.emit('sequencer:preview-start', { sectionId: section.id });
    },

    stopPreview() {
      MPC.transport.stop();
      MPC.transport.scheduleNotes = null;
      MPC.bus.emit('sequencer:preview-stop');
    },

    _scheduleLoop(from, to) {
      const section = this.activePlaybackSection();
      if (!section || section.muted) return;
      const tp = MPC.transport;
      const loopStart = tp.loopStartTime;
      const loopLen = tp.loopLength;
      if (loopLen <= 0) return;
      const iMin = Math.floor((from - loopStart) / loopLen) - 1;
      const iMax = Math.floor((to - loopStart) / loopLen) + 1;
      const now = MPC.engine.now();
      for (const ev of section.events) {
        const pad = this.resolvePad(ev.padIndex);
        if (!pad || pad.muted) continue;
        for (let i = iMin; i <= iMax; i++) {
          const when = loopStart + i * loopLen + ev.time;
          if (when < loopStart - 1e-6) continue;
          // Skip only the exact occurrence already played live on the record pass.
          if (ev._skipTime != null && Math.abs(when - ev._skipTime) < 1e-4) continue;
          if (when >= from && when < to && when >= now - 0.001) {
            this._voice(pad, ev.padIndex, when, ev.velocity);
          }
        }
      }
    },

    // ---- timeline (FL-style playlist) playback ---------------------------
    // Flatten every clip into absolute-time voice events. Section volume is
    // baked into velocity so overlapping clips can share one monitor bus;
    // per-section EQ is applied accurately on export (render.js).
    buildTimelineEvents() {
      const st = MPC.app.state;
      const barLen = MPC.app.barLenSec();
      const events = [];
      for (const clip of st.clips) {
        const section = st.sections.find((s) => s.id === clip.sectionId);
        if (!section || section.muted) continue;
        const loopLen = section.bars * barLen;
        if (loopLen <= 0) continue;
        const clipStart = clip.startBar * barLen;
        const clipDur = clip.lenBars * barLen;
        const secVol = MPC.util.clamp(dbToGain(section.volumeDb || 0), 0, 4);
        for (const e of section.events) {
          const pad = this.resolvePad(e.padIndex);
          if (!pad || pad.muted) continue;
          let n = Math.ceil((clip.srcOffsetSec - e.time) / loopLen - 1e-9);
          for (; ; n++) {
            const occ = e.time + n * loopLen;
            if (occ >= clip.srcOffsetSec + clipDur - 1e-9) break;
            if (occ >= clip.srcOffsetSec - 1e-9) {
              events.push({
                padIndex: e.padIndex,
                when: clipStart + (occ - clip.srcOffsetSec),
                velocity: MPC.util.clamp(e.velocity * secVol, 0, 1),
              });
            }
          }
        }
      }
      events.sort((a, b) => a.when - b.when);
      return events;
    },

    playArrangement(opts) {
      opts = opts || {};
      const st = MPC.app.state;
      if (!st.clips.length) { MPC.toast('The playlist is empty — record a section first.', 'error'); return; }
      this._timeline = this.buildTimelineEvents();
      if (!this._timeline.length) { MPC.toast('Nothing to play in the playlist yet.', 'error'); return; }
      this._timelineTotalSec = MPC.app.totalTimelineBars() * MPC.app.barLenSec();
      // Neutralise the shared bus — section volume is already baked in.
      MPC.engine.sectionBus.setEq(MPC.models.defaultEq());
      MPC.engine.sectionBus.setVolume(1);
      MPC.transport.beatsPerBar = st.beatsPerBar;
      MPC.transport.setTempo(st.bpm);
      MPC.transport.scheduleNotes = (from, to) => this._scheduleTimeline(from, to);
      MPC.transport.startArrangement(MPC.app.totalTimelineBars() * st.beatsPerBar, { loop: !!opts.loop });
      MPC.bus.emit('sequencer:arrangement-start');
    },

    stopArrangement() {
      MPC.transport.stop();
      MPC.transport.scheduleNotes = null;
      this._timeline = null;
      MPC.bus.emit('sequencer:arrangement-stop');
    },

    _scheduleTimeline(from, to) {
      const tl = this._timeline;
      if (!tl) return;
      const base = MPC.transport._startTime;
      const total = this._timelineTotalSec;
      const loop = MPC.transport.loopArrangement;
      const now = MPC.engine.now();
      const pMin = loop ? Math.max(0, Math.floor((from - base) / total)) : 0;
      const pMax = loop ? Math.floor((to - base) / total) + 1 : 0;
      for (let p = pMin; p <= pMax; p++) {
        const offset = base + p * total;
        for (const ev of tl) {
          const when = offset + ev.when;
          if (when < from) continue;
          if (when >= to) break; // tl is sorted by when
          if (when >= now - 0.001) {
            const pad = this.resolvePad(ev.padIndex);
            if (pad && !pad.muted) this._voice(pad, ev.padIndex, when, ev.velocity);
          }
        }
      }
    },

    // ---- editing ----------------------------------------------------------
    clearSection(section) {
      section.events = [];
      MPC.bus.emit('section:updated', { sectionId: section.id });
    },
    undoLast(section) {
      if (section.events.length) {
        section.events.pop();
        MPC.bus.emit('section:updated', { sectionId: section.id });
      }
    },
  };

  MPC.sequencer = Sequencer;
})();
