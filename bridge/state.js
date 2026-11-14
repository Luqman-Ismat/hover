// Mirrors the slice of client state the phone needs, and maps phone intents
// to LCU calls. The phone never sends raw endpoints: only the commands below.
import { EventEmitter } from 'node:events';
import { LCU } from './lcu.js';

const URI = {
  phase: '/lol-gameflow/v1/gameflow-phase',
  lobby: '/lol-lobby/v2/lobby',
  search: '/lol-matchmaking/v1/search',
  readyCheck: '/lol-matchmaking/v1/ready-check',
  session: '/lol-champ-select/v1/session',
};
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
    };
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
      const [champs, spells] = await Promise.all([
        this.lcu.get('/lol-game-data/assets/v1/champion-summary.json').catch(() => null),
        this.lcu.get('/lol-game-data/assets/v1/summoner-spells.json').catch(() => null),
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
    }
    if (key === 'session') {
      this.s.sessionAt = Date.now();
      if (value) this.#refreshPools();
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
      assignedPosition: m.assignedPosition, spell1Id: m.spell1Id, spell2Id: m.spell2Id,
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
        members: s.lobby.members?.length ?? 1,
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
        bench: sess.benchEnabled ? (sess.benchChampions || []).map((b) => b.championId) : null,
        rerolls: sess.allowRerolling ? sess.rerollsRemaining : null,
        spectating: !!sess.isSpectating,
      },
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
        const pool = action.type === 'ban' ? this.s.bannable : this.s.pickable;
        if (pool.length && !pool.includes(championId)) throw new Error('That champion isn’t available');
        return this.#call('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId });
      }
      case 'lock': {
        const action = this.#myActions().find((a) => a.isInProgress);
        if (!action) throw new Error('It isn’t your turn');
        if (!action.championId) throw new Error('Choose a champion first');
        return this.#call('POST', `/lol-champ-select/v1/session/actions/${action.id}/complete`);
      }
      case 'spells': {
        const spell1Id = int(msg.spell1Id), spell2Id = int(msg.spell2Id);
        if (!spell1Id || !spell2Id) throw new Error('Choose two spells');
        return this.#call('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id, spell2Id });
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
