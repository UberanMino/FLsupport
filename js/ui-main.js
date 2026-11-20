/*
 * ui-main.js — bootstrap. Initializes state + all UI modules and provides
 * small promise-based modal helpers (MPC.ui.prompt / MPC.ui.confirm).
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { el, qs } = MPC.dom;

  // ---- modal helpers ------------------------------------------------------
  function modal({ title, withInput, defaultValue, okText, cancelText }) {
    return new Promise((resolve) => {
      const host = qs('#modal-host');
      const input = withInput ? el('input', { class: 'modal-input', value: defaultValue || '' }) : null;
      const close = (val) => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(val); };

      const okBtn = el('button', { class: 'primary', text: okText || 'OK' });
      const cancelBtn = el('button', { class: 'mini', text: cancelText || 'Cancel' });
      okBtn.addEventListener('click', () => close(withInput ? (input.value.trim() || null) : true));
      cancelBtn.addEventListener('click', () => close(withInput ? null : false));

      const box = el('div', { class: 'modal-box' }, [
        el('div', { class: 'modal-title', text: title }),
        input,
        el('div', { class: 'modal-actions' }, [cancelBtn, okBtn]),
      ].filter(Boolean));
      const overlay = el('div', { class: 'modal-overlay' }, [box]);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(withInput ? null : false); });

      const onKey = (e) => {
        if (e.key === 'Escape') close(withInput ? null : false);
        else if (e.key === 'Enter') { e.preventDefault(); close(withInput ? (input.value.trim() || null) : true); }
      };
      window.addEventListener('keydown', onKey);

      host.appendChild(overlay);
      if (input) { input.focus(); input.select(); }
    });
  }

  MPC.ui = {
    prompt(title, defaultValue) { return modal({ title, withInput: true, defaultValue, okText: 'Save' }); },
    confirm(title) { return modal({ title, withInput: false, okText: 'Yes', cancelText: 'No' }); },
  };

  // ---- boot ---------------------------------------------------------------
  function boot() {
    MPC.app.init();

    MPC.uiPads.init();
    MPC.uiMixer.init();
    MPC.uiTransport.init();
    MPC.uiTabs.init();
    MPC.uiPlaylist.init();
    MPC.uiLibrary.init();
    MPC.uiSynth.init();

    // Warn about unsaved work.
    window.addEventListener('beforeunload', (e) => {
      if (MPC.app.state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Storage availability notice.
    MPC.storage.available().then((ok) => {
      if (!ok) {
        MPC.toast('Storage unavailable here — saving banks/projects may not work. Try serving the folder over http (see README).', 'error');
      }
    });

    console.log('%cMPC Studio ready', 'color:#54a0ff;font-weight:bold');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
