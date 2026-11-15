// Show Notes — browser app.
// Connects to the server over WebSocket (shared state across devices). If no server
// is reachable it runs the same engine locally and saves to localStorage.
import { apply, createState, normalizeShow, currentCue, nextCue, countdown, cueIndex, timeLeft, DEPARTMENTS } from './engine.js';
import { RATES, rateById, parseTC, formatTC, formatDuration, tcSeconds, parseLength, formatClock } from './timecode.js';
import {
  SOURCE_TYPES, InternalClock, LTCSource, MTCSource, LTCGenerator,
  listAudioInputs, listAudioOutputs, getMIDIAccess, secureContextNote,
} from './sources.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const LS_SHOW = 'shownotes.show';
const LS_PREFS = 'shownotes.prefs';

const prefs = { name: '', source: 'none', ltcDevice: '', ltcChannel: 0, mtcInput: '', feedSource: '', feedDevice: '', ...JSON.parse(localStorage.getItem(LS_PREFS) || '{}') };
// Show Notes · Video lives at /video: same app, plus the program feed (layout B).
const VIDEO_IN = /^\/video\/?$/.test(location.pathname);
if (VIDEO_IN) { document.body.classList.add('video-in'); document.title = 'Show Notes · Video'; }
const savePrefs = () => localStorage.setItem(LS_PREFS, JSON.stringify(prefs));

// ---- store ---------------------------------------------------------------
const store = {
  state: createState(loadLocalShow()),
  ws: null,
  connected: false,
  myId: null,
  clients: [],
  lastTcAt: 0,
  serverOffset: 0, // server clock minus this browser's clock
};
const serverNow = () => Date.now() + store.serverOffset;

function loadLocalShow() {
  try { return normalizeShow(JSON.parse(localStorage.getItem(LS_SHOW))); } catch { return normalizeShow({}); }
}

function dispatch(action) {
  if (store.connected) {
    store.ws.send(JSON.stringify({ type: 'action', action }));
    return;
  }
  const prev = store.state;
  const { state, events } = apply(prev, { ...action, source: action.source || prefs.name || 'local' });
  store.state = state;
  if (state.show !== prev.show) localStorage.setItem(LS_SHOW, JSON.stringify(state.show));
  if (state.runtime.tc !== prev.runtime.tc) store.lastTcAt = performance.now();
  events.forEach(onEngineEvent);
  render(prev);
}

function connect() {
  if (location.protocol === 'file:') return setConn('local');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    store.ws = ws;
    store.connected = true;
    setConn('online');
    ws.send(JSON.stringify({ type: 'identify', name: prefs.name || deviceName(), role: activeSource ? 'tc-master' : 'viewer' }));
  };
  ws.onmessage = (e) => onServerMessage(JSON.parse(e.data));
  ws.onclose = () => {
    store.connected = false;
    store.ws = null;
    setConn(opened ? 'lost' : 'local');
    setTimeout(connect, opened ? 1000 : 3000);
  };
}

function onServerMessage(msg) {
  const prev = store.state;
  if (msg.now) store.serverOffset = msg.now - Date.now();
  switch (msg.type) {
    case 'hello':
      store.myId = msg.id;
      store.state = { show: msg.show, runtime: msg.runtime, log: msg.log || [] };
      break;
    case 'show':
      store.state = { ...store.state, show: msg.show };
      break;
    case 'runtime':
      if (msg.runtime.tc !== prev.runtime.tc) store.lastTcAt = performance.now();
      store.state = { ...store.state, runtime: msg.runtime };
      break;
    case 'log':
      store.state = { ...store.state, log: msg.log };
      break;
    case 'event':
      store.state = { ...store.state, log: [...store.state.log, msg.event.entry].slice(-500) };
      onEngineEvent(msg.event);
      break;
    case 'ltcServer':
      onLtcServer(msg);
      return;
    case 'mediamtx':
      onMediaMTX(msg.status);
      return;
    case 'ltcLevel':
      $('#srvMeter').style.width = `${Math.min(100, msg.peak * 100)}%`;
      return;
    case 'clients':
      store.clients = msg.clients;
      renderClients();
      return;
  }
  render(prev);
}

function onEngineEvent(ev) {
  if (ev.type === 'fired') flashGo();
}

function deviceName() {
  return /iPad|iPhone|Android/.test(navigator.userAgent) ? 'Tablet' : 'Browser';
}

function setConn(mode) {
  const pill = $('#connPill');
  const text = { online: 'Connected', lost: 'Reconnecting…', local: 'Local only' }[mode];
  pill.textContent = text;
  pill.className = 'pill ' + ({ online: 'ok', lost: 'bad', local: 'warn' }[mode]);
  pill.title = mode === 'local' ? 'No Show Notes server found: changes are saved in this browser only.' : 'Synced with the Show Notes server';
}

// ---- rendering -----------------------------------------------------------
let selectedId = null;

