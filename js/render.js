/*
 * render.js — offline (faster-than-realtime) rendering for export + waveforms.
 *
 * Export mirrors the live graph in an OfflineAudioContext so bounces match what
 * you hear. The timeline is clip-based (FL-style): each clip places a section
 * on the grid. For accurate per-section EQ with overlapping clips, the offline
 * graph builds one EQ chain per section and one pad chain per (pad, section):
 *   voice -> padChain(trim/tune/EQ/pan/vol) -> sectionChain(EQ/vol) -> [master]
 *
 * Produces: per-pad stems (whole timeline), each section (pattern) as a WAV,
 * and a master mix. It also renders section waveforms for the playlist grid.
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
    const fadeIn = Math.min(0.0015, playDur * 0.5);
    const fadeOut = Math.min(0.005, playDur * 0.5);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + fadeIn);
    env.gain.setValueAtTime(peak, Math.max(when + fadeIn, when + playDur - fadeOut));
    env.gain.linearRampToValueAtTime(0, when + playDur);
    src.connect(env); env.connect(destination);
    src.start(when, trimStart, bufDur);
  }

  function newOfflineCtx(duration, sampleRate) {
    const sr = sampleRate || MPC.const.RENDER_SAMPLE_RATE;
    const frames = Math.ceil(Math.max(0.05, duration) * sr);
    return new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, frames, sr);
  }

  // voices: [{ padIndex, pad, when, velocity, section? }]
  //  - opts.sectionChains: route through per-section EQ chains (voice.section required)
  //  - opts.applySectionBus + opts.placements: single shared section bus (per-pattern render)
  //  - neither: dry pad chains (waveform render)
  async function renderVoices(opts) {
    const ctx = newOfflineCtx(opts.duration, opts.sampleRate);

    let finalDest = ctx.destination;
    if (opts.applyMaster) {
      const mg = ctx.createGain();
      mg.gain.value = opts.masterVolume != null ? opts.masterVolume : 0.9;
      mg.connect(ctx.destination);
      finalDest = mg;
    }

    if (opts.sectionChains) {
      const secChains = {};
      const padChains = {};
      const secChain = (section) => {
        if (secChains[section.id]) return secChains[section.id];
        const sc = MPC.engine.createEqChain(ctx, false);
        MPC.engine.applyEq(sc, section.eq);
        sc.gain.gain.value = dbToGain(section.volumeDb || 0);
        sc.output.connect(finalDest);
        secChains[section.id] = sc;
        return sc;
      };
      const padChain = (padIndex, pad, section) => {
        const key = padIndex + '@' + section.id;
        if (padChains[key]) return padChains[key];
        const ch = MPC.engine.createEqChain(ctx, true);
        MPC.engine.applyEq(ch, pad.eq);
        ch.gain.gain.value = dbToGain(pad.gainDb || 0);
        if (ch.panner) ch.panner.pan.value = pad.pan || 0;
        ch.output.connect(secChain(section).input);
        padChains[key] = ch;
        return ch;
      };
      for (const v of opts.voices) {
        const pad = v.pad;
        if (!pad || !pad.sample || !pad.sample.buffer || !v.section) continue;
        const ch = padChain(v.padIndex, pad, v.section);
        scheduleVoice(ctx, pad.sample, ch.input, {
          when: v.when, rate: semitonesToRate(pad.tune || 0),
          trimStart: pad.trimStart || 0,
          trimEnd: pad.trimEnd != null ? pad.trimEnd : pad.sample.duration,
          velocity: v.velocity,
        });
      }
      return ctx.startRendering();
    }

    // single-bus / dry path
    let busInput = finalDest;
    if (opts.applySectionBus) {
      const sec = MPC.engine.createEqChain(ctx, false);
      sec.output.connect(finalDest);
      (opts.placements || []).forEach((p) => {
        const t = Math.max(0, p.startTime - 0.0005);
        sec.gain.gain.setValueAtTime(dbToGain(p.section.volumeDb || 0), t);
        MPC.engine.applyEq(sec, p.section.eq, t);
      });
      busInput = sec.input;
    }
    const chains = {};
    const chainFor = (padIndex, pad) => {
      if (chains[padIndex]) return chains[padIndex];
      const ch = MPC.engine.createEqChain(ctx, true);
      MPC.engine.applyEq(ch, pad.eq);
      ch.gain.gain.value = dbToGain(pad.gainDb || 0);
      if (ch.panner) ch.panner.pan.value = pad.pan || 0;
      ch.output.connect(busInput);
      chains[padIndex] = ch;
      return ch;
    };
    for (const v of opts.voices) {
      const pad = v.pad;
      if (!pad || !pad.sample || !pad.sample.buffer) continue;
      const ch = chainFor(v.padIndex, pad);
      scheduleVoice(ctx, pad.sample, ch.input, {
        when: v.when, rate: semitonesToRate(pad.tune || 0),
        trimStart: pad.trimStart || 0,
        trimEnd: pad.trimEnd != null ? pad.trimEnd : pad.sample.duration,
        velocity: v.velocity,
      });
    }
    return ctx.startRendering();
  }

  // ---- voice/plan builders ----------------------------------------------
  function sectionVoices(section, pads) {
    const barLen = MPC.app.barLenSec();
    const loopSec = section.bars * barLen;
    const voices = [];
    let tail = 0;
    for (const ev of section.events) {
      const pad = pads[ev.padIndex];
      if (!pad || !pad.sample || pad.muted) continue;
      voices.push({ padIndex: ev.padIndex, pad, when: ev.time, velocity: ev.velocity });
      tail = Math.max(tail, trimmedPlayLength(pad));
    }
    return { voices, duration: loopSec + tail + 0.2, loopSec };
  }

  // Expand every clip into absolute-time voices carrying their section.
  function timelineVoices(pads, padFilter) {
    const st = MPC.app.state;
    const barLen = MPC.app.barLenSec();
    const voices = [];
    let tail = 0;
    let endSec = 0;
    for (const clip of st.clips) {
      const section = st.sections.find((s) => s.id === clip.sectionId);
      if (!section || section.muted) continue;
      const loopLen = section.bars * barLen;
      if (loopLen <= 0) continue;
      const clipStart = clip.startBar * barLen;
      const clipDur = clip.lenBars * barLen;
      endSec = Math.max(endSec, clipStart + clipDur);
      for (const e of section.events) {
        if (padFilter != null && e.padIndex !== padFilter) continue;
        const pad = pads[e.padIndex];
        if (!pad || !pad.sample || pad.muted) continue;
        let n = Math.ceil((clip.srcOffsetSec - e.time) / loopLen - 1e-9);
        for (; ; n++) {
          const occ = e.time + n * loopLen;
          if (occ >= clip.srcOffsetSec + clipDur - 1e-9) break;
          if (occ >= clip.srcOffsetSec - 1e-9) {
            voices.push({ padIndex: e.padIndex, pad, when: clipStart + (occ - clip.srcOffsetSec), velocity: e.velocity, section });
            tail = Math.max(tail, trimmedPlayLength(pad));
          }
        }
      }
    }
    return { voices, duration: endSec + tail + 0.3 };
  }

  // ---- section waveform (for the playlist grid) --------------------------
  function peaksFromBuffer(buffer, startSec, endSec, buckets) {
    buckets = buckets || 600;
    const sr = buffer.sampleRate;
    const startF = Math.max(0, Math.floor(startSec * sr));
    const endF = Math.min(buffer.length, Math.floor(endSec * sr));
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const len = Math.max(1, endF - startF);
    const step = Math.max(1, Math.floor(len / buckets));
    const peaks = new Float32Array(buckets * 2);
    for (let b = 0; b < buckets; b++) {
      let mn = 1, mx = -1;
      const s = startF + b * step;
      const e = Math.min(endF, s + step);
      for (let i = s; i < e; i++) {
        let v = ch0[i];
        if (ch1) v = (v + ch1[i]) * 0.5;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (s >= e) { mn = 0; mx = 0; }
      peaks[b * 2] = mn;
      peaks[b * 2 + 1] = mx;
    }
    return peaks;
  }

  function sectionSignature(section) {
    const st = MPC.app.state;
    const padSig = st.pads.map((p) => p.sampleId
      ? p.sampleId + ',' + (p.trimStart || 0).toFixed(3) + ',' + (p.trimEnd != null ? p.trimEnd.toFixed(3) : '') + ',' + (p.tune || 0) + ',' + (p.gainDb || 0)
      : '-').join('|');
    const evSig = section.events.map((e) => e.padIndex + '@' + e.time.toFixed(3) + 'x' + e.velocity.toFixed(2)).join(',');
    return section.bars + ':' + st.bpm + ':' + st.beatsPerBar + ':' + evSig + ':' + padSig;
  }

  const Render = {
    // Returns cached peaks (one loop of the section) or renders them. Also sets
    // section._loopSec so the grid can map clip windows onto the peaks.
    async ensureSectionPeaks(section, buckets) {
      const sig = sectionSignature(section);
      section._loopSec = section.bars * MPC.app.barLenSec();
      if (section._peaksSig === sig && section._peaks) return section._peaks;
      if (!section.events.length) {
        section._peaks = new Float32Array((buckets || 600) * 2);
        section._peaksSig = sig;
        return section._peaks;
      }
      const { voices, loopSec } = sectionVoices(section, MPC.app.state.pads);
      const buf = await renderVoices({ voices, duration: loopSec + 0.4 });
      section._peaks = peaksFromBuffer(buf, 0, loopSec, buckets || 600);
      section._peaksSig = sig;
      return section._peaks;
    },

    // ---- export ----------------------------------------------------------
    async renderMaster() {
      const st = MPC.app.state;
      const { voices, duration } = timelineVoices(st.pads, null);
      if (!voices.length) throw new Error('The playlist is empty — record a section first.');
      const buf = await renderVoices({ voices, duration, sectionChains: true, applyMaster: true, masterVolume: st.masterVolume });
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
        const buf = await renderVoices({ voices, duration, applySectionBus: true, placements: [{ startTime: 0, section }] });
        const name = MPC.util.sanitizeFilename(String(i).padStart(2, '0') + '_' + section.name) + '.wav';
        out.push({ name, bytes: new Uint8Array(await MPC.encoders.encodeWav(buf, 24).arrayBuffer()) });
      }
      if (!out.length) throw new Error('No recorded sections to export.');
      return out;
    },

    async renderPadStems() {
      const st = MPC.app.state;
      const used = new Set();
      st.clips.forEach((c) => {
        const sec = st.sections.find((s) => s.id === c.sectionId);
        if (sec && !sec.muted) sec.events.forEach((e) => used.add(e.padIndex));
      });
      const padIndices = Array.from(used).sort((a, b) => a - b).filter((i) => st.pads[i] && st.pads[i].sample && !st.pads[i].muted);
      if (!padIndices.length) throw new Error('No pad hits in the playlist to bounce.');

      const out = [];
      let done = 0;
      for (const padIndex of padIndices) {
        done++;
        MPC.bus.emit('export:progress', { label: 'Stem ' + done + '/' + padIndices.length });
        const { voices, duration } = timelineVoices(st.pads, padIndex);
        const buf = await renderVoices({ voices, duration, sectionChains: true });
        const pad = st.pads[padIndex];
        const label = MPC.util.sanitizeFilename('pad' + String(padIndex + 1).padStart(2, '0') + '_' + (pad.name || ''));
        out.push({ name: label + '.wav', bytes: new Uint8Array(await MPC.encoders.encodeWav(buf, 24).arrayBuffer()) });
      }
      return out;
    },

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
        manifest.push('stems/  — one WAV per pad, full timeline, bar-1 aligned (' + stems.length + ' files)');
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
      await MPC.host.saveFile(projName + '_export.zip', zip);
      MPC.bus.emit('export:done');
    },
  };

  MPC.render = Render;
})();
