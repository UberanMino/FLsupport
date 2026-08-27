/*
 * sample.js — a loaded audio file: raw bytes (for persistence/re-decode),
 * a decoded AudioBuffer (for playback), and pre-computed peaks (for drawing).
 */
(function () {
  'use strict';
  const MPC = window.MPC;

  // Reduce an AudioBuffer to min/max peak pairs for a compact waveform view.
  function computePeaks(audioBuffer, buckets) {
    buckets = buckets || 800;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const len = ch0.length;
    const step = Math.max(1, Math.floor(len / buckets));
    const peaks = new Float32Array(buckets * 2);
    for (let b = 0; b < buckets; b++) {
      let min = 1, max = -1;
      const start = b * step;
      const end = Math.min(len, start + step);
      for (let i = start; i < end; i++) {
        let s = ch0[i];
        if (ch1) s = (s + ch1[i]) * 0.5;
        if (s < min) min = s;
        if (s > max) max = s;
      }
      if (start >= end) { min = 0; max = 0; }
      peaks[b * 2] = min;
      peaks[b * 2 + 1] = max;
    }
    return peaks;
  }

  const Sample = {
    // Build a sample record from a File/Blob. Decodes via the shared context.
    async fromFile(file) {
      const arrayBuffer = await file.arrayBuffer();
      // decodeAudioData detaches the buffer, so keep a copy of the raw bytes.
      const rawCopy = arrayBuffer.slice(0);
      const audioBuffer = await MPC.engine.decode(arrayBuffer);
      const id = MPC.util.uid('smp');
      return {
        id,
        name: file.name || 'sample',
        type: file.type || 'audio/wav',
        data: rawCopy,                 // ArrayBuffer, persisted
        duration: audioBuffer.duration,
        buffer: audioBuffer,           // runtime only
        peaks: computePeaks(audioBuffer),
      };
    },

    // Rehydrate a persisted sample record (has .data ArrayBuffer, no .buffer).
    async fromRecord(record) {
      const audioBuffer = await MPC.engine.decode(record.data.slice(0));
      return Object.assign({}, record, {
        buffer: audioBuffer,
        duration: audioBuffer.duration,
        peaks: computePeaks(audioBuffer),
      });
    },

    // Strip runtime fields before persisting.
    toRecord(sample) {
      return {
        id: sample.id,
        name: sample.name,
        type: sample.type,
        data: sample.data,
        duration: sample.duration,
      };
    },

    computePeaks,
  };

  MPC.Sample = Sample;
})();
