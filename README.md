# Show Notes

Web-based cue calling and tracking driven by **SMPTE timecode**. Show Notes always knows which cue a production is on: it follows LTC carried over **Dante**, MIDI Timecode, OSC, or its own clock. Timed cues fire automatically as timecode passes them, and it keeps every device in the room in sync. The stage manager's desk, operators' tablets and backstage displays all follow it.

```
             Dante network
  ┌───────────────┐   LTC on a Dante channel   ┌──────────────────────────────┐
  │ Playback /    │ ─────────────────────────▶ │ Show Notes machine           │
  │ TC generator  │                            │  Dante Virtual Soundcard/Via │
  └───────────────┘                            │  Browser (TC in)  ─────┐     │
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

## Test it on your computer

1. Install **Node.js 18 or newer** (LTS) from https://nodejs.org.
2. Download this repo (green **Code** button → **Download ZIP**, or https://github.com/ZooPop/show-notes/archive/refs/heads/main.zip) and unzip it.
3. Double-click the launcher for your system:
   * macOS: `start-mac.command` (first time: right-click → Open, because it is an unsigned script)
   * Windows: `start-windows.bat`
   * Linux: `./start-linux.sh` (see [Linux](#linux-omarchy-arch-ubuntu-fedora) below)

It installs its one dependency the first time, starts the server and opens http://localhost:3000 with an example show loaded. To stop it, close the terminal window.

**A 2-minute test with no hardware:**

1. Open http://localhost:3000. Under *Timecode source*, pick **Practice clock**, type `00:59:55:00` in the Locate box, then press **Connect** and **▶ Run**.
2. Watch cues 1, 2 and 3 fire on their own at 01:00:00, :05 and :10. STANDBY flashes 10 s before each one.
3. Open http://localhost:3000/?view=display in a second window, or on a phone/tablet using the LAN address the terminal prints. It follows along.
4. Type `01:00:22:00` and press **Locate**. Show Notes chases to cue 4 without firing it.
5. Press **Space** for GO and **Backspace** for Back.

**Test LTC without Dante:** Edit → Show settings → *LTC test generator* → Start. Then set the timecode source to **LTC**, choose an input that hears that output (a loopback device such as BlackHole on macOS or VB-Cable on Windows), and press Connect.

**Test LTC from Ableton (or any DAW) on the same machine:** make an LTC file with `node tools/make-ltc-wav.js --start 00:59:50:00 --fps 30 --minutes 5`. Put it on an audio track with **Warp off**, and send Ableton's output to a loopback device (VB-Cable on Windows, BlackHole on macOS). In Show Notes, choose Source **LTC audio** with input **CABLE Output** / **BlackHole**, then Connect.

## Linux (Omarchy, Arch, Ubuntu, Fedora)

Show Notes runs fully on Linux, including the server-side LTC input and Show Notes · Video.

1. **Node.js 18+**
   - Omarchy / Arch: `sudo pacman -S nodejs npm`, or with mise: `mise use -g node@lts`
   - Ubuntu / Debian: `sudo apt install nodejs npm`. Fedora: `sudo dnf install nodejs npm`
2. **Run it:** `./start-linux.sh`. It installs dependencies, starts the server and opens your browser (Omarchy's default browser via `xdg-open`). Set `NO_BROWSER=1` to skip that, e.g. over SSH.
3. **Firewall:** Omarchy turns on UFW, which blocks other screens. Allow Show Notes once:
   `sudo ufw allow 3000/tcp && sudo ufw allow 53100/udp`
4. **Start at login (optional):** `scripts/linux-service.sh install` runs Show Notes as a systemd user service. `status` / `uninstall` work too; logs: `journalctl --user -u show-notes -f`. For a show computer that should run it from boot, also run `loginctl enable-linger $USER`.

**Audio (LTC in, any channel):** works with PipeWire (Omarchy's default), PulseAudio and ALSA. It needs `alsa-lib` and `libpulse`, which Omarchy already has; on a minimal Arch install run `sudo pacman -S alsa-lib libpulse pipewire-pulse`. No microphone permission prompt is needed on Linux.

**Dante on Linux:** Audinate doesn't make Dante Virtual Soundcard for Linux. Options:
- a **Dante USB interface** such as a Dante AVIO USB adapter. It shows up as a normal USB sound card; the AVIO USB has 2 channels, so put the LTC on 1 or 2.
- a multichannel **Dante-to-USB interface**, which works with any channel via the *Dante* source.
- **Inferno**, an unofficial open-source Dante implementation for Linux (experimental).
- Or send **MTC** or **OSC timecode** to Show Notes over the network from the Ableton computer.

**Browsers:** Chromium, Brave or Chrome are recommended. Firefox works too.

**Program feed (Show Notes · Video):** the *OBS stream* source works on any Linux browser. For a *camera / capture card*, Blackmagic's Desktop Video drivers for Linux work in **OBS**. Use OBS's Virtual Camera, which on Linux needs `v4l2loopback` (Arch: `sudo pacman -S v4l2loopback-dkms`), or stream from OBS to MediaMTX (Linux builds are available).

## Quick start (command line)

```bash
git clone https://github.com/ZooPop/show-notes.git
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

