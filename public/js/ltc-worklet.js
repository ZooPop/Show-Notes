// AudioWorklet that decodes LTC from one channel of an audio input
// (e.g. a Dante Virtual Soundcard / Dante Via channel) or generates test LTC.
import { LTCDecoder, LTCEncoder } from './ltc-decoder.js';

class LTCReader extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channel = options.processorOptions?.channel ?? 0;
    this.decoder = new LTCDecoder(sampleRate, (frame) => {
      this.port.postMessage({ type: 'frame', frame, time: currentTime });
    });
    this.peak = 0;
    this.counter = 0;
    this.channels = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'channel') this.channel = e.data.channel;
    };
  }

  process(inputs) {
    const input = inputs[0];
    this.channels = input ? input.length : 0;
    if (input && input.length) {
      const data = input[Math.min(this.channel, input.length - 1)];
      if (data) {
        this.decoder.process(data);
        for (let i = 0; i < data.length; i++) {
          const a = Math.abs(data[i]);
          if (a > this.peak) this.peak = a;
        }
      }
    }
    this.counter += 128;
    if (this.counter >= sampleRate / 15) {
      this.port.postMessage({ type: 'level', peak: this.peak, channels: this.channels, bitPeriod: this.decoder.bitPeriod });
      this.peak = 0;
      this.counter = 0;
    }
    return true;
  }
}

// LTC generator: useful for testing, or to feed LTC out to a Dante channel via the
// browser's audio output (select Dante Virtual Soundcard as the output device).
class LTCWriter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.fps = o.fps || 30;
    this.drop = !!o.drop;
    this.encoder = new LTCEncoder(sampleRate, this.fps, o.amplitude ?? 0.4);
    this.frame = o.startFrame || 0; // frame counter (non-drop label math done on main thread)
    this.labels = null;
    this.buffer = new Float32Array(0);
    this.read = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'locate') { this.frame = d.frame; this.buffer = new Float32Array(0); this.read = 0; }
      if (d.type === 'run') this.running = d.running;
    };
  }

  label(n) {
    const fpsN = Math.round(this.fps);
    let frames = n;
    if (this.drop) {
      const per10 = fpsN * 600 - 18, perMin = fpsN * 60 - 2;
      const tens = Math.floor(frames / per10), rem = frames % per10;
      frames += 18 * tens + (rem > 2 ? 2 * Math.floor((rem - 2) / perMin) : 0);
    }
    return {
      h: Math.floor(frames / (fpsN * 3600)) % 24,
      m: Math.floor(frames / (fpsN * 60)) % 60,
      s: Math.floor(frames / fpsN) % 60,
      f: frames % fpsN,
      drop: this.drop,
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    if (!ch0) return true;
    for (let i = 0; i < ch0.length; i++) {
      if (!this.running) { ch0[i] = 0; continue; }
      if (this.read >= this.buffer.length) {
        this.buffer = this.encoder.frame(this.label(this.frame++));
        this.read = 0;
      }
      ch0[i] = this.buffer[this.read++];
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('ltc-reader', LTCReader);
registerProcessor('ltc-writer', LTCWriter);
