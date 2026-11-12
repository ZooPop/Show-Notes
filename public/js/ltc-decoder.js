// SMPTE Linear Timecode (LTC) decoder + encoder. Pure JS, no DOM.
// Runs inside an AudioWorklet in the browser and in Node for tests.
//
// LTC is biphase-mark encoded: the level flips at every bit boundary, and a "1"
// bit has an extra flip in the middle. Each frame is 80 bits ending in the sync
// word 0011 1111 1111 1101. When Dante Virtual Soundcard / Dante Via is installed,
// a Dante channel carrying LTC is just an audio input to the browser.

export const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
const SYNC_REVERSE = [...SYNC_WORD].reverse();

export class LTCDecoder {
  /**
   * @param {number} sampleRate
   * @param {(frame: {h:number,m:number,s:number,f:number,drop:boolean,reverse:boolean}) => void} onFrame
   */
  constructor(sampleRate, onFrame) {
    this.sampleRate = sampleRate;
    this.onFrame = onFrame;
    this.bits = new Uint8Array(80);
    this.bitsSinceSync = 0;
    this.minBit = sampleRate / (30 * 80) / 1.3; // fastest plausible bit (30fps, +30% varispeed)
    this.maxBit = (sampleRate / (24 * 80)) * 1.3; // slowest plausible bit (24fps, -30%)
    this.bitPeriod = sampleRate / (25 * 80);
    this.envelope = 0;
    this.sign = 0;
    this.sinceEdge = 0;
    this.halfPending = false;
    this.pendingHalf = 0;
    this.framesDecoded = 0;
  }

  /** Feed a block of samples (Float32Array). */
  process(samples) {
    const decay = 0.9995;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const ax = x < 0 ? -x : x;
      this.envelope = ax > this.envelope ? ax : this.envelope * decay;
      const thresh = Math.max(0.003, this.envelope * 0.15); // hysteresis rejects noise
      this.sinceEdge++;
      let sign = this.sign;
      if (x > thresh) sign = 1;
      else if (x < -thresh) sign = -1;
      if (sign !== this.sign) {
        if (this.sign !== 0) this._edge(this.sinceEdge);
        this.sign = sign;
        this.sinceEdge = 0;
      }
    }
  }

  _edge(interval) {
    if (interval < this.minBit * 0.35 || interval > this.maxBit * 1.5) {
      // Noise or silence gap: lose sync.
      this.halfPending = false;
      return;
    }
    if (interval > this.bitPeriod * 0.75) {
      // Full-length cell -> 0. A dangling half here means we were misaligned; drop it.
      this.halfPending = false;
      this._adapt(interval);
      this._push(0);
    } else if (this.halfPending) {
      this.halfPending = false;
      this._adapt(interval + this.pendingHalf);
      this._push(1);
    } else {
      this.halfPending = true;
      this.pendingHalf = interval;
    }
  }

  _adapt(period) {
    const p = this.bitPeriod * 0.9 + period * 0.1;
    this.bitPeriod = Math.min(this.maxBit, Math.max(this.minBit, p));
  }

  _push(bit) {
    const b = this.bits;
    b.copyWithin(0, 1);
    b[79] = bit;
    this.bitsSinceSync++;
    if (this.bitsSinceSync < 80) return;
    if (matches(b, 64, SYNC_WORD)) {
      this._decode(b, false);
    } else if (matches(b, 0, SYNC_REVERSE)) {
      // Playing backwards: bit order is mirrored.
      this._decode(Uint8Array.from(b).reverse(), true);
    }
  }

  _decode(bits, reverse) {
    const frame = decodeFrameBits(bits);
    if (!frame) return;
    this.bitsSinceSync = 0;
    this.framesDecoded++;
    frame.reverse = reverse;
    this.onFrame(frame);
  }
}

function matches(bits, offset, word) {
  for (let i = 0; i < 16; i++) if (bits[offset + i] !== word[i]) return false;
  return true;
}

function field(bits, start, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v |= bits[start + i] << i;
  return v;
}

/** Decode the 80-bit LTC frame (bit 0 first). Returns null if the BCD fields are invalid. */
export function decodeFrameBits(bits) {
  const fu = field(bits, 0, 4), ft = field(bits, 8, 2);
  const su = field(bits, 16, 4), st = field(bits, 24, 3);
  const mu = field(bits, 32, 4), mt = field(bits, 40, 3);
  const hu = field(bits, 48, 4), ht = field(bits, 56, 2);
  if (fu > 9 || su > 9 || mu > 9 || hu > 9) return null;
  const tc = { h: ht * 10 + hu, m: mt * 10 + mu, s: st * 10 + su, f: ft * 10 + fu, drop: bits[10] === 1 };
  if (tc.h > 23 || tc.m > 59 || tc.s > 59 || tc.f > 29) return null;
  return tc;
}

function setField(bits, start, len, value) {
  for (let i = 0; i < len; i++) bits[start + i] = (value >> i) & 1;
}

/** Build the 80-bit frame for a timecode. */
export function encodeFrameBits({ h, m, s, f, drop = false }) {
  const bits = new Uint8Array(80);
  setField(bits, 0, 4, f % 10);
  setField(bits, 8, 2, Math.floor(f / 10));
  bits[10] = drop ? 1 : 0;
  setField(bits, 16, 4, s % 10);
  setField(bits, 24, 3, Math.floor(s / 10));
  setField(bits, 32, 4, m % 10);
  setField(bits, 40, 3, Math.floor(m / 10));
  setField(bits, 48, 4, h % 10);
  setField(bits, 56, 2, Math.floor(h / 10));
  SYNC_WORD.forEach((v, i) => (bits[64 + i] = v));
  // Polarity-correction bit (27) keeps the number of zeros even, so every frame starts on the same edge.
  const zeros = bits.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
  if (zeros % 2 === 1) bits[27] = 1;
  return bits;
}

/**
 * Stateful biphase-mark LTC writer. Call write(tc, out, offset) per frame;
 * it keeps level and fractional sample position across frames.
 */
export class LTCEncoder {
  constructor(sampleRate, fps, amplitude = 0.5) {
    this.sampleRate = sampleRate;
    this.fps = fps;
    this.amplitude = amplitude;
    this.level = 1;
    this.pos = 0; // fractional sample clock
    this.written = 0; // integer samples emitted
  }

  samplesPerFrame() {
    return this.sampleRate / this.fps;
  }

  /** Render one frame; returns a Float32Array of that frame's samples. */
  frame(tc) {
    const bits = encodeFrameBits(tc);
    const bitLen = this.sampleRate / (this.fps * 80);
    const end = Math.round(this.pos + bitLen * 80);
    const out = new Float32Array(end - this.written);
    let idx = 0;
    const emitUntil = (t) => {
      const stop = Math.round(t);
      while (this.written < stop) {
        out[idx++] = this.level * this.amplitude;
        this.written++;
      }
    };
    for (let i = 0; i < 80; i++) {
      this.level = -this.level; // transition at every bit boundary
      if (bits[i]) {
        emitUntil(this.pos + bitLen / 2);
        this.level = -this.level; // extra mid-bit transition for "1"
      }
      this.pos += bitLen;
      emitUntil(this.pos);
    }
    return out.subarray(0, idx);
  }
}
