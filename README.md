# MPC Studio

A browser-based MPC / groove box for sketching sounds and loops when you're
away from your DAW — then exporting clean stems to drop into **FL Studio**
later. No install, no build step, no account, no server required: it's plain
HTML + JavaScript using the Web Audio API, and everything you make is stored
locally in your browser.

Built for the workflow of: *import some sounds → jam on the keyboard → record
loop after loop into a playlist → mix a little → export the stems.*

---

## Run it

There are two ways to run the exact same app:

- **Standalone build** (this repo) — full features **including WAV/ZIP stem
  export**. Open it directly or serve it (below).
- **Live in-session build** — a single-file version published as a claude.ai
  Artifact so you can play it right in the chat. Everything works there too;
  the only difference is that the Artifact viewer can't save `.wav` files, so a
  single WAV export arrives as a `.zip` with the WAV inside (stem export is a
  ZIP anyway). Click into the page once before typing so it gets the keyboard.
  Rebuild the single file any time with `node tools/build-artifact.js`.

**Option A — open the file.** Double-click `index.html` (or drag it into a
browser). Works offline. In Chrome/Edge this includes saving banks & projects.

**Option B — serve it locally (recommended for saving).** Some browsers restrict
local storage on `file://`. Serving the folder over `http://` avoids that and is
still fully offline. From this folder run either:

```bash
python3 -m http.server 8000
# or
npx --yes serve .
```

then open <http://localhost:8000>.

> Chrome, Edge, and Firefox (recent) are all supported. First click/keypress
> starts the audio engine (browser autoplay rule).

---

## What it does

### 🥁 The MPC — pads & keyboard
- **16 pads (4×4)**. Load a sound by **dropping an audio file on a pad**, or
  double-clicking a pad / using **Load…** in the pad editor.
- **Play with your keyboard**, hardware-MPC layout (pad 1 = bottom-left):

  ```
  1 2 3 4      a s d f      →  the four rows of pads
  q w e r      z x c v
  ```
- Click a pad to open it in the **pad editor** below the grid.

The workspace has three tabs: **🥁 MPC** (pads + pad mixer), **🎚 Playlist**
(the timeline grid) and **🎹 Synth** (a synth sample creator, see below). Finishing a recording jumps you to the Playlist.

### 🎹 Synth — sample creator
A small subtractive polysynth you play with the computer keyboard, FL Studio
"typing keyboard" style:

```
 2 3   5 6 7   9 0   =        ← top row: one octave higher
Q W E R T Y U I O P [ ]
 S D   G H J   L ;
Z X C V B N M , . /          ← bottom row: starts at C of the current octave
```

- Keys are matched by **physical position**, so it works the same on a German
  QWERTZ keyboard (the key labelled `Y` bottom-left plays C). In Chromium-based
  browsers the on-screen piano shows your real key caps.
- `↑` / `↓` octave, `Enter` record, `Space` play/stop the take, `Esc` all notes off.
  You can also click/touch the on-screen piano.
- **Sound**: 2 oscillators (sine/triangle/saw/square, octave, semitone, detune,
  level), unison (up to 7 voices with stereo spread), low/high/band-pass filter
  with its own ADSR, amp ADSR, an LFO for pitch/filter wobble (vibrato or tape
  warble), noise, drive, delay and reverb. Save your own presets (stored in
  this browser).
- **Presets**: 8 basics plus a 12-preset **Trip Hop Kit** for atmospheric hip
  hop / psychedelic trip hop: Dusty Keys, Tape Warble Pad, Haze Drone, Smoky
  Sub, Mellow Bass, Psych Lead, Ghost Theremin, Breathy Flute, Lo-fi Strings,
  Dream Bell, Echo Pluck and Space Sweep.
- **Record a melody**: `● Rec` (optional one-bar count-in and click at the
  project BPM), play, stop. Note starts are quantized (Off … 1/32). **Overdub**
  adds to the take instead of replacing it; Undo note, transpose ±1 and Clear
  edit it. The take is shown in a mini piano roll and saved with the project.
- **Export**: render the melody (starting at bar 1 for grid alignment, or
  trimmed to the first note) or a single **one-shot** note to a 44.1 kHz WAV
  (24- or 16-bit, optional normalize to −0.3 dBFS). Rendering happens offline,
  so it is sample-accurate and includes the delay/reverb tail.
- **→ Load onto MPC pad** puts the rendered sound straight onto the selected
  pad, so you can chop it or play it in the MPC tab.
- **☁ Save to Drive** (claude.ai version only) uploads the rendered WAV into a
  Google Drive folder you name (default `FL Studio Samples`, created in My
  Drive if missing), using your Google Drive connector. If the view can only
  send small files, a 24-bit file that is too big is sent as 16-bit instead.

