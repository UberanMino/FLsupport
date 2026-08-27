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
  Artifact so you can jam right in the chat. Everything works there *except*
  audio-file downloads (the Artifact sandbox blocks `.wav`/`.zip`). To get stems
  out, use **⬇ Project file** to download a portable `.json` (your sounds are
  embedded), then open the standalone build, **⬆ Load file**, and **Export ZIP**.
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

### 🎚 Per-pad mixing
Select a pad to adjust:
- **Length / trim** — drag the yellow handles on the waveform to set the start
  and end of the sound (double-click the waveform to reset). Great for chopping
  or tightening one-shots.
- **Tune** (± semitones), **Volume**, **Pan**, **Mute**.
- **3-band EQ** — Low / Mid (sweepable frequency + Q) / High.

### ⏱ Tempo, metronome & count-in
- Set **BPM**, **meter** (beats per bar) and **bars per section** (loop length)
  in the top bar.
- **🎵 Click** toggles the metronome; **Count-in** gives you a one-bar count
  before recording starts.
- **Quantize** snaps recorded hits to a grid (1/4 … 1/32, incl. triplets, or Off).

### 🔁 Loop station → Playlist
- Hit **● Rec** to record a new **section**: the transport loops your chosen bar
  length while you play; hits are captured and quantized. Keep playing to
  **overdub** more layers into the same loop.
- Press **■ Stop** to finish. The section lands in the **Playlist** on the right.
- Record the next section the same way — **one after another** — to build an
  arrangement. Each row has: loop-preview ▶, **overdub ●+**, reorder ▲▼,
  duplicate ⧉, delete ✕.
- **▶ Play** plays the whole playlist top to bottom; **↻** loops it.

### 🎛 Per-section mixing
Select a section to set its **Volume**, **Repeats** (×1–16), **Mute**, and its
own **3-band EQ** — so each part of the arrangement can sit differently.

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
| `models.js` | pad / section / EQ data model |
| `transport.js` | clock, lookahead scheduler, metronome |
| `sequencer.js` | recording, quantize, loop & arrangement scheduling |
| `render.js` | offline rendering → stems / sections / master |
| `app.js` | central state + actions |
| `ui-*.js` | pads, mixer, transport, arrangement, library, bootstrap |
