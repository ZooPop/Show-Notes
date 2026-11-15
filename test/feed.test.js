import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedUrl } from '../public/js/feed.js';

test('stream address: adds http, MediaMTX port and /whep when left out', () => {
  assert.equal(normalizeFeedUrl('192.168.29.68/program'), 'http://192.168.29.68:8889/program/whep');
  assert.equal(normalizeFeedUrl('192.168.29.68:8889/program'), 'http://192.168.29.68:8889/program/whep');
  assert.equal(normalizeFeedUrl('http://192.168.29.68:8889/program/'), 'http://192.168.29.68:8889/program/whep');
  assert.equal(normalizeFeedUrl('192.168.29.68:9000/program/whep'), 'http://192.168.29.68:9000/program/whep');
  assert.equal(normalizeFeedUrl('192.168.29.68/program/index.m3u8'), 'http://192.168.29.68:8888/program/index.m3u8');
  assert.equal(normalizeFeedUrl(''), '');
});
