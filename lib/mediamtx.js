// Built-in MediaMTX: Show Notes downloads MediaMTX (free, MIT licensed) on first run, starts it
// with the server and stops it on exit, so OBS can stream straight to the Show Notes computer
// and every Show Notes · Video screen can play the program feed. Nothing to launch by hand.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

export const PINNED_VERSION = 'v1.12.2'; // used only if GitHub's "latest release" lookup fails
const WEBRTC_PORT = 8889;
const API_PORT = 9997;
export const STREAM_PATH = 'program';

/** MediaMTX release archive name for this computer, e.g. mediamtx_v1.12.2_windows_amd64.zip. */
export function assetPattern(platform = process.platform, arch = process.arch) {
  const o = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[arch];
  if (!o || !a) return null;
  const ext = platform === 'win32' ? 'zip' : 'tar\\.gz';
  const archRe = a === 'arm64' && o === 'linux' ? 'arm64(v8)?' : a;
  return new RegExp(`^mediamtx_v[\\d.]+_${o}_${archRe}\\.${ext}$`);
}

export function pinnedAssetName(platform = process.platform, arch = process.arch) {
  const o = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const a = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[arch];
  if (!o || !a) return null;
  return `mediamtx_${PINNED_VERSION}_${o}_${a}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

export function pickAsset(assets, platform, arch) {
  const re = assetPattern(platform, arch);
  return re ? assets.find((x) => re.test(x.name)) || null : null;
}

/** This computer's network addresses, so other screens can receive the video (webrtcAdditionalHosts). */
export function lanAddresses() {
  const out = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

export class BuiltInMediaMTX {
  constructor({ dir, onStatus, log = console.log }) {
    this.dir = dir;
    this.onStatus = onStatus;
    this.log = log;
    this.bin = path.join(dir, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
    this.proc = null;
    this.stopping = false;
    this.restarts = 0;
    this.status = { state: 'off', text: 'Built-in MediaMTX is off.', publishing: false };
    this.tail = [];
  }

  setStatus(patch) {
    const next = { ...this.status, ...patch, hosts: lanAddresses(), port: WEBRTC_PORT, path: STREAM_PATH };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) this.onStatus?.(this.status);
  }

  async start() {
    if (/^(off|0|no|false)$/i.test(process.env.SHOWNOTES_MEDIAMTX || '')) {
      return this.setStatus({ state: 'disabled', text: 'Built-in MediaMTX is turned off (SHOWNOTES_MEDIAMTX=off).' });
    }
    if (await portInUse(WEBRTC_PORT)) {
      // MediaMTX (or something else) is already running here: use it instead of starting another.
      this.setStatus({ state: 'external', text: 'MediaMTX is already running on this computer. Using it.' });
      this.pollPublishing();
      return;
    }
    try {
      const bin = process.env.MEDIAMTX_PATH || (await this.ensureBinary());
      this.launch(bin);
    } catch (e) {
      this.setStatus({ state: 'error', text: `Couldn't set up MediaMTX: ${e.message}` });
    }
  }

  async ensureBinary() {
    if (fs.existsSync(this.bin)) return this.bin;
    fs.mkdirSync(this.dir, { recursive: true });
    this.setStatus({ state: 'downloading', text: 'Downloading MediaMTX (first run only)…' });
    let url = null;
    try {
      const r = await fetch('https://api.github.com/repos/bluenviron/mediamtx/releases/latest', { headers: { 'user-agent': 'show-notes', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (r.ok) url = pickAsset((await r.json()).assets || [])?.browser_download_url || null;
    } catch { /* fall back to the pinned release */ }
    if (!url) {
      const name = pinnedAssetName();
      if (!name) throw new Error(`no MediaMTX build for ${process.platform}/${process.arch}`);
      url = `https://github.com/bluenviron/mediamtx/releases/download/${PINNED_VERSION}/${name}`;
    }
    const archive = path.join(this.dir, path.basename(new URL(url).pathname));
    const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`download failed (${res.status}) from ${url}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // tar extracts .tar.gz everywhere and .zip on Windows 10+ (bsdtar ships with Windows).
    await new Promise((resolve, reject) => execFile('tar', ['-xf', archive, '-C', this.dir], (err) => (err ? reject(new Error(`couldn't unpack ${path.basename(archive)}: ${err.message}`)) : resolve())));
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(this.bin)) throw new Error('mediamtx was not in the download');
    if (process.platform !== 'win32') fs.chmodSync(this.bin, 0o755);
    this.log(`MediaMTX downloaded to ${this.dir}`);
    return this.bin;
  }

  launch(bin) {
    this.setStatus({ state: 'starting', text: 'Starting MediaMTX…' });
    const cwd = path.dirname(bin);
    const yml = path.join(cwd, 'mediamtx.yml');
    const hosts = lanAddresses();
    const env = {
      ...process.env,
      // Tell MediaMTX this computer's addresses so other screens actually receive the video.
      MTX_WEBRTCADDITIONALHOSTS: hosts.join(','),
      // Local-only status API, so Show Notes can say whether OBS is streaming.
      MTX_API: 'yes',
      MTX_APIADDRESS: `127.0.0.1:${API_PORT}`,
    };
    const proc = spawn(bin, fs.existsSync(yml) ? [yml] : [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const onLine = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > 40) this.tail.shift();
        if (/\[WebRTC\] listener opened on/i.test(line) && this.status.state === 'starting') {
          this.restarts = 0;
          this.setStatus({ state: 'running', text: 'Built-in MediaMTX is running.' });
        }
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('error', (e) => this.setStatus({ state: 'error', text: `Couldn't start MediaMTX: ${e.message}` }));
    proc.on('exit', (code) => {
      if (proc !== this.proc) return;
      this.proc = null;
      clearInterval(this.pollTimer);
      if (this.stopping) return;
      const why = this.tail.slice(-3).join(' ').replace(/\s+/g, ' ').slice(-300);
      if (/address already in use|only one usage of each socket/i.test(why)) {
        return this.setStatus({ state: 'error', text: 'A MediaMTX port is already taken on this computer (8889, 8189, 1935 or 8888). Close the other MediaMTX and restart Show Notes.', publishing: false });
      }
      this.restarts++;
      const wait = Math.min(30, 2 ** this.restarts);
      this.setStatus({ state: 'error', text: `MediaMTX stopped (${code ?? 'killed'}${why ? `: ${why}` : ''}). Restarting in ${wait} s…`, publishing: false });
      this.restartTimer = setTimeout(() => this.launch(bin), wait * 1000);
    });
    // If its startup line is missed (log format changes between versions), the open port says it's up.
    setTimeout(async () => { if (proc === this.proc && this.status.state === 'starting' && (await portInUse(WEBRTC_PORT))) this.setStatus({ state: 'running', text: 'Built-in MediaMTX is running.' }); }, 2500);
    this.pollPublishing();
  }

  /** Ask MediaMTX whether OBS is streaming to /program (the API only answers on this computer). */
  pollPublishing() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${API_PORT}/v3/paths/get/${STREAM_PATH}`, { signal: AbortSignal.timeout(1500) });
        if (r.status === 404) return this.setStatus({ publishing: false });
        if (!r.ok) return;
        const p = await r.json();
        this.setStatus({ publishing: !!p.ready, readers: (p.readers || []).length });
      } catch { /* API not reachable (e.g. an external MediaMTX without it): leave as is */ }
    }, 2000);
  }

  stop() {
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.restartTimer);
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }
}
