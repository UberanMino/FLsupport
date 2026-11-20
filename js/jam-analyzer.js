/*
 * jam-analyzer.js — turn a free jam into loops.
 *
 * In the claude.ai build the jam's notes go to Claude (the `sample` runtime
 * capability), which picks the loopable passages, works out each one's own
 * tempo (the player may change tempo during the jam), fixes the timing and
 * makes the end lead back into the start. Without Claude (standalone build,
 * or the viewer declined) the rule-based loop-finder.js is used instead.
 *
 * Both paths return loops shaped like a take:
 *   { name, reason, bpm, beatsPerBar, bars, lengthSec, startInJam, source,
 *     notes: [{ midi, velocity, start, end }] }   // seconds from the loop start
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const MAX_NOTES = 1500;

  let samplePromise = null;
  function sampleFn() {
    if (!samplePromise) {
      samplePromise = (window.claude && typeof window.claude.use === 'function')
        ? Promise.resolve().then(() => window.claude.use('sample')).catch(() => null)
        : Promise.resolve(null);
    }
    return samplePromise;
  }

  function buildPrompt(jam, hintBpm) {
    const notes = jam.notes.slice().sort((a, b) => a.start - b.start).slice(0, MAX_NOTES);
    const lines = notes.map((n) => [
      n.start.toFixed(3), (n.end - n.start).toFixed(3), n.midi,
      MPC.synthEngine.noteName(n.midi), Math.round(n.velocity * 127),
    ].join(' '));
    return [
      'A music producer improvised on a synth (played on a computer keyboard) with no metronome, to find ideas for loops',
      'for atmospheric hip hop / trip hop beats. They may speed up, slow down or switch tempo between ideas.',
      '',
      'Every note they played, one per line: start_seconds duration_seconds midi_number note_name velocity_1_127',
      lines.join('\n'),
      '',
      hintBpm ? 'A rough automatic tempo estimate for the whole jam is ' + hintBpm + ' BPM. It can be wrong, especially where the tempo changes.' : '',
      '',
      'Find up to 3 passages that would work best as loops (a repeated riff or phrase, a chord progression, a hook).',
      'For each one:',
      '- Work out ITS OWN tempo and meter from the notes in that passage only (BPM usually 60-160), and pick a length of 1, 2, 4 or 8 bars.',
      '  If the player repeated an idea, the loop is one repetition of it.',
      '- startTime: the second in the jam where bar 1, beat 1 of the loop falls.',
      '- Rewrite it as a clean loop: positions in beats from 0 (16th notes and 8th-note triplets allowed), lengths in beats,',
      '  keeping the pitches and the player\'s rhythm. Fix sloppy timing, drop obvious mistakes and stray notes, and make the',
      '  end lead back into the start: no note may run past the loop end (shorten the last notes if needed).',
      '  Do not invent new material beyond such small fixes.',
      '',
      'Reply with only JSON in this shape, best loop first:',
      '{"loops":[{"name":"2-3 word evocative name","reason":"one sentence: why this works as a loop and what you fixed",',
      '"bpm":88,"beatsPerBar":4,"bars":2,"startTime":12.34,"notes":[{"midi":57,"beat":0,"len":1,"vel":100}]}]}',
      'If nothing in the jam works as a loop, reply {"loops":[]}.',
    ].join('\n');
  }

  function num(v, lo, hi, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }

  // Validate Claude's JSON and convert beats to seconds.
  function fromClaude(data) {
    const list = data && Array.isArray(data.loops) ? data.loops : [];
    return list.slice(0, 3).map((l, i) => {
      const bpm = num(l.bpm, 30, 300, 90);
      const bpb = Math.round(num(l.beatsPerBar, 1, 12, 4));
      const bars = Math.round(num(l.bars, 1, 16, 2));
      const beats = bars * bpb;
      const spb = 60 / bpm;
      const notes = (Array.isArray(l.notes) ? l.notes : [])
        .map((n) => {
          const beat = num(n.beat, -1, beats, NaN);
          const len = num(n.len, 0.03, beats, 0.5);
          const midi = Math.round(num(n.midi, 0, 127, NaN));
          if (!Number.isFinite(beat) || !Number.isFinite(midi) || beat < 0 || beat >= beats) return null;
          const end = Math.min(beats, beat + len);
          return { midi, velocity: num(n.vel, 1, 127, 100) / 127, start: beat * spb, end: Math.max(beat * spb + 0.02, end * spb) };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);
      return {
        name: String(l.name || 'Loop ' + String.fromCharCode(65 + i)).slice(0, 40),
        reason: String(l.reason || '').slice(0, 300),
        bpm, beatsPerBar: bpb, bars,
        lengthSec: beats * spb,
        startInJam: num(l.startTime, 0, 1e6, 0),
        source: 'claude',
        notes,
      };
    }).filter((l) => l.notes.length > 0);
  }

  function byScript(jam) {
    const res = MPC.loopFinder.findLoops(jam.notes, { beatsPerBar: 4 });
    return res.loops.map((l, i) => Object.assign({}, l, {
      name: 'Loop ' + String.fromCharCode(65 + i),
      reason: (l.repeat >= 0.6 ? 'You played this phrase twice in a row. ' : '') + 'Found by the built-in loop finder at ' + l.bpm + ' BPM.',
      source: 'script',
    }));
  }

  const JamAnalyzer = {
    async claudeAvailable() { return !!(await sampleFn()); },

    // opts: { useClaude (default true), signal, onProgress(text) }
    async analyze(jam, opts) {
      opts = opts || {};
      const sample = opts.useClaude === false ? null : await sampleFn();
      if (!sample) return { loops: byScript(jam), source: 'script' };
      const hint = MPC.loopFinder.estimateTempo(jam.notes);
      const prompt = buildPrompt(jam, hint ? hint.bpm : null);
      try {
        const data = await sample.json(prompt, {
          signal: opts.signal,
          onText: opts.onProgress ? () => opts.onProgress('Claude is writing the loops…') : undefined,
          cache: false,
        });
        return { loops: fromClaude(data), source: 'claude' };
      } catch (err) {
        const code = err && err.code;
        if (code === 'cancelled') throw err;
        // Claude unavailable for this viewer: fall back, and say why.
        const why = code === 'not_granted' ? 'Claude wasn’t allowed for this page'
          : code === 'rate_limited' ? 'Claude is busy right now'
            : code === 'invalid_json' ? 'Claude’s answer couldn’t be read'
              : 'Claude couldn’t be reached';
        return { loops: byScript(jam), source: 'script', note: why + ', so the built-in loop finder was used.' };
      }
    },
  };

  MPC.jamAnalyzer = JamAnalyzer;
})();
