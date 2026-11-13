import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLength, formatClock } from '../public/js/timecode.js';
import { apply, createState, createShow, timeLeft } from '../public/js/engine.js';

test('parseLength / formatClock', () => {
  assert.equal(parseLength('4:30'), 270);
  assert.equal(parseLength('4'), 240);
  assert.equal(parseLength(''), null);
  assert.ok(Number.isNaN(parseLength('abc')));
  assert.equal(parseLength('25:00'), 600); // capped at 10 minutes
  assert.equal(formatClock(270), '4:30');
  assert.equal(formatClock(59.2), '1:00'); // rounds up so 0:00 means done
  assert.equal(formatClock(-5), '0:00');
});

function show() {
  let s = createState(createShow({ rate: '30' }));
  s = apply(s, { type: 'cue:add', cue: { number: '1', name: 'Song', tc: '02:00:00:00', time: '4:00' } }).state;
  s = apply(s, { type: 'cue:add', cue: { number: '1.5', name: 'Talk', time: '2:00' } }).state;
  s = apply(s, { type: 'cue:add', cue: { number: '2', name: 'No length' } }).state;
  return s;
}
const tc = (m, sec) => ({ type: 'timecode', tc: { h: 2, m, s: sec, f: 0, fps: 30, source: 'ltc' }, at: 1000 });

test('timed cue counts down from timecode and pauses with it', () => {
  let s = show();
  s = apply(s, tc(0, 0)).state; // chase onto cue 1 at 02:00:00
  assert.equal(timeLeft(s, 1000), 240);
  s = apply(s, tc(0, 1)).state;
  s = apply(s, tc(1, 30)).state; // 90s in (a locate, still cue 1)
  assert.equal(timeLeft(s, 999999), 150); // wall clock does not matter: TC paused here
});

test('manual cue counts down from when it became current; no length = null', () => {
  let s = show();
  s = apply(s, { type: 'goto', number: '1.5', at: 10_000 }).state;
  assert.equal(timeLeft(s, 10_000), 120);
  assert.equal(timeLeft(s, 40_000), 90);
  assert.equal(timeLeft(s, 500_000), 0);
  s = apply(s, { type: 'go', at: 50_000 }).state;
  assert.equal(timeLeft(s, 60_000), null);
});