function render(prev = {}) {
  const { show, runtime, log } = store.state;
  if (!prev.show || prev.show !== show) renderSettings();
  if (!prev.show || prev.show !== show || prev.runtime?.currentCueId !== runtime.currentCueId) renderTable();
  if (!prev.log || prev.log !== log) renderLog();
  renderBand();
}

function renderBand() {
  const state = store.state;
  const { show, runtime } = state;
  const tc = runtime.tc;
  const stale = !tc || performance.now() - store.lastTcAt > 1000;
  const tcEl = $('#tcDisplay');
  tcEl.textContent = formatTC(tc);
  tcEl.classList.toggle('stale', stale);
  $('#tcRate').textContent = tc ? `${tc.fps}${tc.drop ? ' DF' : ''} fps` : rateById(show.rate).label;
  $('#tcSource').textContent = tc ? `${tc.source}${stale ? ' (stopped)' : ''}` : 'no source';

  const tcPill = $('#tcPill');
  tcPill.textContent = !tc ? 'No timecode' : stale ? 'TC stopped' : `TC ${tc.source.toUpperCase()}`;
  tcPill.className = 'pill ' + (!tc ? '' : stale ? 'warn' : 'ok');

  const cur = currentCue(state);
  $('#curNum').textContent = cur ? cur.number : '—';
  $('#curName').textContent = cur ? cur.name : 'Ready — top of show';
  $('#curNotes').textContent = cur ? cur.notes || '' : '';
  $('#curLeads').hidden = !cur?.leads;
  $('#curLeadsText').textContent = cur?.leads || '';

  const next = nextCue(state);
  // TIME LEFT: CURRENT counts down live; NEXT shows its full length, ready to go.
  const left = cur ? timeLeft(state, serverNow()) : null;
  showTime('#curTime', left);
  const curCell = document.querySelector('tr.current td.tleft');
  if (curCell && left != null) curCell.textContent = formatClock(left);
  const nextLen = next ? parseLength(next.time) : null;
  showTime('#nextTime', Number.isNaN(nextLen) ? null : nextLen);

  $('#nextNum').textContent = next ? next.number : '—';
  $('#nextName').textContent = next ? next.name : 'End of cue list';
  $('#nextLeads').hidden = !next?.leads;
  $('#nextLeadsText').textContent = next?.leads || '';
  $('#nextNotes').textContent = next ? next.notes || '' : '';
  fitDisplayBoxes();
  const cd = countdown(state);
  const standby = !!next && cd != null && cd >= 0 && cd <= show.settings.standbySeconds && !stale;
  $('#nextBox').classList.toggle('standby', standby);
  const nextRow = next && document.querySelector(`tr[data-id="${next.id}"]`);
  $$('tr.standby').forEach((r) => r !== nextRow && r.classList.remove('standby'));
  nextRow?.classList.toggle('standby', standby);
  // NEXT pulses gently only while timecode is actually running.
  const running = !stale && !!next;
  $('#nextBox').classList.toggle('running', running);
  $$('tr.running').forEach((r) => r !== nextRow && r.classList.remove('running'));
  nextRow?.classList.toggle('running', running);
  $('#autoFireChk').checked = !!show.settings.autoFire;
}

function showTime(sel, seconds) {
  const el = $(sel);
  el.hidden = seconds == null;
  if (seconds == null) return;
  $(sel + 'Val').textContent = formatClock(seconds);
  el.classList.toggle('warn', seconds <= 30 && seconds > 0);
  el.classList.toggle('zero', seconds <= 0);
}

// Display view: scale each CURRENT / NEXT box's text down until everything in it fits.
let fitKey = '';
function fitDisplayBoxes() {
  const boxes = $$('.cuebox');
  const key = boxes.map((b) => [...b.children].filter((c) => !c.classList.contains('label')).map((c) => c.textContent).join('|') + (b.querySelector('.timeleft').hidden ? '' : 'T')).join('|') + `|${document.body.className}|${innerWidth}x${innerHeight}`;
  if (key === fitKey) return;
  fitKey = key;
  document.body.style.setProperty('--hdr', `${$('.topbar').offsetHeight}px`); // phone layout fills the screen below the header
  for (const box of boxes) {
    box.style.setProperty('--fit', 1);
    if (!document.body.classList.contains('view-display')) continue;
    let fit = 1;
    while (box.scrollHeight > box.clientHeight + 1 && fit > 0.3) {
      fit -= 0.04;
      box.style.setProperty('--fit', fit.toFixed(2));
    }
  }
}
addEventListener('resize', () => { fitKey = ''; renderBand(); });

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTable() {
  const { show, runtime } = store.state;
  const curIdx = cueIndex(show, runtime.currentCueId);
  const body = $('#cueTable tbody');
  body.innerHTML = show.cues
    .map((c, i) => {
      const cls = [i < curIdx ? 'done' : '', i === curIdx ? 'current' : '', i === curIdx + 1 ? 'next' : '', c.id === selectedId ? 'selected' : '']
        .filter(Boolean).join(' ');
      return `<tr data-id="${c.id}" class="${cls}">
        <td class="num">${esc(c.number)}</td>
        <td>${esc(c.name)}</td>
        <td class="leads-cell">${esc(c.leads)}</td>
        <td><span class="dept dept-${esc(c.dept)}">${esc(c.dept)}</span></td>
        <td class="trig">${esc(c.tc) || '<span title="Manual GO">—</span>'}</td>
        <td class="tleft">${esc(c.time)}</td>
        <td>${c.tc ? (c.auto === false ? '✗' : '✓') : ''}</td>
        <td class="notes">${esc(c.notes)}</td>
        <td class="actions">
          <button data-act="goto" title="Fire this cue now">GO</button>
          <button data-act="load" title="Make this the current cue without firing">Load</button>
          <span class="edit-only">
            <button data-act="up" title="Move up">↑</button>
            <button data-act="down" title="Move down">↓</button>
            <button data-act="edit">Edit</button>
            <button data-act="del" title="Delete">✕</button>
          </span>
        </td>
      </tr>`;
    })
    .join('');
  $('#emptyMsg').hidden = show.cues.length > 0;
  scrollRowIntoView(body.querySelector('tr.current'));
}

