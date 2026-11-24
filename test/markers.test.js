import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMarker } from '../lib/ableton-markers.js';

const markers = ['Nutcracker', 'Hark ', 'Kids – Joy (Sing + Shout)', 'joy to the world', 'Joy to the World - Reprise'];

test('marker names match even when spacing, dashes or capitals differ', () => {
  assert.equal(findMarker(markers, 'Nutcracker'), 0);
  assert.equal(findMarker(markers, 'Hark'), 1); // trailing space in Ableton
  assert.equal(findMarker(markers, 'Kids - Joy (Sing + Shout)'), 2); // en dash in Ableton
  assert.equal(findMarker(markers, 'Joy to the World'), 3); // capitals differ
  assert.equal(findMarker(markers, 'Joy to the World - Reprise'), 4); // doesn't grab "Joy to the World"
  assert.equal(findMarker(markers, 'Silent Night'), -1);
});
