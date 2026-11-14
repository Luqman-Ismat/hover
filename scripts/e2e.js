// End-to-end test: boots the mock client + bridge on spare ports, then acts as the phone.
// Run with `npm test`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hover-e2e-'));
const PORT = 7399;
const env = { ...process.env, HOVER_PORT: String(PORT), MOCK_PORT: '52499', MOCK_SPEED: '5', HOVER_HOME: tmp, HOVER_LOCKFILE: path.join(tmp, 'lockfile') };
const base = `http://127.0.0.1:${PORT}`;

const mock = spawn(process.execPath, ['mock/lcu.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
const bridge = spawn(process.execPath, ['bridge/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
const done = (code) => { mock.kill(); bridge.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
const timeout = setTimeout(() => { console.error('✗ timed out'); done(1); }, 120_000);

let out = '';
const code = await new Promise((resolve) => bridge.stdout.on('data', (b) => { out += b; const m = out.match(/Pairing code\s+(\d{3}) (\d{3})/); if (m) resolve(m[1] + m[2]); }));
const ok = (msg) => console.log('✓', msg);

try {
  assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { paired: false });
  const bad = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: '000000' === code ? '111111' : '000000' }) });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json(), { paired: true });
  ok('pairing: wrong code rejected, right code issues a device cookie');

  // Unauthenticated socket is refused.
  await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    w.on('open', () => reject(new Error('unauthenticated socket opened')));
    w.on('error', () => resolve());
  });
  ok('socket without a device cookie is refused');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  let state = null, data = null, seq = 0;
  const waiters = [], pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'state') { state = m.state; waiters.slice().forEach((w) => w()); }
    if (m.type === 'data') data = m.data;
    if (m.type === 'result') pending.get(m.id)?.(m);
  });
  await new Promise((r) => ws.on('open', r));
  const until = (pred, label) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waiting for ${label}; phase=${state?.phase}`)), 60_000);
    const check = () => { if (state && pred(state)) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); resolve(state); } };
    waiters.push(check); check();
  });
  const cmd = (type, extra = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, type, ...extra })); });

  await until((s) => s.lcu && s.phase === 'Lobby' && s.queueName, 'lobby');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(data && data.champions.length > 150 && data.champions.every((c) => c.id < 10000), 'champion data');
  assert.ok(data.spells.some((s) => s.id === 4 && s.modes.includes('CLASSIC')), 'spell data');
  ok(`lobby "${state.queueName}" with ${data.champions.length} champions and ${data.spells.length} spells`);

  const img = await fetch(`${base}/asset?p=${encodeURIComponent(data.champions[0].icon)}`, { headers: { cookie } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image/);
  assert.equal((await fetch(`${base}/asset?p=${encodeURIComponent(data.champions[0].icon)}`)).status, 401);
  assert.equal((await fetch(`${base}/asset?p=${encodeURIComponent('/lol-summoner/v1/current-summoner')}`, { headers: { cookie } })).status, 400);
  ok('asset proxy serves icons to paired devices only, and only game-data paths');

  assert.equal((await cmd('rawRequest', { path: '/lol-login/v1/session' })).ok, false);
  ok('unknown commands are rejected');

  assert.ok((await cmd('search')).ok);
  await until((s) => s.phase === 'Matchmaking' && s.search, 'queue');
  ok('find match -> in queue');
  await until((s) => s.phase === 'ReadyCheck' && s.readyCheck?.response === 'None', 'ready check');
  assert.ok((await cmd('accept')).ok);
  await until((s) => s.readyCheck?.response === 'Accepted', 'accepted');
  ok('match found -> accepted');

  await until((s) => s.phase === 'ChampSelect' && s.session?.timer?.phase === 'PLANNING' && s.pickable.length, 'planning');
  const me = () => state.session.myTeam.find((m) => m.cellId === state.session.me);
  const mine = () => state.session.actions.flat().filter((a) => a.actor === state.session.me);
  const want = state.pickable[0];
  assert.ok((await cmd('hover', { championId: want })).ok);
  await until(() => me().championPickIntent === want, 'pick intent');
  ok(`planning: declared ${data.champions.find((c) => c.id === want).name}`);

  const early = await cmd('lock');
  assert.equal(early.ok, false);
  ok(`lock before your turn refused ("${early.error}")`);

  await until(() => mine().some((a) => a.type === 'ban' && a.active), 'my ban turn');
  const ban = state.bannable.find((id) => id !== want);
  assert.ok((await cmd('hover', { championId: ban })).ok);
  await until(() => mine().find((a) => a.type === 'ban').championId === ban, 'ban hover');
  assert.ok((await cmd('lock')).ok);
  await until(() => mine().find((a) => a.type === 'ban').completed, 'ban done');
  ok(`banned ${data.champions.find((c) => c.id === ban).name}`);

  await until(() => mine().some((a) => a.type === 'pick' && a.active), 'my pick turn');
  const pick = state.pickable.includes(want) ? want : state.pickable[0];
  assert.ok((await cmd('hover', { championId: pick })).ok);
  await until(() => mine().find((a) => a.type === 'pick').championId === pick, 'pick hover');
  assert.ok((await cmd('lock')).ok);
  await until(() => mine().find((a) => a.type === 'pick').completed && me().championId === pick, 'locked');
  ok(`locked in ${data.champions.find((c) => c.id === pick).name}`);

  assert.ok((await cmd('spells', { spell1Id: 12, spell2Id: 4 })).ok);
  await until(() => me().spell1Id === 12 && me().spell2Id === 4, 'spells');
  ok('spells set to Teleport + Flash');

  await until((s) => s.phase === 'InProgress', 'in game');
  ok('champ select finished -> in game');

  // ARAM: bench + reroll
  await until((s) => s.phase === 'Lobby', 'back to lobby');
  assert.ok((await cmd('createLobby', { queueId: 450 })).ok);
  await until((s) => s.phase === 'Lobby' && s.lobby?.queueId === 450, 'aram lobby');
  await cmd('search');
  await until((s) => s.phase === 'ReadyCheck', 'aram ready check');
  await cmd('accept');
  await until((s) => s.phase === 'ChampSelect' && s.session?.bench, 'aram select');
  const before = me().championId;
  assert.ok((await cmd('reroll')).ok);
  await until(() => me().championId !== before && state.session.rerolls === 1, 'reroll');
  const benchId = state.session.bench.find((id) => id > 0);
  assert.ok((await cmd('bench', { championId: benchId })).ok);
  await until(() => me().championId === benchId, 'bench swap');
  ok('ARAM: rerolled and swapped from the bench');

  console.log('\nAll checks passed.');
  clearTimeout(timeout);
  done(0);
} catch (err) {
  console.error('✗', err.message);
  done(1);
}