// Scroll only the cue table, never the page.
function scrollRowIntoView(row) {
  const wrap = $('.table-wrap');
  if (!row || !wrap) return;
  const head = wrap.querySelector('thead').offsetHeight;
  const top = row.offsetTop - head, bottom = row.offsetTop + row.offsetHeight;
  if (top < wrap.scrollTop) wrap.scrollTop = top;
  else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight;
}

function renderLog() {
  const items = store.state.log.slice(-200).reverse();
  $('#log').innerHTML = items
    .map((e) => {
      const time = new Date(e.at).toLocaleTimeString([], { hour12: false });
      const label = e.kind === 'reset' ? 'Reset' : `${e.kind === 'fire' ? 'GO' : e.kind} ${esc(e.number)} ${esc(e.name)}`;
      return `<li class="k-${e.kind}"><span class="t">${time}</span><span class="tc">${esc(e.tc)}</span><span>${label}<small> · ${esc(e.source)}</small></span></li>`;
    })
    .join('');
}

function renderSettings() {
  const { show } = store.state;
  $('#showName').textContent = show.name;
  document.title = `${show.name} · Show Notes${VIDEO_IN ? ' · Video' : ''}`;
  const set = (sel, v) => { const el = $(sel); if (document.activeElement !== el) el.value = v; };
  set('#setName', show.name);
  set('#setRate', show.rate);
  set('#setStandby', show.settings.standbySeconds);
  set('#setOsc', show.settings.oscTarget || '');
  $('#setOscTc').checked = show.settings.oscOnTimecode !== false;
  $('#setChase').checked = !!show.settings.chaseOnLocate;
}

function renderClients() {
  $('#clients').innerHTML = store.clients
    .map((c) => `<li class="${c.id === store.myId ? 'me' : ''}">${esc(c.name)}${c.role === 'tc-master' ? ' <span class="role">· timecode in</span>' : ''}${c.id === store.myId ? ' (you)' : ''}</li>`)
    .join('') || '<li>Only this browser</li>';
}

function flashGo() {
  const b = $('#goBtn');
  b.animate([{ filter: 'brightness(1.8)' }, { filter: 'brightness(1)' }], { duration: 400 });
}

// Repaint the band periodically so "stopped" / countdown stay fresh when no TC arrives.
setInterval(renderBand, 250);

// ---- views ---------------------------------------------------------------
function setView(view) {
  document.body.classList.remove('view-operate', 'view-edit', 'view-display');
  document.body.classList.add(`view-${view}`);
  $$('.views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const url = new URL(location.href);
  if (view === 'operate') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  history.replaceState(null, '', url);
}
$$('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// ---- transport + table ---------------------------------------------------
$('#goBtn').addEventListener('click', () => dispatch({ type: 'go' }));
$('#backBtn').addEventListener('click', () => dispatch({ type: 'back' }));
$('#resetBtn').addEventListener('click', () => confirm('Reset to the top of the show?') && dispatch({ type: 'reset' }));
$('#autoFireChk').addEventListener('change', (e) => dispatch({ type: 'settings:update', patch: { autoFire: e.target.checked } }));

$('#cueTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'goto') dispatch({ type: 'goto', cueId: id });
  else if (act === 'load') dispatch({ type: 'goto', cueId: id, fire: false });
  else if (act === 'up') dispatch({ type: 'cue:move', id, by: -1 });
  else if (act === 'down') dispatch({ type: 'cue:move', id, by: 1 });
  else if (act === 'edit') openCueDialog(id);
  else if (act === 'del') {
    const cue = store.state.show.cues.find((c) => c.id === id);
    if (confirm(`Delete cue ${cue.number} ${cue.name}?`)) dispatch({ type: 'cue:delete', id });
  } else {
    selectedId = id;
    $$('#cueTable tr.selected').forEach((r) => r.classList.remove('selected'));
    tr.classList.add('selected');
  }
});
$('#cueTable tbody').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  if (tr && document.body.classList.contains('view-edit')) openCueDialog(tr.dataset.id);
});

