// Ableton marker (locator) lookup through AbletonOSC.
// AbletonOSC only jumps to a marker by name when the name matches exactly, character for character,
// so a trailing space, a different dash or a capital letter makes a jump silently do nothing.
// Show Notes asks Ableton for its real marker list, matches the name loosely, and jumps by position.
import dgram from 'node:dgram';
import * as osc from './osc.js';

/** Loose form of a marker name: case, spacing, dash style and quotes don't matter. */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-') // all dash styles -> "-"
    .replace(/[‘’“”"'`]/g, '')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

const alnum = (s) => normalizeName(s).replace(/[^a-z0-9]/g, '');

/** Index of the marker that matches `name` (exact, then loose, then letters/numbers only), or -1. */
export function findMarker(names, name) {
  let i = names.indexOf(name);
  if (i >= 0) return i;
  const n = normalizeName(name);
  i = names.findIndex((x) => normalizeName(x) === n);
  if (i >= 0) return i;
  const a = alnum(name);
  return a ? names.findIndex((x) => alnum(x) === a) : -1;
}

export class AbletonMarkers {
  /**
   * @param {object} o
   * @param {() => [string, number] | null} o.target   Ableton's host and port (AbletonOSC listens on 11000)
   * @param {dgram.Socket} o.sendSocket                 socket used to send to Ableton
   * @param {number} [o.replyPort]                      AbletonOSC always replies on 11001
   */
  constructor({ target, sendSocket, replyPort = 11001, log = console.log }) {
    Object.assign(this, { target, sendSocket, replyPort, log });
    this.waiters = [];
    this.available = false;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (buf) => {
      let msgs;
      try { msgs = osc.decode(buf); } catch { return; }
      for (const m of msgs) {
        if (m.address !== '/live/song/get/cue_points') continue;
        const names = [];
        for (let k = 0; k < m.args.length; k += 2) names.push(String(m.args[k]));
        this.waiters.splice(0).forEach((w) => w(names));
      }
    });
    this.socket.on('error', (e) => {
      this.available = false;
      this.log(`Ableton markers: can't listen on udp/${this.replyPort} (${e.message}). Marker names must then match exactly.`);
    });
    this.socket.bind(this.replyPort, () => { this.available = true; });
  }

  /** Ask Ableton for its marker names (in arrangement order). Resolves null if Ableton doesn't answer. */
  list(timeoutMs = 600) {
    const t = this.target();
    if (!t || !this.available) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (names) => { clearTimeout(timer); resolve(names); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(null); }, timeoutMs);
      this.waiters.push(done);
      this.sendSocket.send(osc.encode('/live/song/get/cue_points', []), t[1], t[0]);
    });
  }

  /**
   * Work out which marker a name means.
   * @returns {Promise<{index: number|null, names: string[]|null}>} index null = not found (or Ableton didn't answer)
   */
  async resolve(name) {
    const names = await this.list();
    if (!names) return { index: null, names: null };
    const i = findMarker(names, name);
    return { index: i >= 0 ? i : null, names };
  }

  close() { try { this.socket.close(); } catch {} }
}
