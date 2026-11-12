import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LTCDecoder, LTCEncoder, encodeFrameBits, decodeFrameBits } from '../public/js/ltc-decoder.js';
import { fromFrames, toFrames, formatTC } from '../public/js/timecode.js';

test('frame bits round-trip', () => {
  const tc = { h: 23, m: 59, s: 58, f: 29, drop: true };
  assert.deepEqual(decodeFrameBits(encodeFrameBits(tc)), tc);
});

function signal({ sampleRate, fps, drop = false, start, count, noise = 0, gain = 1, invert = false }) {
  const enc = new LTCEncoder(sampleRate, fps, 0.5 * gain);
  const chunks = [];
  const startFrame = toFrames(start, fps, drop);
  // One extra frame so the last real frame gets its closing edge.
  for (let i = 0; i <= count; i++) chunks.push(enc.frame({ ...fromFrames(startFrame + i, fps, drop), drop }));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  // Simple one-pole low-pass to round the edges like a real cable/converter would.
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y += 0.5 * (out[i] - y);
    out[i] = (invert ? -y : y) + noise * rnd();
  }
  return out;
}

function decodeAll(samples, sampleRate, block = 128) {
  const frames = [];
  const dec = new LTCDecoder(sampleRate, (f) => frames.push(f));
  for (let i = 0; i < samples.length; i += block) dec.process(samples.subarray(i, i + block));
  return frames;
}

for (const [fps, drop, sr] of [[24, false, 48000], [25, false, 48000], [29.97, true, 48000], [30, false, 44100], [30, false, 96000]]) {
  test(`decodes ${fps}${drop ? 'df' : ''} LTC at ${sr} Hz with noise`, () => {
    const start = { h: 1, m: 9, s: 59, f: 20 };
    const samples = signal({ sampleRate: sr, fps, drop, start, count: 60, noise: 0.05 });
    const frames = decodeAll(samples, sr);
    assert.ok(frames.length >= 57, `decoded ${frames.length} of 60 frames`);
    // Consecutive frames must be consecutive timecode.
    for (let i = 1; i < frames.length; i++) {
      assert.equal(toFrames(frames[i], fps, drop) - toFrames(frames[i - 1], fps, drop), 1, `${formatTC(frames[i - 1])} -> ${formatTC(frames[i])}`);
    }
    const last = frames.at(-1);
    assert.equal(formatTC(last, drop), formatTC(fromFrames(toFrames(start, fps, drop) + 59, fps, drop), drop));
    assert.equal(last.drop, drop);
  });
}

test('decodes quiet, inverted-polarity LTC', () => {
  const samples = signal({ sampleRate: 48000, fps: 25, start: { h: 10, m: 0, s: 0, f: 0 }, count: 30, gain: 0.05, invert: true });
  const frames = decodeAll(samples, 48000);
  assert.ok(frames.length >= 27);
  assert.equal(formatTC(frames.at(-1)), '10:00:01:04');
});

test('decodes reversed LTC', () => {
  const fwd = signal({ sampleRate: 48000, fps: 25, start: { h: 0, m: 0, s: 10, f: 0 }, count: 20 });
  const frames = decodeAll(Float32Array.from(fwd).reverse(), 48000);
  assert.ok(frames.length >= 17, `got ${frames.length}`);
  assert.ok(frames.every((f) => f.reverse));
  assert.equal(formatTC(frames.at(-1)), '00:00:10:01'); // 10:00 is played last, with no closing edge
});

test('ignores silence and noise', () => {
  let seed = 7;
  const noise = Float32Array.from({ length: 48000 }, () => (((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5) * 0.01);
  assert.equal(decodeAll(noise, 48000).length, 0);
});
