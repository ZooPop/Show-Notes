import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, parseMessageString } from '../lib/osc.js';

test('OSC round trip', () => {
  const [m] = decode(encode('/shownotes/goto', ['12', 3, 1.5]));
  assert.equal(m.address, '/shownotes/goto');
  assert.equal(m.args[0], '12');
  assert.equal(m.args[1], 3);
  assert.equal(m.args[2], 1.5);
  assert.deepEqual(parseMessageString('/cue/12/start 1 x'), { address: '/cue/12/start', args: [1, 'x'] });
});

test('quoted OSC arguments keep spaces and stay strings', () => {
  assert.deepEqual(parseMessageString('/live/song/cue_point/jump "Mary Did You Know"'), { address: '/live/song/cue_point/jump', args: ['Mary Did You Know'] });
  assert.deepEqual(parseMessageString('/live/song/cue_point/jump 7'), { address: '/live/song/cue_point/jump', args: [7] });
  assert.deepEqual(parseMessageString('/x "12"'), { address: '/x', args: ['12'] });
});