// ---- cue editor ----------------------------------------------------------
const dlg = $('#cueDialog');
const form = $('#cueForm');
form.dept.innerHTML = DEPARTMENTS.map((d) => `<option>${d}</option>`).join('');
let editingId = null;

function suggestNumber() {
  const nums = store.state.show.cues.map((c) => parseFloat(c.number)).filter((n) => isFinite(n));
  return String(nums.length ? Math.floor(Math.max(...nums)) + 1 : 1);
}

function openCueDialog(id, defaults = {}) {
  editingId = id;
  const cue = id ? store.state.show.cues.find((c) => c.id === id) : { number: suggestNumber(), name: '', dept: 'SM', tc: '', auto: true, leads: '', notes: '', osc: '', ...defaults };
  $('#cueDialogTitle').textContent = id ? `Edit cue ${cue.number}` : 'New cue';
  for (const k of ['number', 'name', 'leads', 'dept', 'tc', 'time', 'notes', 'osc']) form[k].value = cue[k] ?? '';
  form.auto.checked = cue.auto !== false;
  $('#cueFormErr').hidden = true;
  dlg.showModal();
  form.name.focus();
}

form.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const data = {
    number: form.number.value.trim(),
    name: form.name.value.trim(),
    leads: form.leads.value.trim(),
    dept: form.dept.value,
    tc: form.tc.value.trim(),
    time: form.time.value.trim(),
    auto: form.auto.checked,
    notes: form.notes.value.trim(),
    osc: form.osc.value.trim(),
  };
  if (data.tc) {
    const tc = parseTC(data.tc);
    if (!tc) {
      e.preventDefault();
      $('#cueFormErr').textContent = 'Timecode must look like HH:MM:SS:FF (use ; before frames for drop-frame).';
      $('#cueFormErr').hidden = false;
      return;
    }
    data.tc = formatTC(tc, rateById(store.state.show.rate).drop);
  }
  if (data.time) {
    const secs = parseLength(data.time);
    if (Number.isNaN(secs)) {
      e.preventDefault();
      $('#cueFormErr').textContent = 'Time left must look like m:ss, e.g. 4:30 (max 10:00).';
      $('#cueFormErr').hidden = false;
      return;
    }
    data.time = formatClock(secs); // capped at 10:00
  }
  if (editingId) dispatch({ type: 'cue:update', id: editingId, patch: data });
  else dispatch({ type: 'cue:add', cue: data, afterId: selectedId || undefined });
});

$('#addCueBtn').addEventListener('click', () => openCueDialog(null));
$('#captureBtn').addEventListener('click', captureCue);
$('#sortBtn').addEventListener('click', () => dispatch({ type: 'cue:sort' }));

function captureCue() {
  const tc = store.state.runtime.tc;
  if (!tc) return alert('No timecode yet. Connect a timecode source first.');
  openCueDialog(null, { tc: formatTC(tc, rateById(store.state.show.rate).drop) });
}

// ---- settings ------------------------------------------------------------
$('#setRate').innerHTML = RATES.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
$('#setName').addEventListener('change', (e) => dispatch({ type: 'show:update', patch: { name: e.target.value.trim() || 'Untitled Show' } }));
$('#setRate').addEventListener('change', (e) => dispatch({ type: 'show:update', patch: { rate: e.target.value } }));
$('#setStandby').addEventListener('change', (e) => dispatch({ type: 'settings:update', patch: { standbySeconds: Math.max(0, +e.target.value || 0) } }));
$('#setChase').addEventListener('change', (e) => dispatch({ type: 'settings:update', patch: { chaseOnLocate: e.target.checked } }));
$('#setOsc').addEventListener('change', (e) => dispatch({ type: 'settings:update', patch: { oscTarget: e.target.value.trim() } }));
$('#setOscTc').addEventListener('change', (e) => dispatch({ type: 'settings:update', patch: { oscOnTimecode: e.target.checked } }));

// ---- import / export -----------------------------------------------------
const CSV_COLS = ['number', 'name', 'leads', 'dept', 'tc', 'time', 'auto', 'notes', 'osc'];

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = () => store.state.show.name.replace(/[^\w-]+/g, '_');
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

$('#exportJsonBtn').addEventListener('click', () => download(`${slug()}.shownotes.json`, JSON.stringify(store.state.show, null, 2), 'application/json'));
$('#exportCsvBtn').addEventListener('click', () => {
  const lines = [CSV_COLS.join(',')].concat(store.state.show.cues.map((c) => CSV_COLS.map((k) => csvCell(k === 'auto' ? (c.auto === false ? 'no' : 'yes') : c[k])).join(',')));
  download(`${slug()}-cues.csv`, lines.join('\n'), 'text/csv');
});
$('#exportLogBtn').addEventListener('click', () => {
  const cols = ['at', 'tc', 'kind', 'number', 'name', 'dept', 'source'];
  const lines = [cols.join(',')].concat(store.state.log.map((e) => cols.map((k) => csvCell(k === 'at' ? new Date(e.at).toISOString() : e[k])).join(',')));
  download(`${slug()}-show-log.csv`, lines.join('\n'), 'text/csv');
});
$('#clearLogBtn').addEventListener('click', () => confirm('Clear the show log?') && dispatch({ type: 'log:clear' }));

