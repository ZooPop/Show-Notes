// Server-side LTC input: the Show Notes server opens the audio device itself (via RtAudio /
// Audify) and decodes LTC from exactly the channel you choose, e.g. channel 3 of Dante Virtual
// Soundcard. Browsers often only expose the first 2 channels of a device; this does not.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LTCDecoder } from '../public/js/ltc-decoder.js';
import { addFrames } from '../public/js/timecode.js';

const require = createRequire(import.meta.url);

function loadAudify() {
  if (process.env.SHOWNOTES_FAKE_AUDIO) return { lib: require('./fake-audio.cjs'), error: null };
  try {
    return { lib: require('audify'), error: null };
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && /audify/.test(e.message)) {
      return { lib: null, error: 'Audio library not installed. Run "npm install" in the show-notes folder (the start scripts do this for you).' };
    }
    // Installed but couldn't load, usually a missing system audio library on Linux.
    const hint = process.platform === 'linux' ? ' On Omarchy / Arch: sudo pacman -S alsa-lib libpulse pipewire-pulse, then restart Show Notes.' : '';
    return { lib: null, error: `Audio library failed to load: ${e.message.split('\n')[0]}.${hint}` };
  }
}

export class ServerLTCInput {
  constructor({ settingsFile, onTC, onStatus, onLevel }) {
    Object.assign(this, { settingsFile, onTC, onStatus, onLevel });
    const { lib, error } = loadAudify();
    this.audify = lib;
    this.loadError = error;
    this.rt = null;
    this.status = { state: 'off', text: 'Not listening.' };
    this.settings = this.readSettings();
  }

  get available() {
    return !!this.audify;
  }

  readSettings() {
    try {
      return { enabled: false, deviceName: '', channel: 2, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      return { enabled: false, deviceName: '', channel: 2 };
    }
  }

  saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch { /* not fatal */ }
  }

  setStatus(state, text) {
    this.status = { state, text };
    this.onStatus?.(this.status);
  }

  listDevices() {
    if (!this.audify) return [];
    try {
      const rt = new this.audify.RtAudio();
      return rt.getDevices()
        .filter((d) => d.inputChannels > 0)
        .map((d) => ({ id: d.id, name: d.name, inputChannels: d.inputChannels, isDefaultInput: !!d.isDefaultInput, preferredSampleRate: d.preferredSampleRate, sampleRates: d.sampleRates }));
    } catch (e) {
      return [];
    }
  }

  /** Start listening. `device` may be a device id or name; `channel` is 0-based (2 = channel 3). */
  start({ deviceName, deviceId, channel }) {
    this.stop(true);
    if (!this.audify) return this.setStatus('error', this.loadError);
    const devices = this.listDevices();
    const dev = devices.find((d) => d.id === deviceId) || devices.find((d) => d.name === deviceName) || devices.find((d) => d.isDefaultInput) || devices[0];
    if (!dev) return this.setStatus('error', 'No audio input devices found on the Show Notes computer.');
    channel = Math.max(0, channel | 0);
    if (channel >= dev.inputChannels) {
      return this.setStatus('error', `${dev.name} has ${dev.inputChannels} input channel(s), so channel ${channel + 1} doesn't exist. Raise its channel count (e.g. in Dante Virtual Soundcard settings) or pick a lower channel.`);
    }
    const rates = dev.sampleRates || [];
    const sampleRate = rates.includes(48000) ? 48000 : dev.preferredSampleRate || rates[rates.length - 1] || 48000;

    this.maxFrame = 0;
    this.lastFrameAt = 0;
    this.decoder = new LTCDecoder(sampleRate, (frame) => this.onFrame(frame));
    let peak = 0, counted = 0;
    try {
      const { RtAudio, RtAudioFormat } = this.audify;
      this.rt = new RtAudio();
      this.rt.openStream(
        null,
        // Open channels 1..N and pick ours. (Asking for "1 channel starting at N" isn't supported by
        // every audio system, e.g. PipeWire/PulseAudio on Linux; this works on all of them.)
        { deviceId: dev.id, nChannels: channel + 1, firstChannel: 0 },
        RtAudioFormat.RTAUDIO_FLOAT32,
        sampleRate,
        256,
        'Show Notes LTC',
        (buf) => {
          const samples = pickChannel(toFloat32(buf), channel + 1, channel); // interleaved -> just our channel
          this.decoder.process(samples);
          for (let i = 0; i < samples.length; i++) { const a = samples[i] < 0 ? -samples[i] : samples[i]; if (a > peak) peak = a; }
          counted += samples.length;
          if (counted >= sampleRate / 10) { this.onLevel?.(peak); peak = 0; counted = 0; }
        },
        null,
        0,
        (type, msg) => this.setStatus('error', `Audio error: ${msg}`),
      );
      this.rt.start();
    } catch (e) {
      this.rt = null;
      return this.setStatus('error', `Could not open ${dev.name}: ${e.message}`);
    }
    this.current = { name: dev.name, channel, channels: dev.inputChannels, sampleRate };
    this.settings = { enabled: true, deviceName: dev.name, channel };
    this.saveSettings();
    this.setStatus('waiting', `Listening for LTC on ${dev.name}, channel ${channel + 1} of ${dev.inputChannels}…`);
    this.watchdog = setInterval(() => {
      if (this.lastFrameAt && Date.now() - this.lastFrameAt > 500) {
        this.lastFrameAt = 0;
        this.setStatus('stopped', `LTC stopped on ${dev.name}, channel ${channel + 1} (no signal)`);
      }
    }, 250);
  }

  onFrame(fr) {
    if (fr.f > this.maxFrame) this.maxFrame = fr.f;
    let fps = 30;
    if (this.maxFrame >= 29) fps = fr.drop ? 29.97 : 30;
    else if (this.maxFrame === 24) fps = 25;
    else if (this.maxFrame === 23) fps = 24;
    const tc = fr.reverse ? fr : addFrames(fr, 1, fps, fr.drop); // reported once the frame's last bit arrives
    if (!this.lastFrameAt) {
      const c = this.current;
      this.setStatus('running', `Following LTC on ${c.name}, channel ${c.channel + 1} · ${fps}${fr.drop ? ' DF' : ''} fps`);
    }
    this.lastFrameAt = Date.now();
    this.onTC?.({ h: tc.h, m: tc.m, s: tc.s, f: tc.f, fps, drop: fr.drop, source: 'ltc' });
  }

  stop(silent = false) {
    clearInterval(this.watchdog);
    if (this.rt) {
      try { this.rt.stop(); } catch {}
      try { if (this.rt.isStreamOpen()) this.rt.closeStream(); } catch {}
      this.rt = null;
    }
    if (!silent) {
      this.settings.enabled = false;
      this.saveSettings();
      this.setStatus('off', 'Not listening.');
    }
  }

  /** Resume listening after a restart if it was on. */
  autoStart() {
    if (this.settings.enabled && this.available) this.start({ deviceName: this.settings.deviceName, channel: this.settings.channel });
  }
}

function toFloat32(buf) {
  if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/** Pull one channel out of interleaved audio (frame-by-frame: ch0, ch1, ... chN-1, ch0, ...). */
function pickChannel(interleaved, channels, channel) {
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let i = 0, j = channel; i < frames; i++, j += channels) out[i] = interleaved[j];
  return out;
}
