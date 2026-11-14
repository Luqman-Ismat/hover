// Mock League client (LCU) for developing Hover without a live game.
// Simulates lobby -> queue -> ready check -> ranked draft (or ARAM) -> game.
// Speed things up with MOCK_SPEED=4.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 52437);
const PASS = 'mock-token';
const SPEED = Number(process.env.MOCK_SPEED || 1);
const LOCKFILE = process.env.HOVER_LOCKFILE || path.join(HERE, '.lockfile');
const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
const ME = 2; // local player is mid

const ms = (s) => (s * 1000) / SPEED;
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => ms(a + Math.random() * (b - a));
const QUEUE_NAMES = { 420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 400: 'Normal Draft', 490: 'Quickplay', 450: 'ARAM' };
const ALLY_NAMES = ['Sorrel', 'Nyx', 'You', 'Basil', 'Tamsin'];

let champIds = [];
const assetCache = new Map();

async function fetchAsset(p) {
  if (assetCache.has(p)) return assetCache.get(p);
  const url = CDRAGON + p.replace('/lol-game-data/assets/', '').toLowerCase();
  const r = await fetch(url);
  if (!r.ok) return null;
  const v = { type: r.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await r.arrayBuffer()) };
  assetCache.set(p, v);
  return v;
}

// ---- state ----------------------------------------------------------------
const S = { phase: 'Lobby', lobby: null, search: null, readyCheck: null, session: null, queueId: 420 };
let timers = [];
const later = (fn, t) => { const h = setTimeout(fn, t); timers.push(h); return h; };
const clearAll = () => { timers.forEach(clearTimeout); timers = []; clearInterval(S.tick); };

const URIS = {
  phase: '/lol-gameflow/v1/gameflow-phase',
  lobby: '/lol-lobby/v2/lobby',
  search: '/lol-matchmaking/v1/search',
  readyCheck: '/lol-matchmaking/v1/ready-check',
  session: '/lol-champ-select/v1/session',
};

function set(key, value) {
  S[key] = value;
  emit(URIS[key], value);
}
function touchSession() { emit(URIS.session, S.session); }

function makeLobby(queueId) {
  return {
    canStartActivity: true, partyId: 'mock-party',
    gameConfig: { queueId, gameMode: queueId === 450 ? 'ARAM' : 'CLASSIC' },
    localMember: { isLeader: true, puuid: 'me' },
    members: [{ puuid: 'me', isLeader: true }],
  };
}

function toLobby() {
  clearAll();
  set('search', null); set('readyCheck', null); set('session', null);
  set('lobby', makeLobby(S.queueId));
  set('phase', 'Lobby');
}

function startSearch() {
  clearAll();
  const started = Date.now();
  set('search', { searchState: 'Searching', timeInQueue: 0, estimatedQueueTime: 94, errors: [] });
  set('phase', 'Matchmaking');
  S.tick = setInterval(() => {
    set('search', { ...S.search, timeInQueue: ((Date.now() - started) / 1000) * SPEED });
  }, ms(1));
  later(startReadyCheck, ms(6));
}

function startReadyCheck() {
  clearAll();
  const started = Date.now();
  set('readyCheck', { state: 'InProgress', playerResponse: 'None', timer: 0, declinerIds: [] });
  set('phase', 'ReadyCheck');
  S.tick = setInterval(() => {
    const elapsed = ((Date.now() - started) / 1000) * SPEED;
    set('readyCheck', { ...S.readyCheck, timer: elapsed });
    if (elapsed >= 12) {
      if (S.readyCheck.playerResponse === 'Accepted') startChampSelect();
      else toLobby(); // missed it
    }
  }, ms(0.25));
}

// ---- champ select ----------------------------------------------------------
const ORDER = [[0], [5, 6], [1, 2], [7, 8], [3, 4], [9]];
const POS = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const DEFAULT_SPELLS = { top: [4, 12], jungle: [4, 11], middle: [4, 14], bottom: [4, 7], utility: [4, 3] };

function taken() {
  const s = S.session;
  const used = new Set();
  for (const a of s.actions.flat()) if (a.championId && (a.completed || a.type === 'pick')) used.add(a.championId);
  for (const m of [...s.myTeam, ...s.theirTeam]) if (m.championId) used.add(m.championId);
  return used;
}
const freeChamp = () => { const used = taken(); return rand(champIds.filter((c) => !used.has(c))); };
const member = (cell) => [...S.session.myTeam, ...S.session.theirTeam].find((m) => m.cellId === cell);

