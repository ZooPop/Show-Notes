# Show Notes

Web-based cue calling and tracking driven by **SMPTE timecode**. Show Notes always knows which cue a production is on: it follows LTC carried over **Dante**, MIDI Timecode, OSC, or its own clock. Timed cues fire automatically as timecode passes them, and it keeps every device in the room in sync. The stage manager's desk, operators' tablets and backstage displays all follow it.

```
             Dante network
  ┌───────────────┐   LTC on a Dante channel   ┌──────────────────────────────┐
  │ Playback /    │ ─────────────────────────▶ │ Show Notes machine           │
  │ TC generator  │                            │  Dante Virtual Soundcard/Via │
  └───────────────┘                            │  Browser (TC master) ──┐     │
  ┌───────────────┐   MTC (USB/RTP MIDI)       │    decodes LTC/MTC     │ WS  │
  │ DAW / QLab    │ ─────────────────────────▶ │  Node server ◀─────────┘     │
  └───────────────┘   OSC  /shownotes/...  ──▶ │   cue engine + state         │
                      OSC  /cue/N/start   ◀──  │                              │
                                               └──────────────┬───────────────┘
                                                    WebSocket │ LAN
                               ┌──────────────────┬───────────┴────────┐
                               ▼                  ▼                    ▼
                          SM desk (Operate)   iPad (Display)     Operators (Operate)
```

## Quick start

```bash
cd show-notes
npm install
npm start            # http://localhost:3000
```

* **Operate**: big clock, current/next cue, countdown, STANDBY warning, GO / Back.
* **Edit**: add, reorder and edit cues, capture a cue at the current timecode (`C`), import/export, show settings.
* **Display** (`/?view=display`): a full-screen read-only view for backstage monitors and tablets.

Open the page on any device on the same network (the server prints the LAN addresses). Every device shares one show state.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | GO (fire the next cue) |
| `Backspace` | Back one cue |
| `↑` / `↓` | Select a cue · `Enter` loads it as the current cue without firing |
| `C` | (Edit view) new cue at the current timecode |
| `Esc` | Back to Operate view |

## Timecode sources

Choose the source on the machine that has the timecode. That browser becomes the **TC master** and streams the timecode to the server, and everyone else follows.

| Source | How it works |
| --- | --- |
| **LTC (Dante / soundcard)** | Install Dante Virtual Soundcard (or Dante Via) on the Show Notes machine and route the LTC channel to it in Dante Controller. In Show Notes, pick the DVS input and the channel. The LTC is decoded in the browser (AudioWorklet). It handles 24/25/29.97DF/30 fps, auto-detects the frame rate, and decodes reverse play. |
| **MIDI Timecode** | Web MIDI (Chrome/Edge). Quarter-frame and full-frame (locate) messages are supported. |
| **Internal clock** | A free-running clock with Run / Stop / Locate, for rehearsals without a timecode source. |
| **OSC** | Any device can push timecode: `/shownotes/tc "01:00:10:00" [fps]`. |

> **Secure context:** browsers only allow audio and MIDI input on `https://` or `http://localhost`. Open the TC master at `http://localhost:3000` on the Dante machine. Other devices can use the LAN address because they only view. To capture on another machine, serve over HTTPS: `HTTPS_KEY=key.pem HTTPS_CERT=cert.pem npm start`.

> **Channel count:** some browser/driver combinations only expose the first 2 channels of a multichannel device. If your LTC is on a high channel, route it to DVS channel 1 or 2 in Dante Controller.

There's also an **LTC test generator** under Edit → Show settings. It plays LTC to an audio output. Select Dante Virtual Soundcard as the output to put it on the network.

## How cues follow timecode

* A cue with a **trigger TC** fires automatically when timecode plays forward across that time, provided **Auto** is on for the cue and *Auto-fire from TC* is enabled. Cues with no trigger TC are manual and need a GO.
* **Safety cues** (fly, pyro, …) should have Auto turned off. They still show a countdown and STANDBY, but only fire on GO.
* A timecode **jump** (backwards, or forward by more than 2 s) is a *locate*. With *Chase* on, Show Notes moves to the last timed cue at or before the new position without firing anything.
* A cue the operator has already passed is never fired again by timecode.
* Next cue turns **STANDBY** (flashing) within the standby window (10 s by default).
* Every GO, chase, back and reset is written to the **show log** with wall-clock time, timecode and source. Export it as CSV for show reports.

## OSC

The server listens on UDP **53100** (`OSC_PORT`):

| Address | Args | Action |
| --- | --- | --- |
| `/shownotes/go` | | GO |
| `/shownotes/back` | | Back |
| `/shownotes/goto` | cue number | Fire that cue |
| `/shownotes/load` | cue number | Make it current without firing |
| `/shownotes/reset` | | Back to top |
| `/shownotes/tc` | `"HH:MM:SS:FF"` [fps] | Push timecode |

**OSC out:** set *OSC output target* (e.g. `127.0.0.1:53000` for QLab). Then give a cue an OSC message such as `/cue/12/start`, and it is sent whenever that cue fires.

## HTTP API

* `GET /api/show`: the show JSON
* `GET /api/state`: runtime and log
* `POST /api/action`: dispatch any engine action, e.g. `{"type":"go"}` or `{"type":"goto","number":"12"}`

## Files

```
server.js                 HTTP + WebSocket + OSC server; owns the show state (data/show.json)
lib/osc.js                OSC encode/decode
public/js/engine.js       cue engine (pure reducer, shared by server and browser)
public/js/timecode.js     SMPTE timecode maths (drop-frame aware)
public/js/ltc-decoder.js  LTC biphase decoder + encoder
public/js/ltc-worklet.js  AudioWorklet reader/generator
public/js/mtc.js          MIDI Timecode parser
public/js/sources.js      browser timecode sources
public/js/app.js          UI
test/                     node --test suites (npm test)
```

If no server is reachable (for example, the page was opened from static hosting), the app runs the same engine locally and saves to `localStorage`.

CSV import/export columns are `number,name,dept,tc,auto,notes,osc`.

## Environment variables

| Var | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `OSC_PORT` | `53100` | UDP OSC input |
| `SHOW_FILE` | `data/show.json` | Where the show is saved |
| `HTTPS_KEY`, `HTTPS_CERT` | | Serve over HTTPS |
