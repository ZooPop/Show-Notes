#!/usr/bin/env node
// Generate an LTC timecode WAV file to play from Ableton, QLab, a DAW, etc.
//
//   node tools/make-ltc-wav.js [--start 00:59:50:00] [--fps 30|25|24|29.97] [--drop]
//                              [--minutes 5] [--rate 48000] [--level -10] [--out ltc.wav]
//
// Put the file on its own track with WARP OFF and no effects, and send that track to the
// device Show Notes listens on (Dante Virtual Soundcard, or a loopback like VB-Cable).
import fs from 'node:fs';
import { LTCEncoder } from '../public/js/ltc-decoder.js';
import { parseTC, toFrames, fromFrames, formatTC } from '../public/js/timecode.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const fps = parseFloat(opt('fps', '30'));
const drop = args.includes('--drop') || (fps === 29.97 && !args.includes('--non-drop'));
const start = parseTC(opt('start', '00:59:50:00'));
const minutes = parseFloat(opt('minutes', '5'));
const sampleRate = parseInt(opt('rate', '48000'), 10);
const levelDb = parseFloat(opt('level', '-10'));
if (!start || !(fps > 0) || !(minutes > 0)) {
  console.error('Usage: node tools/make-ltc-wav.js --start 00:59:50:00 --fps 30 --minutes 5 --out ltc.wav');
  process.exit(1);
}
const out = opt('out', `LTC_${formatTC(start, false).replace(/:/g, '-')}_${fps}${drop ? 'DF' : ''}fps_${minutes}min.wav`);

const enc = new LTCEncoder(sampleRate, fps, Math.pow(10, levelDb / 20));
const frameCount = Math.round(minutes * 60 * fps);
const totalSamples = Math.ceil((frameCount + 1) * (sampleRate / fps)) + 16;
const pcm = Buffer.alloc(totalSamples * 2);
let n = 0;
const first = toFrames(start, fps, drop);
for (let i = 0; i < frameCount; i++) {
  for (const s of enc.frame({ ...fromFrames(first + i, fps, drop), drop })) {
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), n * 2);
    n++;
  }
}
const data = pcm.subarray(0, n * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);
fs.writeFileSync(out, Buffer.concat([header, data]));
const end = fromFrames(first + frameCount - 1, fps, drop);
console.log(`Wrote ${out}: ${formatTC(start, drop)} → ${formatTC(end, drop)} @ ${fps}${drop ? ' DF' : ''} fps, ${sampleRate} Hz, ${levelDb} dBFS`);