> Note names here use MIDI 60 = C4. As far as I know FL Studio labels the same
> note C5, so a sample named `…_C4.wav` is FL's C5.

### 🎚 Per-pad mixing
Select a pad to adjust:
- **Length / trim** — drag the yellow handles on the waveform to set the start
  and end of the sound (double-click the waveform to reset). Great for chopping
  or tightening one-shots.
- **Tune** (± semitones), **Volume**, **Pan**, **Mute**.
- **3-band EQ** — Low / Mid (sweepable frequency + Q) / High.

### ⏱ Tempo, metronome & count-in
- Set **BPM**, **meter** (beats per bar) and **bars per section** — the loop
  length, now up to **32 bars** — in the top bar.
- **🎵 Click** toggles the metronome; **Count-in** gives you a one-bar count
  before recording starts.
- **Quantize** snaps recorded hits to a grid (1/4 … 1/32, incl. triplets, or Off).

### 🔁 Loop station
- Hit **● Rec** to record a new **section**: the transport loops your chosen bar
  length while you play; hits are captured and quantized. Keep playing to
  **overdub** more layers into the same loop.
- Press **■ Stop** to finish — the loop drops onto the **Playlist** as a clip.
- Record the next section the same way — **one after another** — to build up the
  arrangement.

### 🎚 The Playlist (FL-style timeline)
A grid with bars across the top and lanes down the side. Each recorded loop
appears as a **clip showing its waveform**:
- **Move** — drag a clip along the timeline or between lanes (clips in different
  lanes play together).
- **Resize / loop** — drag a clip's right edge; extend past its length and the
  loop repeats to fill.
- **Chop** — switch to the **✂ Slice** tool and click a clip to split it at that
  grid line. Great for rearranging or dropping part of a groove.
- **Duplicate / delete** — from the clip's mixer below, or `Delete` on the
  keyboard.
- **Snap** to Bar / Beat / Off, and **zoom** in/out. **▶ Play** runs the whole
  timeline; **↻** loops it. A green **playhead** tracks playback.

### 🎛 Per-section mixing
Select a clip to set its section's **Volume**, **Mute** and **3-band EQ** — so
each part of the arrangement can sit differently. (Per-section EQ is applied
exactly on export/bounce.)

### 💾 Sound banks & projects
- **Sound Banks** save a set of pads + their sounds and mix settings. Save,
  load, save-as, delete.
- **Projects** save *everything*: tempo, pads, all recorded sections and their
  mixing. Come back and pick up where you left off.
- **⬇ Project file / ⬆ Load file** export or import a project as a portable
  `.json` with the audio embedded — move a session between machines or between
  the live and standalone builds.
- All data lives in your browser (IndexedDB) — nothing is uploaded anywhere.

### ⬇ Export for FL Studio
Pick what you want and hit **Export ZIP**. Everything renders offline to
**24-bit / 44.1 kHz WAV**, bar-1 aligned, so you can drop it straight onto the
FL Studio timeline:
- **Per-pad stems** — one WAV per pad across the whole arrangement (each pad's
  full contribution, aligned). Drop them all in and your groove reassembles.
- **Per-section WAVs** — each recorded loop as its own file.
- **Master mix** — the whole playlist bounced to one stereo WAV (optional).

A `README.txt` with tempo/meta is included in the ZIP.

---

## Tips
- **Space** = Stop. Recording auto-creates the next section, so you can keep the
  flow going: Rec → play → Stop → Rec → play → Stop.
- Trim is non-destructive and travels with the pad into stems, so tighten sounds
  freely.
- Save a **Project** before exporting if you want to reopen and tweak later.

## How it's built
Vanilla JS modules under `js/` (no dependencies), styled by `styles/main.css`:

| File | Role |
|------|------|
| `core.js` | namespace, constants, utils, event bus |
| `storage.js` | IndexedDB (samples / banks / projects) |
| `export-encoders.js` | WAV + CRC32 + ZIP writers |
| `sample.js` | decode + waveform peaks |
| `audio-engine.js` | live Web Audio graph (pad channels, EQ, master) |
| `models.js` | pad / section / clip / EQ data model |
| `transport.js` | clock, lookahead scheduler, metronome |
| `sequencer.js` | recording, quantize, loop & clip-timeline scheduling |
| `render.js` | offline rendering → stems / sections / master + clip waveforms |
| `synth-engine.js` | synth voices, FX bus, presets, offline synth rendering |
| `synth.js` | synth playing, take recording/playback, export, persistence |
| `drive.js` | save WAVs to a Google Drive folder (Artifact build, via the `mcp` capability) |
| `host-bridge.js` | file saving (browser download or Artifact `downloads`) |
| `app.js` | central state + actions |
| `ui-*.js` | pads, mixer, transport, tabs, playlist grid, library, synth tab, bootstrap |
| `tools/build-artifact.js` | inline everything into one self-contained page |
