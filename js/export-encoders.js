/*
 * export-encoders.js — pure encoders with no dependencies.
 *   - AudioBuffer -> 16/24-bit PCM WAV (Blob)
 *   - CRC32
 *   - minimal ZIP archive (store / no compression) so multiple stems can be
 *     handed back as a single download.
 */
(function () {
  'use strict';
  const MPC = window.MPC;

  /* ------------------------------------------------------------------ WAV */
  // Interleave planar channel data and write a canonical PCM WAV.
  function encodeWav(audioBuffer, bitDepth) {
    bitDepth = bitDepth || 24;
    const numCh = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);         // PCM chunk size
    view.setUint16(20, 1, true);          // format = PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    // Gather channels once.
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));

    let offset = 44;
    if (bitDepth === 16) {
      for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numCh; c++) {
          let s = channels[c][i];
          s = s < -1 ? -1 : s > 1 ? 1 : s;
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          offset += 2;
        }
      }
    } else { // 24-bit
      for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numCh; c++) {
          let s = channels[c][i];
          s = s < -1 ? -1 : s > 1 ? 1 : s;
          let v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
          if (v < 0) v += 0x1000000;
          view.setUint8(offset, v & 0xff);
          view.setUint8(offset + 1, (v >> 8) & 0xff);
          view.setUint8(offset + 2, (v >> 16) & 0xff);
          offset += 3;
        }
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /* ---------------------------------------------------------------- CRC32 */
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }
  function crc32(bytes) {
    const table = crcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* ------------------------------------------------------------------ ZIP */
  // Store method only (no compression). Enough to bundle WAV stems, which are
  // already raw PCM. entries: [{ name, bytes:Uint8Array }]
  function zip(entries) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.bytes;
      const crc = crc32(data);

      const local = new ArrayBuffer(30 + nameBytes.length);
      const lv = new DataView(local);
      lv.setUint32(0, 0x04034b50, true);          // local file header sig
      lv.setUint16(4, 20, true);                   // version needed
      lv.setUint16(6, 0, true);                    // flags
      lv.setUint16(8, 0, true);                    // method = store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);         // compressed size
      lv.setUint32(22, data.length, true);         // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);                   // extra len
      const localBytes = new Uint8Array(local);
      localBytes.set(nameBytes, 30);

      chunks.push(localBytes, data);

      const cd = new ArrayBuffer(46 + nameBytes.length);
      const cv = new DataView(cd);
      cv.setUint32(0, 0x02014b50, true);           // central dir sig
      cv.setUint16(4, 20, true);                   // version made by
      cv.setUint16(6, 20, true);                   // version needed
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);                   // method
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);                   // extra
      cv.setUint16(32, 0, true);                   // comment
      cv.setUint16(34, 0, true);                   // disk number
      cv.setUint16(36, 0, true);                   // internal attrs
      cv.setUint32(38, 0, true);                   // external attrs
      cv.setUint32(42, offset, true);              // local header offset
      const cdBytes = new Uint8Array(cd);
      cdBytes.set(nameBytes, 46);
      central.push(cdBytes);

      offset += localBytes.length + data.length;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const centralOffset = offset;

    const end = new ArrayBuffer(22);
    const ev = new DataView(end);
    ev.setUint32(0, 0x06054b50, true);             // end of central dir sig
    ev.setUint16(8, entries.length, true);         // entries this disk
    ev.setUint16(10, entries.length, true);        // total entries
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);                      // comment len

    return new Blob([...chunks, ...central, new Uint8Array(end)], { type: 'application/zip' });
  }

  MPC.encoders = { encodeWav, crc32, zip };
})();
