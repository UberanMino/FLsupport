/*
 * loop-finder.js — find loopable phrases in a free jam (no click, no tempo).
 *
 *   1. Tempo: try beat periods between 60 and 160 BPM and score how well the
 *      note onsets line up with a 16th/8th/beat grid (phase coherence),
 *      with a soft preference for ~90 BPM (where trip hop lives).
 *   2. Grid: the phase of the best fit says where the beats fall.
 *   3. Candidates: every 1/2/4-bar window that starts on a beat is scored on
 *      how much the player repeated it right after (or before), how busy it
 *      is, whether something lands on its first beat, and how cleanly the
 *      notes sit on the grid.
 *   4. The best non-overlapping windows become loops: notes quantized to
 *      16ths, positioned from 0, clipped to the loop length.
 *
 * Pure functions (no audio, no DOM) so they can be tested in Node.
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  // Merge notes struck together (chords) into one onset time.
  function onsetTimes(notes) {
    const ts = notes.map((n) => n.start).sort((a, b) => a - b);
    const out = [];
    ts.forEach((t) => { if (!out.length || t - out[out.length - 1] > 0.04) out.push(t); });
    return out;
  }

  // Phase coherence of onsets against a grid of `period` seconds: 1 = all on
  // the grid, ~0 = random. Also returns the phase (seconds) of the grid.
  function coherence(times, period) {
    let c = 0, s = 0;
    times.forEach((t) => { const a = (TAU * t) / period; c += Math.cos(a); s += Math.sin(a); });
    const r = Math.sqrt(c * c + s * s) / Math.max(1, times.length);
    let phase = (Math.atan2(s, c) / TAU) * period;
    if (phase < 0) phase += period;
    return { r, phase };
  }

  function estimateTempo(notes, opts) {
    opts = opts || {};
    const times = onsetTimes(notes);
    if (times.length < 4) return null;
    const minBpm = opts.forceBpm || opts.minBpm || 60, maxBpm = opts.forceBpm || opts.maxBpm || 160, pref = opts.preferBpm || 90;
    let best = null;
    for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
      const beat = 60 / bpm;
      const r16 = coherence(times, beat / 4).r;
      const r8 = coherence(times, beat / 2).r;
      const r4 = coherence(times, beat).r;
      // Finer grids fit anything a bit, so the coarser levels carry weight.
      const fit = 0.3 * r16 * r16 + 0.35 * r8 * r8 + 0.35 * r4 * r4;
      const oct = Math.log2(bpm / pref);
      const prior = Math.exp(-(oct * oct) / (2 * 0.6 * 0.6));
      const score = fit * (0.5 + 0.5 * prior);
      if (!best || score > best.score) best = { bpm, score, fit };
    }
    // Phase from the 16th grid (most onsets), refined to the beat grid.
    const beat = 60 / best.bpm;
    const ph16 = coherence(times, beat / 4).phase;
    // Choose which of the 4 sixteenths is the beat: the one with most onsets.
    let bestOff = 0, bestCount = -1;
    for (let k = 0; k < 4; k++) {
      const off = ph16 + (k * beat) / 4;
      let count = 0;
      times.forEach((t) => {
        const x = ((t - off) / beat) % 1; const d = Math.min(Math.abs(x), 1 - Math.abs(x));
        if (d < 0.08) count++;
      });
      if (count > bestCount) { bestCount = count; bestOff = off; }
    }
    return { bpm: Math.round(best.bpm * 4) / 4, beat, offset: bestOff % beat, confidence: best.fit };
  }

  // Note -> beat positions on the detected grid, quantized to `q` beats.
  function toGrid(notes, tempo, q) {
    q = q || 0.25;
    return notes.map((n) => {
      const sb = (n.start - tempo.offset) / tempo.beat;
      const eb = (n.end - tempo.offset) / tempo.beat;
      const qs = Math.round(sb / q) * q;
      const len = Math.max(q, Math.round((eb - sb) / q) * q);
      return { midi: n.midi, velocity: n.velocity, beat: qs, len, err: Math.abs(sb - qs) / q };
    });
  }

  function key(n, s, lenBeats) {
    return n.midi + '@' + (((n.beat - s) % lenBeats) + lenBeats) % lenBeats;
  }

  function windowNotes(grid, s, lenBeats) {
    return grid.filter((n) => n.beat >= s - 1e-6 && n.beat < s + lenBeats - 1e-6);
  }

  // Jaccard similarity of two windows' (pitch, position) patterns.
  function similarity(a, b, sa, sb, lenBeats) {
    if (!a.length || !b.length) return 0;
    const A = new Set(a.map((n) => key(n, sa, lenBeats)));
    const B = new Set(b.map((n) => key(n, sb, lenBeats)));
    let inter = 0; A.forEach((k) => { if (B.has(k)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  function findLoops(notes, opts) {
    opts = opts || {};
    const beatsPerBar = opts.beatsPerBar || 4;
    const maxLoops = opts.maxLoops || 3;
    const tempo = opts.tempo || estimateTempo(notes, opts);
    if (!tempo) return { tempo: null, loops: [] };
    const grid = toGrid(notes, tempo, 0.25);
    const firstBeat = Math.floor(Math.min.apply(null, grid.map((n) => n.beat)));
    const lastBeat = Math.ceil(Math.max.apply(null, grid.map((n) => n.beat + n.len)));

    const cands = [];
    [1, 2, 4].forEach((bars) => {
      const L = bars * beatsPerBar;
      for (let s = firstBeat; s + L <= lastBeat + beatsPerBar; s += 1) {
        const w = windowNotes(grid, s, L);
        if (w.length < 3) continue;
        const next = windowNotes(grid, s + L, L);
        const prev = windowNotes(grid, s - L, L);
        const simNext = similarity(w, next, s, s + L, L);
        const simPrev = similarity(w, prev, s, s - L, L);
        const rep = Math.max(simNext, simPrev);
        // Where a repeated phrase begins (new material before, a repeat after)
        // is most likely where the player heard "one".
        const phraseStart = simNext >= 0.6 && simPrev < 0.5 ? 1 : 0;
        const onOne = w.some((n) => Math.abs(n.beat - s) < 1e-6) ? 1 : 0;
        const density = Math.min(1, w.length / (bars * 6));
        const tight = 1 - Math.min(1, w.reduce((m, n) => m + n.err, 0) / w.length * 2);
        const crossing = grid.filter((n) => n.beat < s - 1e-6 && n.beat + n.len > s + 0.5).length;
        const pitches = new Set(w.map((n) => n.midi % 12)).size;
        const variety = Math.min(1, (pitches - 1) / 3);
        const score = 3 * rep + 0.6 * phraseStart + 0.8 * onOne + 0.7 * density + 0.5 * tight + 0.4 * variety - 0.4 * crossing
          + (bars === 2 ? 0.15 : 0);   // two bars is the sweet spot for a sample loop
        cands.push({ startBeat: s, bars, lenBeats: L, score, repeat: rep, notes: w });
      }
    });
    cands.sort((a, b) => b.score - a.score);

    // Same phrase started on a different beat, or the same phrase at another
    // length (2 bars of a repeated 1-bar idea), is not a new loop.
    function samePhrase(a, b) {
      const L = Math.max(a.lenBeats, b.lenBeats);
      const pat = (c) => {
        const out = [];
        for (let k = 0; k < L / c.lenBeats; k++) c.notes.forEach((n) => out.push({ midi: n.midi, pos: n.beat - c.startBeat + k * c.lenBeats }));
        return out;
      };
      const A = pat(a), B = pat(b);
      for (let shift = 0; shift < L; shift += 0.25) {
        const ka = new Set(A.map((n) => n.midi + '@' + (((n.pos + shift) % L) + L) % L));
        const kb = new Set(B.map((n) => n.midi + '@' + n.pos % L));
        let inter = 0; ka.forEach((k) => { if (kb.has(k)) inter++; });
        if (inter / (ka.size + kb.size - inter) >= 0.6) return true;
      }
      return false;
    }

    const picked = [];
    for (const c of cands) {
      const overlaps = picked.some((p) => (c.startBeat < p.startBeat + p.lenBeats && p.startBeat < c.startBeat + c.lenBeats) || samePhrase(c, p));
      if (overlaps) continue;
      picked.push(c);
      if (picked.length >= maxLoops) break;
    }

    const beatSec = 60 / tempo.bpm;
    const loops = picked.map((c, i) => {
      const lenSec = c.lenBeats * beatSec;
      const loopNotes = c.notes.map((n) => {
        const start = (n.beat - c.startBeat) * beatSec;
        const end = Math.min(lenSec, start + n.len * beatSec);
        return { midi: n.midi, velocity: n.velocity, start, end: Math.max(start + beatSec / 8, end) };
      });
      return {
        id: 'loop-' + i,
        bars: c.bars,
        bpm: tempo.bpm,
        beatsPerBar,
        lengthSec: lenSec,
        startInJam: tempo.offset + c.startBeat * tempo.beat,
        repeat: c.repeat,
        score: c.score,
        notes: loopNotes,
      };
    });
    return { tempo, loops };
  }

  const LoopFinder = { estimateTempo, findLoops, toGrid, onsetTimes };
  if (root.MPC) root.MPC.loopFinder = LoopFinder;
  if (typeof module !== 'undefined' && module.exports) module.exports = LoopFinder;
})(typeof window !== 'undefined' ? window : globalThis);
