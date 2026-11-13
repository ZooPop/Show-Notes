// Show Notes cue engine: a pure reducer shared by the server and the browser.
//   apply(state, action) -> { state, events }
// state = { show, runtime, log }. Unchanged branches keep their object identity
// so callers can cheaply detect what changed.

import { parseTC, formatTC, tcSeconds, rateById, parseLength } from './timecode.js';

export const DEPARTMENTS = ['SM', 'SONG', 'MIC', 'LX', 'SND', 'VID', 'FLY', 'SFX', 'PYRO', 'AUTO', 'OTHER'];
const LOG_LIMIT = 500;

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function createShow(overrides = {}) {
  return {
    name: 'Untitled Show',
    rate: '30',
    settings: {
      autoFire: true, // fire timed cues when timecode passes them
      chaseOnLocate: true, // when timecode jumps, move to the cue for that position
      standbySeconds: 10, // warn this long before a timed cue
      locateThresholdSeconds: 2, // a timecode jump bigger than this counts as a locate
      oscTarget: '', // "host:port" for OSC output, e.g. "127.0.0.1:53000" for QLab
    },
    cues: [],
    ...overrides,
  };
}

export function createCue(fields = {}) {
  return {
    id: uid(),
    number: '',
    name: '',
    tc: '', // trigger timecode label, empty = manual (GO) cue
    dept: 'SM',
    leads: '', // who is leading (singers / speakers)
    time: '', // length for the TIME LEFT countdown, m:ss (max 10:00)
    notes: '',
    auto: true, // allow timecode to fire this cue
    osc: '', // optional OSC message sent when the cue fires, e.g. "/cue/12/start"
    ...fields,
  };
}

export function createRuntime() {
  return { currentCueId: null, currentAt: null, lastGo: null, tc: null };
}

export function createState(show = createShow()) {
  return { show, runtime: createRuntime(), log: [] };
}

// ---- selectors -----------------------------------------------------------

export function cueIndex(show, id) {
  return show.cues.findIndex((c) => c.id === id);
}

export function cueSeconds(show, cue) {
  const tc = parseTC(cue.tc);
  return tc ? tcSeconds(tc, rateById(show.rate).fps) : null;
}

export function currentCue(state) {
  return state.show.cues.find((c) => c.id === state.runtime.currentCueId) || null;
}

export function nextCue(state) {
  const i = cueIndex(state.show, state.runtime.currentCueId);
  return state.show.cues[i + 1] || null;
}

/** Seconds until the next timed cue fires, or null if it is manual / no timecode. */
export function countdown(state, now = state.runtime.tc) {
  const next = nextCue(state);
  if (!next || !now) return null;
  const at = cueSeconds(state.show, next);
  return at == null ? null : at - tcSeconds(now);
}

/** The last timed cue at or before a timecode position (used for chase/locate). */
export function cueForPosition(show, seconds) {
  let found = null;
  for (const cue of show.cues) {
    const at = cueSeconds(show, cue);
    if (at != null && at <= seconds + 1e-6) found = cue;
  }
  return found;
}

// ---- reducer -------------------------------------------------------------

export function apply(state, action) {
  const events = [];
  const next = reduce(state, action, events);
  return { state: next, events };
}

function reduce(state, action, events) {
  const { show, runtime } = state;
  const at = action.at || Date.now();

  switch (action.type) {
    case 'go': {
      const i = cueIndex(show, runtime.currentCueId);
      const cue = show.cues[i + 1];
      return cue ? fire(state, cue, action.source || 'manual', at, events) : state;
    }
    case 'back': {
      const i = cueIndex(show, runtime.currentCueId);
      if (i < 0) return state;
      const cue = show.cues[i - 1] || null;
      return move(state, cue, 'back', at, events);
    }
    case 'goto': {
      const cue = action.cueId
        ? show.cues.find((c) => c.id === action.cueId)
        : show.cues.find((c) => String(c.number) === String(action.number));
      if (!cue) return state;
      return action.fire === false
        ? move(state, cue, 'goto', at, events)
        : fire(state, cue, action.source || 'goto', at, events);
    }
    case 'reset':
      return move(state, null, 'reset', at, events);

    case 'timecode':
      return onTimecode(state, action.tc, at, events);

    case 'show:replace':
      return { ...state, show: normalizeShow(action.show), runtime: { ...runtime, currentCueId: null } };
    case 'show:update': {
      const { cues, settings, ...rest } = action.patch || {};
      return { ...state, show: { ...show, ...rest } };
    }
    case 'settings:update':
      return { ...state, show: { ...show, settings: { ...show.settings, ...action.patch } } };

    case 'cue:add': {
      const cue = createCue(action.cue);
      const cues = [...show.cues];
      const after = action.afterId ? cueIndex(show, action.afterId) : -1;
      if (after >= 0) cues.splice(after + 1, 0, cue);
      else cues.push(cue);
      events.push({ type: 'cue:added', cueId: cue.id });
      return { ...state, show: { ...show, cues } };
    }
    case 'cue:update': {
      const { id: _ignored, ...patch } = action.patch || {};
      const cues = show.cues.map((c) => (c.id === action.id ? { ...c, ...patch } : c));
      return { ...state, show: { ...show, cues } };
    }
    case 'cue:delete': {
      const cues = show.cues.filter((c) => c.id !== action.id);
      const currentCueId = runtime.currentCueId === action.id ? null : runtime.currentCueId;
      return { ...state, show: { ...show, cues }, runtime: { ...runtime, currentCueId } };
    }
    case 'cue:move': {
      const from = cueIndex(show, action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(show.cues.length - 1, action.to ?? from + (action.by || 0)));
      if (to === from) return state;
      const cues = [...show.cues];
      const [cue] = cues.splice(from, 1);
      cues.splice(to, 0, cue);
      return { ...state, show: { ...show, cues } };
    }
    case 'cue:sort': {
      // Sort timed cues by trigger time while leaving manual cues attached to the cue before them.
      const groups = [];
      for (const cue of show.cues) {
        const at = cueSeconds(show, cue);
        if (at != null || !groups.length) groups.push({ at: at ?? -1, cues: [cue] });
        else groups[groups.length - 1].cues.push(cue);
      }
      groups.sort((a, b) => a.at - b.at);
      return { ...state, show: { ...show, cues: groups.flatMap((g) => g.cues) } };
    }
    case 'log:clear':
      return { ...state, log: [] };
    default:
      return state;
  }
}