function setTimer(phase, seconds) {
  S.session.timer = {
    phase, adjustedTimeLeftInPhase: ms(seconds), totalTimeInPhase: ms(seconds),
    internalNowInEpochMs: Date.now(), isInfinite: false,
  };
  S.phaseEnds = Date.now() + ms(seconds);
}

function startChampSelect() {
  clearAll();
  set('readyCheck', null); set('search', null);
  const aram = S.queueId === 450;
  const mk = (cell) => {
    const ally = cell < 5;
    const pos = ally && !aram ? POS[cell] : '';
    const spells = aram ? [4, 32] : DEFAULT_SPELLS[POS[cell % 5]];
    return {
      cellId: cell, team: ally ? 1 : 2, assignedPosition: pos, championId: 0, championPickIntent: 0,
      spell1Id: spells[0], spell2Id: spells[1], gameName: ally ? ALLY_NAMES[cell] : '', puuid: `p${cell}`,
    };
  };
  let id = 1;
  const act = (cell, type) => ({ id: id++, actorCellId: cell, championId: 0, completed: false, isAllyAction: cell < 5, isInProgress: false, type, pickTurn: 0 });
  S.session = {
    gameId: 1, localPlayerCellId: ME, isSpectating: false,
    myTeam: [0, 1, 2, 3, 4].map(mk), theirTeam: [5, 6, 7, 8, 9].map(mk),
    actions: aram ? [] : [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => act(c, 'ban')),
      [{ ...act(-1, 'ten_bans_reveal') }],
      ...ORDER.map((g) => g.map((c) => act(c, 'pick'))),
    ],
    bans: { myTeamBans: [], theirTeamBans: [], numBans: 10 },
    benchEnabled: aram, benchChampions: [], allowRerolling: aram, rerollsRemaining: aram ? 2 : 0,
    timer: null,
  };
  set('phase', 'ChampSelect');
  aram ? aramFlow() : draftFlow();
}

function aramFlow() {
  for (const m of [...S.session.myTeam, ...S.session.theirTeam]) m.championId = freeChamp();
  S.session.benchChampions = Array.from({ length: 4 }, () => ({ championId: freeChamp(), isPriority: false }));
  setTimer('BAN_PICK', 60);
  touchSession();
  // A teammate grabs something off the bench now and then.
  later(() => benchSwap(0, S.session.benchChampions[0]?.championId), ms(9));
  later(finalize, ms(60));
}

function benchSwap(cell, championId) {
  const s = S.session;
  const i = s.benchChampions.findIndex((b) => b.championId === championId);
  if (i < 0) return false;
  const m = member(cell);
  s.benchChampions[i] = { championId: m.championId, isPriority: false };
  m.championId = championId;
  touchSession();
  return true;
}

function draftFlow() {
  setTimer('PLANNING', 12);
  touchSession();
  // Allies declare intents during planning.
  for (const c of [0, 1, 3, 4]) later(() => { member(c).championPickIntent = freeChamp(); touchSession(); }, between(1.5, 6));
  later(() => runGroup(0), ms(12));
}

function runGroup(gi) {
  const s = S.session;
  if (gi >= s.actions.length) return finalize();
  const group = s.actions[gi];
  if (group[0].type === 'ten_bans_reveal') {
    group[0].completed = true;
    const bans = s.actions[0];
    s.bans.myTeamBans = bans.filter((a) => a.actorCellId < 5 && a.championId).map((a) => a.championId);
    s.bans.theirTeamBans = bans.filter((a) => a.actorCellId >= 5 && a.championId).map((a) => a.championId);
    touchSession();
    return later(() => runGroup(gi + 1), ms(1.5));
  }
  const isBan = group[0].type === 'ban';
  setTimer('BAN_PICK', isBan ? 30 : 30);
  for (const a of group) a.isInProgress = true;
  touchSession();

  for (const a of group) {
    if (a.actorCellId === ME) continue;
    later(() => {
      if (a.completed) return;
      const m = member(a.actorCellId);
      a.championId = isBan ? freeChamp() : (m.championPickIntent && !taken().has(m.championPickIntent) ? m.championPickIntent : freeChamp());
      if (!isBan && a.isAllyAction) m.championId = a.championId; // ally hovers are visible
      touchSession();
    }, between(1, 3));
    later(() => complete(a, gi), between(4, 8));
  }
  S.groupTimer = later(() => {
    // Mock leniency: time out by auto-locking instead of dodging.
    for (const a of group) if (!a.completed) { if (!a.championId && !isBan) a.championId = freeChamp(); complete(a, gi); }
  }, ms(30));
}

