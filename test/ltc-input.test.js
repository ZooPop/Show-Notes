import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServerLTCInput } from '../lib/ltc-input.js';

process.env.SHOWNOTES_FAKE_AUDIO = '1'; // 8-channel stand-in device with LTC on channel 3 only
const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sn-')), 'ltc-input.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function listener() {
  const frames = [], statuses = [];
  const input = new ServerLTCInput({ settingsFile, onTC: (tc) => frames.push(tc), onStatus: (s) => statuses.push(s) });
  return { input, frames, statuses };
}

test('lists input devices with their channel counts', () => {
  const { input } = listener();
  const dante = input.listDevices().find((d) => /dante/i.test(d.name));
  assert.equal(dante.inputChannels, 8);
});

test('decodes LTC from channel 3 only', async () => {
  const { input, frames, statuses } = listener();
  input.start({ deviceName: 'Dante Virtual Soundcard', channel: 0 }); // channel 1: silent
  await wait(600);
  assert.equal(frames.length, 0);
  input.start({ deviceName: 'Dante Virtual Soundcard', channel: 2 }); // channel 3: LTC
  await wait(800);
  input.stop();
  assert.ok(frames.length > 10, `got ${frames.length} frames`);
  assert.equal(frames.at(-1).h, 3);
  assert.equal(frames.at(-1).fps, 30);
  assert.match(statuses.find((s) => s.state === 'running').text, /channel 3/);
});

test('remembers the device and channel, and refuses channels the device does not have', async () => {
  const a = listener();
  a.input.start({ deviceName: 'Dante Virtual Soundcard', channel: 2 });
  a.input.stop(true); // e.g. the server shutting down
  const b = listener();
  assert.deepEqual(b.input.settings, { enabled: true, deviceName: 'Dante Virtual Soundcard', channel: 2 });
  b.input.autoStart();
  await wait(600);
  b.input.stop();
  assert.ok(b.frames.length > 0);
  assert.equal(listener().input.settings.enabled, false);
  const c = listener();
  c.input.start({ deviceName: 'Dante Virtual Soundcard', channel: 12 });
  assert.equal(c.input.status.state, 'error');
  assert.match(c.input.status.text, /has 8 input channel/);
});