function logEntry(state, cue, kind, source, at) {
  const tc = state.runtime.tc;
  return {
    kind, // 'fire' | 'chase' | 'back' | 'goto' | 'reset'
    cueId: cue?.id || null,
    number: cue?.number ?? '',
    name: cue?.name ?? '',
    dept: cue?.dept ?? '',
    source,
    at,
    tc: tc ? formatTC(tc) : '',
  };
}

function pushLog(state, entry) {
  const log = state.log.length >= LOG_LIMIT ? state.log.slice(-LOG_LIMIT + 1) : state.log.slice();
  log.push(entry);
  return log;
}

function fire(state, cue, source, at, events) {
  const entry = logEntry(state, cue, 'fire', source, at);
  events.push({ type: 'fired', cue, entry });
  return {
    ...state,
    runtime: { ...state.runtime, currentCueId: cue.id, currentAt: at, lastGo: { cueId: cue.id, at, source } },
    log: pushLog(state, entry),
  };
}

function move(state, cue, kind, at, events) {
  const entry = logEntry(state, cue, kind, kind, at);
  events.push({ type: 'moved', cue, entry });
  return {
    ...state,
    runtime: { ...state.runtime, currentCueId: cue ? cue.id : null, currentAt: at },
    log: pushLog(state, entry),
  };
}

function onTimecode(state, tcIn, at, events) {
  if (!tcIn) return state;
  const { show, runtime } = state;
  const tc = {
    h: tcIn.h | 0,
    m: tcIn.m | 0,
    s: tcIn.s | 0,
    f: tcIn.f | 0,
    fps: tcIn.fps || rateById(show.rate).fps,
    drop: !!tcIn.drop,
    source: tcIn.source || 'unknown',
  };
  const prevSec = runtime.tc ? tcSeconds(runtime.tc) : null;
  const curSec = tcSeconds(tc);
  let next = { ...state, runtime: { ...runtime, tc } };
  const s = show.settings;
  const delta = prevSec == null ? null : curSec - prevSec;

  if (delta === 0) return next;

  const isLocate = delta == null || delta < 0 || delta > (s.locateThresholdSeconds ?? 2);
  if (isLocate) {
    if (!s.chaseOnLocate) return next;
    const target = cueForPosition(show, curSec);
    const targetId = target ? target.id : null;
    if (targetId === runtime.currentCueId) return next;
    // Don't chase backwards onto "nothing" on the very first frame of a session unless a cue exists.
    if (delta == null && !target) return next;
    const entry = logEntry(next, target, 'chase', tc.source, at);
    events.push({ type: 'chased', cue: target, entry });
    return { ...next, runtime: { ...next.runtime, currentCueId: targetId, currentAt: at }, log: pushLog(next, entry) };
  }

  if (!s.autoFire) return next;
  // Normal forward play: fire the last auto cue crossed since the previous frame,
  // but only if it is after the current cue (never re-fire something the operator passed).
  const curIdx = cueIndex(show, runtime.currentCueId);
  let toFire = null;
  show.cues.forEach((cue, i) => {
    if (i <= curIdx || cue.auto === false) return;
    const t = cueSeconds(show, cue);
    if (t != null && t > prevSec + 1e-6 && t <= curSec + 1e-6) toFire = cue;
  });
  return toFire ? fire(next, toFire, `tc:${tc.source}`, at, events) : next;
}

export function normalizeShow(input) {
  const base = createShow();
  const show = { ...base, ...(input || {}) };
  show.settings = { ...base.settings, ...(input?.settings || {}) };
  show.cues = Array.isArray(input?.cues) ? input.cues.map((c) => createCue({ ...c, id: c.id || uid() })) : [];
  return show;
}

/**
 * Seconds elapsed in the current cue. A timed cue follows timecode (so it pauses when
 * playback pauses) while the timecode sits within an hour after the cue's trigger;
 * otherwise it counts wall-clock time since the cue became current.
 */
export function cueElapsed(state, nowMs = Date.now()) {
  const cur = currentCue(state);
  if (!cur) return null;
  const start = cueSeconds(state.show, cur);
  const tc = state.runtime.tc;
  if (start != null && tc) {
    const d = tcSeconds(tc) - start;
    if (d >= 0 && d <= 3600) return d;
  }
  if (state.runtime.currentAt == null) return 0;
  return Math.max(0, (nowMs - state.runtime.currentAt) / 1000);
}

/** TIME LEFT for the current cue in seconds, or null if it has no length set. */
export function timeLeft(state, nowMs = Date.now()) {
  const len = parseLength(currentCue(state)?.time);
  if (len == null || Number.isNaN(len)) return null;
  return Math.max(0, len - cueElapsed(state, nowMs));
}
