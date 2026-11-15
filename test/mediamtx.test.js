import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAsset, pinnedAssetName, PINNED_VERSION } from '../lib/mediamtx.js';

const assets = [
  'mediamtx_v1.15.0_windows_amd64.zip',
  'mediamtx_v1.15.0_darwin_amd64.tar.gz',
  'mediamtx_v1.15.0_darwin_arm64.tar.gz',
  'mediamtx_v1.15.0_linux_amd64.tar.gz',
  'mediamtx_v1.15.0_linux_arm64.tar.gz',
  'mediamtx_v1.15.0_linux_armv7.tar.gz',
  'checksums.sha256',
].map((name) => ({ name, browser_download_url: `https://example/${name}` }));

test('picks the right MediaMTX download for each computer', () => {
  assert.equal(pickAsset(assets, 'win32', 'x64').name, 'mediamtx_v1.15.0_windows_amd64.zip');
  assert.equal(pickAsset(assets, 'darwin', 'arm64').name, 'mediamtx_v1.15.0_darwin_arm64.tar.gz');
  assert.equal(pickAsset(assets, 'darwin', 'x64').name, 'mediamtx_v1.15.0_darwin_amd64.tar.gz');
  assert.equal(pickAsset(assets, 'linux', 'x64').name, 'mediamtx_v1.15.0_linux_amd64.tar.gz');
  assert.equal(pickAsset(assets, 'linux', 'arm64').name, 'mediamtx_v1.15.0_linux_arm64.tar.gz');
  assert.equal(pickAsset([{ name: 'mediamtx_v1.9.0_linux_arm64v8.tar.gz' }], 'linux', 'arm64').name, 'mediamtx_v1.9.0_linux_arm64v8.tar.gz');
  assert.equal(pickAsset(assets, 'sunos', 'x64'), null);
});

test('pinned fallback names', () => {
  assert.equal(pinnedAssetName('win32', 'x64'), `mediamtx_${PINNED_VERSION}_windows_amd64.zip`);
  assert.equal(pinnedAssetName('darwin', 'arm64'), `mediamtx_${PINNED_VERSION}_darwin_arm64.tar.gz`);
});
