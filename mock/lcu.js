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
const S = { phase: 'Lobby', lobby: null, search: null, readyCheck: null, session: null, queueId: 420, invites: [] };
let timers = [];
const later = (fn, t) => { const h = setTimeout(fn, t); timers.push(h); return h; };
const clearAll = () => { timers.forEach(clearTimeout); timers = []; clearInterval(S.tick); };

const URIS = {
  phase: '/lol-gameflow/v1/gameflow-phase',
  lobby: '/lol-lobby/v2/lobby',
  search: '/lol-matchmaking/v1/search',
  readyCheck: '/lol-matchmaking/v1/ready-check',
  session: '/lol-champ-select/v1/session',
  invites: '/lol-lobby/v2/received-invitations',
  runePages: '/lol-perks/v1/pages',
  runeCurrent: '/lol-perks/v1/currentpage',
};

function set(key, value) {
  S[key] = value;
  emit(URIS[key], value);
}
function touchSession() { emit(URIS.session, S.session); }

// ---- party ------------------------------------------------------------------
const FRIENDS = [
  { summonerId: 2001, puuid: 'f1', gameName: 'Juniper', gameTag: 'EUW', icon: 7, availability: 'chat', status: 'outOfGame' },
  { summonerId: 2002, puuid: 'f2', gameName: 'Marrow', gameTag: 'NA1', icon: 12, availability: 'chat', status: 'outOfGame' },
  { summonerId: 2003, puuid: 'f3', gameName: 'Lumen', gameTag: 'OCE', icon: 15, availability: 'chat', status: 'outOfGame' },
  { summonerId: 2004, puuid: 'f4', gameName: 'Quill', gameTag: 'EUW', icon: 20, availability: 'away', status: 'outOfGame' },
  { summonerId: 2005, puuid: 'f5', gameName: 'Thistle', gameTag: 'NA1', icon: 23, availability: 'dnd', status: 'championSelect' },
  { summonerId: 2006, puuid: 'f6', gameName: 'Saffron', gameTag: 'KR', icon: 25, availability: 'dnd', status: 'inGame' },
  { summonerId: 2007, puuid: 'f7', gameName: 'Wren', gameTag: 'EUW', icon: 3, availability: 'mobile', status: '' },
  { summonerId: 2008, puuid: 'f8', gameName: 'Corvid', gameTag: 'NA1', icon: 9, availability: 'offline', status: '' },
];
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const POSITION_QUEUES = [400, 420, 440];
const mkMember = (f, leader) => ({
  summonerId: f.summonerId, puuid: f.puuid, gameName: f.gameName, gameTag: f.gameTag, summonerIconId: f.icon,
  isLeader: leader, firstPositionPreference: 'UNSELECTED', secondPositionPreference: 'UNSELECTED',
});
const ME_INFO = { summonerId: 1001, puuid: 'me', gameName: 'Hover Tester', gameTag: 'MOCK', icon: 4 };
const P = { members: [mkMember(ME_INFO, true)], invitations: [] };
const meMember = () => P.members.find((m) => m.puuid === 'me');
const resetParty = () => { P.members = [mkMember(ME_INFO, true)]; P.invitations = []; };

function lobbyView() {
  const positions = POSITION_QUEUES.includes(S.queueId);
  const me = meMember();
  const rolesOk = !positions || P.members.every((m) => m.firstPositionPreference === 'FILL' || (m.firstPositionPreference !== 'UNSELECTED' && m.secondPositionPreference !== 'UNSELECTED'));
  return {
    canStartActivity: me.isLeader && rolesOk, partyId: 'mock-party',
    gameConfig: { queueId: S.queueId, gameMode: S.queueId === 450 ? 'ARAM' : 'CLASSIC', showPositionSelector: positions, maxLobbySize: 5 },
    localMember: me, members: P.members, invitations: P.invitations,
  };
}
const touchLobby = () => S.phase === 'Lobby' && set('lobby', lobbyView());

// Friends pick roles you haven't taken, like a polite party would.
function botRoles(m) {
  const used = new Set(P.members.filter((x) => x !== m).map((x) => x.firstPositionPreference));
  const free = ROLES.filter((r) => !used.has(r));
  m.firstPositionPreference = free[0] || 'FILL';
  m.secondPositionPreference = free[1] || (m.firstPositionPreference === 'FILL' ? 'UNSELECTED' : 'FILL');
}

