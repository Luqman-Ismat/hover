// Hover bridge: serves the phone app on your LAN and relays it to the League client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { ClientState } from './state.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The desktop app (desktop/main.js) sets this to hear when Hover is up or failed to start.
const HOST = globalThis.__hoverHost || null;
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.HOVER_PORT || 7373);
const HOME = process.env.HOVER_HOME || path.join(os.homedir(), '.hover');
const DEVICES = path.join(HOME, 'devices.json');
const COOKIE = 'hover_device';

fs.mkdirSync(HOME, { recursive: true });
// Optional settings without env vars: ~/.hover/config.json  { "ntfyTopic": "hover-…" }
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch { return {}; } })();
const NTFY = process.env.HOVER_NTFY_TOPIC || CONFIG.ntfyTopic; // optional: phone pushes via ntfy.sh

// ---- paired devices -------------------------------------------------------
const loadDevices = () => { try { return JSON.parse(fs.readFileSync(DEVICES, 'utf8')); } catch { return []; } };
let devices = loadDevices();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const saveDevices = () => fs.writeFileSync(DEVICES, JSON.stringify(devices, null, 2), { mode: 0o600 });

// A fresh 6-digit code each launch. Pairing is the only unauthenticated action.
const pairCode = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const attempts = new Map(); // ip -> [timestamps]

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
}
function authed(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return false;
  const h = hash(t);
  return devices.some((d) => crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h)));
}

// ---- client state ---------------------------------------------------------
const client = new ClientState();
client.start();

// Phone pushes (optional, via ntfy) for the moments you might be away from the screen.
function push(title, body, tags, priority = 'high') {
  if (!NTFY) return;
  fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, {
    method: 'POST',
    headers: { Title: title, Priority: priority, Tags: tags, Click: `http://${lanAddress()}:${PORT}` },
    body,
  }).catch(() => {});
}
client.on('readyCheck', () => push('Match found', 'Accept it from Hover.', 'crossed_swords', 'urgent'));
client.on('pickTimeout', (type) => {
  log(`Your ${type} timer is almost out`);
  push(type === 'ban' ? 'Ban now' : 'Pick now', '10 seconds left. If the timer runs out you’ll be removed from champ select.', 'hourglass', 'urgent');
});
client.on('gameLoaded', () => {
  log('Game loaded: the game timer has started');
  push('Game loaded', 'The game timer has started. Get to your computer.', 'video_game');
});
client.on('afkRisk', () => {
  log('Nothing bought yet: AFK warning likely soon');
  push('AFK warning coming', 'You haven’t bought anything yet. Get to your computer.', 'warning', 'urgent');
});

let lcuWasUp = null;
client.on('state', (s) => {
  if (s.lcu !== lcuWasUp) {
    lcuWasUp = s.lcu;
    log(s.lcu ? 'League client connected' : 'Waiting for the League client…');
  }
  broadcast({ type: 'state', state: s });
});
client.on('data', (d) => broadcast({ type: 'data', data: d }));

// ---- http ------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const STATIC = {
  '/vendor/preact.js': path.join(ROOT, 'node_modules/htm/preact/standalone.mjs'),
};
// Client assets (icons, splash art), kept in memory up to a byte budget. Oldest go first.
const assetCache = new Map();
const ASSET_BUDGET = 96 * 1024 * 1024;
let assetBytes = 0;
async function getAsset(ap) {
  let hit = assetCache.get(ap);
  if (hit) { assetCache.delete(ap); assetCache.set(ap, hit); return hit; }
  const r = await client.lcu.asset(ap);
  if (r.status !== 200) return null;
  hit = { type: r.type || 'image/png', body: r.body };
  assetCache.set(ap, hit);
  assetBytes += hit.body.length;
  for (const [k, v] of assetCache) {
    if (assetBytes <= ASSET_BUDGET) break;
    assetCache.delete(k); assetBytes -= v.body.length;
  }
  return hit;
}

// Per-champion art paths + title, from the client's champion detail file.
const champInfo = new Map();
async function getChampInfo(id) {
  if (champInfo.has(id)) return champInfo.get(id);
  const d = await client.lcu.get(`/lol-game-data/assets/v1/champions/${id}.json`).catch(() => null);
  const base = d?.skins?.find((s) => s.isBase) || d?.skins?.[0];
  if (!base) return null;
  const info = { id, title: d.title || '', splash: base.splashPath, wide: base.uncenteredSplashPath, tile: base.tilePath };
  champInfo.set(id, info);
  return info;
}
const ART = { splash: 'splash', wide: 'wide', tile: 'tile' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });

