// Connection to the local League Client API (LCU).
// Credentials come from the client's lockfile or, failing that, the
// LeagueClientUx process arguments. REST is HTTPS with a self-signed cert;
// events arrive over a WAMP-style WebSocket on the same port.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const LOCKFILES = {
  darwin: ['/Applications/League of Legends.app/Contents/LoL/lockfile'],
  win32: ['C:\\Riot Games\\League of Legends\\lockfile'],
};

function parseLockfile(text) {
  const [, , port, password, protocol] = text.trim().split(':');
  if (!port || !password) return null;
  return { port: Number(port), password, protocol: protocol || 'https' };
}

function parseArgs(cmdline) {
  if (!cmdline) return null;
  const port = cmdline.match(/--app-port=(\d+)/)?.[1];
  const password = cmdline.match(/--remoting-auth-token=([\w-]+)/)?.[1];
  return port && password ? { port: Number(port), password, protocol: 'https' } : null;
}

function fromProcess() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"],
        { windowsHide: true },
        (err, out) => resolve(err ? null : parseArgs(out)),
      );
    } else {
      execFile('ps', ['-A', '-o', 'args='], { maxBuffer: 8 << 20 }, (err, out) => {
        if (err) return resolve(null);
        resolve(parseArgs(out.split('\n').find((l) => l.includes('LeagueClientUx'))));
      });
    }
  });
}

export async function findCredentials() {
  const explicit = process.env.HOVER_LOCKFILE;
  const paths = explicit ? [explicit] : LOCKFILES[process.platform] || [];
  for (const p of paths) {
    try {
      const creds = parseLockfile(fs.readFileSync(p, 'utf8'));
      if (creds) return creds;
    } catch {}
  }
  return explicit ? null : fromProcess();
}

// Event names are the endpoint path with "/" swapped for "_".
export const eventName = (uri) => 'OnJsonApiEvent' + uri.replaceAll('/', '_');

export class LCU extends EventEmitter {
  constructor(subscriptions) {
    super();
    this.subscriptions = subscriptions;
    this.creds = null;
    this.ws = null;
    this.connected = false;
  }

  start() {
    const tick = async () => {
      if (!this.connected && !this.connecting) {
        this.connecting = true;
        try {
          const creds = await findCredentials();
          if (creds) await this.#connect(creds);
        } catch {}
        this.connecting = false;
      }
      setTimeout(tick, this.connected ? 5000 : 2000);
    };
    tick();
  }

  #auth(creds = this.creds) {
    return 'Basic ' + Buffer.from(`riot:${creds.password}`).toString('base64');
  }

  #connect(creds) {
    return new Promise((resolve, reject) => {
      const scheme = creds.protocol === 'http' ? 'ws' : 'wss';
      const ws = new WebSocket(`${scheme}://127.0.0.1:${creds.port}/`, {
        headers: { Authorization: this.#auth(creds) },
        rejectUnauthorized: false,
      });
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.creds = creds;
        this.ws = ws;
        this.connected = true;
        for (const uri of this.subscriptions) ws.send(JSON.stringify([5, eventName(uri)]));
        this.emit('connect');
        resolve();
      });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (Array.isArray(msg) && msg[0] === 8 && msg[2]) this.emit('event', msg[2]);
      });
      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
          this.emit('disconnect');
        }
        if (!opened) reject(new Error('closed'));
      });
      ws.on('error', (err) => { if (!opened) reject(err); });
    });
  }

  #raw(method, path, body) {
    if (!this.creds) return Promise.reject(new Error('League client is not running'));
    const { port, protocol } = this.creds;
    const lib = protocol === 'http' ? http : https;
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          host: '127.0.0.1', port, path, method,
          rejectUnauthorized: false,
          headers: {
            Authorization: this.#auth(),
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 8000,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error('LCU request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // JSON request. Resolves { status, data }; never throws on HTTP errors.
  async request(method, path, body) {
    const res = await this.#raw(method, path, body);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.statusCode, data };
  }

  async get(path) {
    const { status, data } = await this.request('GET', path);
    return status >= 200 && status < 300 ? data : null;
  }

  // Binary asset fetch (champion icons etc.).
  async asset(path) {
    const res = await this.#raw('GET', path);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    return { status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) };
  }
}
