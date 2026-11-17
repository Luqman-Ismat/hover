// End-to-end test: boots the mock client + bridge on spare ports, then acts as the phone.
// Run with `npm test`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import WebSocket from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hover-e2e-'));
const PORT = 7399;
const env = { ...process.env, HOVER_PORT: String(PORT), MOCK_PORT: '52499', MOCK_LIVE_PORT: '52498', HOVER_LIVE_URL: 'http://127.0.0.1:52498', MOCK_SPEED: '5', HOVER_HOME: tmp, HOVER_NTFY_SERVER: 'http://127.0.0.1:52497', HOVER_LOCKFILE: path.join(tmp, 'lockfile') };
const base = `http://127.0.0.1:${PORT}`;

// Stand-in for ntfy.sh: records every phone notification the bridge sends.
const pushes = [];
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { pushes.push({ topic: decodeURIComponent(req.url.slice(1)), title: req.headers.title, priority: req.headers.priority, body }); res.end('{}'); });
}).listen(52497, '127.0.0.1');

const mock = spawn(process.execPath, ['mock/lcu.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
const bridge = spawn(process.execPath, ['bridge/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
const done = (code) => { ntfy.close(); mock.kill(); bridge.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
const timeout = setTimeout(() => { console.error('✗ timed out'); done(1); }, 300_000);

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
  const alerts = [];
  const waiters = [], pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'state') { state = m.state; waiters.slice().forEach((w) => w()); }
    if (m.type === 'data') data = m.data;
    if (m.type === 'result') pending.get(m.id)?.(m);
    if (m.type === 'alert') alerts.push(m.alert);
  });
  await new Promise((r) => ws.on('open', r));
  const until = (pred, label) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waiting for ${label}; phase=${state?.phase}`)), 60_000);
    const check = () => { if (state && pred(state)) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); resolve(state); } };
    waiters.push(check); check();
  });
  const debug = !!process.env.E2E_DEBUG;
  const cmd = (type, extra = {}) => new Promise((resolve) => {
    const id = ++seq;
    if (debug) console.log(`  → ${type} ${JSON.stringify(extra)}`);
    pending.set(id, (r) => { if (debug) console.log(`  ← ${type} ${r.ok ? "ok" : r.error}`); resolve(r); });
    ws.send(JSON.stringify({ ...extra, id, type }));
  });

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

  assert.ok(data.champions.some((c) => c.roles?.length), 'champion roles');
  const champ = data.champions.find((c) => c.alias === 'Ahri') || data.champions[0];
  for (const k of ['splash', 'tile']) {
    const art = await fetch(`${base}/art?id=${champ.id}&k=${k}`, { headers: { cookie } });
    assert.equal(art.status, 200, `art ${k}`);
    assert.match(art.headers.get('content-type'), /image/);
  }
  assert.equal((await fetch(`${base}/art?id=${champ.id}&k=splash`)).status, 401);
  assert.equal((await fetch(`${base}/art?id=-1`, { headers: { cookie } })).status, 400);
  const info = await (await fetch(`${base}/api/champion?id=${champ.id}`, { headers: { cookie } })).json();
  assert.ok(info.title, 'champion title');
  ok(`splash art + title for ${champ.name} (“${info.title}”), paired devices only`);

  assert.equal((await cmd('rawRequest', { path: '/lol-login/v1/session' })).ok, false);
  ok('unknown commands are rejected');

  // ---- phone notifications ----
  let n = await cmd('notifyInfo');
  assert.ok(n.ok && n.data.on === false, 'notifications start off');
  assert.equal((await cmd('notifyTest')).ok, false);
  n = await cmd('notifySet', { on: true });
  assert.ok(n.ok && n.data.on && /^hover-[a-z0-9]{6,}$/.test(n.data.topic), 'topic created');
  const topic = n.data.topic;
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).ntfyTopic, topic, 'topic saved');
  assert.ok((await cmd('notifyTest')).ok);
  assert.ok(pushes.some((p) => p.topic === topic && p.title === 'Hover is set up'), 'test notification sent');
  assert.equal((await cmd('notifySet', { on: 'yes' })).ok, false);
  ok(`notifications: turned on with topic ${topic}, test notification delivered`);
  const pushed = (title) => pushes.some((p) => p.title === title);
  const alerted = (kind) => alerts.some((a) => a.kind === kind);
  const soon = (pred, label) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (pred() ? resolve() : Date.now() - t0 > 5000 ? reject(new Error(`waiting for ${label}`)) : setTimeout(tick, 50));
    tick();
  });

  // ---- runes ----
  const runes = data.runes;
  assert.ok(runes.styles.length >= 5 && runes.perks.length > 50, 'rune data');
  await until((s) => s.runes.pages.length >= 3 && s.runes.current, 'rune pages');
  const preset = state.runes.pages.find((p) => !p.isEditable);
  const other = state.runes.pages.find((p) => p.isEditable && p.id !== state.runes.current);
  assert.ok((await cmd('runeSelect', { pageId: other.id })).ok);
  await until((s) => s.runes.current === other.id, 'rune page switched');
  const prec = runes.styles.find((s) => s.id === 8000), sorc = runes.styles.find((s) => s.id === 8200);
  const rowsOf = (st) => st.slots.filter((sl) => sl.type !== 'kStatMod' && sl.type !== 'kKeyStone');
  const shards = prec.slots.filter((sl) => sl.type === 'kStatMod').map((sl) => sl.perks[0]);
  const page0 = {
    name: 'e2e page', primaryStyleId: 8000, subStyleId: 8200,
    selectedPerkIds: [prec.slots[0].perks[0], ...rowsOf(prec).map((r) => r.perks[0]), rowsOf(sorc)[0].perks[0], rowsOf(sorc)[1].perks[0], ...shards],
  };
  const bad1 = await cmd('runeSave', { ...page0, selectedPerkIds: [...page0.selectedPerkIds.slice(0, 4), rowsOf(sorc)[0].perks[0], rowsOf(sorc)[0].perks[1], ...shards] });
  assert.equal(bad1.ok, false);
  const bad2 = await cmd('runeSave', { ...page0, subStyleId: 8000 });
  assert.equal(bad2.ok, false);
  ok(`rune pages: switched page; invalid pages refused ("${bad1.error}")`);
  assert.ok((await cmd('runeSave', page0)).ok);
  await until((s) => s.runes.pages.some((p) => p.name === 'e2e page' && p.id === s.runes.current), 'new page active');
  const made = state.runes.pages.find((p) => p.name === 'e2e page');
  assert.ok((await cmd('runeSave', { ...page0, pageId: made.id, name: 'e2e renamed' })).ok);
  await until((s) => s.runes.pages.some((p) => p.id === made.id && p.name === 'e2e renamed'), 'page renamed');
  assert.equal((await cmd('runeDelete', { pageId: preset.id })).ok, false);
  assert.ok((await cmd('runeDelete', { pageId: made.id })).ok);
  await until((s) => !s.runes.pages.some((p) => p.id === made.id), 'page deleted');
  ok('rune pages: created, edited and deleted; presets stay put');

  // ---- party + roles ----
  assert.ok(state.lobby.positions && state.lobby.members.length === 1 && state.lobby.members[0].me);
  const early2 = await cmd('search');
  assert.equal(early2.ok, false);
  assert.equal((await cmd('positions', { first: 'MIDDLE', second: 'MIDDLE' })).ok, false);
  assert.ok((await cmd('positions', { first: 'MIDDLE', second: 'TOP' })).ok);
  await until((s) => s.lobby.members[0].first === 'MIDDLE' && s.lobby.members[0].second === 'TOP' && s.lobby.canStart, 'roles set');
  ok(`roles: queue blocked until picked ("${early2.error}"), then Mid / Top`);

  const friends = (await cmd('friends')).data;
  assert.ok(Array.isArray(friends) && friends.length >= 5 && friends[0].availability === 'chat', 'friends list, online first');
  const online = friends.filter((f) => f.availability === 'chat' && f.status === 'outOfGame');
  const busy = friends.find((f) => f.availability === 'dnd');
  assert.ok((await cmd('invite', { summonerId: online[0].summonerId })).ok);
  assert.ok((await cmd('invite', { summonerId: online[1].summonerId })).ok);
  assert.ok((await cmd('invite', { summonerId: busy.summonerId })).ok);
  await until((s) => s.lobby.invited.length >= 1, 'invites pending');
  await until((s) => s.lobby.members.length === 3 && !s.lobby.invited.length, 'friends joined, busy one declined');
  assert.ok(state.lobby.members.filter((m) => !m.me).every((m) => m.first !== 'UNSELECTED'), 'friends picked roles');
  ok(`party: ${state.lobby.members.filter((m) => !m.me).map((m) => m.name).join(' + ')} joined, ${busy.name} declined`);
  assert.ok((await cmd('kick', { summonerId: online[1].summonerId })).ok);
  await until((s) => s.lobby.members.length === 2, 'kicked');
  ok(`kicked ${online[1].name}`);

  ws.send(JSON.stringify({ type: 'visible', on: true })); // Hover open on the phone
  assert.ok((await cmd('search')).ok);
  await until((s) => s.phase === 'Matchmaking' && s.search, 'queue');
  ok('find match -> in queue');
  await until((s) => s.phase === 'ReadyCheck' && s.readyCheck?.response === 'None', 'ready check');
  await soon(() => alerted('readyCheck'), 'match found alert');
  assert.ok(!pushed('Match found'), 'no notification while the app is open');
  ws.send(JSON.stringify({ type: 'visible', on: false })); // phone locked from here on
  assert.ok((await cmd('accept')).ok);
  await until((s) => s.readyCheck?.response === 'Accepted', 'accepted');
  ok('match found -> alert shown in the app (no notification while it is open) -> accepted');

  await until((s) => s.phase === 'ChampSelect' && s.session?.timer?.phase === 'PLANNING' && s.pickable.length, 'planning');
  const me = () => state.session.myTeam.find((m) => m.cellId === state.session.me);
  assert.equal(me().assignedPosition, 'middle');
  assert.ok(state.session.myTeam.some((m) => m.name === online[0].name), 'party member on my team');
  ok('champ select: assigned my primary role, party member on my team');
  const mine = () => state.session.actions.flat().filter((a) => a.actor === state.session.me);
  // Position swaps during planning: cell 1 always declines, others accept.
  const sw = (kind, cell) => state.session.swaps[kind].find((x) => x.cellId === cell);
  const ally = state.session.myTeam.find((m) => m.cellId === 0);
  const myPos = me().assignedPosition, theirPos = ally.assignedPosition;
  assert.equal(sw('position', 0).state, 'AVAILABLE');
  assert.equal((await cmd('swap', { kind: 'position', swapId: 9999, action: 'request' })).ok, false);
  assert.equal((await cmd('swap', { kind: 'rawEndpoint', swapId: sw('position', 0).id, action: 'request' })).ok, false);
  assert.ok((await cmd('swap', { kind: 'position', swapId: sw('position', 1).id, action: 'request' })).ok);
  await until(() => sw('position', 1).state === 'DECLINED', 'position swap declined');
  assert.ok((await cmd('swap', { kind: 'position', swapId: sw('position', 0).id, action: 'request' })).ok);
  await until(() => sw('position', 0).state === 'SENT', 'position swap sent');
  await until(() => me().assignedPosition === theirPos, 'position swapped');
  assert.equal(state.session.myTeam.find((m) => m.cellId === 0).assignedPosition, myPos);
  ok(`swaps: position swap declined by one teammate, accepted by another (${myPos} -> ${theirPos})`);
  // Swap back so the rest of the run is as before.
  await until(() => sw('position', 0).state === 'AVAILABLE', 'position swap available again');
  assert.ok((await cmd('swap', { kind: 'position', swapId: sw('position', 0).id, action: 'request' })).ok);
  await until(() => me().assignedPosition === myPos, 'position swapped back');

  const want = state.pickable[0];
  assert.ok((await cmd('hover', { championId: want })).ok);
  await until(() => me().championPickIntent === want, 'pick intent');
  ok(`planning: declared ${data.champions.find((c) => c.id === want).name}`);

  const early = await cmd('lock');
  assert.equal(early.ok, false);
  ok(`lock before your turn refused ("${early.error}")`);

  await until(() => mine().some((a) => a.type === 'ban' && a.active), 'my ban turn');
  // The client's bannable list is short in the mock (as it can be for real); bans outside it still work.
  const ban = data.champions.map((c) => c.id).find((id) => id !== want && !state.bannable.includes(id));
  assert.ok(ban, 'a champion missing from the bannable list');
  assert.ok((await cmd('hover', { championId: ban })).ok);
  await until(() => mine().find((a) => a.type === 'ban').championId === ban, 'ban hover');
  assert.ok((await cmd('lock', { championId: ban })).ok);
  await until(() => mine().find((a) => a.type === 'ban').completed, 'ban done');
  ok(`banned ${data.champions.find((c) => c.id === ban).name}, who wasn't on the client's bannable list`);
  await soon(() => pushed('Champ select started') && pushed('Your turn to ban'), 'champ select notifications');

  await until(() => mine().some((a) => a.type === 'pick' && a.active), 'my pick turn');
  const pick = state.pickable.find((id) => id !== want) ?? want;
  // Lock straight from the phone's selection, even though the client still has the declared pick.
  assert.ok((await cmd('lock', { championId: pick })).ok);
  await until(() => mine().find((a) => a.type === 'pick').completed && me().championId === pick, 'locked');
  ok(`locked in ${data.champions.find((c) => c.id === pick).name} in one call (set + complete)`);
  await soon(() => pushed('Your turn to pick'), 'pick notification');
  ok('notifications with the phone locked: champ select started, your turn to ban, your turn to pick');

  assert.ok((await cmd('spells', { spell1Id: 12, spell2Id: 4 })).ok);
  await until(() => me().spell1Id === 12 && me().spell2Id === 4, 'spells');
  ok('spells set to Teleport + Flash');

  // Skins: the carousel, wearing an owned skin, refusing one you don't own, and its splash art.
  const skins = (await cmd('skins')).data;
  assert.ok(Array.isArray(skins) && skins.length > 1 && skins.some((k) => k.base), 'skins listed');
  const wear = skins.find((k) => k.owned && !k.base);
  assert.ok(wear, 'an owned skin to wear');
  assert.equal(me().skinId, pick * 1000, 'starts on the base skin');
  assert.ok((await cmd('skin', { skinId: wear.id })).ok);
  await until(() => me().skinId === wear.id, 'skin selected');
  const notOwned = skins.find((k) => !k.owned);
  if (notOwned) assert.equal((await cmd('skin', { skinId: notOwned.id })).ok, false);
  for (const k of ['splash', 'load']) {
    const a = await fetch(`${base}/art?id=${pick}&k=${k}&skin=${wear.id}`, { headers: { cookie } });
    const b = await fetch(`${base}/art?id=${pick}&k=${k}`, { headers: { cookie } });
    assert.equal(a.status, 200, `${k} art for the skin`);
    assert.notDeepEqual(Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer()), `${k} art differs from the base skin`);
  }
  ok(`skins: wearing ${wear.name}, with its own splash and loading art`);

  // A teammate offers a champion trade during finalization.
  await until(() => state.session?.swaps?.trade.some((x) => x.state === 'RECEIVED'), 'incoming trade');
  const offer = state.session.swaps.trade.find((x) => x.state === 'RECEIVED');
  const theirChamp = state.session.myTeam.find((m) => m.cellId === offer.cellId).championId;
  assert.ok((await cmd('swap', { kind: 'trade', swapId: offer.id, action: 'accept' })).ok);
  await until(() => me().championId === theirChamp, 'traded');
  ok(`swaps: accepted a teammate's trade for ${data.champions.find((c) => c.id === theirChamp).name}`);
  assert.equal(pushes.filter((p) => p.title === 'Champion trade offer').length, 1, 'one trade notification');

  await until((s) => s.phase === 'InProgress', 'in game');
  ok('champ select finished -> in game');
  await until((s) => s.live && !s.live.loaded, 'loading screen');
  await until((s) => s.live?.loaded && s.live.gameTime > 0, 'game loaded');
  ok(`live game: loaded and timer running (${state.live.gameTime}s)`);
  await until((s) => s.live?.afkRisk, 'afk risk');
  ok(`live game: AFK risk flagged at ${state.live.gameTime}s with nothing bought`);
  await soon(() => pushed('Game loaded') && pushed('AFK warning coming'), 'game notifications');

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

  await until((s) => s.phase === 'Lobby', 'back to lobby after ARAM');
  assert.equal(state.lobby.members.length, 2, 'party stays together between games');
  assert.ok((await cmd('promote', { summonerId: online[0].summonerId })).ok);
  await until((s) => !s.lobby.isLeader && s.lobby.members.find((m) => m.leader || m.isLeader)?.name === online[0].name, 'promoted');
  assert.equal((await cmd('search')).ok, false);
  ok(`promoted ${online[0].name} to party leader; only the leader can queue`);

  assert.ok((await cmd('leaveLobby')).ok);
  await until((s) => s.phase === 'None' && !s.lobby, 'left lobby');
  await until((s) => s.invites.length === 1, 'incoming invite');
  const inv = state.invites[0];
  assert.equal((await cmd('acceptInvite', { invitationId: '../../lol-login' })).ok, false);
  assert.ok((await cmd('acceptInvite', { invitationId: inv.id })).ok);
  await until((s) => s.phase === 'Lobby' && s.lobby?.queueId === inv.queueId && !s.lobby.isLeader && !s.invites.length, 'joined friend lobby');
  ok(`accepted ${inv.from}’s invite into their lobby`);
  await soon(() => pushes.some((p) => p.title === 'Party invite' && p.body.includes(inv.from)), 'invite notification');
  assert.equal(pushes.filter((p) => p.title === 'Party invite').length, 1, 'one notification per invite');
  ok(`notifications: party invite from ${inv.from}, game loaded, AFK warning, trade offer`);

  assert.ok((await cmd('leaveLobby')).ok);
  await until((s) => s.phase === 'None', 'left again');
  assert.ok((await cmd('createLobby', { queueId: 420 })).ok);
  await until((s) => s.phase === 'Lobby' && s.lobby?.queueId === 420 && s.lobby.members.length === 1, 'new lobby');
  ok('left the lobby and opened a new one');

  console.log('\nAll checks passed.');
  clearTimeout(timeout);
  done(0);
} catch (err) {
  console.error('✗', err.message);
  done(1);
}
