import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, createState, createShow, currentCue, nextCue, countdown } from '../public/js/engine.js';

function setup() {
  let state = createState(createShow({ rate: '25' }));
  const add = (cue) => (state = apply(state, { type: 'cue:add', cue }).state);
  add({ number: '1', name: 'Preset', tc: '' });
  add({ number: '2', name: 'Lights up', tc: '01:00:10:00' });
  add({ number: '3', name: 'Sound in', tc: '01:00:20:00' });
  add({ number: '3.5', name: 'Manual follow', tc: '' });
  add({ number: '4', name: 'Blackout', tc: '01:00:30:00', auto: false });
  add({ number: '5', name: 'Bows', tc: '01:00:40:00' });
  return state;
}

const tc = (s, f = 0) => ({ type: 'timecode', tc: { h: 1, m: 0, s, f, fps: 25, source: 'test' } });

function run(state, actions) {
  const events = [];
  for (const a of actions) {
    const r = apply(state, a);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

test('manual GO / BACK walk the list', () => {
  let { state } = run(setup(), [{ type: 'go' }, { type: 'go' }]);
  assert.equal(currentCue(state).number, '2');
  assert.equal(nextCue(state).number, '3');
  state = apply(state, { type: 'back' }).state;
  assert.equal(currentCue(state).number, '1');
});

test('timecode fires cues as it passes them', () => {
  const frames = [];
  for (let s = 9; s <= 21; s++) for (let f = 0; f < 25; f += 5) frames.push(tc(s, f));
  const { state, events } = run(setup(), frames);
  const fired = events.filter((e) => e.type === 'fired').map((e) => e.cue.number);
  assert.deepEqual(fired, ['2', '3']); // first frame (01:00:09) has nothing to chase; 10s and 20s fire
  assert.equal(currentCue(state).number, '3');
});

test('first timecode chases, later crossings fire, auto=false cues are skipped', () => {
  let s = setup();
  let r = run(s, [tc(5)]); // before cue 2: no chase target, nothing happens
  assert.equal(r.state.runtime.currentCueId, null);
  r = run(r.state, [tc(9, 20), tc(10, 0), tc(10, 1)]);
  assert.deepEqual(r.events.filter((e) => e.type === 'fired').map((e) => e.cue.number), ['2']);
  // countdown to cue 3 is ~10s
  assert.ok(Math.abs(countdown(r.state) - (10 - 1 / 25)) < 1e-6);
  // run through 3, past 4 (auto=false) into 5
  const seq = [];
  for (let t = 11; t <= 41; t++) seq.push(tc(t));
  r = run(r.state, seq);
  assert.deepEqual(r.events.filter((e) => e.type === 'fired').map((e) => e.cue.number), ['3', '5']);
});

test('locate jumps chase to the right cue without firing', () => {
  let r = run(setup(), [tc(1), tc(2)]);
  r = run(r.state, [tc(35)]); // jump forward > threshold
  assert.equal(r.events[0].type, 'chased');
  assert.equal(currentCue(r.state).number, '4');
  r = run(r.state, [tc(12)]); // jump backwards
  assert.equal(currentCue(r.state).number, '2');
  assert.equal(r.events.filter((e) => e.type === 'fired').length, 0);
});

test('operator who has already gone past a cue does not get it re-fired', () => {
  let r = run(setup(), [tc(1), { type: 'goto', number: '3' }]);
  r = run(r.state, [tc(2), tc(3), tc(4), tc(5), tc(6), tc(7), tc(8), tc(9), tc(10), tc(11)]);
  assert.equal(r.events.filter((e) => e.type === 'fired').length, 0);
  assert.equal(currentCue(r.state).number, '3');
});

test('cue editing, sorting and log', () => {
  let s = setup();
  const id = s.show.cues[5].id;
  s = apply(s, { type: 'cue:move', id, to: 1 }).state;
  assert.equal(s.show.cues[1].number, '5');
  s = apply(s, { type: 'cue:sort' }).state;
  assert.deepEqual(s.show.cues.map((c) => c.number), ['1', '2', '3', '3.5', '4', '5']);
  s = apply(s, { type: 'cue:update', id, patch: { name: 'Curtain call' } }).state;
  assert.equal(s.show.cues[5].name, 'Curtain call');
  s = run(s, [{ type: 'go' }, { type: 'go' }]).state;
  assert.equal(s.log.length, 2);
  s = apply(s, { type: 'cue:delete', id: s.runtime.currentCueId }).state;
  assert.equal(s.runtime.currentCueId, null);
});
