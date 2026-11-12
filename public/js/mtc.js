// MIDI Timecode parser (quarter-frame + full-frame SysEx). Pure JS.
import { addFrames } from './timecode.js';

export const MTC_RATES = [
  { fps: 24, drop: false },
  { fps: 25, drop: false },
  { fps: 29.97, drop: true },
  { fps: 30, drop: false },
];

export class MTCParser {
  constructor(onTC) {
    this.onTC = onTC;
    this.pieces = new Uint8Array(8);
    this.mask = 0;
    this.lastPiece = -1;
  }

  /** Feed one MIDI message (Uint8Array or array of bytes). */
  message(data) {
    if (!data || !data.length) return;
    if (data[0] === 0xf1 && data.length >= 2) {
      const piece = (data[1] >> 4) & 7;
      if (piece === 0) this.mask = 0;
      // Require pieces in order; anything else (reverse play, dropped bytes) resets.
      if (piece !== 0 && piece !== this.lastPiece + 1) this.mask = 0;
      this.lastPiece = piece;
      this.pieces[piece] = data[1] & 0x0f;
      this.mask |= 1 << piece;
      if (piece === 7 && this.mask === 0xff) {
        const p = this.pieces;
        const rate = MTC_RATES[(p[7] >> 1) & 3];
        const tc = {
          f: p[0] | ((p[1] & 1) << 4),
          s: p[2] | ((p[3] & 3) << 4),
          m: p[4] | ((p[5] & 3) << 4),
          h: p[6] | ((p[7] & 1) << 4),
        };
        // A full quarter-frame sequence spans two frames, so the value is 2 frames old.
        const now = addFrames(tc, 2, rate.fps, rate.drop);
        this.onTC({ ...now, fps: rate.fps, drop: rate.drop, kind: 'quarter' });
      }
    } else if (
      data[0] === 0xf0 && data.length >= 10 &&
      data[1] === 0x7f && data[3] === 0x01 && data[4] === 0x01
    ) {
      const rate = MTC_RATES[(data[5] >> 5) & 3];
      this.mask = 0;
      this.onTC({ h: data[5] & 0x1f, m: data[6], s: data[7], f: data[8], fps: rate.fps, drop: rate.drop, kind: 'full' });
    }
  }
}