Show Notes **follows** timecode; it never generates or controls it. Under **Timecode in**, on the machine that receives the timecode (e.g. the one running Dante Virtual Soundcard), pick the input and press **Listen**. That browser passes what it hears to the server, and every connected screen follows. LTC can be on any channel the device offers (up to 32), e.g. channel 3 of Dante Virtual Soundcard.

| Source | How it works |
| --- | --- |
| **Dante** (recommended) | The Show Notes **server** opens the audio device itself and listens on exactly the channel you pick, e.g. **channel 3 of Dante Virtual Soundcard**. Choose the device and channel and press **Listen**. You can do this from any screen, even a tablet. It remembers the choice and starts listening again whenever Show Notes restarts. It handles 24/25/29.97DF/30 fps, auto-detects the frame rate, and decodes reverse play. |
| **Audio (browser, ch 1–2)** | The older method: the browser decodes LTC from an audio input. Browsers usually only expose the first **2 channels** of a device, so use this only if your LTC is on channel 1 or 2. |
| **Listen only** | For every other screen: just shows the timecode Show Notes is already receiving (e.g. Dante on the Show Notes computer). Nothing to set up, and it can't stop or change the timecode input. |
| **Practice clock** | A free-running clock with Run / Stop / Locate, for rehearsals without a timecode source. |
| **OSC** | Any device can push timecode: `/shownotes/tc "01:00:10:00" [fps]`. |

> **macOS: allow microphone access once.** macOS asks before any app reads an audio input, Dante Virtual Soundcard included. The first time you press **Listen** with the *Dante* source, allow **Terminal** (or whatever started Show Notes) to use the microphone. If the level meter stays empty, turn it on in **System Settings → Privacy & Security → Microphone**, then restart Show Notes.
>
> **Channel count:** the channel list shows how many inputs the device has. If you need a channel that isn't listed, raise the device's channel count in Dante Virtual Soundcard's settings.

> **Secure context:** browsers only allow audio and MIDI input on `https://` or `http://localhost`. Open the listening page at `http://localhost:3000` on the Dante machine. Other devices can use the LAN address because they only view. To capture on another machine, serve over HTTPS: `HTTPS_KEY=key.pem HTTPS_CERT=cert.pem npm start`.


There's also an **LTC test generator** under Edit → Show settings. It plays LTC to an audio output. Select Dante Virtual Soundcard as the output to put it on the network.

## How cues follow timecode

* A cue with a **trigger TC** fires automatically when timecode plays forward across that time, provided **Auto** is on for the cue and *Auto-fire from TC* is enabled. Cues with no trigger TC are manual and need a GO.
* **Safety cues** (fly, pyro, …) should have Auto turned off. They still show a countdown and STANDBY, but only fire on GO.
* A timecode **jump** (backwards, or forward by more than 2 s) is a *locate*. With *Chase* on, Show Notes moves to the last timed cue at or before the new position without firing anything.
* A cue the operator has already passed is never fired again by timecode.
* Next cue turns **STANDBY** (flashing) within the standby window (10 s by default).
* **TIME LEFT:** give a cue a length (m:ss, max 10:00) and CURRENT counts it down in a large badge. It turns orange in the last 30 s and flashes at 0:00. NEXT shows its full length. Timed cues count from their timecode, so the countdown pauses when playback pauses; manual cues count from when they were fired.
* Every GO, chase, back and reset is written to the **show log** with wall-clock time, timecode and source. Export it as CSV for show reports.

## Show Notes · Video (program feed)

A second version of the page lives at **`http://<computer>:3000/video`**. It's the same show, cues and timecode, plus a live **program feed**: video on the left, with timecode, CURRENT and NEXT stacked on the right, in both the Operate and Display views. The regular page at `/` is unchanged. Both versions stay in sync.

**Switching:** click the **SHOW NOTES** title (top left) to toggle between the two versions. The **VIDEO** slider under the title is grey when off and red when on. You stay in the same tab (Operate, Edit or Display).

Pick the feed under **Program feed** (Operate view). Each screen chooses its own source:

| Source | Use it for | Delay |
|---|---|---|
| **OBS virtual camera / capture card** | The computer with the DeckLink (Blackmagic WDM Capture), OBS Virtual Camera, or NDI Webcam. Only works when the page is opened at `http://localhost:3000/video` on that computer. | almost none |
| **OBS stream** | Every other screen: tablets, phones, backstage TVs. The address is shared, so a new screen opening `/video?view=display` plays it automatically. | ~0.3–1 s |