// Show templates served by the server (data/*.json and data/private/*.json).
async function refreshTemplates() {
  if (location.protocol === 'file:') return;
  try {
    const list = await (await fetch('/api/templates')).json();
    $('#templateSel').innerHTML = list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${t.cues} cues)</option>`).join('');
    $('#templateRow').hidden = !list.length;
  } catch { /* no server */ }
}
$('#templateBtn').addEventListener('click', async () => {
  const id = $('#templateSel').value;
  if (!id || !confirm('Replace the current show with this template? Export first if you want to keep it.')) return;
  const show = await (await fetch(`/api/templates?id=${encodeURIComponent(id)}`)).json();
  dispatch({ type: 'show:replace', show });
});
refreshTemplates();

let importKind = 'json';
$('#importJsonBtn').addEventListener('click', () => { importKind = 'json'; $('#fileInput').click(); });
$('#importCsvBtn').addEventListener('click', () => { importKind = 'csv'; $('#fileInput').click(); });
$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  try {
    if (importKind === 'json' || file.name.endsWith('.json')) {
      if (!confirm('Replace the whole show with this file?')) return;
      dispatch({ type: 'show:replace', show: JSON.parse(text) });
    } else {
      const [header, ...rows] = parseCSV(text);
      const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
      const get = (r, k) => (idx[k] != null ? (r[idx[k]] || '').trim() : '');
      const cues = rows.map((r) => ({
        number: get(r, 'number') || get(r, 'cue'),
        name: get(r, 'name'),
        dept: (get(r, 'dept') || 'SM').toUpperCase(),
        tc: get(r, 'tc') || get(r, 'timecode'),
        time: get(r, 'time') || get(r, 'time left'),
        auto: !/^(no|false|0|n)$/i.test(get(r, 'auto')),
        leads: get(r, 'leads'),
        notes: get(r, 'notes'),
        osc: get(r, 'osc'),
      }));
      const replace = confirm(`Import ${cues.length} cues.\nOK = replace the cue list, Cancel = append to it.`);
      dispatch({ type: 'show:replace', show: { ...store.state.show, cues: replace ? cues : [...store.state.show.cues, ...cues] } });
    }
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

// ---- timecode sources ----------------------------------------------------
let activeSource = null;
let midiAccess = null;

$('#srcType').innerHTML = Object.entries(SOURCE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#srcType').value = prefs.source;
$('#ltcChannel').innerHTML = Array.from({ length: 32 }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
$('#ltcChannel').value = prefs.ltcChannel;

function showSourceOptions() {
  const type = $('#srcType').value;
  $$('.src-opts').forEach((el) => (el.hidden = el.dataset.src !== type));
  if (type === 'server') refreshServerDevices();
  const note = type === 'ltc' || type === 'mtc' ? secureContextNote() : '';
  $('#secureWarn').hidden = !note;
  $('#secureWarn').textContent = note;
  if (type === 'ltc') refreshAudioDevices();
  if (type === 'mtc') refreshMidi();
}

async function refreshAudioDevices() {
  const devices = await listAudioInputs().catch(() => []);
  const sel = $('#ltcDevice');
  sel.innerHTML = '<option value="">Default input</option>' +
    devices.map((d) => `<option value="${d.deviceId}">${esc(d.label || 'Input ' + d.deviceId.slice(0, 6))}</option>`).join('');
  // Prefer a Dante device when nothing is chosen yet.
  const dante = devices.find((d) => /dante/i.test(d.label));
  sel.value = devices.some((d) => d.deviceId === prefs.ltcDevice) ? prefs.ltcDevice : dante ? dante.deviceId : '';
}

async function refreshMidi() {
  try {
    midiAccess = midiAccess || (await getMIDIAccess());
    const sel = $('#mtcInput');
    sel.innerHTML = '<option value="">All inputs</option>' + [...midiAccess.inputs.values()].map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
    sel.value = prefs.mtcInput;
  } catch (e) {
    setSrcStatus({ state: 'error', text: e.message });
  }
}

function setSrcStatus(s) {
  $('#srcStatus').textContent = s.text;
}

function sendTC(tc) {
  dispatch({ type: 'timecode', tc });
}

async function startSource() {
  stopSource();
  const type = $('#srcType').value;
  prefs.source = type;
  savePrefs();
  if (type === 'server') return startServerLTC();
  if (type !== 'none' && serverLtc.status?.state && serverLtc.status.state !== 'off') stopServerLTC(); // one timecode input at a time
  const rate = rateById(store.state.show.rate);
  const common = { onTC: sendTC, onStatus: setSrcStatus };
  try {
    if (type === 'internal') {
      activeSource = new InternalClock({ ...common, fps: rate.fps, drop: rate.drop });
      activeSource.locate($('#clockLocate').value);
      setSrcStatus({ text: 'Practice clock ready. Press Run.' });
    } else if (type === 'ltc') {
      prefs.ltcDevice = $('#ltcDevice').value;
      prefs.ltcChannel = +$('#ltcChannel').value;
      savePrefs();
      activeSource = new LTCSource({
        ...common, deviceId: prefs.ltcDevice, channel: prefs.ltcChannel, fps: rate.fps,
        onLevel: (peak, channels) => {
          $('#ltcMeter').style.width = `${Math.min(100, peak * 100)}%`;
          const st = $('#srcStatus');
          if (channels && channels > prefs.ltcChannel && st.textContent.startsWith('Listening for LTC') && !st.textContent.includes('channels coming in')) {
            st.textContent = `Listening for LTC on channel ${prefs.ltcChannel + 1}… (${channels} channels coming in)`;
          }
          if (channels && channels <= prefs.ltcChannel) setSrcStatus({ text: `The browser is only receiving ${channels} channel(s) from this input, so channel ${prefs.ltcChannel + 1} isn't available. Check the device's channel count (e.g. Dante Virtual Soundcard settings) or route the LTC to a lower channel.` });
        },
      });
      await activeSource.start();
      refreshAudioDevices(); // labels become available after permission is granted
    } else if (type === 'mtc') {
      midiAccess = midiAccess || (await getMIDIAccess());
      prefs.mtcInput = $('#mtcInput').value;
      savePrefs();
      activeSource = new MTCSource({ ...common, access: midiAccess, inputId: prefs.mtcInput });
      activeSource.start();
    } else {
      setSrcStatus({ text: 'Not listening.' });
    }
  } catch (e) {
    activeSource = null;
    setSrcStatus({ text: `Could not start: ${e.message}` });
  }
  identify();
}

function stopSource() {
  activeSource?.destroy();
  activeSource = null;
  $('#ltcMeter').style.width = '0';
  setSrcStatus({ text: 'Not listening.' });
  identify();
}

function identify() {
  if (store.connected) store.ws.send(JSON.stringify({ type: 'identify', name: prefs.name || deviceName(), role: activeSource ? 'tc-master' : 'viewer' }));
}

$('#srcType').addEventListener('change', showSourceOptions);
$('#srcStart').addEventListener('click', startSource);
$('#srcStop').addEventListener('click', () => { if ($('#srcType').value === 'server') stopServerLTC(); });
$('#srcStop').addEventListener('click', stopSource);
$('#ltcChannel').addEventListener('change', (e) => {
  prefs.ltcChannel = +e.target.value;
  savePrefs();
  if (activeSource instanceof LTCSource) activeSource.setChannel(prefs.ltcChannel);
});
$('#clockStart').addEventListener('click', async () => {
  if (!(activeSource instanceof InternalClock)) { $('#srcType').value = 'internal'; await startSource(); }
  activeSource.start();
});
$('#clockStop').addEventListener('click', () => activeSource instanceof InternalClock && activeSource.stop());
$('#clockLocateBtn').addEventListener('click', () => {
  if (activeSource instanceof InternalClock) {
    if (!activeSource.locate($('#clockLocate').value)) alert('Timecode must look like HH:MM:SS:FF');
  }
});

let generator = null;
$('#genBtn').addEventListener('click', async () => {
  if (generator) {
    generator.destroy();
    generator = null;
    $('#genBtn').textContent = 'Start generator';
    return;
  }
  const rate = rateById(store.state.show.rate);
  generator = new LTCGenerator({ fps: rate.fps, drop: rate.drop, startTC: $('#genStart').value, sinkId: $('#genOut').value });
  try {
    await generator.start();
    $('#genBtn').textContent = 'Stop generator';
  } catch (e) {
    generator = null;
    alert(`Generator failed: ${e.message}`);
  }
});
$('details').addEventListener('toggle', async () => {
  const outs = await listAudioOutputs().catch(() => []);
  $('#genOut').innerHTML = '<option value="">Default output</option>' + outs.filter((o) => o.deviceId !== 'default').map((o) => `<option value="${o.deviceId}">${esc(o.label || 'Output')}</option>`).join('');
});

$('#clientName').value = prefs.name;
$('#clientName').addEventListener('change', (e) => { prefs.name = e.target.value.trim(); savePrefs(); identify(); });

// ---- keyboard ------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  const cues = store.state.show.cues;
  if (e.code === 'Space') { e.preventDefault(); dispatch({ type: 'go' }); }
  else if (e.key === 'Backspace') { e.preventDefault(); dispatch({ type: 'back' }); }
  else if (e.key === 'Escape') setView('operate');
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const i = cueIndex(store.state.show, selectedId ?? store.state.runtime.currentCueId);
    const n = cues[Math.max(0, Math.min(cues.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) { selectedId = n.id; renderTable(); scrollRowIntoView(document.querySelector('tr.selected')); }
  } else if (e.key === 'Enter' && selectedId) dispatch({ type: 'goto', cueId: selectedId, fire: false });
  else if (e.key.toLowerCase() === 'c' && document.body.classList.contains('view-edit')) captureCue();
});

// ---- boot ----------------------------------------------------------------
setView(new URLSearchParams(location.search).get('view') || 'operate');
showSourceOptions();
render();
renderClients();
connect();
if (prefs.source === 'internal') startSource(); // LTC/MTC need a click (browser permission); server LTC resumes by itself

// Exposed for debugging / automation from the console.
window.showNotes = { store, dispatch, tcSeconds };

// Optional logo in the header (served from data/private/logo.png when present).
{
  const logo = $('#brandLogo');
  const show = () => { logo.hidden = false; $('#brandDiv').hidden = false; };
  if (logo.complete && logo.naturalWidth) show();
  else logo.addEventListener('load', show);
}
// Display view: tappable "Hit Esc to exit" for touch screens.
$('#escHint').addEventListener('click', () => setView('operate'));

// ---- Video: program feed -------------------------------------------------
import { ProgramFeed, listVideoInputs, normalizeFeedUrl } from './feed.js';

const feed = new ProgramFeed($('#pgmVideo'), (state, text) => {
  $('#feedStatus').textContent = text;
  $('#pgmEmpty').hidden = state === 'live';
  $('#pgmHint').textContent = state === 'off' ? 'Set it up under Program feed in the Operate view.' : text;
  const pill = $('#pgmPill');
  pill.textContent = { live: 'PGM LIVE', connecting: 'PGM…', error: 'PGM ERROR', off: 'No feed' }[state] || state;
  pill.className = 'pill video-only ' + ({ live: 'ok', connecting: 'warn', error: 'bad' }[state] || '');
});

// ---- Built-in MediaMTX (runs on the Show Notes computer) ----
let mtx = { state: 'off' };
const mtxUp = () => mtx.state === 'running' || mtx.state === 'external';

/** The shared address, or (when it's blank) the MediaMTX built into the Show Notes server. */
function feedUrl() {
  const typed = store.state.show.settings.feedUrl || '';
  if (typed || !mtxUp()) return typed;
  return `${location.hostname}:${mtx.port || 8889}/${mtx.path || 'program'}`;
}

function onMediaMTX(status) {
  mtx = status || { state: 'off' };
  if (!$('#mtxBox')) return;
  const hosts = mtx.hosts || [];
  const host = hosts.includes(location.hostname) ? location.hostname : hosts[0] || location.hostname;
  const label = {
    running: mtx.publishing ? 'Running · OBS is streaming' : 'Running · waiting for OBS',
    external: mtx.publishing ? 'Using the MediaMTX already open · OBS is streaming' : 'Using the MediaMTX already open on this computer',
    downloading: 'Downloading (first run only)…',
    starting: 'Starting…',
    disabled: 'Turned off',
    off: 'Off',
  }[mtx.state] || mtx.text;
  $('#mtxState').textContent = label;
  $('#mtxDot').className = 'mtx-dot ' + (mtxUp() ? (mtx.publishing ? 'ok' : 'warn') : mtx.state === 'error' ? 'bad' : '');
  $('#mtxObs').hidden = !mtxUp() || !!mtx.publishing;
  $('#mtxWhip').textContent = `http://${host}:${mtx.port || 8889}/${mtx.path || 'program'}/whip`;
  $('#mtxRtmp').textContent = `rtmp://${host}:1935`;
}
$$('#mtxBox .copy').forEach((el) => el.addEventListener('click', () => {
  navigator.clipboard?.writeText(el.textContent).then(() => { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 900); }).catch(() => {});
}));

