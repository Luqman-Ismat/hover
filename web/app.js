import { html, render, useState, useEffect, useRef } from '/vendor/preact.js';

// ---------------------------------------------------------------------------
// Bridge connection + tiny store
// ---------------------------------------------------------------------------
const store = { link: 'connecting', state: null, data: null, toast: null };
const listeners = new Set();
const update = (patch) => { Object.assign(store, patch); listeners.forEach((l) => l()); };
function useStore() {
  const [, force] = useState(0);
  // Re-sync on subscribe: the socket may have delivered updates before the effect ran.
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); l(); return () => listeners.delete(l); }, []);
  return store;
}

let ws = null, seq = 0, attempts = 0, retryTimer;
const pending = new Map();

async function connect() {
  if (ws && ws.readyState <= 1) return;
  clearTimeout(retryTimer);
  let session;
  try { session = await fetch('/api/session', { cache: 'no-store' }).then((r) => r.json()); }
  catch { update({ link: 'offline' }); return retry(); }
  if (!session.paired) return update({ link: 'unpaired' });

  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => { attempts = 0; update({ link: 'open' }); };
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') { m.state.at = performance.now(); update({ state: m.state }); }
    else if (m.type === 'data') update({ data: indexData(m.data) });
    else if (m.type === 'result') { pending.get(m.id)?.(m); pending.delete(m.id); }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    for (const p of pending.values()) p({ ok: false, error: 'Lost connection to your computer' });
    pending.clear();
    update({ link: 'offline' });
    retry();
  };
}
function retry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, Math.min(500 * 2 ** attempts++, 4000)); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) connect(); });

function send(type, payload = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ ok: false, error: 'Not connected' });
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, type, ...payload }));
  }).then((r) => { if (!r.ok) toast(r.error); return r; });
}

let toastTimer;
function toast(text) {
  clearTimeout(toastTimer);
  update({ toast: { text, key: Date.now() } });
  toastTimer = setTimeout(() => update({ toast: null }), 3200);
}

