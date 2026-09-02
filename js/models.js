/*
 * models.js — factory functions and (de)serialization for the data model.
 * Pads, sections and EQ settings are plain JSON-friendly objects.
 */
(function () {
  'use strict';
  const MPC = window.MPC;

  function defaultEq() {
    return {
      low:  { freq: 120,  gain: 0 },
      mid:  { freq: 1000, gain: 0, q: 1 },
      high: { freq: 4000, gain: 0 },
    };
  }

  function defaultPad(index) {
    return {
      index,
      name: 'Pad ' + (index + 1),
      sampleId: null,
      trimStart: 0,
      trimEnd: null,      // null => whole sample; resolved when a sample loads
      gainDb: 0,
      pan: 0,
      tune: 0,            // semitones
      eq: defaultEq(),
      color: MPC.const.PAD_COLORS[index],
      muted: false,
      // runtime only: sample (resolved Sample object)
    };
  }

  function makeSection(name, bars) {
    const id = MPC.util.uid('sec');
    return {
      id,
      name: name || 'Section',
      color: '#54a0ff',
      bars: bars || MPC.const.DEFAULT_BARS_PER_SECTION,
      events: [],          // { padIndex, time (s, within one loop), velocity }
      repeats: 1,
      volumeDb: 0,
      eq: defaultEq(),
      muted: false,
    };
  }

  // A clip is a placement of a section (pattern) on the timeline grid.
  // It plays the section's loop, tiled, for `lenBars`, starting `srcOffsetSec`
  // into the loop (slicing changes offset + length).
  function makeClip(sectionId, opts) {
    opts = opts || {};
    return {
      id: MPC.util.uid('clip'),
      sectionId,
      lane: opts.lane || 0,
      startBar: opts.startBar || 0,
      lenBars: opts.lenBars || 1,
      srcOffsetSec: opts.srcOffsetSec || 0,
    };
  }

  // Strip runtime fields from a pad for persistence.
  function padToRecord(pad) {
    return {
      index: pad.index,
      name: pad.name,
      sampleId: pad.sampleId,
      trimStart: pad.trimStart,
      trimEnd: pad.trimEnd,
      gainDb: pad.gainDb,
      pan: pad.pan,
      tune: pad.tune,
      eq: MPC.util.clone(pad.eq),
      color: pad.color,
      muted: pad.muted,
    };
  }

  // Merge a persisted pad record over a fresh default (tolerates old saves).
  function padFromRecord(record, index) {
    const pad = defaultPad(index != null ? index : record.index || 0);
    return Object.assign(pad, record, { eq: Object.assign(defaultEq(), record.eq || {}) });
  }

  MPC.models = { defaultEq, defaultPad, makeSection, makeClip, padToRecord, padFromRecord };
})();