function invite(toSummonerId) {
  const f = FRIENDS.find((x) => x.summonerId === toSummonerId);
  if (!f) return 'Not on your friends list';
  if (P.members.some((m) => m.summonerId === toSummonerId)) return 'Already in your party';
  if (P.members.length + P.invitations.length >= 5) return 'Your party is full';
  if (P.invitations.some((i) => i.toSummonerId === toSummonerId)) return null;
  const inv = { invitationId: `inv-${toSummonerId}`, toSummonerId, toSummonerName: f.gameName, state: 'Pending' };
  P.invitations.push(inv);
  touchLobby();
  const free = f.availability === 'chat' && f.status === 'outOfGame';
  setTimeout(() => {
    if (!P.invitations.includes(inv) || S.phase !== 'Lobby') return;
    if (free) {
      P.invitations = P.invitations.filter((i) => i !== inv);
      const m = mkMember(f, false);
      P.members.push(m);
      if (POSITION_QUEUES.includes(S.queueId)) botRoles(m);
    } else {
      inv.state = 'Declined';
      setTimeout(() => { P.invitations = P.invitations.filter((i) => i !== inv); touchLobby(); }, ms(2));
    }
    touchLobby();
  }, between(2, 4));
  return null;
}

// After you leave a lobby, a friend sometimes asks you to join theirs.
function maybeIncomingInvite() {
  setTimeout(() => {
    if (S.phase !== 'None' || S.invites.length) return;
    const f = FRIENDS[0];
    set('invites', [{ invitationId: 'rx-juniper', fromSummonerId: f.summonerId, fromSummonerName: f.gameName, state: 'Pending', gameConfig: { queueId: 450 } }]);
  }, ms(5));
}

function toLobby() {
  clearAll();
  set('search', null); set('readyCheck', null); set('session', null);
  S.phase = 'Lobby';
  set('lobby', lobbyView());
  set('phase', 'Lobby');
  // A friend who leads the party starts the queue on their own.
  if (!meMember().isLeader) later(() => S.phase === 'Lobby' && !meMember().isLeader && startSearch(), ms(8));
}

