/*
 * render.js — offline (faster-than-realtime) rendering for export.
 *
 * Mirrors the live graph in an OfflineAudioContext so exports match what you
 * hear: voice -> pad channel (trim/tune/EQ/pan/vol) -> section bus (per-section
 * EQ/vol) -> destination. Produces:
 *   - per-pad stems across the whole arrangement (bar-1 aligned)
 *   - each section as its own WAV
 *   - a single master-mix WAV
 * Multiple files are bundled with the dependency-free ZIP writer.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { semitonesToRate, dbToGain, clamp } = MPC.util;

  function trimmedPlayLength(pad) {
    const dur = pad.sample.duration;
    const trimEnd = pad.trimEnd != null ? pad.trimEnd : dur;
    const rate = semitonesToRate(pad.tune || 0);
    return (trimEnd - (pad.trimStart || 0)) / rate;
  }

  // Schedule one sample voice into an (offline) context.
  function scheduleVoice(ctx, sample, destination, opts) {
    const when = Math.max(0, opts.when);
    const rate = opts.rate || 1;
    const trimStart = clamp(opts.trimStart || 0, 0, sample.duration);
    const trimEnd = clamp(opts.trimEnd != null ? opts.trimEnd : sample.duration, trimStart + 0.001, sample.duration);
    const bufDur = trimEnd - trimStart;
    const playDur = bufDur / rate;
    const peak = clamp(opts.velocity != null ? opts.velocity : 1, 0, 1);

    const src = ctx.createBufferSource();
    src.buffer = sample.buffer;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    const fade = Math.min(0.006, playDur / 2);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + fade);
    env.gain.setValueAtTime(peak, Math.max(when + fade, when + playDur - fade));
    env.gain.linearRampToValueAtTime(0, when + playDur);
    src.connect(env); env.connect(destination);
    src.start(when, trimStart, bufDur);
  }

  // voices: [{ padIndex, pad, when, velocity }]
  // placements (optional, for section bus automation): [{ startTime, section }]
  async function renderVoices(opts) {
    const sampleRate = opts.sampleRate || MPC.const.RENDER_SAMPLE_RATE;
    const duration = Math.max(0.05, opts.duration);
    const frames = Math.ceil(duration * sampleRate);
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, frames, sampleRate);

    // Destination chain (optional section bus, optional master gain).
    let busInput = ctx.destination;
    if (opts.applySectionBus) {
      const sec = MPC.engine.createEqChain(ctx, false);
      let out = sec.output;
      if (opts.applyMaster) {
        const mg = ctx.createGain();
        mg.gain.value = opts.masterVolume != null ? opts.masterVolume : 0.9;
        out.connect(mg); mg.connect(ctx.destination);
      } else {
        out.connect(ctx.destination);
      }
      const placements = opts.placements || [];
      if (placements.length) {
        placements.forEach((p) => {
          const t = Math.max(0, p.startTime - 0.0005);
          sec.gain.gain.setValueAtTime(dbToGain(p.section.volumeDb || 0), t);
          MPC.engine.applyEq(sec, p.section.eq, t);
        });
      }
      busInput = sec.input;
    } else if (opts.applyMaster) {
      const mg = ctx.createGain();
      mg.gain.value = opts.masterVolume != null ? opts.masterVolume : 0.9;
      mg.connect(ctx.destination);
      busInput = mg;
    }

    // Per-pad channels (built lazily).
    const chains = {};
    function chainFor(padIndex, pad) {
      if (chains[padIndex]) return chains[padIndex];
      const ch = MPC.engine.createEqChain(ctx, true);
      MPC.engine.applyEq(ch, pad.eq);
      ch.gain.gain.value = dbToGain(pad.gainDb || 0);
      if (ch.panner) ch.panner.pan.value = pad.pan || 0;
      ch.output.connect(busInput);
      chains[padIndex] = ch;
      return ch;
    }

    for (const v of opts.voices) {
      const pad = v.pad;
      if (!pad || !pad.sample || !pad.sample.buffer) continue;
      const ch = chainFor(v.padIndex, pad);
      scheduleVoice(ctx, pad.sample, ch.input, {
        when: v.when,
        rate: semitonesToRate(pad.tune || 0),
        trimStart: pad.trimStart || 0,
        trimEnd: pad.trimEnd != null ? pad.trimEnd : pad.sample.duration,
        velocity: v.velocity,
      });
    }

    return ctx.startRendering();
  }

  // ---- plan builders ------------------------------------------------------
  function sectionVoices(section, pads) {
    const st = MPC.app.state;
    const spb = 60 / st.bpm;
    const loopSec = section.bars * st.beatsPerBar * spb;
    const reps = Math.max(1, section.repeats || 1);
    const voices = [];
    let tail = 0;
    for (let r = 0; r < reps; r++) {
      for (const ev of section.events) {
        const pad = pads[ev.padIndex];
        if (!pad || !pad.sample || pad.muted) continue;
        const when = r * loopSec + ev.time;
        voices.push({ padIndex: ev.padIndex, pad, when, velocity: ev.velocity });
        tail = Math.max(tail, trimmedPlayLength(pad));
      }
    }
    return { voices, duration: loopSec * reps + tail + 0.2, loopSec, reps };
  }

  function arrangementPlacements() {
    const st = MPC.app.state;
    const spb = 60 / st.bpm;
    let t = 0;
    const placements = [];
    for (const section of st.sections) {
      const loopSec = section.bars * st.beatsPerBar * spb;
      const reps = Math.max(1, section.repeats || 1);
      placements.push({ section, startTime: t, loopSec, reps });
      t += loopSec * reps;
    }
    return { placements, totalSec: t };
  }

  function arrangementVoices(pads, padFilter) {
    const { placements, totalSec } = arrangementPlacements();
    const voices = [];
    let tail = 0;
    for (const p of placements) {
      if (p.section.muted) continue;
      for (let r = 0; r < p.reps; r++) {
        for (const ev of p.section.events) {
          if (padFilter != null && ev.padIndex !== padFilter) continue;
          const pad = pads[ev.padIndex];
          if (!pad || !pad.sample || pad.muted) continue;
          voices.push({
            padIndex: ev.padIndex, pad,
            when: p.startTime + r * p.loopSec + ev.time,
            velocity: ev.velocity,
          });
          tail = Math.max(tail, trimmedPlayLength(pad));
        }
      }
    }
    return { voices, placements, duration: totalSec + tail + 0.3 };
  }

  // ---- public export API --------------------------------------------------
  const Render = {
    async renderMaster() {
      const st = MPC.app.state;
      const { voices, placements, duration } = arrangementVoices(st.pads, null);
      if (!voices.length) throw new Error('The playlist is empty — record a section first.');
      const buf = await renderVoices({
        voices, placements, duration,
        applySectionBus: true, applyMaster: true, masterVolume: st.masterVolume,
      });
      return MPC.encoders.encodeWav(buf, 24);
    },

    async renderSectionWavs() {
      const st = MPC.app.state;
      const out = [];
      let i = 0;
      for (const section of st.sections) {
        i++;
        if (!section.events.length) continue;
        MPC.bus.emit('export:progress', { label: 'Section ' + i + '/' + st.sections.length });
        const { voices, duration } = sectionVoices(section, st.pads);
        const buf = await renderVoices({
          voices, duration,
          placements: [{ startTime: 0, section }],
          applySectionBus: true, applyMaster: false,
        });
        const name = MPC.util.sanitizeFilename(String(i).padStart(2, '0') + '_' + section.name) + '.wav';
        out.push({ name, bytes: new Uint8Array(await MPC.encoders.encodeWav(buf, 24).arrayBuffer()) });
      }
      if (!out.length) throw new Error('No recorded sections to export.');
      return out;
    },

    async renderPadStems() {
      const st = MPC.app.state;
      // Which pads actually play in the arrangement?
      const used = new Set();
      st.sections.forEach((s) => { if (!s.muted) s.events.forEach((e) => used.add(e.padIndex)); });
      const padIndices = Array.from(used).sort((a, b) => a - b).filter((i) => st.pads[i] && st.pads[i].sample && !st.pads[i].muted);
      if (!padIndices.length) throw new Error('No pad hits in the playlist to bounce.');

      const out = [];
      let done = 0;
      for (const padIndex of padIndices) {
        done++;
        MPC.bus.emit('export:progress', { label: 'Stem ' + done + '/' + padIndices.length });
        const { voices, placements, duration } = arrangementVoices(st.pads, padIndex);
        const buf = await renderVoices({
          voices, placements, duration,
          applySectionBus: true, applyMaster: false,
        });
        const pad = st.pads[padIndex];
        const label = MPC.util.sanitizeFilename('pad' + String(padIndex + 1).padStart(2, '0') + '_' + (pad.name || ''));
        out.push({ name: label + '.wav', bytes: new Uint8Array(await MPC.encoders.encodeWav(buf, 24).arrayBuffer()) });
      }
      return out;
    },

    // Bundle whatever was requested into a single zip download.
    async exportBundle(choice) {
      const st = MPC.app.state;
      const projName = MPC.util.sanitizeFilename(st.projectName || 'project');
      const entries = [];
      const manifest = [
        'MPC Studio export',
        'Project: ' + (st.projectName || 'Untitled'),
        'Tempo: ' + st.bpm + ' BPM   Time signature: ' + st.beatsPerBar + '/4',
        'Exported: ' + new Date().toISOString(),
        '',
        'All WAVs are 24-bit / ' + MPC.const.RENDER_SAMPLE_RATE + ' Hz and start at bar 1,',
        'so you can drop them straight onto the timeline in FL Studio.',
        '',
      ];

      if (choice.stems) {
        MPC.bus.emit('export:progress', { label: 'Rendering pad stems…' });
        const stems = await this.renderPadStems();
        stems.forEach((s) => entries.push({ name: 'stems/' + s.name, bytes: s.bytes }));
        manifest.push('stems/  — one WAV per pad, full arrangement, bar-1 aligned (' + stems.length + ' files)');
      }
      if (choice.sections) {
        MPC.bus.emit('export:progress', { label: 'Rendering sections…' });
        const secs = await this.renderSectionWavs();
        secs.forEach((s) => entries.push({ name: 'sections/' + s.name, bytes: s.bytes }));
        manifest.push('sections/ — each recorded section as its own WAV (' + secs.length + ' files)');
      }
      if (choice.master) {
        MPC.bus.emit('export:progress', { label: 'Rendering master mix…' });
        const master = await this.renderMaster();
        entries.push({ name: 'master_mix.wav', bytes: new Uint8Array(await master.arrayBuffer()) });
        manifest.push('master_mix.wav — the whole playlist bounced to stereo');
      }
      if (!entries.length) throw new Error('Choose at least one thing to export.');

      entries.push({ name: 'README.txt', bytes: new TextEncoder().encode(manifest.join('\n')) });
      MPC.bus.emit('export:progress', { label: 'Packaging…' });
      const zip = MPC.encoders.zip(entries);
      MPC.util.download(zip, projName + '_export.zip');
      MPC.bus.emit('export:done');
    },
  };

  MPC.render = Render;
})();
