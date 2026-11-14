// Show Notes server: serves the web app, holds the authoritative show state,
// runs the cue engine and syncs every connected browser over WebSocket.
// Optional OSC in/out over UDP for integration with QLab, consoles, etc.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { apply, createState, normalizeShow } from './public/js/engine.js';
import { parseTC } from './public/js/timecode.js';
import * as osc from './lib/osc.js';
import { ServerLTCInput } from './lib/ltc-input.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 3000);
const OSC_PORT = +(process.env.OSC_PORT || 53100);
const DATA_FILE = process.env.SHOW_FILE || path.join(__dirname, 'data', 'show.json');
const PUBLIC = path.join(__dirname, 'public');

// ---- state ---------------------------------------------------------------
const TEMPLATE_DIRS = [path.join(__dirname, 'data', 'private'), path.join(__dirname, 'data')];
let state = createState(loadShow());
let saveTimer = null;

// Show templates: data/*.json (shared, committed) and data/private/*.json (local only, git-ignored).

function listTemplates() {
  const out = [];
  for (const dir of TEMPLATE_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('show.json')).sort(); } catch { continue; }
    for (const f of files) {
      try {
        const show = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push({ id: `${path.basename(dir) === 'private' ? 'private/' : ''}${f}`, name: show.name || f, cues: (show.cues || []).length });
      } catch { /* skip unreadable files */ }
    }
  }
  return out;
}

function readTemplate(id) {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) return null;
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', t.id), 'utf8'));
}

function loadShow() {
  try {
    return normalizeShow(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    // First run: start from a private show if there is one, else the example.
    const first = listTemplates()[0];
    try { return normalizeShow(first ? readTemplate(first.id) : {}); } catch { return normalizeShow({}); }
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state.show, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 300);
}

function dispatch(action, origin = 'server') {
  if (!action || typeof action.type !== 'string') return;
  action = { ...action, at: Date.now() };
  if (!action.source) action.source = origin;
  const prev = state;
  const result = apply(state, action);
  state = result.state;
  if (state.show !== prev.show) {
    scheduleSave();
    broadcast({ type: 'show', show: state.show });
  }
  if (state.runtime !== prev.runtime) broadcast({ type: 'runtime', runtime: state.runtime, now: Date.now() });
  if (state.log !== prev.log && state.log.length === 0) broadcast({ type: 'log', log: [] });
  for (const ev of result.events) {
    if (ev.entry) broadcast({ type: 'event', event: { type: ev.type, entry: ev.entry } });
    if (ev.type === 'fired') sendCueOsc(ev.cue);
  }
}

// ---- HTTP ----------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/show' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(state.show, null, 2));
  }
  if (url.pathname === '/api/ltc' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ available: ltcIn.available, error: ltcIn.loadError, status: ltcIn.status, settings: ltcIn.settings, devices: ltcIn.listDevices() }));
  }
  if ((url.pathname === '/api/ltc/start' || url.pathname === '/api/ltc/stop') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch {}
      if (url.pathname.endsWith('/start')) ltcIn.start({ deviceId: opts.deviceId, deviceName: opts.deviceName, channel: Number(opts.channel) || 0 });
      else ltcIn.stop();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ltcIn.status, settings: ltcIn.settings }));
    });
    return;
  }
  if (url.pathname === '/api/logo' && req.method === 'GET') {
    // Optional organisation logo: data/private/logo.png (git-ignored) or data/logo.png.
    for (const f of [path.join(__dirname, 'data', 'private', 'logo.png'), path.join(__dirname, 'data', 'logo.png')]) {
      if (fs.existsSync(f)) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
        return fs.createReadStream(f).pipe(res);
      }
    }
    res.writeHead(404);
    return res.end();
  }
  if (url.pathname === '/api/templates' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const body = id ? readTemplate(id) : listTemplates();
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ runtime: state.runtime, log: state.log, now: Date.now() }));
  }
  if (url.pathname === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        dispatch(JSON.parse(body), 'http');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runtime: state.runtime }));
      } catch (e) {
        res.writeHead(400); res.end(String(e.message));
      }
    });
    return;
  }
  if (url.pathname === '/video/') { res.writeHead(301, { location: '/video' + url.search }); return res.end(); }
  if (url.pathname === '/video') url.pathname = '/index.html'; // Show Notes · Video
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const useHttps = process.env.HTTPS_KEY && process.env.HTTPS_CERT;
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(process.env.HTTPS_KEY), cert: fs.readFileSync(process.env.HTTPS_CERT) }, handler)
  : http.createServer(handler);