function indexData(d) {
  return {
    champs: new Map(d.champions.map((c) => [c.id, c])),
    list: d.champions,
    spells: new Map(d.spells.map((s) => [s.id, s])),
    spellList: d.spells,
    queues: d.queues,
    styles: d.runes?.styles || [],
    styleMap: new Map((d.runes?.styles || []).map((s) => [s.id, s])),
    perks: new Map((d.runes?.perks || []).map((p) => [p.id, p])),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const asset = (p) => (p ? `/asset?p=${encodeURIComponent(p)}` : '');
const art = (id, k = 'splash') => (id > 0 ? `/art?id=${id}&k=${k}` : '');
const champIcon = (id) => (id > 0 ? asset(store.data?.champs.get(id)?.icon || `/lol-game-data/assets/v1/champion-icons/${id}.png`) : '');
const champName = (id) => store.data?.champs.get(id)?.name || '';
const fold = (s) => s.normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();
const POSITIONS = { top: 'Top', jungle: 'Jungle', middle: 'Mid', bottom: 'Bot', utility: 'Support' };
const clock = (sec) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const cx = (...c) => c.filter(Boolean).join(' ');

// One-line pitch for each queue on the Play screen.
const QUEUE_BLURB = {
  490: 'Choose roles and champions, then go',
  400: 'Bans and picks, no rank on the line',
  420: 'Climb alone or with one friend',
  440: 'Ranked with a group of up to five',
  450: 'One lane, random champions',
};
// Maps, as the client groups them. Art comes from the client's own game-mode assets.
const GM = '/lol-game-data/assets/content/src/LeagueClient/GameModeAssets';
const MAPS = [
  { key: 'sr', name: 'Summoner’s Rift', place: 'Summoner’s Rift', sub: '5v5', queues: [490, 400, 420, 440],
    bg: `${GM}/Classic_SRU/img/parties-background.jpg`, icon: `${GM}/Classic_SRU/img/game-select-icon-active.png` },
  { key: 'ha', name: 'ARAM', place: 'Howling Abyss', sub: 'Howling Abyss', queues: [450],
    bg: `${GM}/ARAM/img/parties-background.jpg`, icon: `${GM}/ARAM/img/game-select-icon-active.png` },
];
const mapOf = (qid) => MAPS.find((m) => m.queues.includes(qid)) || MAPS[0];
const ROLES = [['', 'All'], ['assassin', 'Assassin'], ['fighter', 'Fighter'], ['mage', 'Mage'], ['marksman', 'Marksman'], ['support', 'Support'], ['tank', 'Tank']];

function useTicker(ms = 200) {
  const [, f] = useState(0);
  useEffect(() => { const t = setInterval(() => f((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}
// Seconds elapsed since the last state message, for client-side timers.
const sinceState = () => (performance.now() - (store.state?.at ?? performance.now())) / 1000;

// Champion titles ("the Nine-Tailed Fox"), fetched once each.
const titles = new Map();
function useTitle(id) {
  const [, f] = useState(0);
  useEffect(() => {
    if (!(id > 0) || titles.has(id)) return;
    titles.set(id, '');
    fetch(`/api/champion?id=${id}`).then((r) => (r.ok ? r.json() : null)).then((d) => { titles.set(id, d?.title || ''); f((n) => n + 1); }).catch(() => {});
  }, [id]);
  return titles.get(id) || '';
}

// Audio: unlocked on first touch so the queue-pop chime can play later.
let audio;
addEventListener('pointerdown', () => { audio ??= new AudioContext(); audio.resume(); }, { once: false, passive: true });
function chime() {
  if (!audio) return;
  const t = audio.currentTime;
  for (const [i, f] of [[0, 660], [1, 880], [2, 1320]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.14);
    g.gain.linearRampToValueAtTime(0.16, t + i * 0.14 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.14 + 0.6);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.14); o.stop(t + i * 0.14 + 0.65);
  }
}

const Icon = {
  search: html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.2 13.2 17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dice: html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.2" cy="7.2" r="1.2" fill="currentColor"/><circle cx="12.8" cy="12.8" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/></svg>`,
  x: html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  plus: html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  crown: html`<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M3 15h14l1-9-4.5 3.5L10 4 6.5 9.5 2 6Z" fill="currentColor"/></svg>`,
  runes: html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 2.5 16.5 10 10 17.5 3.5 10Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6.5 13 10l-3 3.5L7 10Z" fill="currentColor"/></svg>`,
  edit: html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 16l.8-3.2L13 4.6l2.4 2.4-8.2 8.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  trash: html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 6h10M8 6V4h4v2M6.5 6l.7 10h5.6l.7-10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  back: html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  arrow: html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  swords: html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 4l9.5 9.5M20 4l-9.5 9.5M6.5 15.5l2 2M17.5 15.5l-2 2M4.5 19.5l3-3M19.5 19.5l-3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

const Logo = () => html`
  <span class="logo" aria-label="Hover">
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" stroke-opacity="0.28" stroke-width="2.6"/>
      <path d="M16 5.5A10.5 10.5 0 1 1 6.2 19.8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
      <circle cx="16" cy="16" r="3" fill="currentColor"/>
    </svg>
    <span class="logo-word">Hover</span>
  </span>`;

// Thin gold rule with a diamond in the middle.
const Rule = () => html`<div class="hx-rule" aria-hidden="true"><i /></div>`;

// Drifting embers over the map art.
const Embers = () => html`<div class="embers" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => html`<i key=${i} style=${{ '--x': `${(i * 37) % 100}%`, '--d': `${9 + (i * 7) % 8}s`, '--t': `${-(i * 1.3)}s`, '--s': `${2 + (i % 3)}px` }} />`)}</div>`;

// ---------------------------------------------------------------------------
// Backdrop: full-bleed map or splash art that cross-fades between scenes
// ---------------------------------------------------------------------------
function Backdrop({ src, tone }) {
  const [layers, setLayers] = useState([]);
  useEffect(() => {
    if (!src) return;
    let live = true;
    const img = new Image();
    img.src = src;
    (img.decode ? img.decode() : new Promise((r) => (img.onload = r))).catch(() => {}).then(() => {
      if (!live || !img.naturalWidth) return;
      setLayers((ls) => (ls.at(-1)?.src === src ? ls : [...ls.slice(-1), { src, key: `${src}#${Date.now()}` }]));
    });
    return () => { live = false; };
  }, [src]);
  const map = ['home', 'lobby', 'queue', 'ready', 'calm'].includes(tone);
  return html`
    <div class=${'backdrop tone-' + tone} aria-hidden="true">
      <div class="aurora"><i /><i /><i /></div>
      ${layers.map((l, i) => html`<img key=${l.key} class=${cx('bd-img', i === layers.length - 1 && 'top')} src=${l.src} alt="" />`)}
      <div class="bd-shade" />
      ${map && html`<${Embers} />`}
      <div class="bd-grain" />
    </div>`;
}

// Which champion (and treatment) sits behind each screen.
// Your last locked champion, kept across reloads so the in-game screen still shows it.
let lastPick = (() => { try { return Number(sessionStorage.getItem('hover.lastPick')) || 0; } catch { return 0; } })();
function rememberPick(id) {
  if (id === lastPick) return;
  lastPick = id;
  try { sessionStorage.setItem('hover.lastPick', String(id)); } catch {}
}
// The map is the backdrop everywhere outside champ select; there, your champion takes over.
function scene(st) {
  const s = st.state;
  if (st.link !== 'open' || !s?.lcu) return { src: '', tone: 'calm' };
  const rift = asset(mapOf(s.lobby?.queueId).bg);
  switch (s.phase) {
    case 'Lobby': return { src: rift, tone: 'lobby' };
    case 'Matchmaking': return { src: rift, tone: 'queue' };
    case 'ReadyCheck': return { src: rift, tone: 'ready' };
    case 'ChampSelect': {
      if (!s.session || !st.data) return { src: lastPick ? art(lastPick) : rift, tone: 'draft' };
      const d = deriveDraft(s);
      const banning = d.current?.type === 'ban';
      const id = d.selected || d.me.championId || 0;
      if (!banning && d.me.championId) rememberPick(d.me.championId);
      const champ = id || lastPick;
      return { src: champ ? art(champ) : rift, tone: banning ? 'ban' : d.pickDone ? 'locked' : 'draft' };
    }
    case 'GameStart': case 'InProgress': case 'Reconnect': return { src: lastPick ? art(lastPick) : rift, tone: lastPick ? 'hero' : 'home' };
    default: return { src: asset(MAPS[0].bg), tone: 'home' };
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
function App() {
  const st = useStore();
  const { link, state } = st;
  const homeish = link === 'open' && state?.lcu && !['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress', 'Reconnect'].includes(state.phase);
  const sc = scene(st);

  let screen;
  if (link === 'unpaired') screen = html`<${Pair} />`;
  else if (link === 'connecting' || (link === 'open' && !state)) screen = html`<${Splash} />`;
  else if (link !== 'open') screen = html`<${Message} eyebrow="Offline" title="Can’t reach your computer" body="Make sure Hover is running there and your phone is on the same Wi‑Fi." waiting="Retrying" />`;
  else if (!state.lcu) screen = html`<${Message} eyebrow="Connected to Hover" title="Open League on your computer" body="Hover picks up the client as soon as it starts." waiting="Waiting for the client" />`;
  else if (homeish) screen = html`<${Home} s=${state} />`;
  else screen = phaseScreen(state);

  const live = link === 'open' && state?.lcu;
  const quiet = !live || ['ChampSelect', 'GameStart', 'InProgress', 'Reconnect', 'ReadyCheck'].includes(state.phase);
  return html`
    <${Backdrop} src=${sc.src} tone=${sc.tone} />
    ${screen}
    ${!quiet && state.invites?.length > 0 && html`<${InviteBanner} invite=${state.invites[0]} />`}
    ${live && st.runesOpen && st.data && html`<${RunesScreen} s=${state} onClose=${() => update({ runesOpen: false })} />`}
    ${st.toast && html`<div class="toast" key=${st.toast.key} role="status">${st.toast.text}</div>`}
  `;
}
const openRunes = () => update({ runesOpen: true });

function phaseScreen(s) {
  switch (s.phase) {
    case 'Lobby': return html`<${Lobby} s=${s} />`;
    case 'Matchmaking': return html`<${Queue} s=${s} />`;
    case 'ReadyCheck': return html`<${ReadyCheck} s=${s} />`;
    case 'ChampSelect': return s.session ? html`<${ChampSelect} s=${s} />` : html`<${Splash} />`;
    case 'GameStart': return html`<${Hero} eyebrow="Loading into game" body="Champ select is done. Good luck out there." />`;
    default: return html`<${Hero} eyebrow="In game" body="Hover will be here when you’re back for the next one." />`;
  }
}

function Splash() {
  return html`<main class="screen splash"><div class="splash-mark"><${Logo} /></div></main>`;
}

function Message({ eyebrow, title, body, waiting }) {
  return html`
    <main class="screen message">
      <header class="top-row"><${Logo} /></header>
      <div class="message-body">
        ${eyebrow && html`<p class="eyebrow">${eyebrow}</p>`}
        <h1 class="title">${title}</h1>
        <p class="sub">${body}</p>
        ${waiting && html`<p class="waiting"><span class="pulse" />${waiting}</p>`}
      </div>
    </main>`;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
function Pair() {
  const initial = new URLSearchParams(location.search).get('code') || '';
  const [code, setCode] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (value = code) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 6) return setError('The code is 6 digits.');
    setBusy(true); setError('');
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: digits }) })
      .then(async (res) => ({ ok: res.ok, ...(await res.json().catch(() => ({}))) }))
      .catch(() => ({ ok: false, error: 'Can’t reach your computer.' }));
    setBusy(false);
    if (!r.ok) return setError(r.error || 'Pairing failed.');
    history.replaceState(null, '', '/');
    update({ link: 'connecting' });
    connect();
  };
  useEffect(() => { if (initial) submit(initial); }, []);

  const digits = code.replace(/\D/g, '').slice(0, 6);
  return html`
    <main class="screen pair">
      <header class="top-row"><${Logo} /></header>
      <div class="message-body">
        <p class="eyebrow">First time on this phone</p>
        <h1 class="title">Pair with your computer</h1>
        <p class="sub">Enter the 6‑digit code shown where Hover is running. You only do this once.</p>
        <form onSubmit=${(e) => { e.preventDefault(); submit(); }}>
          <label class="code-wrap">
            <input class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
              value=${digits} onInput=${(e) => { setCode(e.target.value); setError(''); }} aria-label="Pairing code" />
            <span class="code-boxes" aria-hidden="true">
              ${[0, 1, 2, 3, 4, 5].map((i) => html`<span class=${cx('code-box', i === digits.length && 'caret', digits[i] && 'filled')}>${digits[i] || ''}</span>`)}
            </span>
          </label>
          <p class="error" aria-live="polite">${error}</p>
        </form>
      </div>
      <footer class="dock"><button class="btn hex" disabled=${busy || digits.length !== 6} onClick=${() => submit()}>${busy ? 'Pairing…' : 'Pair this phone'}</button></footer>
    </main>`;
}

// ---------------------------------------------------------------------------
// Start screen + modes
// ---------------------------------------------------------------------------
function Home({ s }) {
  const [picking, setPicking] = useState(false);
  const after = ['WaitingForStats', 'PreEndOfGame', 'EndOfGame'].includes(s.phase);
  return html`
    <main class="screen home">
      <header class="top-row">
        <${Logo} />
        <span class="chip"><i class="dot live" />Client connected</span>
      </header>
      <div class="home-hero">
        <p class="eyebrow">${after ? 'Game over' : 'Welcome, summoner'}</p>
        <h1 class="mega">${after ? 'Good game' : 'Summoner’s Rift awaits'}</h1>
        <${Rule} />
        <p class="sub">${after ? 'Queue up again whenever you’re ready.' : 'Open a lobby, queue and draft from your phone.'}</p>
      </div>
      <footer class="dock">
        <button class="btn hex xl" onClick=${() => setPicking(true)}><span>${after ? 'Play again' : 'Play'}</span></button>
        <div class="dock-row"><button class="btn quiet" onClick=${openRunes}>${Icon.runes}<span>Runes</span></button></div>
      </footer>
      ${picking && html`<${ModeSelect} onClose=${() => setPicking(false)} />`}
    </main>`;
}

// The client's Play screen: maps on top, that map's queues underneath, then Confirm.
function ModeSelect({ current, onClose }) {
  const queues = store.data?.queues || [];
  const [mapKey, setMapKey] = useState(mapOf(current ?? 420).key);
  const [qid, setQid] = useState(current ?? null);
  const [closing, setClosing] = useState(false);
  const map = MAPS.find((m) => m.key === mapKey);
  const options = map.queues.map((id) => queues.find((q) => q.id === id)).filter(Boolean);
  const close = () => { setClosing(true); setTimeout(onClose, 180); };
  const chooseMap = (m) => {
    setMapKey(m.key);
    if (!m.queues.includes(qid)) setQid(m.queues.includes(current) ? current : m.queues.length === 1 ? m.queues[0] : null);
  };
  const confirm = () => { if (qid && qid !== current) send('createLobby', { queueId: qid }); close(); };
  useEffect(() => { const k = (e) => e.key === 'Escape' && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return html`
    <div class=${cx('modesel', closing && 'closing')} role="dialog" aria-label="Play">
      <header class="top-row">
        <button class="icon-btn glass" onClick=${close} aria-label="Back">${Icon.back}</button>
        <h1 class="modesel-title">Play</h1>
        <span class="top-spacer" />
      </header>

      <section class="maps" role="radiogroup" aria-label="Map">
        ${MAPS.map((m) => html`
          <button key=${m.key} role="radio" aria-checked=${m.key === mapKey} class=${cx('map-card', m.key === mapKey && 'on')} onClick=${() => chooseMap(m)}>
            <img class="map-art" src=${asset(m.bg)} alt="" />
            <span class="map-shade" />
            <img class="map-icon" src=${asset(m.icon)} alt="" />
            <span class="map-name">${m.name}</span>
            <span class="map-sub">${m.sub}</span>
          </button>`)}
      </section>

      <${Rule} />

      <section class="queues" role="radiogroup" aria-label="Queue">
        <p class="eyebrow">${map.name}</p>
        ${options.map((q, i) => html`
          <button key=${q.id} role="radio" aria-checked=${q.id === qid} class=${cx('queue-opt', q.id === qid && 'on')} style=${{ animationDelay: `${i * 45}ms` }} onClick=${() => setQid(q.id)}>
            <span class="diamond" />
            <span class="queue-text">
              <span class="queue-name">${q.name}</span>
              <span class="queue-blurb">${q.id === current ? 'Current mode' : QUEUE_BLURB[q.id] || ''}</span>
            </span>
          </button>`)}
      </section>

      <footer class="dock">
        <button class="btn hex xl" disabled=${!qid} onClick=${confirm}>${qid && qid === current ? 'Keep this mode' : 'Confirm'}</button>
      </footer>
    </div>`;
}

function Lobby({ s }) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(null); // 'friends' | { member } | { role: 1|2 }
  const lobby = s.lobby;
  const leader = lobby?.isLeader;
  const me = lobby?.members.find((m) => m.me) || {};
  const rolesDone = !lobby?.positions || me.first === 'FILL' || (me.first !== 'UNSELECTED' && me.second !== 'UNSELECTED');
  const find = async () => { setBusy(true); await send('search'); setBusy(false); };
  const others = (lobby?.members.length || 1) - 1;

  let primary;
  if (!rolesDone) primary = html`<button class="btn hex xl" onClick=${() => setSheet({ role: me.first === 'UNSELECTED' ? 1 : 2 })}>Choose your roles</button>`;
  else if (leader) primary = html`<button class="btn hex xl" disabled=${busy || !lobby?.canStart} onClick=${find}>Find match</button>`;
  else primary = html`<p class="dock-note">The party leader starts the queue</p>`;

  return html`
    <main class="screen lobby">
      <header class="top-row">
        <button class="icon-btn glass back" onClick=${() => send('leaveLobby')} aria-label="Leave lobby">${Icon.back}</button>
        <span class="chip">${others ? `Party of ${others + 1}` : 'Lobby'}</span>
      </header>
      <div class="stage">
        <p class="eyebrow">${mapOf(lobby?.queueId).place}</p>
        <h1 class="mega">${s.queueName || 'Lobby'}</h1>
        <${Rule} />
        <p class="sub">${!leader ? 'Waiting for the party leader.' : lobby?.canStart ? 'Ready when you are.' : rolesDone ? 'Waiting for everyone to pick roles.' : 'Pick your roles to queue.'}</p>
      </div>

      <${Party} lobby=${lobby} onInvite=${() => setSheet('friends')} onMember=${(m) => setSheet({ member: m })} />
      ${lobby?.positions && html`<${RolePicker} me=${me} onPick=${(slot) => setSheet({ role: slot })} />`}

      <footer class="dock">
        ${primary}
        <div class="dock-row">
          <button class="btn quiet" onClick=${openRunes}>${Icon.runes}<span>Runes</span></button>
          ${leader && html`<button class="btn quiet" onClick=${() => setChanging(true)}>Change mode</button>`}
        </div>
      </footer>
      ${changing && html`<${ModeSelect} current=${lobby?.queueId} onClose=${() => setChanging(false)} />`}
      ${sheet === 'friends' && html`<${FriendsSheet} lobby=${lobby} onClose=${() => setSheet(null)} />`}
      ${sheet?.member && html`<${MemberSheet} member=${sheet.member} onClose=${() => setSheet(null)} />`}
      ${sheet?.role && html`<${RoleSheet} slot=${sheet.role} me=${me} onClose=${() => setSheet(null)} />`}
    </main>`;
}

// ---------------------------------------------------------------------------
// Party: members, invites, roles
// ---------------------------------------------------------------------------
const ROLE_NAMES = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support', FILL: 'Fill', UNSELECTED: 'None' };
const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL'];
const profileIcon = (id) => asset(`/lol-game-data/assets/v1/profile-icons/${id ?? 29}.jpg`);

// Lane glyphs: a little map square with the lane traced in.
function RoleGlyph({ role, size = 22 }) {
  const lane = {
    TOP: html`<path d="M6 18V6h12" />`,
    BOTTOM: html`<path d="M6 18h12V6" />`,
    MIDDLE: html`<path d="M7 17 17 7" />`,
    JUNGLE: html`<path d="M12 6.5 16.5 14h-9Z M12 14v4" />`,
    UTILITY: html`<path d="M12 5.5 17.5 8v4c0 3.2-2.4 5.6-5.5 6.5C8.9 17.6 6.5 15.2 6.5 12V8Z" />`,
    FILL: html`<path d="M12 6v12M6 12h12M8 8l8 8M16 8l-8 8" />`,
  }[role];
  return html`
    <svg class=${cx('role-glyph', `r-${(role || 'none').toLowerCase()}`)} viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" class="rg-frame" />
      ${lane ? html`<g class="rg-lane">${lane}</g>` : html`<path d="M9 12h6" class="rg-lane" />`}
    </svg>`;
}

function Party({ lobby, onInvite, onMember }) {
  if (!lobby) return null;
  const slots = [];
  for (const m of lobby.members) slots.push({ kind: 'member', m });
  for (const i of lobby.invited) slots.push({ kind: 'invited', i });
  while (slots.length < lobby.maxSize) slots.push({ kind: 'open' });
  return html`
    <section class="party" aria-label="Party">
      ${slots.slice(0, lobby.maxSize).map((sl, k) => {
        if (sl.kind === 'member') {
          const { m } = sl;
          const tappable = lobby.isLeader && !m.me;
          return html`
            <button key=${'m' + m.summonerId} class=${cx('member', m.me && 'me', m.isLeader && 'leader')} disabled=${!tappable} onClick=${() => onMember(m)}>
              <span class="member-face"><img src=${profileIcon(m.icon)} alt="" />${m.isLeader && html`<i class="crown" title="Party leader">${Icon.crown}</i>`}</span>
              <span class="member-name">${m.me ? 'You' : m.name}</span>
              ${lobby.positions && html`<span class="member-roles"><${RoleGlyph} role=${m.first} size=${15} /><${RoleGlyph} role=${m.second} size=${15} /></span>`}
            </button>`;
        }
        if (sl.kind === 'invited') return html`
          <div key=${'i' + sl.i.summonerId} class="member invited">
            <span class="member-face"><span class="pulse" /></span>
            <span class="member-name">${sl.i.name}</span>
            <span class="member-sub">Invited</span>
          </div>`;
        return html`
          <button key=${'o' + k} class="member open" onClick=${onInvite} aria-label="Invite a friend">
            <span class="member-face">${Icon.plus}</span>
            <span class="member-name">Invite</span>
          </button>`;
      })}
    </section>`;
}

function RolePicker({ me, onPick }) {
  return html`
    <section class="roles-pick" aria-label="Your roles">
      ${[1, 2].map((slot) => {
        const role = slot === 1 ? me.first : me.second;
        const off = slot === 2 && me.first === 'FILL';
        return html`
          <button key=${slot} class=${cx('role-slot', role !== 'UNSELECTED' && 'set')} disabled=${off} onClick=${() => onPick(slot)}>
            <${RoleGlyph} role=${off ? 'UNSELECTED' : role} size=${30} />
            <span class="role-slot-text">
              <span class="role-slot-label">${slot === 1 ? 'Primary' : 'Secondary'}</span>
              <span class="role-slot-name">${off ? 'Not needed' : role === 'UNSELECTED' ? 'Choose' : ROLE_NAMES[role]}</span>
            </span>
          </button>`;
      })}
    </section>`;
}

function RoleSheet({ slot, me, onClose }) {
  const current = slot === 1 ? me.first : me.second;
  const other = slot === 1 ? me.second : me.first;
  const choose = (role) => {
    onClose();
    let first = me.first, second = me.second;
    if (slot === 1) {
      if (role === second) second = first; // swap, like the client
      first = role;
      if (first === 'FILL') second = 'UNSELECTED';
    } else {
      if (role === first) first = second;
      second = role;
    }
    send('positions', { first, second });
  };
  const options = ROLE_ORDER.filter((r) => slot === 1 || r !== 'FILL');
  return html`
    <${Sheet} title=${slot === 1 ? 'Primary role' : 'Secondary role'} onClose=${onClose}>
      <ul class="role-grid">
        ${options.map((r) => html`
          <li key=${r}>
            <button class=${cx('role-opt', r === current && 'on', r === other && 'other')} onClick=${() => choose(r)}>
              <${RoleGlyph} role=${r} size=${40} />
              <span>${ROLE_NAMES[r]}</span>
            </button>
          </li>`)}
      </ul>
    </${Sheet}>`;
}

const FRIEND_STATUS = {
  inGame: 'In game', championSelect: 'In champ select', inQueue: 'In queue', outOfGame: 'Online',
};
function friendStatus(f) {
  if (f.availability === 'offline') return 'Offline';
  if (f.availability === 'mobile') return 'On mobile';
  if (f.status?.startsWith('hosting')) return 'In a lobby';
  const s = FRIEND_STATUS[f.status] || 'Online';
  return f.availability === 'away' && s === 'Online' ? 'Away' : s;
}

function FriendsSheet({ lobby, onClose }) {
  const [list, setList] = useState(null);
  const [sent, setSent] = useState(new Set());
  useEffect(() => { send('friends').then((r) => setList(r.ok ? r.data : [])); }, []);
  const inParty = new Set(lobby.members.map((m) => m.summonerId));
  const invited = new Set(lobby.invited.map((i) => i.summonerId));
  const full = lobby.members.length + lobby.invited.length >= lobby.maxSize;
  const invite = async (f) => {
    setSent((x) => new Set(x).add(f.summonerId));
    const r = await send('invite', { summonerId: f.summonerId });
    if (!r.ok) setSent((x) => { const n = new Set(x); n.delete(f.summonerId); return n; });
  };
  return html`
    <${Sheet} title="Invite friends" onClose=${onClose}>
      ${!list ? html`<p class="sheet-note"><span class="pulse" />Loading friends</p>` : !list.length ? html`<p class="sheet-note">No friends to show.</p>` : html`
        <ul class="friends">
          ${list.map((f) => {
            const here = inParty.has(f.summonerId), pend = invited.has(f.summonerId) || sent.has(f.summonerId);
            const reachable = f.availability !== 'offline' && f.availability !== 'mobile';
            return html`
              <li key=${f.summonerId} class=${cx('friend', !reachable && 'away')}>
                <span class="friend-face"><img src=${profileIcon(f.icon)} alt="" loading="lazy" /><i class=${'avail a-' + f.availability} /></span>
                <span class="friend-text">
                  <span class="friend-name">${f.name}${f.tag && html`<span class="friend-tag">#${f.tag}</span>`}</span>
                  <span class="friend-status">${friendStatus(f)}</span>
                </span>
                ${here ? html`<span class="friend-flag">In party</span>`
                  : pend ? html`<span class="friend-flag gold">Invited</span>`
                  : html`<button class="btn hex sm" disabled=${!reachable || full} onClick=${() => invite(f)}>Invite</button>`}
              </li>`;
          })}
        </ul>`}
    </${Sheet}>`;
}

function MemberSheet({ member, onClose }) {
  const act = (type) => { onClose(); send(type, { summonerId: member.summonerId }); };
  return html`
    <${Sheet} title=${member.name} onClose=${onClose}>
      <div class="member-actions">
        <button class="btn glass" onClick=${() => act('promote')}>${Icon.crown}<span>Make party leader</span></button>
        <button class="btn danger" onClick=${() => act('kick')}>Remove from party</button>
      </div>
    </${Sheet}>`;
}

function InviteBanner({ invite }) {
  const [busy, setBusy] = useState(false);
  const q = store.data?.queues.find((x) => x.id === invite.queueId)?.name;
  const go = async (type) => { setBusy(true); await send(type, { invitationId: invite.id }); setBusy(false); };
  return html`
    <div class="invite-banner" role="alert" key=${invite.id}>
      <p class="invite-text"><span class="eyebrow">Party invite</span><span><b>${invite.from}</b> invited you${q ? html` to <b>${q}</b>` : ''}</span></p>
      <div class="invite-actions">
        <button class="btn quiet sm" disabled=${busy} onClick=${() => go('declineInvite')}>Decline</button>
        <button class="btn hex sm" disabled=${busy} onClick=${() => go('acceptInvite')}>Join</button>
      </div>
    </div>`;
}

function Queue({ s }) {
  useTicker(250);
  const elapsed = (s.search?.timeInQueue ?? 0) + sinceState();
  const estimate = s.search?.estimate;
  return html`
    <main class="screen queue">
      <header class="top-row"><${Logo} /><span class="chip"><i class="dot live" />Searching</span></header>
      <div class="queue-center">
        <div class="orbit" aria-hidden="true"><i /><i /></div>
        <div class="queue-read">
          <p class="eyebrow">${s.queueName || 'In queue'}</p>
          <p class="clock">${clock(elapsed)}</p>
          ${estimate > 0 && html`<p class="sub">Usually about ${clock(estimate)}</p>`}
        </div>
      </div>
      <footer class="dock"><button class="btn glass" onClick=${() => send('cancelSearch')}>Leave queue</button></footer>
    </main>`;
}

// ---------------------------------------------------------------------------
// Ready check: the one loud moment
// ---------------------------------------------------------------------------
const READY_SECONDS = 12;
function ReadyCheck({ s }) {
  useTicker(100);
  useEffect(() => { chime(); navigator.vibrate?.([180, 90, 180, 90, 320]); }, []);
  const rc = s.readyCheck;
  const left = Math.max(0, READY_SECONDS - ((rc?.timer ?? 0) + sinceState()));
  const frac = left / READY_SECONDS;
  const response = rc?.response;
  const R = 112, C = 2 * Math.PI * R;
  return html`
    <main class=${cx('screen ready', response === 'Accepted' && 'accepted', response === 'Declined' && 'declined')}>
      <div class="ready-top">
        <p class="eyebrow">${s.queueName || 'Match'}</p>
        <h1 class="mega">${response === 'Accepted' ? 'Accepted' : response === 'Declined' ? 'Declined' : 'Match found'}</h1>
        <p class="sub">${response === 'Accepted' ? 'Waiting for everyone else.' : response === 'Declined' ? 'Back to the lobby.' : 'Accept before the timer runs out.'}</p>
      </div>
      <div class="ring-wrap">
        <div class="ring-glow" />
        <svg class="ring" viewBox="0 0 250 250" aria-hidden="true">
          <circle cx="125" cy="125" r=${R} class="ring-track" />
          <circle cx="125" cy="125" r=${R} class="ring-fill" style=${{ strokeDasharray: C, strokeDashoffset: C * (1 - frac) }} />
        </svg>
        <button class="accept" disabled=${response !== 'None'} onClick=${() => send('accept')} aria-label="Accept match">
          ${response === 'Accepted' ? Icon.check : html`<span>Accept</span>`}
        </button>
      </div>
      <footer class="dock">
        <p class="ready-count">${Math.ceil(left)}s</p>
        ${response === 'None' && html`<button class="btn quiet" onClick=${() => send('decline')}>Decline</button>`}
      </footer>
    </main>`;
}

// ---------------------------------------------------------------------------
// Champ select
// ---------------------------------------------------------------------------
function deriveDraft(s) {
  const sess = s.session;
  const flat = sess.actions.flat();
  const mine = flat.filter((a) => a.actor === sess.me);
  const current = mine.find((a) => a.active && !a.completed);
  const myPick = mine.find((a) => a.type === 'pick');
  const me = sess.myTeam.find((m) => m.cellId === sess.me) || {};
  const activeCells = new Set(flat.filter((a) => a.active && !a.completed).map((a) => a.actor));
  const locked = new Set(flat.filter((a) => a.completed && a.championId > 0).map((a) => a.championId));
  const aram = !!sess.bench;
  const phase = sess.timer?.phase;
  const pickDone = aram || (myPick ? myPick.completed : me.championId > 0 && !current);
  const selected = current ? current.championId : (myPick && !myPick.completed ? myPick.championId || me.championPickIntent : me.championId);
  const allyCells = new Set(sess.myTeam.map((m) => m.cellId)); // red side uses cells 5-9
  const allyActive = [...activeCells].some((c) => allyCells.has(c));
  return { sess, flat, current, myPick, me, activeCells, locked, aram, phase, pickDone, selected, allyActive };
}

function statusLine(d) {
  if (d.sess.spectating) return 'Spectating';
  if (d.aram) return d.phase === 'FINALIZATION' ? 'Finalize your loadout' : 'Champion select';
  if (d.phase === 'PLANNING') return 'Declare your pick';
  if (d.phase === 'FINALIZATION') return 'Finalize your loadout';
  if (d.phase === 'GAME_STARTING') return 'Game starting';
  if (d.current) return d.current.type === 'ban' ? 'Your ban' : 'Your pick';
  const anyBan = d.flat.some((a) => a.active && a.type === 'ban');
  if (anyBan) return 'Banning';
  return d.allyActive ? 'Your team is picking' : 'Enemy team is picking';
}

function ChampSelect({ s }) {
  useTicker(200);
  const d = deriveDraft(s);
  const { sess, current, me } = d;
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [optimistic, setOptimistic] = useState(null);
  const [spellSlot, setSpellSlot] = useState(0); // 0 closed, 1 = D, 2 = F
  const [busy, setBusy] = useState(false);

  const banning = current?.type === 'ban';
  const pool = new Set(banning ? s.bannable : s.pickable);
  const selected = optimistic ?? d.selected;
  useEffect(() => { if (optimistic && d.selected === optimistic) setOptimistic(null); }, [d.selected]);
  // A new turn starts with a clean list.
  useEffect(() => { setOptimistic(null); setQuery(''); }, [current?.id]);

  const left = sess.timer?.left == null ? null : Math.max(0, sess.timer.left / 1000 - sinceState());
  const total = (sess.timer?.total || 1) / 1000;
  const urgent = left != null && left <= 5 && !!current;

  const hover = async (id) => {
    if (busy) return;
    setOptimistic(id);
    navigator.vibrate?.(8);
    const r = await send('hover', { championId: id });
    if (!r.ok) setOptimistic(null);
  };
  const lock = async () => { setBusy(true); const r = await send('lock'); setBusy(false); if (r.ok) navigator.vibrate?.([20, 40, 60]); };

  const showPool = !d.aram && !sess.spectating && !d.pickDone && d.phase !== 'FINALIZATION' && d.phase !== 'GAME_STARTING';
  const q = fold(query);
  // Show what you can take, plus already-taken champions (dimmed). Unowned ones stay hidden.
  const list = (store.data?.list || []).filter((c) =>
    (!pool.size || pool.has(c.id) || d.locked.has(c.id)) &&
    (!role || c.roles?.includes(role)) &&
    (!q || fold(c.name).includes(q) || fold(c.alias).includes(q)));

  let dock;
  const name = champName(selected);
  if (current && banning) dock = html`<button class="btn danger xl" disabled=${!selected || busy} onClick=${lock}>${selected ? `Ban ${name}` : 'Choose a ban'}</button>`;
  else if (current) dock = html`<button class="btn hex xl" disabled=${!selected || busy} onClick=${lock}>${selected ? `Lock in ${name}` : 'Choose a champion'}</button>`;
  else if (d.aram && sess.rerolls != null) dock = html`<button class="btn glass" disabled=${!sess.rerolls} onClick=${() => send('reroll')}>${Icon.dice}<span>Reroll</span><span class="count">${sess.rerolls} left</span></button>`;
  else dock = html`<p class="dock-note">${d.pickDone ? (d.phase === 'GAME_STARTING' ? 'Loading in' : 'Locked in. Spells can still change.') : d.phase === 'PLANNING' ? 'Bans start after planning' : 'Waiting for your turn'}</p>`;

  const pos = POSITIONS[me.assignedPosition];
  return html`
    <main class=${cx('screen draft', current && 'my-turn', banning && 'banning', urgent && 'urgent', !showPool && 'settled')}>
      <header class="draft-head">
        <div class="draft-title">
          <p class="eyebrow">${s.queueName || 'Champ select'}${pos ? ` · ${pos}` : ''}</p>
          <h1 class="phase">${statusLine(d)}</h1>
        </div>
        ${left != null && html`<span class="timer" aria-label=${`${Math.ceil(left)} seconds left`}>${Math.ceil(left)}</span>`}
      </header>
      <div class=${cx('bar', current ? '' : !d.activeCells.size ? 'idle' : d.allyActive ? 'ally' : 'enemy')}><i style=${{ transform: `scaleX(${left == null ? 1 : Math.min(1, left / total)})` }} /></div>

      <${Teams} d=${d} />
      <${Bans} sess=${sess} />

      <${MeCard} d=${d} selected=${selected} banning=${banning} onSpell=${setSpellSlot} />

      ${d.aram && sess.bench && html`<${Bench} bench=${sess.bench} />`}

      ${showPool && html`
        <section class="pool">
          <div class="pool-tools">
            <label class="search">
              ${Icon.search}
              <input type="search" placeholder=${banning ? 'Search bans' : 'Search champions'} value=${query}
                onInput=${(e) => setQuery(e.target.value)} autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" />
              ${query && html`<button class="clear" onClick=${() => setQuery('')} aria-label="Clear search">${Icon.x}</button>`}
            </label>
            <div class="roles" role="tablist" aria-label="Filter by role">
              ${ROLES.map(([k, label]) => html`<button role="tab" aria-selected=${role === k} class=${cx('role', role === k && 'on')} onClick=${() => setRole(k)}>${label}</button>`)}
            </div>
          </div>
          <ul class="grid">
            ${list.map((c) => {
              const ok = pool.size ? pool.has(c.id) : !d.locked.has(c.id);
              return html`
                <li key=${c.id}>
                  <button class=${cx('champ', selected === c.id && 'on')} disabled=${!ok} onClick=${() => hover(c.id)}>
                    <span class="champ-face"><img src=${asset(c.icon)} alt="" loading="lazy" decoding="async" /></span>
                    <span class="champ-name">${c.name}</span>
                  </button>
                </li>`;
            })}
            ${!list.length && html`<li class="none">No champion matches${query ? ` “${query}”` : ' that role'}.</li>`}
          </ul>
        </section>`}

      <footer class="dock">${dock}</footer>

      ${spellSlot > 0 && html`<${SpellSheet} slot=${spellSlot} me=${me} mode=${s.gameMode || (d.aram ? 'ARAM' : 'CLASSIC')} onClose=${() => setSpellSlot(0)} />`}
    </main>`;
}

function meStatus(d, banning, selected) {
  if (d.sess.spectating) return 'You’re watching this one';
  if (d.aram) return 'Swap from the bench or reroll';
  if (d.pickDone) return 'Locked in';
  if (d.current) return banning ? (selected ? 'Banning' : 'Tap a champion to ban') : selected ? 'Hovering' : 'Tap a champion to hover';
  return selected ? 'Declared to your team' : 'Hover one to show your team';
}

function MeCard({ d, selected, banning, onSpell }) {
  const { me, sess } = d;
  const title = useTitle(selected);
  return html`
    <section class=${cx('mecard', d.pickDone && 'locked')}>
      <div class="me-text">
        <p class=${cx('me-status', d.pickDone && 'done')}>${d.pickDone && html`<i class="dot gold" />`}${meStatus(d, banning, selected)}</p>
        <h2 class=${cx('me-name', !(selected > 0) && 'empty')} key=${selected}>${selected > 0 ? champName(selected) : banning ? 'No ban yet' : 'No champion yet'}</h2>
        ${selected > 0 && title && html`<p class="me-title">${title}</p>`}
      </div>
      ${!sess.spectating && html`
        <div class="spells">
          <${RuneButton} />
          ${[me.spell1Id, me.spell2Id].map((id, i) => html`
            <button class="spell" key=${i} onClick=${() => onSpell(i + 1)} aria-label=${`Change ${i ? 'F' : 'D'} spell`}>
              ${id > 0 && html`<img src=${asset(store.data?.spells.get(id)?.icon)} alt="" />`}
              <span class="spell-key">${i ? 'F' : 'D'}</span>
            </button>`)}
        </div>`}
    </section>`;
}

function Teams({ d }) {
  const { sess, activeCells } = d;
  const ally = (m) => {
    const id = m.championId || m.championPickIntent;
    const intent = !m.championId && id;
    return html`
      <li class=${cx('slot ally', m.cellId === sess.me && 'me', activeCells.has(m.cellId) && 'active', intent && 'intent', m.championId && 'filled')} key=${m.cellId}>
        <span class="slot-face">
          ${id > 0 ? html`<img src=${art(id, 'tile')} alt=${champName(id)} key=${id} />` : html`<span class="slot-pos">${(POSITIONS[m.assignedPosition] || '').slice(0, 3)}</span>`}
        </span>
        <span class="slot-label">${m.cellId === sess.me ? 'You' : POSITIONS[m.assignedPosition] || m.name || ''}</span>
      </li>`;
  };
  const enemy = (m) => html`
    <li class=${cx('slot enemy', activeCells.has(m.cellId) && 'active')} key=${m.cellId}>
      <span class="slot-face">${m.championId > 0 && html`<img src=${champIcon(m.championId)} alt=${champName(m.championId)} />`}</span>
    </li>`;
  return html`
    <section class="teams">
      <ul class="team" aria-label="Your team">${sess.myTeam.map(ally)}</ul>
      <div class="vs"><span>Enemy</span></div>
      <ul class="team theirs" aria-label="Enemy team">${sess.theirTeam.map(enemy)}</ul>
    </section>`;
}

function Bans({ sess }) {
  const { mine, theirs } = sess.bans;
  if (!mine.length && !theirs.length) return null;
  const row = (ids) => ids.map((id, i) => html`<li key=${i} class="ban">${id > 0 && html`<img src=${champIcon(id)} alt=${champName(id)} />`}</li>`);
  return html`
    <section class="bans" aria-label="Bans">
      <ul>${row(mine)}</ul>
      <span class="bans-label">Bans</span>
      <ul class="theirs">${row(theirs)}</ul>
    </section>`;
}

function Bench({ bench }) {
  return html`
    <section class="bench">
      <h2 class="eyebrow">Bench</h2>
      ${bench.length ? html`
        <ul class="bench-row">
          ${bench.map((id) => html`
            <li key=${id}><button class="champ" onClick=${() => send('bench', { championId: id })}>
              <span class="champ-face"><img src=${champIcon(id)} alt="" /></span><span class="champ-name">${champName(id)}</span>
            </button></li>`)}
        </ul>` : html`<p class="sub">Empty for now. Rerolled champions land here.</p>`}
    </section>`;
}

function SpellSheet({ slot, me, mode, onClose }) {
  const spells = (store.data?.spellList || []).filter((sp) => sp.modes.includes(mode));
  const current = slot === 1 ? me.spell1Id : me.spell2Id;
  const other = slot === 1 ? me.spell2Id : me.spell1Id;
  const choose = (id) => {
    onClose();
    if (id === current) return;
    // Picking the other slot's spell swaps them, like the client does.
    const next = id === other ? [other, current] : [id, other];
    const [a, b] = slot === 1 ? next : [next[1], next[0]];
    send('spells', { spell1Id: a, spell2Id: b });
  };
  return html`
    <${Sheet} title=${`${slot === 1 ? 'D' : 'F'} spell`} onClose=${onClose}>
      <ul class="spell-grid">
        ${spells.map((sp) => html`
          <li key=${sp.id}>
            <button class=${cx('spell-opt', sp.id === current && 'on', sp.id === other && 'other')} onClick=${() => choose(sp.id)}>
              <img src=${asset(sp.icon)} alt="" /><span>${sp.name}</span>
            </button>
          </li>`)}
      </ul>
    </${Sheet}>`;
}

// ---------------------------------------------------------------------------
// Loading / in game: your champion, full screen
// ---------------------------------------------------------------------------
function Hero({ eyebrow, body }) {
  const id = lastPick;
  const title = useTitle(id);
  return html`
    <main class="screen hero">
      <header class="top-row"><${Logo} /><span class="chip"><i class="dot live" />${eyebrow}</span></header>
      <div class="hero-foot">
        ${id > 0 ? html`
          <p class="eyebrow">You’re playing</p>
          <h1 class="giant">${champName(id)}</h1>
          ${title && html`<p class="hero-title">${title}</p>`}` : html`<h1 class="mega">${eyebrow}</h1>`}
        <p class="sub">${body}</p>
      </div>
    </main>`;
}

// ---------------------------------------------------------------------------
// Runes: pages, and an editor that follows the tree rules
// ---------------------------------------------------------------------------
const perkOf = (id) => store.data?.perks.get(id);
const styleOf = (id) => store.data?.styleMap.get(id);
const keystoneRow = (st) => (st?.slots || []).find((sl) => sl.type === 'kKeyStone') || { perks: [] };
const regularRows = (st) => (st?.slots || []).filter((sl) => sl.type !== 'kKeyStone' && sl.type !== 'kStatMod');
const shardRows = (st) => (st?.slots || []).filter((sl) => sl.type === 'kStatMod');
const activePage = (s) => s?.runes?.pages.find((p) => p.id === s.runes.current) || null;

function RuneButton() {
  const ks = perkOf(activePage(store.state)?.selectedPerkIds[0]);
  return html`<button class="spell rune-btn" onClick=${openRunes} aria-label="Runes">${ks ? html`<img src=${asset(ks.icon)} alt="" />` : Icon.runes}</button>`;
}

function RunesScreen({ s, onClose }) {
  const [editing, setEditing] = useState(null); // a page, or 'new'
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); setTimeout(onClose, 180); };
  useEffect(() => { const k = (e) => e.key === 'Escape' && !editing && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [editing]);
  const pages = s.runes?.pages || [];
  if (editing) return html`<${RuneEditor} page=${editing === 'new' ? null : editing} onClose=${() => setEditing(null)} />`;
  return html`
    <div class=${cx('modesel runes', closing && 'closing')} role="dialog" aria-label="Runes">
      <header class="top-row">
        <button class="icon-btn glass" onClick=${close} aria-label="Back">${Icon.back}</button>
        <h1 class="modesel-title">Runes</h1>
        <span class="top-spacer" />
      </header>
      <p class="sub runes-sub">Tap a page to use it. The client switches right away.</p>
      ${!pages.length ? html`<p class="sheet-note">No rune pages yet.</p>` : html`
        <ul class="pages">
          ${pages.map((p, i) => {
            const ks = perkOf(p.selectedPerkIds[0]), pr = styleOf(p.primaryStyleId), sb = styleOf(p.subStyleId);
            const on = p.id === s.runes.current;
            return html`
              <li key=${p.id} style=${{ animationDelay: `${i * 35}ms` }} class=${cx('page', on && 'on')}>
                <button class="page-main" onClick=${() => !on && send('runeSelect', { pageId: p.id })} aria-pressed=${on}>
                  <span class="page-key">${ks && html`<img src=${asset(ks.icon)} alt="" />`}</span>
                  <span class="page-text">
                    <span class="page-name">${p.name}</span>
                    <span class="page-trees">
                      ${pr && html`<img src=${asset(pr.icon)} alt="" />${pr.name}`}
                      ${sb && html`<span class="sep" /><img src=${asset(sb.icon)} alt="" />${sb.name}`}
                    </span>
                  </span>
                  ${on ? html`<span class="page-flag">Active</span>` : !p.isEditable && html`<span class="page-flag dim">Preset</span>`}
                </button>
                ${p.isEditable && html`<button class="icon-btn page-edit" onClick=${() => setEditing(p)} aria-label=${`Edit ${p.name}`}>${Icon.edit}</button>`}
              </li>`;
          })}
        </ul>`}
      <footer class="dock"><button class="btn hex xl" onClick=${() => setEditing('new')}>New page</button></footer>
    </div>`;
}

function PerkBtn({ id, on, dim, size = '', onPick }) {
  const p = perkOf(id);
  return html`
    <button class=${cx('perk', size, on && 'on', dim && 'dim')} onClick=${onPick} aria-pressed=${!!on} aria-label=${p?.name || 'Rune'}>
      ${p && html`<img src=${asset(p.icon)} alt="" loading="lazy" />`}
    </button>`;
}

function RuneEditor({ page, onClose }) {
  const styles = store.data.styles;
  const [v, setV] = useState(() => {
    if (page) {
      const ids = page.selectedPerkIds;
      const subRows = regularRows(styleOf(page.subStyleId));
      return {
        name: page.name, primary: page.primaryStyleId, sub: page.subStyleId,
        keystone: ids[0], prim: ids.slice(1, 4),
        subSel: ids.slice(4, 6).map((id) => ({ row: subRows.findIndex((r) => r.perks.includes(id)), id })).filter((x) => x.row >= 0),
        shards: ids.slice(6, 9),
      };
    }
    const st = styles.find((x) => x.id === 8000) || styles[0];
    return { name: 'New page', primary: st.id, sub: st.subs[0], keystone: null, prim: [null, null, null], subSel: [], shards: st.defaults.slice(6, 9) };
  });
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const P = styleOf(v.primary), Sb = styleOf(v.sub);
  const patch = (x) => setV((cur) => ({ ...cur, ...x }));

  const pickPrimary = (id) => {
    if (id === v.primary) return;
    const st = styleOf(id);
    const sub = v.sub === id || !st.subs.includes(v.sub) ? st.subs[0] : v.sub;
    patch({ primary: id, keystone: null, prim: [null, null, null], sub, subSel: sub === v.sub ? v.subSel : [] });
  };
  const pickSub = (id) => id !== v.sub && patch({ sub: id, subSel: [] });
  const tap = (id, fn) => () => { setInfo(id); fn(); };
  // Two secondary runes from different rows; a third tap replaces the older one.
  const pickSubRune = (row, id) => {
    let sel = v.subSel.filter((x) => x.row !== row).concat({ row, id });
    if (sel.length > 2) sel = sel.slice(-2);
    patch({ subSel: sel });
  };

  const ids = [v.keystone, ...v.prim, ...[...v.subSel].sort((a, b) => a.row - b.row).map((x) => x.id), ...v.shards];
  const done = ids.length === 9 && ids.every(Boolean) && v.name.trim();
  const missing = !v.keystone ? 'Pick a keystone' : v.prim.some((x) => !x) ? 'Pick one rune in each primary row' : v.subSel.length < 2 ? 'Pick two secondary runes' : !v.name.trim() ? 'Name the page' : '';

  const save = async () => {
    setBusy(true);
    const r = await send('runeSave', { pageId: page?.id ?? null, name: v.name.trim(), primaryStyleId: v.primary, subStyleId: v.sub, selectedPerkIds: ids });
    setBusy(false);
    if (r.ok) { toast(page ? 'Rune page saved' : 'New page saved and set active'); onClose(); }
  };
  const del = async () => {
    if (!sure) { setSure(true); setTimeout(() => setSure(false), 3000); return; }
    setBusy(true);
    const r = await send('runeDelete', { pageId: page.id });
    setBusy(false);
    if (r.ok) { toast('Rune page deleted'); onClose(); }
  };
  const ip = perkOf(info);

  return html`
    <div class="modesel runes editor" role="dialog" aria-label=${page ? 'Edit rune page' : 'New rune page'}>
      <header class="top-row">
        <button class="icon-btn glass" onClick=${onClose} aria-label="Back to pages">${Icon.back}</button>
        <h1 class="modesel-title">${page ? 'Edit page' : 'New page'}</h1>
        ${page ? html`<button class=${cx('icon-btn glass', sure && 'danger-on')} disabled=${busy} onClick=${del} aria-label=${sure ? 'Tap again to delete' : 'Delete page'}>${Icon.trash}</button>` : html`<span class="top-spacer" />`}
      </header>
      ${sure && html`<p class="confirm-note">Tap the bin again to delete this page.</p>`}
      <input class="page-name-input" value=${v.name} maxlength="50" aria-label="Page name"
        onInput=${(e) => patch({ name: e.target.value })} autocomplete="off" spellcheck="false" enterkeyhint="done" />

      <section class="tree">
        <p class="eyebrow">Primary</p>
        <div class="tree-tabs" role="radiogroup" aria-label="Primary tree">
          ${styles.map((st) => html`<button key=${st.id} role="radio" aria-checked=${st.id === v.primary} class=${cx('tree-tab', st.id === v.primary && 'on')} onClick=${() => pickPrimary(st.id)} aria-label=${st.name}><img src=${asset(st.icon)} alt="" /></button>`)}
        </div>
        <p class="tree-name">${P?.name}</p>
        <div class="perk-row keystones">
          ${keystoneRow(P).perks.map((id) => html`<${PerkBtn} key=${id} id=${id} size="big" on=${v.keystone === id} dim=${v.keystone && v.keystone !== id} onPick=${tap(id, () => patch({ keystone: id }))} />`)}
        </div>
        ${regularRows(P).map((row, ri) => html`
          <div class="perk-row" key=${'p' + ri}>
            ${row.perks.map((id) => html`<${PerkBtn} key=${id} id=${id} on=${v.prim[ri] === id} dim=${v.prim[ri] && v.prim[ri] !== id} onPick=${tap(id, () => patch({ prim: v.prim.map((x, i) => (i === ri ? id : x)) }))} />`)}
          </div>`)}
      </section>

      <section class="tree">
        <p class="eyebrow">Secondary <span class="count">${v.subSel.length}/2</span></p>
        <div class="tree-tabs" role="radiogroup" aria-label="Secondary tree">
          ${(P?.subs || []).map(styleOf).filter(Boolean).map((st) => html`<button key=${st.id} role="radio" aria-checked=${st.id === v.sub} class=${cx('tree-tab', st.id === v.sub && 'on')} onClick=${() => pickSub(st.id)} aria-label=${st.name}><img src=${asset(st.icon)} alt="" /></button>`)}
        </div>
        <p class="tree-name">${Sb?.name}</p>
        ${regularRows(Sb).map((row, ri) => {
          const chosen = v.subSel.find((x) => x.row === ri);
          return html`
            <div class="perk-row" key=${'s' + ri}>
              ${row.perks.map((id) => html`<${PerkBtn} key=${id} id=${id} on=${chosen?.id === id} dim=${(chosen && chosen.id !== id) || (!chosen && v.subSel.length === 2)} onPick=${tap(id, () => pickSubRune(ri, id))} />`)}
            </div>`;
        })}
      </section>

      <section class="tree">
        <p class="eyebrow">Shards</p>
        ${shardRows(P).map((row, ri) => html`
          <div class="perk-row shards" key=${'x' + ri}>
            ${row.perks.map((id, k) => html`<${PerkBtn} key=${k} id=${id} size="small" on=${v.shards[ri] === id} dim=${v.shards[ri] && v.shards[ri] !== id} onPick=${tap(id, () => patch({ shards: v.shards.map((x, i) => (i === ri ? id : x)) }))} />`)}
          </div>`)}
      </section>

      <footer class="dock">
        <p class="perk-info" aria-live="polite">${ip ? html`<b>${ip.name}</b> ${ip.desc}` : 'Tap a rune to see what it does.'}</p>
        <button class="btn hex xl" disabled=${!done || busy} onClick=${save}>${done ? (busy ? 'Saving…' : 'Save page') : missing}</button>
      </footer>
    </div>`;
}

function Sheet({ title, onClose, children }) {
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); setTimeout(onClose, 180); };
  useEffect(() => { const k = (e) => e.key === 'Escape' && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return html`
    <div class=${cx('sheet-layer', closing && 'closing')}>
      <button class="scrim" aria-label="Close" onClick=${close} />
      <div class="sheet" role="dialog" aria-label=${title}>
        <div class="grabber" />
        <div class="sheet-head"><h2 class="sheet-title">${title}</h2><button class="icon-btn" onClick=${close} aria-label="Close">${Icon.x}</button></div>
        ${children}
      </div>
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
connect();
