/*
 * host-bridge.js — abstracts "save a file to the user".
 *
 * Standalone (opened directly / served): a normal browser download.
 * Inside a claude.ai Artifact: the sandbox blocks page-initiated downloads, so
 * route through the `downloads` runtime capability. That capability only allows
 * a fixed set of extensions (json/txt/png/… — NOT wav or zip), so audio/ZIP
 * export is a standalone-only feature; the portable project file is .json and
 * works everywhere.
 */
(function () {
  'use strict';
  const MPC = window.MPC;

  const isArtifact = typeof window.claude !== 'undefined' && window.claude && typeof window.claude.use === 'function';
  let nsPromise = null;

  function downloadsNs() {
    if (!isArtifact) return Promise.resolve(null);
    if (!nsPromise) nsPromise = Promise.resolve().then(() => window.claude.use('downloads')).catch(() => null);
    return nsPromise;
  }

  function guessType(fn) {
    if (fn.endsWith('.json')) return 'application/json';
    if (fn.endsWith('.zip')) return 'application/zip';
    if (fn.endsWith('.wav')) return 'audio/wav';
    return 'application/octet-stream';
  }

  const Host = {
    isArtifact,

    // Returns true if the file was handed off / saved, false otherwise.
    async saveFile(filename, data) {
      if (!isArtifact) {
        const blob = (data instanceof Blob) ? data : new Blob([data], { type: guessType(filename) });
        MPC.util.download(blob, filename);
        return true;
      }
      const dl = await downloadsNs();
      if (!dl) {
        MPC.toast('Saving files isn’t available in this view.', 'error');
        return false;
      }
      try {
        await dl.save({ filename, data });
        return true;
      } catch (err) {
        const code = err && err.code;
        if (code === 'declined') { /* viewer cancelled — no noise */ }
        else if (code === 'rejected_extension' || code === 'extension_not_enabled') {
          const ext = (filename.split('.').pop() || '').toUpperCase();
          MPC.toast('This in-session view can’t download ' + ext + ' files. Use “Save project file” (.json), then export WAV stems from the standalone build.', 'error');
        } else if (code === 'too_large') {
          MPC.toast('That file is over the 16 MB download limit for this view.', 'error');
        } else {
          MPC.toast('Download failed: ' + ((err && err.message) || code || 'unknown'), 'error');
        }
        return false;
      }
    },
  };

  MPC.host = Host;
})();
