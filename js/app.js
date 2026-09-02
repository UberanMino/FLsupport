/*
 * app.js — central state + high-level actions.
 *
 * UI modules read MPC.app.state and call MPC.app.* actions; actions mutate
 * state, drive the engine/transport, persist to IndexedDB, and emit bus events
 * that the UI re-renders from.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { models, engine, storage, sequencer, transport } = MPC;

  const App = {
    sampleCache: new Map(),   // sampleId -> resolved Sample object

    state: {
      projectId: null,
      projectName: 'Untitled Project',
      bankId: null,
      bankName: 'Untitled Bank',

      bpm: MPC.const.DEFAULT_BPM,
      beatsPerBar: MPC.const.DEFAULT_BEATS_PER_BAR,
      barsPerSection: MPC.const.DEFAULT_BARS_PER_SECTION,
      quantize: '1/16',
      metronomeOn: true,
      countIn: true,
      masterVolume: 0.9,

      selectedPad: 0,
      pads: [],
      sections: [],           // recorded loops (patterns)
      clips: [],              // placements of sections on the timeline grid
      selectedSectionId: null,
      selectedClipId: null,
      dirty: false,
    },

    // seconds per bar at the current tempo/meter
    barLenSec() { return this.state.beatsPerBar * (60 / this.state.bpm); },

    // total timeline length in bars (grid extent)
    totalTimelineBars() {
      let end = 0;
      this.state.clips.forEach((c) => { end = Math.max(end, c.startBar + c.lenBars); });
      return Math.max(8, Math.ceil(end));
    },

    init() {
      const s = this.state;
      s.pads = [];
      for (let i = 0; i < MPC.const.NUM_PADS; i++) s.pads.push(models.defaultPad(i));
      this.applyTransportSettings();
    },

    markDirty() { this.state.dirty = true; },

    ensureAudio() {
      return engine.ensure().then((ctx) => {
        engine.master.setVolume(this.state.masterVolume);
        return ctx;
      });
    },

    // ---- pads -------------------------------------------------------------
    getPad(i) { return this.state.pads[i]; },
    selectPad(i) {
      this.state.selectedPad = i;
      MPC.bus.emit('pad:selected', { padIndex: i });
    },

    async loadSampleToPad(padIndex, file) {
      try {
        const sample = await MPC.Sample.fromFile(file);
        this.sampleCache.set(sample.id, sample);
        await storage.saveSample(MPC.Sample.toRecord(sample));
        const pad = this.state.pads[padIndex];
        pad.sampleId = sample.id;
        pad.sample = sample;
        pad.trimStart = 0;
        pad.trimEnd = sample.duration;
        if (pad.name === 'Pad ' + (padIndex + 1)) pad.name = sample.name.replace(/\.[^.]+$/, '').slice(0, 18);
        engine.syncPadChannel(padIndex, pad);
        this.markDirty();
        MPC.bus.emit('pad:changed', { padIndex });
        MPC.toast('Loaded “' + sample.name + '” to pad ' + (padIndex + 1));
      } catch (err) {
        console.error(err);
        MPC.toast('Could not load audio: ' + err.message, 'error');
      }
    },

    clearPad(padIndex) {
      const pad = this.state.pads[padIndex];
      const fresh = models.defaultPad(padIndex);
      Object.assign(pad, fresh, { name: 'Pad ' + (padIndex + 1) });
      pad.sample = null;
      engine.syncPadChannel(padIndex, pad);
      this.markDirty();
      MPC.bus.emit('pad:changed', { padIndex });
    },

    updatePad(padIndex, changes) {
      const pad = this.state.pads[padIndex];
      Object.assign(pad, changes);
      engine.syncPadChannel(padIndex, pad);
      this.markDirty();
      MPC.bus.emit('pad:changed', { padIndex });
    },

    updatePadEq(padIndex, band, changes) {
      const pad = this.state.pads[padIndex];
      Object.assign(pad.eq[band], changes);
      engine.syncPadChannel(padIndex, pad);
      this.markDirty();
      MPC.bus.emit('pad:changed', { padIndex });
    },

    syncAllPadChannels() {
      this.state.pads.forEach((p, i) => engine.syncPadChannel(i, p));
    },

    // ---- transport / global settings -------------------------------------
    applyTransportSettings() {
      const s = this.state;
      transport.bpm = s.bpm;
      transport.beatsPerBar = s.beatsPerBar;
      transport.metronomeEnabled = s.metronomeOn;
      transport.countInBeats = s.beatsPerBar; // one-bar count-in
    },

    setTempo(bpm) {
      this.state.bpm = MPC.util.clamp(Math.round(bpm), 20, 300);
      transport.setTempo(this.state.bpm);
      this.markDirty();
      MPC.bus.emit('settings:changed');
    },
    setBeatsPerBar(n) {
      this.state.beatsPerBar = MPC.util.clamp(n, 1, 12);
      this.applyTransportSettings();
      this.markDirty();
      MPC.bus.emit('settings:changed');
    },
    setBarsPerSection(n) {
      this.state.barsPerSection = MPC.util.clamp(n, 1, MPC.const.MAX_BARS_PER_SECTION);
      this.markDirty();
      MPC.bus.emit('settings:changed');
    },
    setQuantize(q) { this.state.quantize = q; this.markDirty(); MPC.bus.emit('settings:changed'); },
    toggleMetronome(on) {
      this.state.metronomeOn = on != null ? on : !this.state.metronomeOn;
      transport.metronomeEnabled = this.state.metronomeOn;
      MPC.bus.emit('settings:changed');
    },
    toggleCountIn(on) {
      this.state.countIn = on != null ? on : !this.state.countIn;
      MPC.bus.emit('settings:changed');
    },
    setMasterVolume(v) {
      this.state.masterVolume = MPC.util.clamp(v, 0, 1.5);
      if (engine.master) engine.master.setVolume(this.state.masterVolume);
      this.markDirty();
      MPC.bus.emit('settings:changed');
    },

    // ---- sections / playlist ---------------------------------------------
    getSelectedSection() {
      return this.state.sections.find((s) => s.id === this.state.selectedSectionId) || null;
    },
    selectSection(id) {
      this.state.selectedSectionId = id;
      MPC.bus.emit('section:selected', { sectionId: id });
    },

    toggleRecord() {
      if (sequencer.recording) { sequencer.stopRecording(); return; }
      this.ensureAudio().then(() => {
        const s = this.state;
        const section = models.makeSection('Section ' + (s.sections.length + 1), s.barsPerSection);
        section.color = MPC.const.PAD_COLORS[(s.sections.length * 3) % MPC.const.PAD_COLORS.length];
        s.sections.push(section);
        s.selectedSectionId = section.id;
        // Drop a clip onto the timeline right after the last clip in lane 0.
        const clip = models.makeClip(section.id, { lane: 0, startBar: this.nextFreeBar(0), lenBars: section.bars });
        s.clips.push(clip);
        s.selectedClipId = clip.id;
        this.markDirty();
        MPC.bus.emit('sections:changed');
        MPC.bus.emit('clips:changed');
        sequencer.startRecording(section);
      });
    },

    nextFreeBar(lane) {
      let end = 0;
      this.state.clips.forEach((c) => { if (c.lane === lane) end = Math.max(end, c.startBar + c.lenBars); });
      return end;
    },

    overdubSection(id) {
      const section = this.state.sections.find((s) => s.id === id);
      if (!section) return;
      if (sequencer.recording) { sequencer.stopRecording(); return; }
      this.state.selectedSectionId = id;
      this.ensureAudio().then(() => sequencer.startRecording(section));
    },

    stopEverything() {
      if (sequencer.recording) sequencer.stopRecording();
      else if (transport.running && transport.mode === 'arrangement') sequencer.stopArrangement();
      else sequencer.stopPreview();
      transport.stop();
    },

    previewSection(id) {
      const section = this.state.sections.find((s) => s.id === id);
      if (!section) return;
      this.state.selectedSectionId = id;
      this.ensureAudio().then(() => sequencer.previewSection(section));
    },

    playArrangement(loop) {
      this.ensureAudio().then(() => sequencer.playArrangement({ loop: !!loop }));
    },

    updateSection(id, changes) {
      const section = this.state.sections.find((s) => s.id === id);
      if (!section) return;
      Object.assign(section, changes);
      // If this section is on the live bus right now, reflect volume/EQ.
      if (sequencer.activePlaybackSection() && sequencer.activePlaybackSection().id === id) {
        engine.sectionBus.setEq(section.eq);
        engine.sectionBus.setVolume(MPC.util.dbToGain(section.volumeDb || 0));
      }
      this.markDirty();
      MPC.bus.emit('section:updated', { sectionId: id });
    },
    updateSectionEq(id, band, changes) {
      const section = this.state.sections.find((s) => s.id === id);
      if (!section) return;
      Object.assign(section.eq[band], changes);
      if (sequencer.activePlaybackSection() && sequencer.activePlaybackSection().id === id) {
        engine.sectionBus.setEq(section.eq);
      }
      this.markDirty();
      MPC.bus.emit('section:updated', { sectionId: id });
    },

    deleteSection(id) {
      const s = this.state;
      s.sections = s.sections.filter((x) => x.id !== id);
      s.clips = s.clips.filter((c) => c.sectionId !== id);
      if (s.selectedSectionId === id) s.selectedSectionId = s.sections.length ? s.sections[0].id : null;
      this.markDirty();
      MPC.bus.emit('sections:changed');
      MPC.bus.emit('clips:changed');
    },
    duplicateSection(id) {
      const s = this.state;
      const idx = s.sections.findIndex((x) => x.id === id);
      if (idx < 0) return;
      const copy = MPC.util.clone(s.sections[idx]);
      copy.id = MPC.util.uid('sec');
      copy.name = s.sections[idx].name + ' copy';
      copy.events = s.sections[idx].events.map((e) => ({ padIndex: e.padIndex, time: e.time, rawTime: e.rawTime, velocity: e.velocity }));
      s.sections.splice(idx + 1, 0, copy);
      s.selectedSectionId = copy.id;
      this.markDirty();
      MPC.bus.emit('sections:changed');
    },
    moveSection(id, dir) {
      const s = this.state;
      const idx = s.sections.findIndex((x) => x.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= s.sections.length) return;
      const [item] = s.sections.splice(idx, 1);
      s.sections.splice(to, 0, item);
      this.markDirty();
      MPC.bus.emit('sections:changed');
    },
    clearSection(id) {
      const section = this.state.sections.find((s) => s.id === id);
      if (section) { sequencer.clearSection(section); this.markDirty(); }
    },

    // ---- clips (timeline placements) --------------------------------------
    getSelectedClip() { return this.state.clips.find((c) => c.id === this.state.selectedClipId) || null; },
    getClipSection(clip) { return clip && this.state.sections.find((s) => s.id === clip.sectionId) || null; },

    selectClip(id) {
      const clip = this.state.clips.find((c) => c.id === id);
      this.state.selectedClipId = id;
      if (clip) this.state.selectedSectionId = clip.sectionId;
      MPC.bus.emit('clip:selected', { clipId: id });
    },

    moveClip(id, changes) {
      const clip = this.state.clips.find((c) => c.id === id);
      if (!clip) return;
      if (changes.startBar != null) clip.startBar = Math.max(0, changes.startBar);
      if (changes.lane != null) clip.lane = MPC.util.clamp(changes.lane, 0, MPC.const.NUM_LANES - 1);
      this.markDirty();
      MPC.bus.emit('clips:changed');
    },

    resizeClip(id, lenBars) {
      const clip = this.state.clips.find((c) => c.id === id);
      if (!clip) return;
      const minBars = 1 / this.state.beatsPerBar; // one beat
      clip.lenBars = Math.max(minBars, lenBars);
      this.markDirty();
      MPC.bus.emit('clips:changed');
    },

    sliceClip(id, atBarWithinClip) {
      const s = this.state;
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return;
      const minBars = 1 / s.beatsPerBar;
      if (atBarWithinClip <= minBars / 2 || atBarWithinClip >= clip.lenBars - minBars / 2) return;
      const right = models.makeClip(clip.sectionId, {
        lane: clip.lane,
        startBar: clip.startBar + atBarWithinClip,
        lenBars: clip.lenBars - atBarWithinClip,
        srcOffsetSec: clip.srcOffsetSec + atBarWithinClip * this.barLenSec(),
      });
      clip.lenBars = atBarWithinClip;
      const idx = s.clips.indexOf(clip);
      s.clips.splice(idx + 1, 0, right);
      s.selectedClipId = right.id;
      this.markDirty();
      MPC.bus.emit('clips:changed');
    },

    duplicateClip(id) {
      const s = this.state;
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return;
      const copy = models.makeClip(clip.sectionId, {
        lane: clip.lane,
        startBar: clip.startBar + clip.lenBars,
        lenBars: clip.lenBars,
        srcOffsetSec: clip.srcOffsetSec,
      });
      s.clips.push(copy);
      s.selectedClipId = copy.id;
      this.markDirty();
      MPC.bus.emit('clips:changed');
    },

    deleteClip(id) {
      const s = this.state;
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return;
      s.clips = s.clips.filter((c) => c.id !== id);
      // prune the section if no clip references it any more
      if (!s.clips.some((c) => c.sectionId === clip.sectionId)) {
        s.sections = s.sections.filter((sec) => sec.id !== clip.sectionId);
      }
      if (s.selectedClipId === id) s.selectedClipId = s.clips.length ? s.clips[0].id : null;
      const sel = this.getSelectedClip();
      s.selectedSectionId = sel ? sel.sectionId : (s.sections[0] ? s.sections[0].id : null);
      this.markDirty();
      MPC.bus.emit('clips:changed');
      MPC.bus.emit('sections:changed');
    },

    // ---- sample resolution (shared by bank/project load) ------------------
    async resolveSample(sampleId) {
      if (!sampleId) return null;
      if (this.sampleCache.has(sampleId)) return this.sampleCache.get(sampleId);
      const record = await storage.getSample(sampleId);
      if (!record) return null;
      const sample = await MPC.Sample.fromRecord(record);
      this.sampleCache.set(sampleId, sample);
      return sample;
    },

    async applyPadRecords(padRecords) {
      const pads = [];
      for (let i = 0; i < MPC.const.NUM_PADS; i++) {
        const rec = padRecords[i];
        const pad = rec ? models.padFromRecord(rec, i) : models.defaultPad(i);
        if (pad.sampleId) {
          pad.sample = await this.resolveSample(pad.sampleId);
          if (!pad.sample) { pad.sampleId = null; }
          else if (pad.trimEnd == null) pad.trimEnd = pad.sample.duration;
        }
        pads.push(pad);
      }
      this.state.pads = pads;
      this.syncAllPadChannels();
      MPC.bus.emit('pads:changed');
    },

    // ---- banks ------------------------------------------------------------
    async saveBank(name) {
      const s = this.state;
      const bank = {
        id: s.bankId || MPC.util.uid('bank'),
        name: name || s.bankName || 'Untitled Bank',
        pads: s.pads.map(models.padToRecord),
      };
      await storage.saveBank(bank);
      s.bankId = bank.id;
      s.bankName = bank.name;
      MPC.bus.emit('library:changed');
      MPC.toast('Saved bank “' + bank.name + '”');
    },
    async saveBankAsNew(name) { this.state.bankId = null; return this.saveBank(name); },

    async loadBank(id) {
      const bank = await storage.getBank(id);
      if (!bank) { MPC.toast('Bank not found', 'error'); return; }
      await this.applyPadRecords(bank.pads || []);
      this.state.bankId = bank.id;
      this.state.bankName = bank.name;
      MPC.bus.emit('library:changed');
      MPC.toast('Loaded bank “' + bank.name + '”');
    },
    async deleteBank(id) {
      await storage.deleteBank(id);
      if (this.state.bankId === id) this.state.bankId = null;
      MPC.bus.emit('library:changed');
    },

    // ---- projects ---------------------------------------------------------
    serializeProject(name) {
      const s = this.state;
      return {
        id: s.projectId || MPC.util.uid('proj'),
        name: name || s.projectName || 'Untitled Project',
        bpm: s.bpm,
        beatsPerBar: s.beatsPerBar,
        barsPerSection: s.barsPerSection,
        quantize: s.quantize,
        metronomeOn: s.metronomeOn,
        countIn: s.countIn,
        masterVolume: s.masterVolume,
        bankName: s.bankName,
        pads: s.pads.map(models.padToRecord),
        sections: s.sections.map((sec) => ({
          id: sec.id, name: sec.name, color: sec.color, bars: sec.bars,
          repeats: sec.repeats, volumeDb: sec.volumeDb, muted: sec.muted,
          eq: MPC.util.clone(sec.eq),
          events: sec.events.map((e) => ({ padIndex: e.padIndex, time: e.time, rawTime: e.rawTime, velocity: e.velocity })),
        })),
        clips: s.clips.map((c) => ({
          id: c.id, sectionId: c.sectionId, lane: c.lane,
          startBar: c.startBar, lenBars: c.lenBars, srcOffsetSec: c.srcOffsetSec,
        })),
      };
    },

    async saveProject(name) {
      const project = this.serializeProject(name);
      await storage.saveProject(project);
      this.state.projectId = project.id;
      this.state.projectName = project.name;
      this.state.dirty = false;
      MPC.bus.emit('library:changed');
      MPC.bus.emit('project:changed');
      MPC.toast('Saved project “' + project.name + '”');
    },
    async saveProjectAsNew(name) { this.state.projectId = null; return this.saveProject(name); },

    async applyProjectObject(project) {
      const s = this.state;
      this.stopEverything();
      s.projectId = project.id || MPC.util.uid('proj');
      s.projectName = project.name || 'Untitled Project';
      s.bpm = project.bpm || MPC.const.DEFAULT_BPM;
      s.beatsPerBar = project.beatsPerBar || MPC.const.DEFAULT_BEATS_PER_BAR;
      s.barsPerSection = project.barsPerSection || MPC.const.DEFAULT_BARS_PER_SECTION;
      s.quantize = project.quantize || '1/16';
      s.metronomeOn = project.metronomeOn !== false;
      s.countIn = project.countIn !== false;
      s.masterVolume = project.masterVolume != null ? project.masterVolume : 0.9;
      s.bankName = project.bankName || 'Untitled Bank';
      s.sections = (project.sections || []).map((sec) => Object.assign(MPC.models.makeSection(sec.name, sec.bars), sec, { eq: Object.assign(MPC.models.defaultEq(), sec.eq || {}) }));
      // Clips: use stored placements, or migrate old sequential sections into
      // a single lane-0 timeline so older projects still open.
      if (project.clips && project.clips.length) {
        s.clips = project.clips.map((c) => Object.assign(MPC.models.makeClip(c.sectionId), c));
      } else {
        let bar = 0;
        s.clips = s.sections.map((sec) => {
          const reps = Math.max(1, sec.repeats || 1);
          const clip = MPC.models.makeClip(sec.id, { lane: 0, startBar: bar, lenBars: sec.bars * reps });
          bar += sec.bars * reps;
          return clip;
        });
      }
      s.selectedSectionId = s.sections.length ? s.sections[0].id : null;
      s.selectedClipId = s.clips.length ? s.clips[0].id : null;
      this.applyTransportSettings();
      if (engine.master) engine.master.setVolume(s.masterVolume);
      await this.applyPadRecords(project.pads || []);
      s.dirty = false;
      MPC.bus.emit('settings:changed');
      MPC.bus.emit('sections:changed');
      MPC.bus.emit('clips:changed');
      MPC.bus.emit('project:changed');
      MPC.bus.emit('library:changed');
    },

    async loadProject(id) {
      const project = await storage.getProject(id);
      if (!project) { MPC.toast('Project not found', 'error'); return; }
      await this.applyProjectObject(project);
      MPC.toast('Loaded project “' + project.name + '”');
    },

    // ---- portable project files (.json with embedded audio) ---------------
    async exportProjectFile() {
      const s = this.state;
      const project = this.serializeProject(s.projectName);
      const ids = new Set();
      s.pads.forEach((p) => { if (p.sampleId) ids.add(p.sampleId); });
      const samples = [];
      for (const id of ids) {
        let rec = await storage.getSample(id);
        if (!rec && this.sampleCache.has(id)) rec = MPC.Sample.toRecord(this.sampleCache.get(id));
        if (!rec) continue;
        samples.push({ id: rec.id, name: rec.name, type: rec.type, duration: rec.duration, dataB64: MPC.util.abToBase64(rec.data) });
      }
      const bundle = { format: 'mpc-studio-project', version: 1, project, samples };
      const fname = MPC.util.sanitizeFilename(s.projectName) + '.json';
      const ok = await MPC.host.saveFile(fname, JSON.stringify(bundle));
      if (ok) MPC.toast('Project file saved (' + samples.length + ' sound' + (samples.length === 1 ? '' : 's') + ' embedded).');
      return ok;
    },

    async importProjectFile(file) {
      try {
        const bundle = JSON.parse(await file.text());
        if (!bundle || bundle.format !== 'mpc-studio-project' || !bundle.project) {
          throw new Error('Not an MPC Studio project file.');
        }
        for (const smp of (bundle.samples || [])) {
          if (this.sampleCache.has(smp.id)) continue;
          const rec = { id: smp.id, name: smp.name, type: smp.type, data: MPC.util.base64ToAb(smp.dataB64), duration: smp.duration };
          try { await storage.saveSample(rec); } catch (e) { /* storage may be unavailable */ }
          try { this.sampleCache.set(smp.id, await MPC.Sample.fromRecord(rec)); } catch (e) { /* keep going */ }
        }
        await this.applyProjectObject(bundle.project);
        try { await storage.saveProject(this.serializeProject(bundle.project.name)); } catch (e) { /* ignore */ }
        MPC.bus.emit('library:changed');
        MPC.toast('Imported project “' + bundle.project.name + '”.');
      } catch (err) {
        console.error(err);
        MPC.toast('Import failed: ' + err.message, 'error');
      }
    },
    async deleteProject(id) {
      await storage.deleteProject(id);
      if (this.state.projectId === id) this.state.projectId = null;
      MPC.bus.emit('library:changed');
    },

    newProject() {
      this.stopEverything();
      const s = this.state;
      s.projectId = null;
      s.projectName = 'Untitled Project';
      s.sections = [];
      s.clips = [];
      s.selectedSectionId = null;
      s.selectedClipId = null;
      s.dirty = false;
      MPC.bus.emit('sections:changed');
      MPC.bus.emit('clips:changed');
      MPC.bus.emit('project:changed');
      MPC.toast('Started a new project');
    },
  };

  MPC.app = App;
})();