function feedMode() {
  // New screens follow the shared stream automatically once there is one.
  return prefs.feedSource || (feedUrl() ? 'network' : 'off');
}

function showFeedOptions() {
  const mode = $('#feedSource').value;
  $$('.feed-opts').forEach((el) => (el.hidden = el.dataset.feed !== mode));
  if (mode === 'local') refreshVideoDevices();
}

async function refreshVideoDevices() {
  const devices = await listVideoInputs().catch(() => []);
  const sel = $('#feedDevice');
  sel.innerHTML = '<option value="">Default camera</option>' +
    devices.map((d) => `<option value="${d.deviceId}">${esc(d.label || 'Camera ' + d.deviceId.slice(0, 6))}</option>`).join('');
  const preferred = devices.find((d) => /decklink|blackmagic|obs virtual|ndi/i.test(d.label));
  sel.value = devices.some((d) => d.deviceId === prefs.feedDevice) ? prefs.feedDevice : preferred ? preferred.deviceId : '';
}

function startFeed() {
  const mode = feedMode();
  if (mode === 'local') feed.start('local', prefs.feedDevice);
  else if (mode === 'network') feed.start('network', feedUrl());
  else feed.stop();
}

if (VIDEO_IN) {
  // Video: GO / BACK / RESET sits at the top of the right-hand column, above Program feed.
  $(".side").prepend($(".transport"));
  let lastFeedUrl = null;
  // Keep the shared address field in sync, and reconnect when someone changes it.
  setInterval(() => {
    if (document.activeElement !== $('#feedUrl')) $('#feedUrl').value = store.state.show.settings.feedUrl || '';
    const url = feedUrl();
    if (lastFeedUrl === null) { lastFeedUrl = url; $('#feedSource').value = feedMode(); showFeedOptions(); startFeed(); return; }
    if (url !== lastFeedUrl) { lastFeedUrl = url; if (feedMode() === 'network') startFeed(); }
  }, 500);

  $('#feedSource').addEventListener('change', showFeedOptions);
  $('#feedStart').addEventListener('click', async () => {
    prefs.feedSource = $('#feedSource').value;
    if (prefs.feedSource === 'local') prefs.feedDevice = $('#feedDevice').value;
    if (prefs.feedSource === 'network') {
      const typed = $('#feedUrl').value.trim();
      if (typed !== (store.state.show.settings.feedUrl || '')) dispatch({ type: 'settings:update', patch: { feedUrl: typed } });
      const url = typed || feedUrl();
      $('#feedStatus').textContent = url ? `Connecting to ${normalizeFeedUrl(url)}…` : 'Enter the stream address first (the built-in MediaMTX is not running).';
      savePrefs();
      if (url) feed.start('network', url);
      return;
    }
    savePrefs();
    startFeed();
    if (prefs.feedSource === 'local') setTimeout(refreshVideoDevices, 1500); // names appear after permission
  });
  $('#feedBuiltIn').addEventListener('click', () => { $('#feedUrl').value = ''; $('#feedSource').value = 'network'; showFeedOptions(); $('#feedStart').click(); });
  $('#feedStop').addEventListener('click', () => { prefs.feedSource = 'off'; savePrefs(); $('#feedSource').value = 'off'; showFeedOptions(); feed.stop(); });
}

