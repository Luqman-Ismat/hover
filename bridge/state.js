// Mirrors the slice of client state the phone needs, and maps phone intents
// to LCU calls. The phone never sends raw endpoints: only the commands below.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { LCU } from './lcu.js';

const URI = {
  phase: '/lol-gameflow/v1/gameflow-phase',
  lobby: '/lol-lobby/v2/lobby',
  search: '/lol-matchmaking/v1/search',
  readyCheck: '/lol-matchmaking/v1/ready-check',
  session: '/lol-champ-select/v1/session',
  invites: '/lol-lobby/v2/received-invitations',
  runePages: '/lol-perks/v1/pages',
  runeCurrent: '/lol-perks/v1/currentpage',
};
const swapList = (list) => (Array.isArray(list) ? list : []).map((x) => ({ id: x.id, cellId: x.cellId, state: x.state }));
const SWAP_KINDS = { trade: ['trades', 'trades'], order: ['pickOrderSwaps', 'pick-order-swaps'], position: ['positionSwaps', 'position-swaps'] };
const SWAP_ACTIONS = ['request', 'accept', 'decline', 'cancel'];
const PICK_WARNING_MS = 10_000; // warn when this much of your pick/ban timer is left
const AFK_AFTER_S = 75;         // in game: no items bought by now suggests you're away