**OBS stream setup (built-in MediaMTX):** Show Notes includes [MediaMTX](https://github.com/bluenviron/mediamtx), the free server that relays OBS to every screen. The first time Show Notes starts, it downloads MediaMTX into the `mediamtx/` folder. After that it starts and stops MediaMTX with Show Notes, so there's nothing to open by hand.
1. Start Show Notes. When your computer asks, allow **mediamtx** through the firewall on **private** networks (Windows) or allow incoming connections (Mac).
2. In OBS, add your **Decklink Device** source. Then in Settings → Stream, choose **WHIP** with the server shown under *Program feed* (e.g. `http://192.168.1.20:8889/program/whip`, OBS 30+). Or choose **Custom** with server `rtmp://192.168.1.20:1935` and stream key `program`. Use the Show Notes computer's address. OBS can run on the same computer or on another one.
3. In Settings → Output: **H.264**, about 4–6 Mbps, **keyframe interval 1 s**, and **B-frames 0** (browsers can't play live WebRTC with B-frames).
4. Press **Start Streaming**. In Show Notes · Video, leave the stream address **blank** (or press **Use built-in**) and press Connect. The Program feed panel shows *Running · OBS is streaming* when it's working.

Show Notes tells MediaMTX this computer's network addresses automatically, so other screens get the picture without editing `mediamtx.yml`.

- **Firewall ports** on the Show Notes computer: TCP 8889 (WebRTC), UDP 8189 (video), TCP 1935 (RTMP from OBS), TCP 8888 (HLS).
- **Already running MediaMTX yourself?** Show Notes sees it and uses it instead of starting another. To use a MediaMTX on a different computer, type its address (e.g. `192.168.1.210:8889/program`) in the stream address.
- **No internet at the venue?** Copy `mediamtx.exe` (or `mediamtx` on Mac/Linux) and `mediamtx.yml` from the [releases page](https://github.com/bluenviron/mediamtx/releases) into the `mediamtx/` folder, and Show Notes will use them instead of downloading. Set `MEDIAMTX_PATH` to use a copy somewhere else, or `SHOWNOTES_MEDIAMTX=off` to turn the built-in one off.

The video starts muted on every screen. Tap **🔇 Sound off** on the program video to hear program audio on that screen (needs OBS streaming with **WHIP**; RTMP audio does not play in browsers). It mutes again each time the page loads.

## OSC

The server listens on UDP **53100** (`OSC_PORT`):

| Address | Args | Action |
| --- | --- | --- |
| `/shownotes/go` | | GO |
| `/shownotes/back` | | Back |
| `/shownotes/goto` | cue number | Fire that cue |
| `/shownotes/load` | cue number | Make it current without firing |
| `/shownotes/reset` | | Back to top |
| `/shownotes/stop` | | Stop Ableton: sends `/live/song/stop_playing` to the OSC output target |
| `/shownotes/tc` | `"HH:MM:SS:FF"` [fps] | Push timecode |

**OSC out:** set *OSC output target* (e.g. `127.0.0.1:53000` for QLab). Then give a cue an OSC message such as `/cue/12/start`, and it is sent whenever that cue fires.

### Driving Ableton arrangement markers

Show Notes can jump Ableton to a song's arrangement marker (locator) and press Play whenever that song's cue fires, from GO, a song button, or Companion. Ableton's LTC then keeps Show Notes in sync.

1. Install **[AbletonOSC](https://github.com/ideoforms/AbletonOSC)** (free) as described in its README: copy it into Ableton's *MIDI Remote Scripts* folder, then in Ableton → Settings → Link, Tempo & MIDI set a **Control Surface** slot to **AbletonOSC**. It listens on UDP **11000**.
2. In Show Notes → Edit → Show settings, set **OSC output target** to `127.0.0.1:11000`, and **turn off** *Also send cue OSC when timecode fires a cue*. Otherwise a song that Ableton is already playing would be told to jump again.
3. Give each song cue an **OSC on fire** message, one per line:
   ```
   /live/song/cue_point/jump 1
   /live/song/start_playing
   ```
   The number is the marker's position in the arrangement (0 = first marker). You can use its name instead: `/live/song/cue_point/jump "Mary Did You Know"`.

## HTTP API

* `GET /api/show`: the show JSON
* `GET /api/state`: runtime and log
* `POST /api/action`: dispatch any engine action, e.g. `{"type":"go"}` or `{"type":"goto","number":"12"}`

## Files

```
server.js                 HTTP + WebSocket + OSC server; owns the show state (data/show.json)
lib/osc.js                OSC encode/decode
lib/mediamtx.js           built-in MediaMTX: download, start/stop, "is OBS streaming?"
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

**Show templates:** any show JSON in `data/` (committed) or `data/private/` (git-ignored, for shows with real names) appears under Edit → Show settings → *Load*. On first run, the server starts with the first private show if there is one, otherwise the example show.

**Logo:** put a PNG at `data/private/logo.png` (git-ignored) or `data/logo.png` and it appears in the top-left corner next to the Show Notes title. Use a white or light logo with a transparent background so it suits the dark theme.

CSV import/export columns are `number,name,leads,dept,tc,time,auto,notes,osc`.

## Environment variables

| Var | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `OSC_PORT` | `53100` | UDP OSC input |
| `SHOW_FILE` | `data/show.json` | Where the show is saved |
| `SHOWNOTES_MEDIAMTX` | on | `off` stops Show Notes from starting its built-in MediaMTX |
| `MEDIAMTX_PATH` | `mediamtx/mediamtx[.exe]` | Use a MediaMTX binary from somewhere else |
| `HTTPS_KEY`, `HTTPS_CERT` | | Serve over HTTPS |