// ---- runes ------------------------------------------------------------------
let styles = [];
let perkNames = new Map();
const R = { pages: [], current: null, nextId: 200 };
const styleOf = (perkId) => styles.find((s) => s.slots.some((sl) => sl.type !== 'kStatMod' && sl.perks.includes(perkId)));
const pageView = (p) => ({ ...p, isActive: p.id === R.current, current: p.id === R.current, isValid: true, isDeletable: p.isEditable });
function touchRunes() {
  set('runePages', R.pages.map(pageView));
  const cur = R.pages.find((p) => p.id === R.current);
  set('runeCurrent', cur ? pageView(cur) : null);
}
function seedRunes() {
  const fromDefaults = (id, name, styleId, editable) => {
    const st = styles.find((s) => s.id === styleId);
    if (!st) return null;
    return { id, name, primaryStyleId: st.id, subStyleId: styleOf(st.defaultPerks[4])?.id ?? st.allowedSubStyles[0], selectedPerkIds: [...st.defaultPerks], isEditable: editable };
  };
  const named = (styleId) => perkNames.get(styles.find((s) => s.id === styleId)?.defaultPerks[0]) || 'Runes';
  R.pages = [
    fromDefaults(101, `Mid · ${named(8100)}`, 8100, true),
    fromDefaults(102, `Top · ${named(8000)}`, 8000, true),
    fromDefaults(103, `Tank · ${named(8400)}`, 8400, true),
    fromDefaults(50, `Recommended · ${named(8200)}`, 8200, false),
  ].filter(Boolean);
  R.current = R.pages[0]?.id ?? null;
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

// ---- champ select swaps -----------------------------------------------------
// Each ally can be asked for a position swap (planning), a pick-order swap (after bans,
// before either of you picks) or a champion trade (once you've both locked in).
// Cell 1 always says no, so declines are easy to test.
const SWAP_BASE = { trade: 100, order: 200, position: 300 };
const SWAP_PATH = { trades: 'trade', 'pick-order-swaps': 'order', 'position-swaps': 'position' };
let SW = { trade: {}, order: {}, position: {} };
const ALLIES = [0, 1, 3, 4];
const picked = (cell) => S.session.actions.flat().some((a) => a.type === 'pick' && a.actorCellId === cell && a.completed);
function swapLists() {
  const s = S.session;
  if (!s || S.queueId === 450) return { trades: [], pickOrderSwaps: [], positionSwaps: [] };
  const phase = s.timer?.phase;
  const bansDone = s.actions[0]?.every((a) => a.completed);
  const avail = {
    position: () => phase === 'PLANNING',
    order: (c) => phase === 'BAN_PICK' && bansDone && !picked(c) && !picked(ME),
    trade: (c) => (phase === 'BAN_PICK' || phase === 'FINALIZATION') && picked(c) && picked(ME),
  };
  const mk = (kind) => ALLIES.map((c) => ({ id: SWAP_BASE[kind] + c, cellId: c, state: SW[kind][c] || (avail[kind](c) ? 'AVAILABLE' : 'INVALID') }));
  return { trades: mk('trade'), pickOrderSwaps: mk('order'), positionSwaps: mk('position') };
}
function doSwap(kind, cell) {
  const s = S.session, me = member(ME), them = member(cell);
  if (kind === 'position') [me.assignedPosition, them.assignedPosition] = [them.assignedPosition, me.assignedPosition];
  if (kind === 'order') {
    const mine = s.actions.flat().filter((a) => a.type === 'pick' && !a.completed && (a.actorCellId === ME || a.actorCellId === cell));
    for (const a of mine) a.actorCellId = a.actorCellId === ME ? cell : ME;
  }
  if (kind === 'trade') {
    [me.championId, them.championId] = [them.championId, me.championId];
    for (const a of s.actions.flat()) {
      if (a.type !== 'pick') continue;
      if (a.actorCellId === ME) a.championId = me.championId;
      if (a.actorCellId === cell) a.championId = them.championId;
    }
  }
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
  SW = { trade: {}, order: {}, position: {} };
  set('readyCheck', null); set('search', null);
  const aram = S.queueId === 450;
  // Your first role (if you picked one) is where you land; everyone else fills around you.
  const want = meMember().firstPositionPreference.toLowerCase();
  const mine = POS.includes(want) ? want : 'middle';
  const lanes = POS.filter((p) => p !== mine);
  lanes.splice(ME, 0, mine);
  const friends = P.members.filter((m) => m.puuid !== 'me').map((m) => m.gameName);
  const allyName = (cell) => (cell === ME ? ME_INFO.gameName : friends.shift() || ALLY_NAMES[cell]);
  const mk = (cell) => {
    const ally = cell < 5;
    const pos = !aram ? lanes[cell % 5] : '';
    const spells = aram ? [4, 32] : DEFAULT_SPELLS[lanes[cell % 5]];
    return {
      cellId: cell, team: ally ? 1 : 2, assignedPosition: ally ? pos : '', championId: 0, championPickIntent: 0,
      spell1Id: spells[0], spell2Id: spells[1], gameName: ally ? allyName(cell) : '', puuid: cell === ME ? 'me' : `p${cell}`,
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
  setTimer('PLANNING', 30);
  touchSession();
  // Allies declare intents during planning.
  for (const c of [0, 1, 3, 4]) later(() => { member(c).championPickIntent = freeChamp(); touchSession(); }, between(1.5, 6));
  later(() => runGroup(0), ms(30));
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
  // A teammate offers you a champion trade.
  if (S.queueId !== 450) later(() => { if (picked(3) && picked(ME) && !SW.trade[3]) { SW.trade[3] = 'RECEIVED'; touchSession(); } }, ms(3));
  later(() => {
    setTimer('GAME_STARTING', 3);
    touchSession();
    later(() => {
      set('session', null);
      set('phase', 'GameStart');
      later(() => { set('phase', 'InProgress'); LIVE.inGameAt = Date.now(); }, ms(2));
      later(() => { LIVE.inGameAt = 0; toLobby(); }, ms(2 + LIVE.LOADING + LIVE.LENGTH));
    }, ms(3));
  }, ms(S.queueId === 450 ? 6 : 15));
}

// ---- live game (the game's own API on :2999) --------------------------------
// The loading screen lasts LOADING seconds; then the game clock runs. You never buy
// anything here, so the AFK estimate trips once the clock passes 75s.
const LIVE = { LOADING: 8, LENGTH: 100, inGameAt: 0 };
function liveView() {
  if (S.phase !== 'InProgress' || !LIVE.inGameAt) return null;
  const t = ((Date.now() - LIVE.inGameAt) / 1000) * SPEED - LIVE.LOADING;
  if (t <= 0) return null;
  const me = `${ME_INFO.gameName}#${ME_INFO.gameTag}`;
  return {
    activePlayer: { riotId: me, summonerName: ME_INFO.gameName, level: 1 },
    allPlayers: [{ riotId: me, summonerName: ME_INFO.gameName, team: 'ORDER', level: 1, isDead: false, items: [] }],
    events: { Events: [{ EventID: 0, EventName: 'GameStart', EventTime: 0 }] },
    gameData: { gameMode: S.queueId === 450 ? 'ARAM' : 'CLASSIC', gameTime: t, mapName: 'Map11' },
  };
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
  // Like the client, a new champion starts on its base skin (skin id = champion id × 1000).
  const skin = (m) => ({ ...m, selectedSkinId: m.championId > 0 ? (Math.floor((m.selectedSkinId || 0) / 1000) === m.championId ? m.selectedSkinId : m.championId * 1000) : 0 });
  return { ...S.session, ...swapLists(), myTeam: S.session.myTeam.map(skin), theirTeam: S.session.theirTeam.map(skin), timer: t && { ...t, adjustedTimeLeftInPhase: Math.max(0, S.phaseEnds - Date.now()), internalNowInEpochMs: Date.now() } };
}

// Skins for your champion, shaped like the client's carousel: you own the base skin and
// every other one, chromas included.
async function skinCarousel(championId) {
  const a = championId > 0 && await fetchAsset(`/lol-game-data/assets/v1/champions/${championId}.json`).catch(() => null);
  if (!a) return [];
  const d = JSON.parse(a.body.toString('utf8'));
  return (d.skins || []).map((k, i) => ({
    id: k.id, championId, name: k.name, unlocked: i % 2 === 0, disabled: false, isBase: !!k.isBase,
    splashPath: k.splashPath, tilePath: k.tilePath, loadScreenPath: k.loadScreenPath,
    childSkins: (k.chromas || []).map((c, j) => ({ id: c.id, name: c.name, unlocked: j % 2 === 0, colors: c.colors || [], parentSkinId: k.id })),
  }));
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
  if (m === 'GET' && p === '/lol-champ-select/v1/skin-carousel-skins') return reply(res, 200, me ? await skinCarousel(me.championId) : []);
  if (m === 'GET' && (p === '/lol-champ-select/v1/pickable-champion-ids' || p === '/lol-champ-select/v1/bannable-champion-ids')) {
    if (!S.session) return err(res, 404, 'No active delegate');
    const lockedPicks = new Set(S.session.actions.flat().filter((a) => a.type === 'pick' && a.completed).map((a) => a.championId));
    const banned = new Set([...S.session.bans.myTeamBans, ...S.session.bans.theirTeamBans, ...S.session.actions.flat().filter((a) => a.type === 'ban' && a.completed).map((a) => a.championId)]);
    // Like the real client, the bannable list can be shorter than what you may actually ban.
    const list = p.includes('bannable') ? champIds.slice(0, Math.ceil(champIds.length / 2)) : champIds;
    return reply(res, 200, list.filter((c) => !banned.has(c) && !(lockedPicks.has(c) && p.includes('pickable'))));
  }

  if (m === 'DELETE' && p === URIS.lobby) {
    clearAll();
    resetParty();
    set('search', null); set('readyCheck', null); set('session', null); set('lobby', null);
    set('phase', 'None');
    maybeIncomingInvite();
    return reply(res, 204);
  }
  if (m === 'POST' && p === URIS.lobby) {
    const { queueId } = await body(req);
    if (S.phase !== 'Lobby') resetParty(); // a fresh lobby; changing mode keeps your party
    else if (!meMember().isLeader) return err(res, 400, 'Only the party leader can change mode');
    S.queueId = queueId || 420;
    if (POSITION_QUEUES.includes(S.queueId)) for (const mm of P.members) if (mm.puuid !== 'me' && mm.firstPositionPreference === 'UNSELECTED') botRoles(mm);
    toLobby();
    return reply(res, 200, S.lobby);
  }

  // Party
  if (m === 'GET' && p === '/lol-chat/v1/friends') {
    const inParty = new Set(P.members.map((x) => x.summonerId));
    return reply(res, 200, FRIENDS.map((f) => ({
      summonerId: f.summonerId, puuid: f.puuid, gameName: f.gameName, gameTag: f.gameTag, name: f.gameName, icon: f.icon,
      availability: inParty.has(f.summonerId) ? 'chat' : f.availability, lol: { gameStatus: inParty.has(f.summonerId) ? 'hosting_NORMAL' : f.status },
    })));
  }
  if (m === 'POST' && p === '/lol-lobby/v2/lobby/invitations') {
    if (S.phase !== 'Lobby') return err(res, 400, 'Not in a lobby');
    const list = await body(req);
    for (const i of Array.isArray(list) ? list : []) { const e = invite(i.toSummonerId); if (e) return err(res, 400, e); }
    return reply(res, 200, P.invitations);
  }
  const memberMatch = p.match(/^\/lol-lobby\/v2\/lobby\/members\/(\d+)\/(kick|promote)$/);
  if (m === 'POST' && memberMatch) {
    if (!meMember().isLeader) return err(res, 400, 'Only the party leader can do that');
    const target = P.members.find((x) => x.summonerId === Number(memberMatch[1]));
    if (!target || target.puuid === 'me') return err(res, 400, 'Not in your party');
    if (memberMatch[2] === 'kick') P.members = P.members.filter((x) => x !== target);
    else { for (const x of P.members) x.isLeader = x === target; later(() => S.phase === 'Lobby' && !meMember().isLeader && startSearch(), ms(8)); }
    touchLobby();
    return reply(res, 204);
  }
  if (m === 'PUT' && p === '/lol-lobby/v2/lobby/members/localMember/position-preferences') {
    const { firstPreference, secondPreference } = await body(req);
    const me = meMember();
    me.firstPositionPreference = firstPreference;
    me.secondPositionPreference = firstPreference === 'FILL' ? 'UNSELECTED' : secondPreference;
    touchLobby();
    return reply(res, 201);
  }
  if (m === 'GET' && p === URIS.invites) return reply(res, 200, S.invites);
  const rxMatch = p.match(/^\/lol-lobby\/v2\/received-invitations\/([\w.:-]+)\/(accept|decline)$/);
  if (m === 'POST' && rxMatch) {
    const inv = S.invites.find((i) => i.invitationId === rxMatch[1]);
    if (!inv) return err(res, 404, 'Invitation not found');
    set('invites', []);
    if (rxMatch[2] === 'accept') {
      const f = FRIENDS.find((x) => x.summonerId === inv.fromSummonerId);
      P.members = [mkMember(f, true), mkMember(ME_INFO, false)];
      P.invitations = [];
      S.queueId = inv.gameConfig.queueId;
      toLobby();
    }
    return reply(res, 204);
  }

  // Runes
  if (m === 'GET' && p === URIS.runePages) return reply(res, 200, R.pages.map(pageView));
  if (m === 'GET' && p === URIS.runeCurrent) {
    const cur = R.pages.find((x) => x.id === R.current);
    return cur ? reply(res, 200, pageView(cur)) : err(res, 404, 'No current page');
  }
  if (m === 'PUT' && p === URIS.runeCurrent) {
    const id = Number(await body(req));
    if (!R.pages.some((x) => x.id === id)) return err(res, 404, 'Page not found');
    R.current = id;
    touchRunes();
    return reply(res, 204);
  }
  if (m === 'POST' && p === URIS.runePages) {
    if (R.pages.filter((x) => x.isEditable).length >= 5) return err(res, 400, 'You’ve used all your rune pages. Delete one first.');
    const b = await body(req);
    if (!Array.isArray(b.selectedPerkIds) || b.selectedPerkIds.length !== 9) return err(res, 400, 'Invalid page');
    const page = { id: R.nextId++, name: b.name, primaryStyleId: b.primaryStyleId, subStyleId: b.subStyleId, selectedPerkIds: b.selectedPerkIds, isEditable: true };
    R.pages.unshift(page);
    if (b.current) R.current = page.id;
    touchRunes();
    return reply(res, 200, pageView(page));
  }
  const pageMatch = p.match(/^\/lol-perks\/v1\/pages\/(\d+)$/);
  if (pageMatch) {
    const page = R.pages.find((x) => x.id === Number(pageMatch[1]));
    if (!page) return err(res, 404, 'Page not found');
    if (!page.isEditable) return err(res, 400, 'Page is not editable');
    if (m === 'PUT') {
      const b = await body(req);
      Object.assign(page, { name: b.name, primaryStyleId: b.primaryStyleId, subStyleId: b.subStyleId, selectedPerkIds: b.selectedPerkIds });
      touchRunes();
      return reply(res, 201, pageView(page));
    }
    if (m === 'DELETE') {
      R.pages = R.pages.filter((x) => x !== page);
      if (R.current === page.id) R.current = R.pages[0]?.id ?? null;
      touchRunes();
      return reply(res, 204);
    }
  }

  if (p === '/lol-lobby/v2/lobby/matchmaking/search') {
    if (m === 'POST') {
      if (S.phase !== 'Lobby') return err(res, 400, 'Not in a lobby');
      if (!lobbyView().canStartActivity) return err(res, 400, meMember().isLeader ? 'Everyone needs to pick roles first' : 'Only the party leader can start the queue');
      startSearch();
      return reply(res, 204);
    }
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
      const { championId, completed } = await body(req);
      if (taken().has(championId) && championId !== a.championId && a.type === 'pick') return err(res, 400, 'Champion unavailable');
      if (completed && !a.isInProgress) return err(res, 400, 'Not your turn');
      a.championId = championId;
      if (a.type === 'pick') { if (a.isInProgress) me.championId = championId; else me.championPickIntent = championId; }
      // Like the real client: { championId, completed: true } locks in one call.
      if (completed) complete(a, S.session.actions.findIndex((g) => g.includes(a)));
      else touchSession();
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
    const { spell1Id, spell2Id, selectedSkinId } = await body(req);
    if (selectedSkinId) {
      const owned = (await skinCarousel(me.championId)).flatMap((k) => [k, ...k.childSkins]).find((k) => k.id === selectedSkinId && k.unlocked);
      if (!owned) return err(res, 400, 'Skin not owned');
      me.selectedSkinId = selectedSkinId;
    }
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
  const swapMatch = p.match(/^\/lol-champ-select\/v1\/session\/(trades|pick-order-swaps|position-swaps)\/(\d+)\/(request|accept|decline|cancel)$/);
  if (m === 'POST' && swapMatch && S.session) {
    const kind = SWAP_PATH[swapMatch[1]];
    const cell = Number(swapMatch[2]) - SWAP_BASE[kind];
    const entry = swapLists()[{ trade: 'trades', order: 'pickOrderSwaps', position: 'positionSwaps' }[kind]].find((x) => x.cellId === cell);
    if (!entry) return err(res, 404, 'No such swap');
    const action = swapMatch[3];
    if (action === 'request') {
      if (entry.state !== 'AVAILABLE') return err(res, 400, 'Swap not available');
      SW[kind][cell] = 'SENT';
      later(() => {
        if (SW[kind][cell] !== 'SENT') return;
        if (cell === 1) { SW[kind][cell] = 'DECLINED'; later(() => { delete SW[kind][cell]; touchSession(); }, ms(2)); }
        else { doSwap(kind, cell); delete SW[kind][cell]; SW[kind][cell] = kind === 'trade' ? 'INVALID' : undefined; if (!SW[kind][cell]) delete SW[kind][cell]; }
        touchSession();
      }, between(2, 3));
    } else if (action === 'cancel') {
      if (entry.state !== 'SENT') return err(res, 400, 'Nothing to cancel');
      delete SW[kind][cell];
    } else {
      if (entry.state !== 'RECEIVED') return err(res, 400, 'No request from them');
      if (action === 'accept') { doSwap(kind, cell); SW[kind][cell] = kind === 'trade' ? 'INVALID' : undefined; if (!SW[kind][cell]) delete SW[kind][cell]; }
      else delete SW[kind][cell];
    }
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
const [stylesRaw, perksRaw] = await Promise.all([
  fetchAsset('/lol-game-data/assets/v1/perkstyles.json').catch(() => null),
  fetchAsset('/lol-game-data/assets/v1/perks.json').catch(() => null),
]);
try { styles = JSON.parse(stylesRaw.body).styles; } catch { styles = []; }
try { perkNames = new Map(JSON.parse(perksRaw.body).map((x) => [x.id, x.name])); } catch {}
seedRunes();
S.lobby = lobbyView();

const LIVE_PORT = Number(process.env.MOCK_LIVE_PORT || 52438);
http.createServer((req, res) => {
  const v = liveView();
  if (new URL(req.url, 'http://x').pathname !== '/liveclientdata/allgamedata' || !v) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(v));
}).listen(LIVE_PORT, '127.0.0.1');

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(LOCKFILE, `LeagueClient:${process.pid}:${PORT}:${PASS}:http`);
  console.log(`Mock League client on :${PORT} (${champIds.length} champions, speed ${SPEED}x). Lockfile: ${LOCKFILE}`);
});
const cleanup = () => { try { fs.unlinkSync(LOCKFILE); } catch {} process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