function complete(a, gi) {
  if (a.completed) return;
  a.completed = true;
  a.isInProgress = false;
  if (a.type === 'pick') {
    const m = member(a.actorCellId);
    m.championId = a.championId;
    m.championPickIntent = 0;
  }
  touchSession();
  const group = S.session.actions[gi];
  if (group.every((x) => x.completed)) {
    clearTimeout(S.groupTimer);
    later(() => runGroup(gi + 1), ms(0.8));
  }
}

function finalize() {
  setTimer('FINALIZATION', S.queueId === 450 ? 6 : 15);
  touchSession();
  later(() => {
    setTimer('GAME_STARTING', 3);
    touchSession();
    later(() => {
      set('session', null);
      set('phase', 'GameStart');
      later(() => set('phase', 'InProgress'), ms(2));
      later(toLobby, ms(25));
    }, ms(3));
  }, ms(S.queueId === 450 ? 6 : 15));
}

// ---- http -------------------------------------------------------------------
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const err = (res, status, message) => reply(res, status, { errorCode: 'RPC_ERROR', httpStatus: status, message });

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString();
  return t ? JSON.parse(t) : {};
}

function sessionView() {
  if (!S.session) return null;
  // Real client: timer counts down from the moment it was set.
  const t = S.session.timer;
  return { ...S.session, timer: t && { ...t, adjustedTimeLeftInPhase: Math.max(0, S.phaseEnds - Date.now()), internalNowInEpochMs: Date.now() } };
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Basic ' + Buffer.from(`riot:${PASS}`).toString('base64')) return err(res, 401, 'unauthorized');
  const { pathname: p } = new URL(req.url, 'http://x');
  const m = req.method;
  const me = S.session && member(ME);

  if (p.startsWith('/lol-game-data/assets/')) {
    if (p === '/lol-game-data/assets/v1/champion-summary.json' || p === '/lol-game-data/assets/v1/summoner-spells.json') {
      const a = await fetchAsset(p);
      return a ? (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(a.body)) : err(res, 404, 'missing');
    }
    const a = await fetchAsset(p).catch(() => null);
    if (!a) return err(res, 404, 'missing');
    res.writeHead(200, { 'Content-Type': a.type });
    return res.end(a.body);
  }

  if (m === 'GET' && p === URIS.phase) return reply(res, 200, S.phase);
  if (m === 'GET' && p === URIS.lobby) return S.lobby ? reply(res, 200, S.lobby) : err(res, 404, 'LOBBY_NOT_FOUND');
  if (m === 'GET' && p === URIS.search) return S.search ? reply(res, 200, S.search) : err(res, 404, 'not searching');
  if (m === 'GET' && p === URIS.readyCheck) return reply(res, 200, S.readyCheck || { state: 'Invalid', playerResponse: 'None', timer: 0 });
  if (m === 'GET' && p === URIS.session) return S.session ? reply(res, 200, sessionView()) : err(res, 404, 'No active delegate');
  if (m === 'GET' && p === '/lol-gameflow/v1/session') return reply(res, 200, { phase: S.phase, gameData: { queue: { id: S.queueId, gameMode: S.queueId === 450 ? 'ARAM' : 'CLASSIC' } } });
  if (m === 'GET' && p.startsWith('/lol-game-queues/v1/queues/')) {
    const id = Number(p.split('/').pop());
    return reply(res, 200, { id, name: QUEUE_NAMES[id] || 'Custom', description: QUEUE_NAMES[id] || 'Custom' });
  }
  if (m === 'GET' && (p === '/lol-champ-select/v1/pickable-champion-ids' || p === '/lol-champ-select/v1/bannable-champion-ids')) {
    if (!S.session) return err(res, 404, 'No active delegate');
    const lockedPicks = new Set(S.session.actions.flat().filter((a) => a.type === 'pick' && a.completed).map((a) => a.championId));
    const banned = new Set([...S.session.bans.myTeamBans, ...S.session.bans.theirTeamBans, ...S.session.actions.flat().filter((a) => a.type === 'ban' && a.completed).map((a) => a.championId)]);
    return reply(res, 200, champIds.filter((c) => !banned.has(c) && !(lockedPicks.has(c) && p.includes('pickable'))));
  }

  if (m === 'DELETE' && p === URIS.lobby) {
    clearAll();
    set('search', null); set('readyCheck', null); set('session', null); set('lobby', null);
    set('phase', 'None');
    return reply(res, 204);
  }
  if (m === 'POST' && p === URIS.lobby) {
    const { queueId } = await body(req);
    S.queueId = queueId || 420;
    toLobby();
    return reply(res, 200, S.lobby);
  }
  if (p === '/lol-lobby/v2/lobby/matchmaking/search') {
    if (m === 'POST') { if (S.phase !== 'Lobby') return err(res, 400, 'Not in a lobby'); startSearch(); return reply(res, 204); }
    if (m === 'DELETE') { toLobby(); return reply(res, 204); }
  }
  if (m === 'POST' && p === '/lol-matchmaking/v1/ready-check/accept') {
    if (!S.readyCheck) return err(res, 400, 'No ready check');
    set('readyCheck', { ...S.readyCheck, playerResponse: 'Accepted' });
    later(() => S.phase === 'ReadyCheck' && startChampSelect(), ms(2));
    return reply(res, 204);
  }
  if (m === 'POST' && p === '/lol-matchmaking/v1/ready-check/decline') {
    if (!S.readyCheck) return err(res, 400, 'No ready check');
    set('readyCheck', { ...S.readyCheck, playerResponse: 'Declined' });
    later(toLobby, ms(1));
    return reply(res, 204);
  }

  const actionMatch = p.match(/^\/lol-champ-select\/v1\/session\/actions\/(\d+)(\/complete)?$/);
  if (actionMatch && S.session) {
    const a = S.session.actions.flat().find((x) => x.id === Number(actionMatch[1]));
    if (!a || a.actorCellId !== ME || a.completed) return err(res, 400, 'Invalid action');
    if (m === 'PATCH') {
      const { championId } = await body(req);
      if (taken().has(championId) && championId !== a.championId && a.type === 'pick') return err(res, 400, 'Champion unavailable');
      a.championId = championId;
      if (a.type === 'pick') { if (a.isInProgress) me.championId = championId; else me.championPickIntent = championId; }
      touchSession();
      return reply(res, 204);
    }
    if (m === 'POST' && actionMatch[2]) {
      if (!a.isInProgress) return err(res, 400, 'Not your turn');
      if (!a.championId) return err(res, 400, 'No champion selected');
      complete(a, S.session.actions.findIndex((g) => g.includes(a)));
      return reply(res, 204);
    }
  }
  if (m === 'PATCH' && p === '/lol-champ-select/v1/session/my-selection' && me) {
    const { spell1Id, spell2Id } = await body(req);
    if (spell1Id) me.spell1Id = spell1Id;
    if (spell2Id) me.spell2Id = spell2Id;
    touchSession();
    return reply(res, 204);
  }
  if (m === 'POST' && p === '/lol-champ-select/v1/session/my-selection/reroll' && me) {
    if (!S.session.rerollsRemaining) return err(res, 400, 'No rerolls left');
    S.session.rerollsRemaining--;
    S.session.benchChampions.push({ championId: me.championId, isPriority: false });
    me.championId = freeChamp();
    touchSession();
    return reply(res, 204);
  }
  const benchMatch = p.match(/^\/lol-champ-select\/v1\/session\/bench\/swap\/(\d+)$/);
  if (m === 'POST' && benchMatch && me) {
    return benchSwap(ME, Number(benchMatch[1])) ? reply(res, 204) : err(res, 400, 'Not on the bench');
  }
  return err(res, 404, `No mock for ${m} ${p}`);
});

