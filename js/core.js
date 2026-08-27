/*
 * core.js — global namespace, constants, small utilities and a tiny event bus.
 * Everything hangs off window.MPC so the app works from file:// with plain
 * <script> tags (no bundler, no ES modules, no network).
 */
(function () {
  'use strict';

  const MPC = (window.MPC = window.MPC || {});

  /* ---------------------------------------------------------------- constants */
  const NUM_PADS = 16;

  // Keyboard -> pad index. Pad index 0 is the bottom-left pad (classic MPC "1").
  // Display is rendered top rows first (see PAD_ROWS) but the numbering keeps
  // pad 1 at the bottom-left the way hardware does.
  const KEY_TO_PAD = {
    '1': 12, '2': 13, '3': 14, '4': 15,
    'q': 8,  'w': 9,  'e': 10, 'r': 11,
    'a': 4,  's': 5,  'd': 6,  'f': 7,
    'z': 0,  'x': 1,  'c': 2,  'v': 3,
  };
  const PAD_TO_KEY = {};
  Object.keys(KEY_TO_PAD).forEach((k) => { PAD_TO_KEY[KEY_TO_PAD[k]] = k; });

  // Rows as displayed, top to bottom.
  const PAD_ROWS = [
    [12, 13, 14, 15],
    [8, 9, 10, 11],
    [4, 5, 6, 7],
    [0, 1, 2, 3],
  ];

  const PAD_COLORS = [
    '#ff5c7a', '#ff9f43', '#ffd93d', '#7bed9f',
    '#2ed573', '#26d0ce', '#54a0ff', '#5f6bff',
    '#a55eea', '#d980fa', '#f368e0', '#ff6b81',
    '#ff7f50', '#c8d64b', '#48dbb0', '#5eead4',
  ];

  const QUANTIZE_VALUES = {
    'off': 0,
    '1/4': 1 / 4,
    '1/8': 1 / 8,
    '1/8T': 1 / 12,   // eighth-note triplet
    '1/16': 1 / 16,
    '1/16T': 1 / 24,  // sixteenth-note triplet
    '1/32': 1 / 32,
  };

  MPC.const = {
    NUM_PADS,
    KEY_TO_PAD,
    PAD_TO_KEY,
    PAD_ROWS,
    PAD_COLORS,
    QUANTIZE_VALUES,
    DEFAULT_BPM: 90,
    DEFAULT_BEATS_PER_BAR: 4,
    DEFAULT_BARS_PER_SECTION: 2,
    RENDER_SAMPLE_RATE: 44100,
  };

  /* --------------------------------------------------------------- utilities */
  const util = {
    clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },

    // Decibels <-> linear amplitude. -Infinity dB == silence.
    dbToGain(db) { return db <= -60 ? 0 : Math.pow(10, db / 20); },
    gainToDb(g) { return g <= 0 ? -60 : 20 * Math.log10(g); },

    // Semitones -> playbackRate multiplier.
    semitonesToRate(semi) { return Math.pow(2, semi / 12); },

    uid(prefix) {
      return (prefix || 'id') + '-' +
        Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2, 8);
    },

    formatTime(seconds) {
      if (!isFinite(seconds)) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return m + ':' + String(s).padStart(2, '0');
    },

    // Trigger a browser download for a Blob.
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    // Deep clone plain data (settings objects). Not for typed arrays / blobs.
    clone(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); },

    sanitizeFilename(name) {
      return String(name || 'untitled')
        .replace(/[^a-z0-9\-_ ]/gi, '_')
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'untitled';
    },

    abToBase64(ab) {
      const bytes = new Uint8Array(ab);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(bin);
    },
    base64ToAb(b64) {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    },
  };
  MPC.util = util;

  /* -------------------------------------------------------------- event bus */
  // Minimal pub/sub. UI subscribes; engine/state emits.
  const listeners = new Map();
  MPC.bus = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => MPC.bus.off(event, fn);
    },
    off(event, fn) {
      const set = listeners.get(event);
      if (set) set.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (set) set.forEach((fn) => {
        try { fn(payload); } catch (err) { console.error('bus handler error', event, err); }
      });
    },
  };

  /* ------------------------------------------------------------ DOM helpers */
  MPC.dom = {
    qs(sel, root) { return (root || document).querySelector(sel); },
    qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); },
    el(tag, props, children) {
      const node = document.createElement(tag);
      if (props) {
        Object.keys(props).forEach((k) => {
          if (k === 'class') node.className = props[k];
          else if (k === 'text') node.textContent = props[k];
          else if (k === 'html') node.innerHTML = props[k];
          else if (k === 'dataset') Object.assign(node.dataset, props[k]);
          else if (k.startsWith('on') && typeof props[k] === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), props[k]);
          } else if (k === 'style' && typeof props[k] === 'object') {
            Object.assign(node.style, props[k]);
          } else if (props[k] != null) {
            node.setAttribute(k, props[k]);
          }
        });
      }
      if (children != null) {
        (Array.isArray(children) ? children : [children]).forEach((c) => {
          if (c == null) return;
          node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
      }
      return node;
    },
  };

  MPC.toast = function (message, kind) {
    const host = MPC.dom.qs('#toast-host') || document.body;
    const t = MPC.dom.el('div', { class: 'toast ' + (kind || 'info'), text: message });
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, kind === 'error' ? 4200 : 2400);
  };
})();
