// Test stand-in for the audio library (only used when SHOWNOTES_FAKE_AUDIO is set).
// Pretends to be an 8-channel "Dante Virtual Soundcard" carrying 30 fps LTC on channel 3 only.
const LTC_CHANNEL = 2; // 0-based: channel 3
let encoderMod = null;
import('../public/js/ltc-decoder.js').then((m) => { encoderMod = m; });

class RtAudio {
  getDevices() {
    return [
      { id: 7, name: 'Built-in Microphone', inputChannels: 1, outputChannels: 0, isDefaultInput: 0, preferredSampleRate: 48000, sampleRates: [44100, 48000] },
      { id: 42, name: 'Dante Virtual Soundcard', inputChannels: 8, outputChannels: 8, isDefaultInput: 1, preferredSampleRate: 48000, sampleRates: [44100, 48000, 96000] },
    ];
  }
  openStream(out, input, format, sampleRate, frameSize, name, cb) {
    this.input = input; this.sampleRate = sampleRate; this.frameSize = frameSize; this.cb = cb; this.open = true;
  }
  start() {
    if (!encoderMod) { setTimeout(() => this.start(), 50); return; } // test module still loading
    const sr = this.sampleRate;
    const enc = new encoderMod.LTCEncoder(sr, 30, 0.4);
    let frame = 30 * 3600 * 3; // 03:00:00:00
    let pending = new Float32Array(0);
    const first = this.input.firstChannel || 0, n = this.input.nChannels || 1;
    const ltcSlot = LTC_CHANNEL - first; // where channel 3 lands in the opened block, if at all
    this.timer = setInterval(() => {
      // ~10 ms of audio per tick, delivered in frameSize blocks like a real driver
      const need = Math.round(sr / 100);
      while (pending.length < need) {
        const f = enc.frame({ h: Math.floor(frame / 108000) % 24, m: Math.floor(frame / 1800) % 60, s: Math.floor(frame / 30) % 60, f: frame % 30 });
        frame++;
        const merged = new Float32Array(pending.length + f.length); merged.set(pending); merged.set(f, pending.length); pending = merged;
      }
      const chunk = pending.subarray(0, need); pending = pending.slice(need);
      for (let i = 0; i < chunk.length; i += this.frameSize) {
        const frames = Math.min(this.frameSize, chunk.length - i);
        const block = new Float32Array(frames * n); // interleaved; every other channel silent
        if (ltcSlot >= 0 && ltcSlot < n) for (let k = 0; k < frames; k++) block[k * n + ltcSlot] = chunk[i + k];
        this.cb(Buffer.from(block.buffer));
      }
    }, 10);
  }
  stop() { clearInterval(this.timer); }
  isStreamOpen() { return !!this.open; }
  closeStream() { this.open = false; }
}

module.exports = { RtAudio, RtAudioFormat: { RTAUDIO_FLOAT32: 0x10 } };