// League's in-game Live Client Data API (served by the game itself once it's running).
const LIVE_URL = process.env.HOVER_LIVE_URL || 'https://127.0.0.1:2999';
function liveData() {
  return new Promise((resolve) => {
    const url = new URL('/liveclientdata/allgamedata', LIVE_URL);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const POSITION_PREFS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL', 'UNSELECTED'];
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const BY_URI = Object.fromEntries(Object.entries(URI).map(([k, v]) => [v, k]));

// Queues offered on the phone's "start a lobby" list.
export const QUEUES = [
  { id: 420, name: 'Ranked Solo/Duo' },
  { id: 440, name: 'Ranked Flex' },
  { id: 400, name: 'Normal Draft' },
  { id: 490, name: 'Quickplay' },
  { id: 450, name: 'ARAM' },
];

const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export class ClientState extends EventEmitter {
  constructor() {
    super();
    this.lcu = new LCU(Object.values(URI));
    this.seenInvites = new Set(); // invitation ids already announced
    this.seenSwaps = new Set();   // swap requests already announced
    this.reset();
    this.data = null; // champions + spells, fetched once per client launch
    this.lcu.on('connect', () => this.#onConnect());
    this.lcu.on('disconnect', () => { this.reset(); this.#changed(); });
    this.lcu.on('event', (e) => this.#onEvent(e));
  }

  reset() {
    this.s = {
      lcu: false, phase: 'None', lobby: null, search: null, readyCheck: null,
      session: null, sessionAt: 0, queueName: null, gameMode: null,
      pickable: [], bannable: [],
      invites: null, runePages: null, runeCurrent: null,
      live: null,
    };
    this.#stopLive?.();
  }

  start() { this.lcu.start(); }

  async #onConnect() {
    this.s.lcu = true;
    const entries = await Promise.all(Object.entries(URI).map(async ([k, uri]) => [k, await this.lcu.get(uri).catch(() => null)]));
    for (const [k, v] of entries) this.#apply(k, v);
    this.s.phase ??= 'None';
    this.#loadData();
    this.#changed();
  }

  async #loadData() {
    // The client can take a few seconds to serve game data after it starts.
    for (let i = 0; i < 10 && this.lcu.connected; i++) {
      const [champs, spells, styles, perks] = await Promise.all([
        this.lcu.get('/lol-game-data/assets/v1/champion-summary.json').catch(() => null),
        this.lcu.get('/lol-game-data/assets/v1/summoner-spells.json').catch(() => null),
        this.lcu.get('/lol-game-data/assets/v1/perkstyles.json').catch(() => null),
        this.lcu.get('/lol-game-data/assets/v1/perks.json').catch(() => null),
      ]);
      if (Array.isArray(champs) && champs.length > 1 && Array.isArray(spells)) {
        this.data = {
          champions: champs
            .filter((c) => c.id > 0 && c.id < 10000) // 6xxxx = mode-specific duplicates
            .map((c) => ({ id: c.id, name: c.name, alias: c.alias, icon: c.squarePortraitPath, roles: c.roles || [] }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          spells: spells
            .filter((s) => s.id > 0 && s.id < 100 && s.gameModes?.length)
            .map((s) => ({ id: s.id, name: s.name, icon: s.iconPath, modes: s.gameModes })),
          queues: QUEUES,
          runes: {
            styles: (styles?.styles || []).map((s) => ({
              id: s.id, name: s.name, icon: s.iconPath,
              slots: (s.slots || []).map((sl) => ({ type: sl.type, perks: sl.perks || [] })),
              subs: s.allowedSubStyles || [], defaults: s.defaultPerks || [],
            })),
            perks: (Array.isArray(perks) ? perks : []).filter((p) => p.id > 0)
              .map((p) => ({ id: p.id, name: p.name, icon: p.iconPath, desc: stripTags(p.shortDesc) })),
          },
        };
        this.emit('data', this.data);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  #onEvent({ uri, eventType, data }) {
    const key = BY_URI[uri];
    if (!key) return;
    this.#apply(key, eventType === 'Delete' ? null : data);
    this.#changed();
  }

  #apply(key, value) {
    const prev = this.s[key];
    this.s[key] = value;
    if (key === 'phase') {
      this.s.phase = value || 'None';
      if (value === 'ChampSelect' && prev !== 'ChampSelect') this.#loadChampSelectExtras();
      if (value === 'ReadyCheck' && prev !== 'ReadyCheck') this.emit('readyCheck');
      if (value === 'ChampSelect' && prev !== 'ChampSelect') this.emit('champSelect');
      // Someone dodged: champ select fell back to the queue (or the lobby).
      if (prev === 'ChampSelect' && (value === 'Matchmaking' || value === 'Lobby')) this.emit('dodged', value === 'Matchmaking');
      if (value === 'GameStart' || value === 'InProgress') this.#startLive();
      else if (value !== 'Reconnect') this.#stopLive();
    }
    if (key === 'session') {
      this.s.sessionAt = Date.now();
      if (value) this.#refreshPools();
      this.#armPickWarning();
      this.#watchTurnAndSwaps();
    }
    if (key === 'invites') {
      // One alert per new party invite.
      const pending = (Array.isArray(value) ? value : []).filter((i) => i.state === 'Pending');
      for (const i of pending) {
        if (this.seenInvites.has(i.invitationId)) continue;
        this.seenInvites.add(i.invitationId);
        const q = i.gameConfig?.queueId;
        this.emit('invite', { from: i.fromSummonerName || 'A friend', queue: QUEUES.find((x) => x.id === q)?.name ?? null });
      }
    }
    if (key === 'lobby') {
      const q = value?.gameConfig?.queueId;
      if (q && q !== this.queueId) {
        this.queueId = q;
        this.s.queueName = QUEUES.find((x) => x.id === q)?.name ?? null;
        this.lcu.get(`/lol-game-queues/v1/queues/${q}`).then((info) => {
          if (info && this.queueId === q) { this.s.queueName = info.name || info.description || this.s.queueName; this.#changed(); }
        }).catch(() => {});
      }
      if (!value) this.queueId = null;
    }
  }

  async #loadChampSelectExtras() {
    const gf = await this.lcu.get('/lol-gameflow/v1/session').catch(() => null);
    this.s.gameMode = gf?.gameData?.queue?.gameMode ?? null;
    this.#refreshPools(true);
  }

  // Pickable/bannable lists shift as champions get locked; refresh at most every 1.5s.
  #refreshPools(force) {
    const now = Date.now();
    if (!force && now - (this.poolsAt || 0) < 1500) {
      clearTimeout(this.poolTimer);
      this.poolTimer = setTimeout(() => this.#refreshPools(true), 1500);
      return;
    }
    this.poolsAt = now;
    Promise.all([
      this.lcu.get('/lol-champ-select/v1/pickable-champion-ids').catch(() => null),
      this.lcu.get('/lol-champ-select/v1/bannable-champion-ids').catch(() => null),
    ]).then(([p, b]) => {
      if (Array.isArray(p)) this.s.pickable = p;
      if (Array.isArray(b)) this.s.bannable = b;
      this.#changed();
    });
  }

  #changed() {
    this.s.lcu = this.lcu.connected;
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.emit('state', this.snapshot()), 25);
  }

  // What the phone receives. Timers are converted to "ms left right now".
  snapshot() {
    const { s } = this;
    const sess = s.session;
    const age = Date.now() - s.sessionAt;
    const member = (m) => ({
      cellId: m.cellId, championId: m.championId, championPickIntent: m.championPickIntent,
      assignedPosition: m.assignedPosition, spell1Id: m.spell1Id, spell2Id: m.spell2Id, skinId: m.selectedSkinId || 0,
      name: m.gameName || m.summonerName || '',
    });
    return {
      lcu: s.lcu,
      phase: s.phase,
      queueName: s.queueName,
      lobby: s.lobby && {
        queueId: s.lobby.gameConfig?.queueId,
        isLeader: !!s.lobby.localMember?.isLeader,
        canStart: !!s.lobby.canStartActivity,
        positions: !!s.lobby.gameConfig?.showPositionSelector,
        maxSize: s.lobby.gameConfig?.maxLobbySize || 5,
        members: (s.lobby.members || []).map((m) => ({
          summonerId: m.summonerId, name: m.gameName || m.summonerName || '', tag: m.gameTag || m.tagLine || '',
          icon: m.summonerIconId, isLeader: !!m.isLeader,
          me: !!(m.puuid && m.puuid === s.lobby.localMember?.puuid),
          first: m.firstPositionPreference || 'UNSELECTED', second: m.secondPositionPreference || 'UNSELECTED',
        })),
        invited: (s.lobby.invitations || []).filter((i) => i.state === 'Pending')
          .map((i) => ({ summonerId: i.toSummonerId, name: i.toSummonerName || '' })),
      },
      invites: (Array.isArray(s.invites) ? s.invites : []).filter((i) => i.state === 'Pending').map((i) => ({
        id: i.invitationId, from: i.fromSummonerName || '', queueId: i.gameConfig?.queueId ?? null,
      })),
      runes: {
        pages: (Array.isArray(s.runePages) ? s.runePages : []).filter((p) => p && p.id).map((p) => ({
          id: p.id, name: p.name, primaryStyleId: p.primaryStyleId, subStyleId: p.subStyleId,
          selectedPerkIds: p.selectedPerkIds || [], isEditable: !!p.isEditable,
        })),
        current: s.runeCurrent?.id ?? null,
      },
      search: s.search && s.search.searchState === 'Searching'
        ? { timeInQueue: s.search.timeInQueue, estimate: s.search.estimatedQueueTime }
        : null,
      readyCheck: s.readyCheck && s.readyCheck.state !== 'Invalid'
        ? { state: s.readyCheck.state, response: s.readyCheck.playerResponse, timer: s.readyCheck.timer }
        : null,
      session: sess && {
        me: sess.localPlayerCellId,
        actions: (sess.actions || []).map((g) => g.map((a) => ({
          id: a.id, actor: a.actorCellId, championId: a.championId, completed: a.completed,
          active: a.isInProgress, type: a.type, ally: a.isAllyAction,
        }))),
        myTeam: (sess.myTeam || []).map(member),
        theirTeam: (sess.theirTeam || []).map(member),
        bans: { mine: sess.bans?.myTeamBans || [], theirs: sess.bans?.theirTeamBans || [] },
        timer: sess.timer && {
          phase: sess.timer.phase,
          left: sess.timer.isInfinite ? null : Math.max(0, sess.timer.adjustedTimeLeftInPhase - age),
          total: sess.timer.totalTimeInPhase,
        },
        swaps: {
          trade: swapList(sess.trades), order: swapList(sess.pickOrderSwaps), position: swapList(sess.positionSwaps),
        },
        bench: sess.benchEnabled ? (sess.benchChampions || []).map((b) => b.championId) : null,
        rerolls: sess.allowRerolling ? sess.rerollsRemaining : null,
        spectating: !!sess.isSpectating,
      },
      live: s.live,
      gameMode: s.gameMode,
      pickable: s.pickable,
      bannable: s.bannable,
    };
  }

  #myActions() {
    const sess = this.s.session;
    if (!sess) return [];
    return (sess.actions || []).flat().filter((a) => a.actorCellId === sess.localPlayerCellId && !a.completed);
  }

  // "Your turn" once per pick/ban, and one alert per swap request someone sends you.
  #watchTurnAndSwaps() {
    const sess = this.s.session;
    if (!sess) { this.turnAction = null; this.seenSwaps.clear(); return; }
    const mine = (sess.actions || []).flat().find((a) => a.actorCellId === sess.localPlayerCellId && a.isInProgress && !a.completed);
    if (mine && this.turnAction !== mine.id) {
      this.turnAction = mine.id;
      this.emit('turn', mine.type);
    }
    const nameOf = (cell) => (sess.myTeam || []).find((m) => m.cellId === cell);
    for (const [kind, [field]] of Object.entries(SWAP_KINDS)) {
      for (const x of Array.isArray(sess[field]) ? sess[field] : []) {
        const k = `${kind}:${x.id}`;
        if (x.state !== 'RECEIVED') { this.seenSwaps.delete(k); continue; }
        if (this.seenSwaps.has(k)) continue;
        this.seenSwaps.add(k);
        const m = nameOf(x.cellId);
        this.emit('swapRequest', { kind, from: m?.gameName || m?.summonerName || 'A teammate' });
      }
    }
  }

  // One heads-up per pick/ban, ten seconds before your timer runs out.
  #armPickWarning() {
    clearTimeout(this.pickWarn);
    const sess = this.s.session;
    if (!sess || sess.timer?.isInfinite) return;
    const mine = (sess.actions || []).flat().find((a) => a.actorCellId === sess.localPlayerCellId && a.isInProgress && !a.completed);
    if (!mine || this.warnedAction === mine.id) return;
    const left = sess.timer?.adjustedTimeLeftInPhase ?? 0;
    const fire = () => { this.warnedAction = mine.id; this.emit('pickTimeout', mine.type); };
    if (left <= PICK_WARNING_MS) { if (left > 0) fire(); }
    else this.pickWarn = setTimeout(fire, left - PICK_WARNING_MS);
  }

  // While a game runs, poll the game's own API: it answers once the game has loaded.
  #startLive() {
    if (this.liveTimer) return;
    this.s.live = { loaded: false, gameTime: 0, afkRisk: false };
    const tick = async () => {
      const d = await liveData();
      if (!this.liveTimer) return;
      const t = d?.gameData?.gameTime;
      if (typeof t === 'number' && t > 0) {
        const me = d.activePlayer?.riotId || d.activePlayer?.summonerName;
        const player = (d.allPlayers || []).find((p) => (p.riotId || p.summonerName) === me);
        const bought = (player?.items || []).length > 0;
        const afkRisk = t >= AFK_AFTER_S && !bought && !player?.isDead;
        const prev = this.s.live;
        this.s.live = { loaded: true, gameTime: Math.floor(t), afkRisk };
        if (!prev.loaded) this.emit('gameLoaded');
        if (afkRisk && !prev.afkRisk) this.emit('afkRisk');
        this.#changed();
      }
      this.liveTimer = setTimeout(tick, 2000);
    };
    this.liveTimer = setTimeout(tick, 0);
    this.#changed();
  }

  #stopLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (this.s?.live) this.s.live = null;
  }

  #page(id) {
    return (Array.isArray(this.s.runePages) ? this.s.runePages : []).find((p) => p.id === id) || null;
  }

  // A page must follow the tree rules: keystone + one per row from the primary tree,
  // two from different rows of an allowed secondary tree, then one shard per shard row.
  #validRunePage(msg) {
    const styles = this.data?.runes?.styles || [];
    const name = String(msg.name ?? '').trim().slice(0, 50);
    const primary = styles.find((s) => s.id === msg.primaryStyleId);
    const sub = styles.find((s) => s.id === msg.subStyleId);
    const ids = Array.isArray(msg.selectedPerkIds) ? msg.selectedPerkIds : [];
    const bad = (why) => { throw new Error(`That rune page isn’t valid (${why})`); };
    if (!name) bad('give it a name');
    if (!primary || !sub) bad('unknown tree');
    if (primary.id === sub.id || !primary.subs.includes(sub.id)) bad('pick a different secondary tree');
    if (ids.length !== 9 || !ids.every((x) => Number.isInteger(x) && x > 0)) bad('choose every rune');
    const rows = (style, type) => style.slots.filter((sl) => sl.type === type || (type === 'regular' && sl.type !== 'kKeyStone' && sl.type !== 'kStatMod'));
    const [keystoneRow] = rows(primary, 'kKeyStone');
    const primaryRows = rows(primary, 'regular');
    const subRows = rows(sub, 'regular');
    const shardRows = rows(primary, 'kStatMod');
    if (!keystoneRow?.perks.includes(ids[0])) bad('keystone');
    for (let i = 0; i < 3; i++) if (!primaryRows[i]?.perks.includes(ids[1 + i])) bad('primary runes');
    const subRowOf = (id) => subRows.findIndex((r) => r.perks.includes(id));
    const r1 = subRowOf(ids[4]), r2 = subRowOf(ids[5]);
    if (r1 < 0 || r2 < 0 || r1 === r2) bad('secondary runes');
    for (let i = 0; i < 3; i++) if (!shardRows[i]?.perks.includes(ids[6 + i])) bad('shards');
    return { name, primaryStyleId: primary.id, subStyleId: sub.id, selectedPerkIds: ids };
  }

  async #call(method, path, body) {
    const { status, data } = await this.lcu.request(method, path, body);
    if (status >= 400) throw new Error(data?.message || `League client refused (${status})`);
    return data;
  }

  async command(msg) {
    if (!this.lcu.connected) throw new Error('League client is not running');
    switch (msg.type) {
      case 'createLobby': {
        const queueId = int(msg.queueId);
        if (!QUEUES.some((q) => q.id === queueId)) throw new Error('Unknown queue');
        return this.#call('POST', '/lol-lobby/v2/lobby', { queueId });
      }
      case 'leaveLobby': return this.#call('DELETE', '/lol-lobby/v2/lobby');

      // ---- party ----
      case 'friends': {
        const list = await this.lcu.get('/lol-chat/v1/friends');
        if (!Array.isArray(list)) throw new Error('Couldn’t load your friends list');
        const rank = { chat: 0, mobile: 1, away: 2, dnd: 3, offline: 4 };
        return list
          .filter((f) => int(f.summonerId))
          .map((f) => ({
            summonerId: f.summonerId, name: f.gameName || f.name || '', tag: f.gameTag || '',
            icon: f.icon, availability: f.availability || 'offline', status: f.lol?.gameStatus || '',
          }))
          .sort((a, b) => (rank[a.availability] ?? 5) - (rank[b.availability] ?? 5) || a.name.localeCompare(b.name));
      }
      case 'invite': {
        const toSummonerId = int(msg.summonerId);
        if (!toSummonerId) throw new Error('Pick a friend');
        return this.#call('POST', '/lol-lobby/v2/lobby/invitations', [{ toSummonerId }]);
      }
      case 'kick': case 'promote': {
        const id = int(msg.summonerId);
        if (!id) throw new Error('Pick a party member');
        return this.#call('POST', `/lol-lobby/v2/lobby/members/${id}/${msg.type}`);
      }
      case 'acceptInvite': case 'declineInvite': {
        const id = String(msg.invitationId || '');
        if (!/^[\w.:-]{1,100}$/.test(id)) throw new Error('Unknown invite');
        return this.#call('POST', `/lol-lobby/v2/received-invitations/${encodeURIComponent(id)}/${msg.type === 'acceptInvite' ? 'accept' : 'decline'}`);
      }
      case 'positions': {
        const first = String(msg.first), second = String(msg.second);
        if (!POSITION_PREFS.includes(first) || !POSITION_PREFS.includes(second)) throw new Error('Unknown role');
        if (first !== 'UNSELECTED' && first !== 'FILL' && first === second) throw new Error('Pick two different roles');
        return this.#call('PUT', '/lol-lobby/v2/lobby/members/localMember/position-preferences', { firstPreference: first, secondPreference: second });
      }

      // ---- runes ----
      case 'runeSelect': {
        const id = int(msg.pageId);
        if (!id || !this.#page(id)) throw new Error('Unknown rune page');
        return this.#call('PUT', '/lol-perks/v1/currentpage', id);
      }
      case 'runeSave': {
        const page = this.#validRunePage(msg);
        const id = msg.pageId == null ? null : int(msg.pageId);
        if (id) {
          const existing = this.#page(id);
          if (!existing) throw new Error('Unknown rune page');
          if (!existing.isEditable) throw new Error('That page can’t be edited');
          return this.#call('PUT', `/lol-perks/v1/pages/${id}`, { ...existing, ...page, id });
        }
        return this.#call('POST', '/lol-perks/v1/pages', { ...page, current: true });
      }
      case 'runeDelete': {
        const id = int(msg.pageId);
        const existing = id && this.#page(id);
        if (!existing) throw new Error('Unknown rune page');
        if (!existing.isEditable) throw new Error('That page can’t be deleted');
        return this.#call('DELETE', `/lol-perks/v1/pages/${id}`);
      }
      case 'search': return this.#call('POST', '/lol-lobby/v2/lobby/matchmaking/search');
      case 'cancelSearch': return this.#call('DELETE', '/lol-lobby/v2/lobby/matchmaking/search');
      case 'accept': return this.#call('POST', '/lol-matchmaking/v1/ready-check/accept');
      case 'decline': return this.#call('POST', '/lol-matchmaking/v1/ready-check/decline');

      case 'hover': {
        const championId = int(msg.championId);
        if (!championId) throw new Error('Pick a champion');
        const mine = this.#myActions();
        const action = mine.find((a) => a.isInProgress) || mine.find((a) => a.type === 'pick');
        if (!action) throw new Error('Nothing to pick right now');
        // Picks are checked against what you can play. Bans go straight to the client, which knows
        // best (its bannable list isn't always the full set you're allowed to ban).
        if (action.type === 'pick' && this.s.pickable.length && !this.s.pickable.includes(championId)) throw new Error('That champion isn’t available');
        return this.#call('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId });
      }
      case 'lock': {
        const action = this.#myActions().find((a) => a.isInProgress);
        if (!action) throw new Error('It isn’t your turn');
        // Lock exactly what the phone shows, even if the hover hadn't reached the client yet.
        const championId = int(msg.championId) || action.championId;
        if (!championId) throw new Error('Choose a champion first');
        const url = `/lol-champ-select/v1/session/actions/${action.id}`;
        // What the client itself does: set the champion and complete the action in one go.
        const first = await this.lcu.request('PATCH', url, { championId, completed: true });
        if (first.status < 400) return null;
        this.emit('log', `Lock via PATCH refused (${first.status} ${first.data?.message || ''}); trying /complete`);
        await this.lcu.request('PATCH', url, { championId });
        return this.#call('POST', `${url}/complete`);
      }
      case 'spells': {
        const spell1Id = int(msg.spell1Id), spell2Id = int(msg.spell2Id);
        if (!spell1Id || !spell2Id) throw new Error('Choose two spells');
        return this.#call('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id, spell2Id });
      }
      case 'swap': {
        const kind = SWAP_KINDS[msg.kind];
        const id = int(msg.swapId);
        if (!kind || !SWAP_ACTIONS.includes(msg.action) || !id) throw new Error('Unknown swap');
        const entry = (this.s.session?.[kind[0]] || []).find((x) => x.id === id);
        if (!entry) throw new Error('That swap isn’t available any more');
        return this.#call('POST', `/lol-champ-select/v1/session/${kind[1]}/${id}/${msg.action}`);
      }
      // Your champion's skins (and chromas) from the client's skin carousel.
      case 'skins': {
        const list = await this.lcu.get('/lol-champ-select/v1/skin-carousel-skins');
        if (!Array.isArray(list)) throw new Error('Couldn’t load your skins');
        return list.filter((k) => int(k.id)).map((k) => ({
          id: k.id, name: k.name || '', owned: !!k.unlocked && !k.disabled, base: !!k.isBase,
          chromas: (k.childSkins || []).filter((c) => int(c.id)).map((c) => ({
            id: c.id, name: c.name || '', owned: !!c.unlocked && !c.disabled, color: c.colors?.[0] || null,
          })),
        }));
      }
      case 'skin': {
        const selectedSkinId = int(msg.skinId);
        if (!selectedSkinId) throw new Error('Pick a skin');
        return this.#call('PATCH', '/lol-champ-select/v1/session/my-selection', { selectedSkinId });
      }
      case 'reroll': return this.#call('POST', '/lol-champ-select/v1/session/my-selection/reroll');
      case 'bench': {
        const championId = int(msg.championId);
        if (!championId) throw new Error('Pick a champion');
        return this.#call('POST', `/lol-champ-select/v1/session/bench/swap/${championId}`);
      }
      default: throw new Error('Unknown command');
    }
  }
}