// ---- WebSocket -----------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });
let clientSeq = 0;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}

function clientList() {
  return [...wss.clients].map((ws) => ({ id: ws.id, name: ws.name, role: ws.role }));
}

wss.on('connection', (ws, req) => {
  ws.id = ++clientSeq;
  ws.name = `client-${ws.id}`;
  ws.role = 'viewer';
  ws.send(JSON.stringify({ type: 'hello', id: ws.id, show: state.show, runtime: state.runtime, log: state.log }));
  ws.send(JSON.stringify({ type: 'ltcServer', status: ltcIn.status, settings: ltcIn.settings, available: ltcIn.available }));
  broadcast({ type: 'clients', clients: clientList() });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'action') dispatch(msg.action, ws.name);
    else if (msg.type === 'identify') {
      ws.name = String(msg.name || ws.name).slice(0, 40);
      ws.role = String(msg.role || 'viewer').slice(0, 20);
      broadcast({ type: 'clients', clients: clientList() });
    }
  });
  ws.on('close', () => broadcast({ type: 'clients', clients: clientList() }));
});

// ---- OSC -----------------------------------------------------------------
const oscSocket = dgram.createSocket('udp4');
oscSocket.on('message', (buf) => {
  let messages;
  try { messages = osc.decode(buf); } catch { return; }
  for (const { address, args } of messages) handleOsc(address, args);
});
oscSocket.on('error', (e) => console.warn(`OSC: ${e.message}`));
oscSocket.bind(OSC_PORT, () => console.log(`OSC listening on udp/${OSC_PORT}`));

function handleOsc(address, args) {
  const a = address.toLowerCase();
  if (a === '/shownotes/go') dispatch({ type: 'go' }, 'osc');
  else if (a === '/shownotes/back') dispatch({ type: 'back' }, 'osc');
  else if (a === '/shownotes/reset') dispatch({ type: 'reset' }, 'osc');
  else if (a === '/shownotes/goto') dispatch({ type: 'goto', number: String(args[0]) }, 'osc');
  else if (a === '/shownotes/load') dispatch({ type: 'goto', number: String(args[0]), fire: false }, 'osc');
  else if (a === '/shownotes/tc') {
    // "/shownotes/tc 01:00:10:12 [fps]" — lets any device on the network push timecode.
    const tc = parseTC(args[0]);
    if (tc) dispatch({ type: 'timecode', tc: { ...tc, fps: Number(args[1]) || undefined, source: 'osc' } }, 'osc');
  }
}

function sendCueOsc(cue) {
  const target = state.show.settings.oscTarget;
  if (!cue?.osc || !target) return;
  const [host, port] = target.split(':');
  if (!host || !+port) return;
  for (const line of String(cue.osc).split(/[\n;]+/)) {
    const msg = osc.parseMessageString(line);
    if (msg) oscSocket.send(osc.encode(msg.address, msg.args), +port, host);
  }
}

// ---- start ---------------------------------------------------------------
// ---- Server-side LTC input (any channel of any audio device on this computer) ----
let ltcLevelAt = 0;
const ltcIn = new ServerLTCInput({
  settingsFile: path.join(__dirname, 'data', 'ltc-input.json'),
  onTC: (tc) => dispatch({ type: 'timecode', tc }, 'ltc-in'),
  onStatus: (status) => broadcast({ type: 'ltcServer', status, settings: ltcIn.settings, available: ltcIn.available }),
  onLevel: (peak) => { const now = Date.now(); if (now - ltcLevelAt > 90) { ltcLevelAt = now; broadcast({ type: 'ltcLevel', peak }); } },
});
ltcIn.autoStart();

server.listen(PORT, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`\nShow Notes running:`);
  console.log(`  ${proto}://localhost:${PORT}            (use this on the Dante/TC machine)`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`  ${proto}://${n.address}:${PORT}`);
  }
  console.log(`  Display view: /?view=display\n`);
});
