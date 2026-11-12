// SMPTE timecode helpers. Shared by the browser and the Node server.
// A timecode is a plain object: { h, m, s, f } plus optional { fps, drop }.

export const RATES = [
  { id: '24', fps: 24, drop: false, label: '24 fps' },
  { id: '25', fps: 25, drop: false, label: '25 fps' },
  { id: '29.97df', fps: 29.97, drop: true, label: '29.97 drop' },
  { id: '29.97', fps: 29.97, drop: false, label: '29.97 non-drop' },
  { id: '30', fps: 30, drop: false, label: '30 fps' },
];

export function rateById(id) {
  return RATES.find((r) => r.id === id) || RATES[4];
}

export function nominal(fps) {
  return Math.round(fps);
}

const pad = (n) => String(n).padStart(2, '0');

/** Parse "HH:MM:SS:FF", "HH:MM:SS;FF" (drop), or "HH:MM:SS". Returns null if invalid. */
export function parseTC(str) {
  if (str == null) return null;
  const t = String(str).trim();
  if (!t) return null;
  let m = t.match(/^(\d{1,2})[:.](\d{1,2})[:.](\d{1,2})([:;.,])(\d{1,2})$/);
  if (m) {
    const tc = { h: +m[1], m: +m[2], s: +m[3], f: +m[5], drop: m[4] === ';' || m[4] === ',' };
    return valid(tc) ? tc : null;
  }
  m = t.match(/^(\d{1,2})[:.](\d{1,2})[:.](\d{1,2})$/);
  if (m) {
    const tc = { h: +m[1], m: +m[2], s: +m[3], f: 0, drop: false };
    return valid(tc) ? tc : null;
  }
  return null;
}

function valid(tc) {
  return tc.h < 24 && tc.m < 60 && tc.s < 60 && tc.f < 60;
}

export function formatTC(tc, drop = tc?.drop) {
  if (!tc) return '--:--:--:--';
  return `${pad(tc.h)}:${pad(tc.m)}:${pad(tc.s)}${drop ? ';' : ':'}${pad(tc.f)}`;
}

/** Frame count since 00:00:00:00, honouring drop-frame numbering. */
export function toFrames(tc, fps, drop = false) {
  const n = nominal(fps);
  const totalMinutes = tc.h * 60 + tc.m;
  let frames = (totalMinutes * 60 + tc.s) * n + tc.f;
  if (drop) {
    const d = n === 60 ? 4 : 2;
    frames -= d * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

export function fromFrames(frames, fps, drop = false) {
  const n = nominal(fps);
  frames = Math.max(0, Math.floor(frames));
  if (drop) {
    const d = n === 60 ? 4 : 2;
    const per10 = n * 600 - 9 * d;
    const perMin = n * 60 - d;
    const tens = Math.floor(frames / per10);
    const rem = frames % per10;
    frames += 9 * d * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  return {
    h: Math.floor(frames / (n * 3600)) % 24,
    m: Math.floor(frames / (n * 60)) % 60,
    s: Math.floor(frames / n) % 60,
    f: frames % n,
    fps,
    drop,
  };
}

export function addFrames(tc, count, fps, drop = false) {
  return fromFrames(toFrames(tc, fps, drop) + count, fps, drop);
}

/**
 * Label value in seconds (h*3600 + m*60 + s + f/fps). Cues are written as
 * timecode labels, so comparing labels keeps drop/non-drop sources consistent.
 */
export function tcSeconds(tc, fps = tc?.fps || 30) {
  if (!tc) return null;
  return tc.h * 3600 + tc.m * 60 + tc.s + tc.f / nominal(fps);
}

export function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds)) return '';
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const body = h ? `${h}:${pad(m)}:${pad(Math.floor(s))}` : `${m}:${pad(Math.floor(s))}.${Math.floor((s % 1) * 10)}`;
  return (neg ? '-' : '') + body;
}