async function readBody(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // The Connect page and its status feed show the pairing code, so only this computer may see them.
    if (p === '/connect' || p === '/api/status') {
      if (!isLocal(req)) return send(res, 403, 'Only available on the computer running Hover.');
      if (p === '/api/status') return json(res, 200, status());
      return send(res, 200, connectPage(), { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (p === '/api/session') return json(res, 200, { paired: authed(req) });

    if (p === '/api/pair' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      const recent = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
      if (recent.length >= 5) return json(res, 429, { error: 'Too many tries. Wait a minute.' });
      attempts.set(ip, [...recent, now]);
      const { code } = await readBody(req);
      if (String(code).replace(/\D/g, '') !== pairCode) return json(res, 401, { error: 'That code doesn’t match. Check your computer.' });
      const token = crypto.randomBytes(32).toString('base64url');
      devices.push({ hash: hash(token), agent: String(req.headers['user-agent'] || '').slice(0, 160), paired: new Date().toISOString() });
      saveDevices();
      log(`Paired a new device (${devices.length} total)`);
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
      });
    }

    if (p === '/asset') {
      if (!authed(req)) return send(res, 401, '');
      const ap = url.searchParams.get('p') || '';
      if (!ap.startsWith('/lol-game-data/assets/') || ap.includes('..')) return send(res, 400, '');
      const hit = await getAsset(ap);
      if (!hit) return send(res, 404, '');
      return send(res, 200, hit.body, { 'Content-Type': hit.type, 'Cache-Control': 'private, max-age=86400' });
    }

    // /art?id=103&k=splash|wide|tile : champion splash art, resolved by the bridge.
    if (p === '/art') {
      if (!authed(req)) return send(res, 401, '');
      const id = Number(url.searchParams.get('id'));
      const key = ART[url.searchParams.get('k')] || 'splash';
      if (!Number.isInteger(id) || id <= 0 || id >= 10000) return send(res, 400, '');
      const info = await getChampInfo(id);
      const ap = info?.[key];
      if (!ap?.startsWith('/lol-game-data/assets/') || ap.includes('..')) return send(res, 404, '');
      const hit = await getAsset(ap);
      if (!hit) return send(res, 404, '');
      return send(res, 200, hit.body, { 'Content-Type': hit.type, 'Cache-Control': 'private, max-age=86400' });
    }

    // /api/champion?id=103 : { title } for the hero card.
    if (p === '/api/champion') {
      if (!authed(req)) return json(res, 401, {});
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id <= 0 || id >= 10000) return json(res, 400, {});
      const info = await getChampInfo(id);
      return info ? json(res, 200, { id, title: info.title }, { 'Cache-Control': 'private, max-age=86400' }) : json(res, 404, {});
    }

    if (req.method !== 'GET') return send(res, 405, '');
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = STATIC[p] || path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!STATIC[p] && !file.startsWith(WEB)) return send(res, 403, '');
    const body = await fs.promises.readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found');
    return send(res, 200, body, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

// ---- phone websocket -------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const sameOrigin = !origin || new URL(origin).host === req.headers.host;
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !sameOrigin || !authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state: client.snapshot() }));
  if (client.data && client.lcu.connected) ws.send(JSON.stringify({ type: 'data', data: client.data }));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      const out = await client.command(msg);
      // Only read commands hand data back; everything else is just ok/error.
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, ...(msg.type === 'friends' ? { data: out } : {}) }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: err.message }));
    }
  });
  // Keep timers honest while the phone sits on a screen.
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000);

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
}

