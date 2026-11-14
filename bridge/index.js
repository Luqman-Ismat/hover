// Hover bridge: serves the phone app on your LAN and relays it to the League client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import { ClientState } from './state.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.HOVER_PORT || 7373);
const HOME = process.env.HOVER_HOME || path.join(os.homedir(), '.hover');
const DEVICES = path.join(HOME, 'devices.json');
const NTFY = process.env.HOVER_NTFY_TOPIC; // optional: push on queue pop via ntfy.sh
const COOKIE = 'hover_device';

fs.mkdirSync(HOME, { recursive: true });

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

client.on('readyCheck', () => {
  if (!NTFY) return;
  fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, {
    method: 'POST',
    headers: { Title: 'Match found', Priority: 'urgent', Tags: 'crossed_swords', Click: `http://${lanAddress()}:${PORT}` },
    body: 'Accept it from Hover.',
  }).catch(() => {});
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
    const file = STATIC[p] || path.join(WEB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!STATIC[p] && !file.startsWith(WEB)) return send(res, 403, '');
    const body = await fs.promises.readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found');
    return send(res, 200, body, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
});