// ---- websocket (WAMP-ish) ---------------------------------------------------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  if (req.headers.authorization !== 'Basic ' + Buffer.from(`riot:${PASS}`).toString('base64')) return ws.close();
  ws.subs = new Set();
  ws.on('message', (raw) => {
    try { const [op, ev] = JSON.parse(raw); if (op === 5) ws.subs.add(ev); if (op === 6) ws.subs.delete(ev); } catch {}
  });
});

function emit(uri, data) {
  const ev = 'OnJsonApiEvent' + uri.replaceAll('/', '_');
  const payload = { data: uri === URIS.session ? sessionView() : data ?? null, eventType: data == null ? 'Delete' : 'Update', uri };
  const text = JSON.stringify([8, ev, payload]);
  for (const ws of wss.clients) if (ws.subs?.has(ev) || ws.subs?.has('OnJsonApiEvent')) ws.send(text);
}

// ---- boot -------------------------------------------------------------------
const summary = await fetchAsset('/lol-game-data/assets/v1/champion-summary.json').catch(() => null);
champIds = summary ? JSON.parse(summary.body).map((c) => c.id).filter((id) => id > 0 && id < 10000) : [1, 22, 51, 64, 103, 157, 222, 266, 412, 777];
S.lobby = makeLobby(S.queueId);

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(LOCKFILE, `LeagueClient:${process.pid}:${PORT}:${PASS}:http`);
  console.log(`Mock League client on :${PORT} (${champIds.length} champions, speed ${SPEED}x). Lockfile: ${LOCKFILE}`);
});
const cleanup = () => { try { fs.unlinkSync(LOCKFILE); } catch {} process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
