// Browser timecode sources. Each source calls onTC(tc) and onStatus(status).
import { fromFrames, toFrames, addFrames, parseTC, nominal } from './timecode.js';
import { MTCParser } from './mtc.js';

export const SOURCE_TYPES = {
  none: 'Off',
  internal: 'Internal clock',
  ltc: 'LTC audio (Dante / soundcard)',
  mtc: 'MIDI Timecode (MTC)',
};

export function secureContextNote() {
  return window.isSecureContext
    ? ''
    : 'Audio and MIDI inputs need a secure page. Open Show Notes at http://localhost on the machine running Dante Virtual Soundcard, or serve it over HTTPS.';
}

// ---------------------------------------------------------------------------
export class InternalClock {
  constructor({ fps, drop, onTC, onStatus }) {
    Object.assign(this, { fps, drop, onTC, onStatus });
    this.startFrame = 0;
    this.startedAt = null;
    this.timer = null;
  }
  frameNow() {
    if (this.startedAt == null) return this.startFrame;
    return this.startFrame + Math.floor(((performance.now() - this.startedAt) / 1000) * this.fps);
  }
  emit() {
    this.onTC({ ...fromFrames(this.frameNow(), this.fps, this.drop), source: 'internal' });
  }
  start() {
    if (this.startedAt != null) return;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this.emit(), 1000 / nominal(this.fps));
    this.onStatus({ state: 'running', text: 'Internal clock running' });
  }
  stop() {
    if (this.startedAt == null) return;
    this.startFrame = this.frameNow();
    this.startedAt = null;
    clearInterval(this.timer);
    this.emit();
    this.onStatus({ state: 'stopped', text: 'Internal clock stopped' });
  }
  locate(tcString) {
    const tc = parseTC(tcString);
    if (!tc) return false;
    const running = this.startedAt != null;
    this.startFrame = toFrames(tc, this.fps, this.drop);
    if (running) this.startedAt = performance.now();
    this.emit();
    return true;
  }
  get running() {
    return this.startedAt != null;
  }
  destroy() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------------------
export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export async function listAudioOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audiooutput');
}

/** Decode LTC from an audio input channel (Dante Virtual Soundcard, Dante Via, or any interface). */
export class LTCSource {
  constructor({ deviceId, channel = 0, fps, onTC, onStatus, onLevel }) {
    Object.assign(this, { deviceId, channel, fps, onTC, onStatus, onLevel });
    this.maxFrame = 0;
    this.lastFrameAt = 0;
    this.watchdog = null;
  }

  async start() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('js/ltc-worklet.js');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        channelCount: { ideal: 64 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const src = this.ctx.createMediaStreamSource(this.stream);
    const channels = src.channelCount || 2;
    this.node = new AudioWorkletNode(this.ctx, 'ltc-reader', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { channel: this.channel },
    });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    src.connect(this.node);
    this.onStatus({ state: 'waiting', text: `Listening on channel ${this.channel + 1} — no LTC yet` });
    this.watchdog = setInterval(() => {
      if (this.lastFrameAt && performance.now() - this.lastFrameAt > 500) {
        this.onStatus({ state: 'stopped', text: 'LTC stopped (no signal)' });
        this.lastFrameAt = 0;
      }
    }, 250);
  }

  onMessage(msg) {
    if (msg.type === 'level') {
      this.onLevel?.(msg.peak, msg.channels);
      return;
    }
    if (msg.type !== 'frame') return;
    const fr = msg.frame;
    // Detect frame rate from the highest frame number seen.
    if (fr.f > this.maxFrame) this.maxFrame = fr.f;
    let fps = this.fps;
    if (this.maxFrame >= 29) fps = fr.drop ? 29.97 : 30;
    else if (this.maxFrame === 24) fps = 25;
    else if (this.maxFrame === 23 && this.fps > 25) fps = 24;
    // The frame is reported once its last bit arrives, so we are now one frame later.
    const tc = fr.reverse ? fr : addFrames(fr, 1, fps, fr.drop);
    if (!this.lastFrameAt) this.onStatus({ state: 'running', text: `LTC locked · ${fps}${fr.drop ? ' DF' : ''} fps` });
    this.lastFrameAt = performance.now();
    this.onTC({ h: tc.h, m: tc.m, s: tc.s, f: tc.f, fps, drop: fr.drop, source: 'ltc' });
  }

  setChannel(ch) {
    this.channel = ch;
    this.node?.port.postMessage({ type: 'channel', channel: ch });
  }

  destroy() {
    clearInterval(this.watchdog);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }
}

// ---------------------------------------------------------------------------
export async function getMIDIAccess() {
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not supported in this browser (use Chrome or Edge).');
  return navigator.requestMIDIAccess({ sysex: true });
}

export class MTCSource {
  constructor({ access, inputId, onTC, onStatus }) {
    Object.assign(this, { access, inputId, onTC, onStatus });
    this.lastAt = 0;
    this.parser = new MTCParser((tc) => {
      if (!this.lastAt) this.onStatus({ state: 'running', text: `MTC locked · ${tc.fps}${tc.drop ? ' DF' : ''} fps` });
      this.lastAt = performance.now();
      this.onTC({ ...tc, source: 'mtc' });
    });
  }
  start() {
    this.handler = (e) => this.parser.message(e.data);
    for (const input of this.access.inputs.values()) {
      if (!this.inputId || input.id === this.inputId) input.addEventListener('midimessage', this.handler);
    }
    this.onStatus({ state: 'waiting', text: 'Waiting for MTC…' });
    this.watchdog = setInterval(() => {
      if (this.lastAt && performance.now() - this.lastAt > 500) {
        this.onStatus({ state: 'stopped', text: 'MTC stopped' });
        this.lastAt = 0;
      }
    }, 250);
  }
  destroy() {
    clearInterval(this.watchdog);
    for (const input of this.access.inputs.values()) input.removeEventListener('midimessage', this.handler);
  }
}

// ---------------------------------------------------------------------------
/** Generate LTC to an audio output (e.g. Dante Virtual Soundcard) for testing or as a master clock. */
export class LTCGenerator {
  constructor({ fps, drop, startTC = '01:00:00:00', sinkId = '' }) {
    Object.assign(this, { fps, drop, startTC, sinkId });
  }
  async start() {
    this.ctx = new AudioContext();
    if (this.sinkId && this.ctx.setSinkId) await this.ctx.setSinkId(this.sinkId).catch(() => {});
    await this.ctx.audioWorklet.addModule('js/ltc-worklet.js');
    const start = parseTC(this.startTC) || { h: 1, m: 0, s: 0, f: 0 };
    this.node = new AudioWorkletNode(this.ctx, 'ltc-writer', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { fps: this.fps, drop: this.drop, startFrame: toFrames(start, this.fps, this.drop) },
    });
    this.node.connect(this.ctx.destination);
  }
  destroy() {
    this.ctx?.close();
  }
}
