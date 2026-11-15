// Minimal OSC 1.0 encode/decode (UDP). Supports i, f, s, T, F types and bundles.

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', offset, end);
  return { value: str, next: (end + 4) & ~3 };
}

export function decode(buf) {
  const out = [];
  decodeInto(buf, out);
  return out;
}

function decodeInto(buf, out) {
  if (buf.length >= 8 && buf.toString('utf8', 0, 7) === '#bundle') {
    let off = 16; // "#bundle\0" + 8-byte timetag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      decodeInto(buf.subarray(off, off + size), out);
      off += size;
    }
    return;
  }
  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) return;
  let off = addr.next;
  const args = [];
  if (off < buf.length && buf[off] === 0x2c) {
    const tags = readString(buf, off);
    off = tags.next;
    for (const t of tags.value.slice(1)) {
      if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
      else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
      else if (t === 's') { const s = readString(buf, off); args.push(s.value); off = s.next; }
      else if (t === 'T') args.push(true);
      else if (t === 'F') args.push(false);
      else break;
    }
  }
  out.push({ address: addr.value, args });
}

function padString(str) {
  const b = Buffer.from(str + '\0', 'utf8');
  const len = (b.length + 3) & ~3;
  const out = Buffer.alloc(len);
  b.copy(out);
  return out;
}

export function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'number' && Number.isInteger(a)) {
      tags += 'i';
      const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b);
    } else if (typeof a === 'number') {
      tags += 'f';
      const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b);
    } else if (a === true) tags += 'T';
    else if (a === false) tags += 'F';
    else { tags += 's'; parts.push(padString(String(a))); }
  }
  return Buffer.concat([padString(address), padString(tags), ...parts]);
}

/** Parse "/cue/12/start 1 two" into an address and typed args. */
export function parseMessageString(str) {
  // Tokens are separated by spaces; "double quotes" keep spaces and always send a string,
  // e.g. /live/song/cue_point/jump "Mary Did You Know"
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(str).trim()))) tokens.push(m[1] !== undefined ? { s: m[1] } : m[2]);
  if (!tokens.length || typeof tokens[0] !== 'string' || !tokens[0].startsWith('/')) return null;
  const args = tokens.slice(1).map((p) => {
    if (typeof p === 'object') return p.s;
    return /^-?\d+$/.test(p) ? parseInt(p, 10) : /^-?\d*\.\d+$/.test(p) ? parseFloat(p) : p;
  });
  return { address: tokens[0], args };
}
