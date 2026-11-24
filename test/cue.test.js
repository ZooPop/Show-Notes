import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createState, createShow, createCue, nextCue, currentCue } from '../public/js/engine.js';

function show() {
  return createState(createShow({ cues: [
    createCue({ number: '1', name: 'Song 1', tc: '22:00:00:00' }),
    createCue({ number: '2', name: 'Song 2', tc: '22:10:00:00' }),
    createCue({ number: '2.5', name: 'Talk' }),
    createCue({ number: '3', name: 'Song 3', tc: '22:20:00:00' }),
  ] }));
}

test('cue up a song: it becomes NEXT, nothing fires, GO plays it', () => {
  let s = show();
  let r = apply(s, { type: 'cue', number: '3' });
  assert.equal(r.events[0].type, 'armed');
  assert.ok(!r.events.some((e) => e.type === 'fired'));
  s = r.state;
  assert.equal(currentCue(s), null);
  assert.equal(nextCue(s).number, '3');
  r = apply(s, { type: 'go' });
  assert.equal(r.events[0].type, 'fired');
  assert.equal(r.events[0].cue.number, '3');
  assert.equal(currentCue(r.state).number, '3');
  assert.equal(r.state.runtime.armedCueId, null);
});

test('cueing a song out of order and back', () => {
  let s = apply(show(), { type: 'go' }).state; // song 1 playing
  s = apply(s, { type: 'cue', number: '2.5' }).state;
  assert.equal(nextCue(s).number, '2.5');
  s = apply(s, { type: 'reset' }).state; // anything that moves the show clears the cued song
  assert.equal(nextCue(s).number, '1');
});

test('unknown cue number does nothing', () => {
  const s = show();
  const r = apply(s, { type: 'cue', number: '99' });
  assert.equal(r.state, s);
  assert.equal(r.events.length, 0);
});

test('timecode chase picks the closest earlier cue time, even when cue times are out of list order', () => {
  let s = createState(createShow({ cues: [
    createCue({ number: '1', name: 'Nutcracker', tc: '22:00:00:00' }),
    createCue({ number: '2', name: 'Hark', tc: '22:10:00:00' }),
    createCue({ number: '7.5', name: 'Podcast Video 2', tc: '19:00:00:00' }),
    createCue({ number: '8', name: 'Mary', tc: '19:10:00:00' }),
  ] }));
  s = apply(s, { type: 'timecode', tc: { h: 22, m: 0, s: 0, f: 0, fps: 30, source: 'ltc' } }).state;
  assert.equal(currentCue(s).number, '1');
  s = apply(s, { type: 'timecode', tc: { h: 19, m: 10, s: 5, f: 0, fps: 30, source: 'ltc' } }).state;
  assert.equal(currentCue(s).number, '8');
  s = apply(s, { type: 'timecode', tc: { h: 22, m: 10, s: 1, f: 0, fps: 30, source: 'ltc' } }).state;
  assert.equal(currentCue(s).number, '2');
});
