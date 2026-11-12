import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTC, formatTC, toFrames, fromFrames, addFrames } from '../public/js/timecode.js';
import { MTCParser } from '../public/js/mtc.js';

test('parse and format', () => {
  assert.deepEqual(parseTC('01:02:03:04'), { h: 1, m: 2, s: 3, f: 4, drop: false });
  assert.equal(parseTC('01:02:03;04').drop, true);
  assert.deepEqual(parseTC('1:00:00'), { h: 1, m: 0, s: 0, f: 0, drop: false });
  assert.equal(parseTC('nope'), null);
  assert.equal(parseTC('25:00:00:00'), null);
  assert.equal(formatTC({ h: 1, m: 2, s: 3, f: 4 }, true), '01:02:03;04');
});

test('drop-frame skips frames 0 and 1 except every tenth minute', () => {
  const before = { h: 0, m: 0, s: 59, f: 29 };
  assert.equal(formatTC(addFrames(before, 1, 29.97, true), true), '00:01:00;02');
  assert.equal(formatTC(addFrames({ h: 0, m: 9, s: 59, f: 29 }, 1, 29.97, true), true), '00:10:00;00');
  assert.equal(toFrames({ h: 1, m: 0, s: 0, f: 0 }, 29.97, true), 107892);
  for (const n of [0, 1799, 1800, 17981, 17982, 107891, 500000]) {
    assert.equal(toFrames(fromFrames(n, 29.97, true), 29.97, true), n);
  }
});

test('MTC quarter frames and full frame', () => {
  const out = [];
  const p = new MTCParser((tc) => out.push(tc));
  // 01:02:03:04 at 25fps (rate code 1)
  const tc = { h: 1, m: 2, s: 3, f: 4 }, rate = 1;
  const vals = [tc.f & 15, tc.f >> 4, tc.s & 15, tc.s >> 4, tc.m & 15, tc.m >> 4, tc.h & 15, (tc.h >> 4) | (rate << 1)];
  vals.forEach((v, i) => p.message([0xf1, (i << 4) | v]));
  assert.equal(out.length, 1);
  assert.equal(formatTC(out[0]), '01:02:03:06'); // +2 frames
  assert.equal(out[0].fps, 25);
  p.message([0xf0, 0x7f, 0x7f, 0x01, 0x01, (3 << 5) | 10, 20, 30, 15, 0xf7]);
  assert.equal(formatTC(out[1]), '10:20:30:15');
  assert.equal(out[1].fps, 30);
});