// ---- startup ---------------------------------------------------------------
// ---- connect page (shown by the desktop app) --------------------------------
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
const phoneUrl = () => `http://${lanAddress()}:${PORT}`;
const pairUrl = () => `${phoneUrl()}/?code=${pairCode}`;
function status() {
  const s = client.snapshot();
  return { lcu: s.lcu, phase: s.phase, url: phoneUrl(), pairUrl: pairUrl(), code: pairCode, devices: devices.length };
}
// QR code as crisp SVG squares.
function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 4; // quiet zone
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges" role="img" aria-label="QR code to pair your iPhone"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#010a13"/></svg>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function connectPage() {
  const st = status();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hover</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { background: radial-gradient(ellipse at 50% 0%, #0d2a3a, #010a13 70%); color: #f0e6d2; font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; display: flex; flex-direction: column; align-items: center; padding: 26px 28px 22px; text-align: center; -webkit-user-select: none; user-select: none; }
  h1 { font: 700 20px/1 Georgia, serif; letter-spacing: .22em; color: #c8aa6e; display: flex; align-items: center; gap: 10px; }
  .status { margin-top: 14px; display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border: 1px solid rgba(200,170,110,.35); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #a09b8c; }
  .dot { width: 7px; height: 7px; transform: rotate(45deg); background: #5b5a56; }
  .on .dot { background: #0ac8b9; box-shadow: 0 0 8px #0ac8b9; }
  .qr { margin-top: 22px; width: 240px; height: 240px; padding: 10px; background: #fff; border: 2px solid #c8aa6e; box-shadow: 0 0 40px -8px rgba(10,200,185,.5); }
  .qr svg { display: block; width: 100%; height: 100%; }
  .lead { margin-top: 18px; font-size: 15px; font-weight: 600; }
  .sub { margin-top: 4px; color: #a09b8c; max-width: 30ch; }
  .code { margin-top: 18px; font: 700 30px/1 Georgia, serif; letter-spacing: .14em; color: #f0e6d2; }
  .codelabel { margin-top: 6px; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #a09b8c; }
  .url { margin-top: 12px; font-size: 12px; color: #5b5a56; -webkit-user-select: text; user-select: text; }
  .foot { margin-top: auto; padding-top: 18px; font-size: 12px; color: #5b5a56; max-width: 34ch; }
</style></head>
<body>
  <h1><svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><circle cx="16" cy="16" r="10.5" fill="none" stroke="#c8aa6e" stroke-opacity=".3" stroke-width="2.6"/><path d="M16 5.5A10.5 10.5 0 1 1 6.2 19.8" fill="none" stroke="#c8aa6e" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#c8aa6e"/></svg>HOVER</h1>
  <div class="status ${st.lcu ? 'on' : ''}" id="status"><i class="dot"></i><span>${st.lcu ? 'League connected' : 'Waiting for League'}</span></div>
  <div class="qr" id="qr">${qrSvg(st.pairUrl)}</div>
  <p class="lead">Scan with your iPhone camera</p>
  <p class="sub">Your iPhone needs to be on the same Wi‑Fi. Then tap Share → Add to Home Screen.</p>
  <p class="code">${esc(st.code.slice(0, 3))} ${esc(st.code.slice(3))}</p>
  <p class="codelabel">Pairing code</p>
  <p class="url">${esc(st.url)}</p>
  <p class="foot" id="foot">${st.devices ? `${st.devices} device${st.devices > 1 ? 's' : ''} paired. ` : ''}Closing this window keeps Hover running in the ${process.platform === 'darwin' ? 'menu bar' : 'system tray'}.</p>
<script>
  let url = ${JSON.stringify(st.pairUrl)};
  setInterval(async () => {
    try {
      const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
      if (s.pairUrl !== url) return location.reload(); // network changed
      const el = document.getElementById('status');
      el.className = 'status' + (s.lcu ? ' on' : '');
      el.querySelector('span').textContent = s.lcu ? 'League connected' : 'Waiting for League';
    } catch {}
  }, 2000);
</script>
</body></html>`;
}

function lanAddress() {
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).map((a) => ({ name, ...a })));
  const v4 = all.filter((a) => a.family === 'IPv4' && !a.internal);
  const pref = v4.find((a) => /^(en0|eth0|wlan0|Wi-Fi|Ethernet)/i.test(a.name)) || v4.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) || v4[0];
  return pref?.address || 'localhost';
}

function log(line) {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  console.log(`  ${t}  ${line}`);
}

server.on('error', (err) => {
  const message = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Another copy of Hover (or something else) is running on it.`
    : `Hover couldn’t start: ${err.message}`;
  if (HOST?.onError) return HOST.onError(message);
  console.error(`\n  ${message}\n`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://${lanAddress()}:${PORT}`;
  console.log(`\n  Hover is running\n`);
  console.log(`  Open on your phone   ${url}`);
  console.log(`  Pairing code         ${pairCode.slice(0, 3)} ${pairCode.slice(3)}`);
  if (NTFY) console.log(`  Queue alerts         ntfy topic “${NTFY}”`);
  console.log('');
  qrcode.generate(`${url}/?code=${pairCode}`, { small: true }, (q) => console.log(q.replace(/^/gm, '  ')));
  log('Waiting for the League client…');
  lcuWasUp = false;
  HOST?.onReady?.({ port: PORT });
});
