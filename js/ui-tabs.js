/*
 * ui-tabs.js — switches the workspace between the MPC and Playlist tabs.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { qs, qsa } = MPC.dom;

  function activate(name) {
    qsa('#tab-bar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    qsa('#tab-body .tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    MPC.bus.emit('tab:changed', { tab: name });
  }

  const UiTabs = {
    activate,
    init() {
      qsa('#tab-bar .tab').forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
      // Jump to the playlist after finishing a recording so the new clip is visible.
      MPC.bus.on('sequencer:record-stop', () => activate('playlist'));
    },
  };

  MPC.uiTabs = UiTabs;
})();
