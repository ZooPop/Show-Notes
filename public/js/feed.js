// Program feed for Show Notes · Video.
// Plays either a capture device on this computer (DeckLink, OBS Virtual Camera, NDI Webcam)
// or a network stream from MediaMTX (WebRTC via WHEP, or HLS on browsers that play it natively).

/** Turn what the user typed into a playable URL. "192.168.1.50:8889/program" -> "http://192.168.1.50:8889/program/whep". */
export function normalizeFeedUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  const hls = /\.m3u8(\?.*)?$/i.test(u);
  // No port typed? Use MediaMTX's defaults: 8889 for WebRTC, 8888 for HLS.
  try {
    const url = new URL(u);
    if (!url.port) { url.port = hls ? '8888' : '8889'; u = url.toString().replace(/\/+$/, ''); }
  } catch { /* leave as typed */ }
  if (hls || /\/whep$/i.test(u)) return u;
  return u + '/whep';
}

export async function listVideoInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
}

export class ProgramFeed {
  constructor(video, onStatus) {
    this.video = video;
    this.onStatus = onStatus;
    this.pc = null;
    this.stream = null;
    this.retry = null;
    this.mode = 'off';
    this.target = '';
    video.muted = true; // picture only: never feed program audio back into the room
  }

  status(state, text) {
    this.state = state;
    this.onStatus?.(state, text);
  }

  async start(mode, target) {
    this.stop(true);
    this.mode = mode;
    this.target = target;
    if (mode === 'local') return this.startLocal(target);
    if (mode === 'network') return this.startNetwork(target);
    this.status('off', 'Program feed off.');
  }

  async startLocal(deviceId) {
    if (!window.isSecureContext) {
      this.status('error', 'Capture devices only work on the computer itself (open Show Notes at http://localhost:3000/video). Other screens: use Network stream.');
      return;
    }
    try {
      this.status('connecting', 'Opening capture device…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
      });
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      const s = this.stream.getVideoTracks()[0]?.getSettings() || {};
      this.status('live', `Live from capture device${s.width ? ` · ${s.width}×${s.height}` : ''}`);
    } catch (e) {
      this.status('error', `Could not open the capture device: ${e.message}`);
    }
  }

  async startNetwork(rawUrl) {
    const url = normalizeFeedUrl(rawUrl);
    if (!url) return this.status('error', 'No stream address set. Enter it under Program feed.');
    if (/\.m3u8/i.test(url)) {
      // HLS: plays natively on Safari and most smart-TV browsers (5–10 s behind live).
      if (!this.video.canPlayType('application/vnd.apple.mpegurl')) {
        return this.status('error', 'This browser cannot play HLS (.m3u8). Use the WebRTC address instead.');
      }
      this.video.srcObject = null;
      this.video.src = url;
      this.video.play().catch(() => {});
      this.video.onplaying = () => this.status('live', 'Live (HLS stream)');
      this.video.onerror = () => this.scheduleRetry('Stream unavailable');
      return this.status('connecting', 'Connecting to stream…');
    }
    try {
      this.status('connecting', 'Connecting to stream…');
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => {
        if (e.track.kind !== 'video') return;
        this.video.srcObject = e.streams[0] || new MediaStream([e.track]);
        this.video.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'connected') { clearTimeout(this.iceTimer); this.status('live', 'Live (network stream)'); }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.scheduleRetry('Stream dropped');
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc, 2000);
      const abort = new AbortController();
      const answerTimer = setTimeout(() => abort.abort(), 6000);
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp, signal: abort.signal });
      } catch (err) {
        const host = new URL(url).host;
        throw new Error(err.name === 'AbortError' ? `MediaMTX at ${host} didn't answer` : `can't reach MediaMTX at ${host} (is it running, and is TCP ${new URL(url).port || 80} allowed through that PC's firewall?)`);
      } finally {
        clearTimeout(answerTimer);
      }
      if (!res.ok) throw new Error(res.status === 404 ? 'no stream at that address (is OBS streaming?)' : `server answered ${res.status}`);
      if (pc !== this.pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      // MediaMTX answered, so the video itself must now connect (UDP 8189 by default). If it doesn't,
      // say why instead of sitting on "Connecting…" forever.
      clearTimeout(this.iceTimer);
      this.iceTimer = setTimeout(() => {
        if (pc === this.pc && pc.connectionState !== 'connected') {
          this.scheduleRetry(`Reached MediaMTX, but the video didn't come through. On the video PC, allow UDP 8189 through the firewall (network set to Private) and set webrtcAdditionalHosts in mediamtx.yml`);
        }
      }, 8000);
    } catch (e) {
      this.scheduleRetry(`Not connected: ${e.message}`);
    }
  }

  scheduleRetry(reason) {
    if (this.mode !== 'network') return;
    this.status('error', `${reason} — retrying…`);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.start(this.mode, this.target), 3000);
  }

  stop(silent = false) {
    clearTimeout(this.iceTimer);
    clearTimeout(this.retry);
    this.retry = null;
    if (this.pc) { this.pc.close(); this.pc = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.onplaying = this.video.onerror = null;
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    this.mode = 'off';
    if (!silent) this.status('off', 'Program feed off.');
  }
}

function waitForIce(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeoutMs);
  });
}