// ---- Title button: switch between Show Notes and Show Notes · Video ----------
{
  const btn = $('#modeToggle');
  btn.title = VIDEO_IN ? 'Turn video off (switch to Show Notes)' : 'Turn video on (switch to Show Notes · Video)';
  btn.classList.toggle('on', VIDEO_IN);
  btn.setAttribute('aria-checked', String(VIDEO_IN));
  btn.addEventListener('click', () => {
    btn.classList.toggle('on', !VIDEO_IN); // slide the knob, then switch pages
    setTimeout(() => { location.href = (VIDEO_IN ? '/' : '/video') + location.search; }, 220); // keeps the current tab
  });
}

// ---- Server-side LTC input: the Show Notes computer listens on any channel ----------
const serverLtc = { status: null, settings: null, available: false, devices: [] };

function onLtcServer(msg) {
  Object.assign(serverLtc, { status: msg.status, settings: msg.settings, available: msg.available });
  if ($('#srcType').value === 'server') setSrcStatus(msg.status);
  if (msg.status?.state === 'off') $('#srvMeter').style.width = '0';
}

async function refreshServerDevices() {
  try {
    const info = await (await fetch('/api/ltc')).json();
    Object.assign(serverLtc, { status: info.status, settings: info.settings, available: info.available, devices: info.devices || [] });
    const sel = $('#srvDevice');
    if (!info.available) {
      sel.innerHTML = '<option value="">Not available</option>';
      setSrcStatus({ text: info.error || 'Server audio input is not available.' });
      return;
    }
    sel.innerHTML = serverLtc.devices.length
      ? serverLtc.devices.map((d) => `<option value="${esc(d.name)}">${esc(d.name)} · ${d.inputChannels} ch</option>`).join('')
      : '<option value="">No audio inputs found</option>';
    const preferred = serverLtc.devices.find((d) => d.name === info.settings?.deviceName) || serverLtc.devices.find((d) => /dante/i.test(d.name)) || serverLtc.devices.find((d) => d.isDefaultInput);
    if (preferred) sel.value = preferred.name;
    fillServerChannels(info.settings?.channel ?? 2);
    setSrcStatus(info.status);
  } catch {
    setSrcStatus({ text: 'Server audio input needs the Show Notes server (not available in local-only mode).' });
  }
}

function fillServerChannels(selected) {
  const dev = serverLtc.devices.find((d) => d.name === $('#srvDevice').value);
  const n = dev ? dev.inputChannels : 0;
  $('#srvChannel').innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${i + 1}</option>`).join('');
  if (n) $('#srvChannel').value = String(Math.min(selected, n - 1));
}
$('#srvDevice').addEventListener('change', () => fillServerChannels(+$('#srvChannel').value || 0));

async function startServerLTC() {
  setSrcStatus({ text: 'Starting…' });
  const res = await fetch('/api/ltc/start', { method: 'POST', body: JSON.stringify({ deviceName: $('#srvDevice').value, channel: +$('#srvChannel').value }) }).catch(() => null);
  if (!res) setSrcStatus({ text: 'Could not reach the Show Notes server.' });
}

async function stopServerLTC() {
  await fetch('/api/ltc/stop', { method: 'POST', body: '{}' }).catch(() => null);
}
