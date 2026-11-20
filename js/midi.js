/*
 * midi.js — write a Standard MIDI File (format 0, one track) for a loop, so
 * the notes can be dragged into FL Studio's piano roll next to the WAV.
 */
(function (root) {
  'use strict';

  function varLen(n) {
    const bytes = [n & 0x7f];
    n >>= 7;
    while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
    return bytes;
  }

  // loop: { bpm, beatsPerBar, lengthSec, notes: [{ midi, velocity(0..1), start, end }] (seconds) }
  function encode(loop, opts) {
    opts = opts || {};
    const PPQ = 480;
    const bpm = loop.bpm;
    const secToTick = (s) => Math.max(0, Math.round((s * bpm / 60) * PPQ));
    const name = String(opts.name || 'Loop').slice(0, 60);

    const events = [];   // { tick, order, bytes }
    const tempo = Math.round(60000000 / bpm);
    events.push({ tick: 0, order: 0, bytes: [0xff, 0x03].concat(varLen(name.length), Array.from(name).map((c) => c.charCodeAt(0) & 0x7f)) });
    events.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] });
    events.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, loop.beatsPerBar || 4, 2, 24, 8] });

    const endTick = secToTick(loop.lengthSec);
    loop.notes.forEach((n) => {
      const on = secToTick(n.start);
      const off = Math.min(endTick, Math.max(on + 1, secToTick(n.end)));
      if (on >= endTick) return;
      const key = Math.max(0, Math.min(127, n.midi | 0));
      const vel = Math.max(1, Math.min(127, Math.round((n.velocity == null ? 0.8 : n.velocity) * 127)));
      events.push({ tick: off, order: 1, bytes: [0x80, key, 0] });    // offs before ons at the same tick
      events.push({ tick: on, order: 2, bytes: [0x90, key, vel] });
    });
    events.push({ tick: endTick, order: 3, bytes: [0xff, 0x2f, 0x00] });
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);

    const track = [];
    let last = 0;
    events.forEach((e) => { track.push.apply(track, varLen(e.tick - last)); track.push.apply(track, e.bytes); last = e.tick; });

    const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
    const len = track.length;
    const trackHead = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];
    return new Uint8Array(header.concat(trackHead, track));
  }

  const Midi = { encode, toBlob: (loop, opts) => new Blob([encode(loop, opts)], { type: 'audio/midi' }) };
  if (root.MPC) root.MPC.midi = Midi;
  if (typeof module !== 'undefined' && module.exports) module.exports = Midi;
})(typeof window !== 'undefined' ? window : globalThis);
