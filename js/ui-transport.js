/*
 * ui-transport.js — top-bar controls, playhead and status readout.
 */
(function () {
  'use strict';
  const MPC = window.MPC;
  const { qs } = MPC.dom;
  const App = MPC.app;

  function syncControls() {
    const s = App.state;
    qs('#project-name').value = s.projectName;
    qs('#bpm').value = s.bpm;
    qs('#beats-per-bar').value = String(s.beatsPerBar);
    qs('#bars-per-section').value = String(s.barsPerSection);
    qs('#quantize').value = s.quantize;
    qs('#master-volume').value = s.masterVolume;
    qs('#metronome-toggle').classList.toggle('active', s.metronomeOn);
    qs('#countin-toggle').classList.toggle('active', s.countIn);
  }

  function setStatus(text, kind) {
    const el = qs('#transport-status');
    el.textContent = text;
    el.className = 'transport-status' + (kind ? ' ' + kind : '');
  }

  const UiTransport = {
    init() {
      qs('#project-name').addEventListener('change', (e) => {
        App.state.projectName = e.target.value.slice(0, 60) || 'Untitled Project';
        App.markDirty();
      });
      qs('#bpm').addEventListener('change', (e) => App.setTempo(parseFloat(e.target.value)));
      qs('#beats-per-bar').addEventListener('change', (e) => App.setBeatsPerBar(parseInt(e.target.value, 10)));
      qs('#bars-per-section').addEventListener('change', (e) => App.setBarsPerSection(parseInt(e.target.value, 10)));
      qs('#quantize').addEventListener('change', (e) => App.setQuantize(e.target.value));
      qs('#metronome-toggle').addEventListener('click', () => App.toggleMetronome());
      qs('#countin-toggle').addEventListener('click', () => App.toggleCountIn());
      qs('#master-volume').addEventListener('input', (e) => App.setMasterVolume(parseFloat(e.target.value)));

      qs('#record-btn').addEventListener('click', () => App.toggleRecord());
      qs('#stop-btn').addEventListener('click', () => App.stopEverything());
      qs('#play-arrangement-btn').addEventListener('click', () => {
        if (MPC.transport.running && MPC.transport.mode === 'arrangement') App.stopEverything();
        else App.playArrangement(false);
      });
      qs('#loop-arrangement-btn').addEventListener('click', () => App.playArrangement(true));

      // transport feedback
      MPC.bus.on('sequencer:record-start', () => {
        qs('#record-btn').classList.add('recording');
        setStatus('● Recording', 'rec');
      });
      MPC.bus.on('sequencer:record-stop', () => {
        qs('#record-btn').classList.remove('recording');
        setStatus('Ready');
      });
      MPC.bus.on('sequencer:preview-start', () => setStatus('Loop preview', 'play'));
      MPC.bus.on('sequencer:arrangement-start', () => {
        qs('#play-arrangement-btn').classList.add('active');
        setStatus('▶ Playing playlist', 'play');
      });
      const clearPlay = () => {
        qs('#play-arrangement-btn').classList.remove('active');
        if (!MPC.sequencer.recording) setStatus('Ready');
        qs('#playhead-fill').style.width = '0%';
      };
      MPC.bus.on('sequencer:arrangement-stop', clearPlay);
      MPC.bus.on('transport:arrangement-end', clearPlay);
      MPC.bus.on('transport:stop', () => { qs('#playhead-fill').style.width = '0%'; });

      MPC.bus.on('transport:position', (p) => {
        const fill = qs('#playhead-fill');
        if (p.mode === 'loop') {
          fill.style.width = (p.fraction * 100).toFixed(1) + '%';
          if (p.countIn) {
            setStatus('Count-in…', MPC.sequencer.recording ? 'rec' : 'play');
          } else {
            const spb = 60 / App.state.bpm;
            const beat = Math.floor(p.loopPositionSec / spb);
            const bar = Math.floor(beat / App.state.beatsPerBar) + 1;
            const beatInBar = (beat % App.state.beatsPerBar) + 1;
            const totalBars = Math.round(p.loopLength / (spb * App.state.beatsPerBar));
            setStatus((MPC.sequencer.recording ? '● Rec' : 'Loop') + ' · bar ' + bar + '/' + totalBars + ' · beat ' + beatInBar,
              MPC.sequencer.recording ? 'rec' : 'play');
          }
        } else {
          fill.style.width = (p.fraction * 100).toFixed(1) + '%';
          setStatus('▶ ' + MPC.util.formatTime(Math.max(0, p.positionSec)) + ' / ' + MPC.util.formatTime(p.totalSec), 'play');
        }
      });

      MPC.bus.on('settings:changed', syncControls);
      MPC.bus.on('project:changed', syncControls);
      syncControls();
    },
  };

  MPC.uiTransport = UiTransport;
})();
