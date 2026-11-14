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

// Art and a one-line pitch for each queue on the mode list.
const QUEUE_LOOK = {
  420: { champ: 266, blurb: 'Climb alone or with one friend' },
  440: { champ: 99, blurb: 'Ranked with a group of up to five' },
  400: { champ: 103, blurb: 'Bans and picks, no rank on the line' },
  490: { champ: 81, blurb: 'Choose roles and champions, then go' },
  450: { champ: 222, blurb: 'One lane, random champions' },
};
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

// A slowly rotating champion for the start screen.
function useFeatured(on) {
  const [id, setId] = useState(0);
  const list = store.data?.list;
  useEffect(() => {
    if (!on || !list?.length) return;
    // Only switch once the next splash is decoded, so the art and its caption change together.
    let live = true, timer;
    const cycle = (delay) => {
      const next = list[Math.floor(Math.random() * list.length)].id;
      const img = new Image();
      img.src = art(next);
      Promise.all([img.decode().catch(() => {}), new Promise((r) => (timer = setTimeout(r, delay)))]).then(() => {
        if (!live) return;
        if (img.naturalWidth) setId(next);
        cycle(9000);
      });
    };
    cycle(id ? 9000 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [on, list]);
  return id;
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

// ---------------------------------------------------------------------------
// Backdrop: full-bleed splash art that cross-fades between scenes
// ---------------------------------------------------------------------------
function Backdrop({ id, tone }) {
  const [layers, setLayers] = useState([]);
  useEffect(() => {
    if (!(id > 0)) return;
    const src = art(id);
    let live = true;
    const img = new Image();
    img.src = src;
    (img.decode ? img.decode() : new Promise((r) => (img.onload = r))).catch(() => {}).then(() => {
      if (!live || !img.naturalWidth) return;
      setLayers((ls) => (ls.at(-1)?.src === src ? ls : [...ls.slice(-1), { src, key: `${src}#${Date.now()}` }]));
    });
    return () => { live = false; };
  }, [id]);
  return html`
    <div class=${'backdrop tone-' + tone} aria-hidden="true">
      <div class="aurora"><i /><i /><i /></div>
      ${layers.map((l, i) => html`<img key=${l.key} class=${cx('bd-img', i === layers.length - 1 && 'top')} src=${l.src} alt="" />`)}
      <div class="bd-shade" />
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
const queueChamp = (qid) => QUEUE_LOOK[qid]?.champ || 0;
function scene(st, featured) {
  const s = st.state;
  if (st.link !== 'open' || !s?.lcu || !st.data) return { id: 0, tone: 'calm' };
  const q = queueChamp(s.lobby?.queueId);
  switch (s.phase) {
    case 'Lobby': return { id: q || featured, tone: 'lobby' };
    case 'Matchmaking': return { id: q || featured, tone: 'queue' };
    case 'ReadyCheck': return { id: q || featured, tone: 'ready' };
    case 'ChampSelect': {
      if (!s.session) return { id: lastPick || q, tone: 'draft' };
      const d = deriveDraft(s);
      const banning = d.current?.type === 'ban';
      const id = d.selected || d.me.championId || 0;
      if (!banning && d.me.championId) rememberPick(d.me.championId);
      return { id: id || lastPick || q, tone: banning ? 'ban' : d.pickDone ? 'locked' : 'draft' };
    }
    case 'GameStart': case 'InProgress': case 'Reconnect': return { id: lastPick || featured, tone: 'hero' };
    default: return { id: featured, tone: 'home' };
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
function App() {
  const st = useStore();
  const { link, state } = st;
  const homeish = link === 'open' && state?.lcu && !['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress', 'Reconnect'].includes(state.phase);
  const featured = useFeatured(homeish);
  const sc = scene(st, featured);

  let screen;
  if (link === 'unpaired') screen = html`<${Pair} />`;
  else if (link === 'connecting' || (link === 'open' && !state)) screen = html`<${Splash} />`;
  else if (link !== 'open') screen = html`<${Message} eyebrow="Offline" title="Can’t reach your computer" body="Make sure Hover is running there and your phone is on the same Wi‑Fi." waiting="Retrying" />`;
  else if (!state.lcu) screen = html`<${Message} eyebrow="Connected to Hover" title="Open League on your computer" body="Hover picks up the client as soon as it starts." waiting="Waiting for the client" />`;
  else if (homeish) screen = html`<${Home} s=${state} featured=${featured} />`;
  else screen = phaseScreen(state);

  return html`
    <${Backdrop} id=${sc.id} tone=${sc.tone} />
    ${screen}
    ${st.toast && html`<div class="toast" key=${st.toast.key} role="status">${st.toast.text}</div>`}
  `;
}

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
      <footer class="dock"><button class="btn gold" disabled=${busy || digits.length !== 6} onClick=${() => submit()}>${busy ? 'Pairing…' : 'Pair this phone'}</button></footer>
    </main>`;
}

// ---------------------------------------------------------------------------
// Start screen + modes
// ---------------------------------------------------------------------------
function Home({ s, featured }) {
  const [picking, setPicking] = useState(false);
  const after = ['WaitingForStats', 'PreEndOfGame', 'EndOfGame'].includes(s.phase);
  const title = useTitle(featured);
  return html`
    <main class="screen home">
      <header class="top-row">
        <${Logo} />
        <span class="chip"><i class="dot live" />Client connected</span>
      </header>
      <div class="home-hero">
        <p class="eyebrow">${after ? 'Game over' : 'Champ select, from your phone'}</p>
        <h1 class="mega">${after ? html`Good<br />game.` : html`Your next<br />game starts<br />here.`}</h1>
        <p class="sub">${after ? 'Queue up again whenever you’re ready.' : 'Open a lobby on your computer without getting up.'}</p>
      </div>
      ${featured > 0 && html`<p class="credit" key=${featured}><span>${champName(featured)}</span>${title && html` · ${title}`}</p>`}
      <footer class="dock">
        <button class="btn gold xl" onClick=${() => setPicking(true)}>${Icon.swords}<span>${after ? 'Play again' : 'Play'}</span></button>
      </footer>
      ${picking && html`
        <${Sheet} title="Choose a mode" onClose=${() => setPicking(false)}>
          <${QueueList} onPick=${(queueId) => { setPicking(false); send('createLobby', { queueId }); }} />
        </${Sheet}>`}
    </main>`;
}

function QueueList({ current, onPick }) {
  const queues = store.data?.queues || [];
  return html`
    <ul class="modes">
      ${queues.map((q, i) => {
        const look = QUEUE_LOOK[q.id] || {};
        return html`
          <li key=${q.id} style=${{ animationDelay: `${i * 40}ms` }}>
            <button class=${cx('mode', q.id === current && 'on')} onClick=${() => onPick(q.id)}>
              ${look.champ && html`<img class="mode-art" src=${art(look.champ)} alt="" loading="lazy" />`}
              <span class="mode-text">
                <span class="mode-name">${q.name}</span>
                <span class="mode-blurb">${q.id === current ? 'Current mode' : look.blurb || ''}</span>
              </span>
              <span class="mode-go">${Icon.arrow}</span>
            </button>
          </li>`;
      })}
    </ul>`;
}

function Lobby({ s }) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const lobby = s.lobby;
  const members = lobby?.members ?? 1;
  const leader = lobby?.isLeader;
  const find = async () => { setBusy(true); await send('search'); setBusy(false); };
  return html`
    <main class="screen lobby">
      <header class="top-row">
        <button class="icon-btn glass back" onClick=${() => send('leaveLobby')} aria-label="Leave lobby">${Icon.back}</button>
        <span class="chip">Lobby</span>
      </header>
      <div class="stage">
        <p class="eyebrow">${leader ? 'Ready to queue' : 'Waiting for the party leader'}</p>
        <h1 class="mega">${s.queueName || 'Lobby'}</h1>
        <div class="party" aria-label=${`${members} in party`}>
          ${Array.from({ length: 5 }, (_, i) => html`<span class=${cx('seat', i < members && 'taken', i === 0 && 'you')} />`)}
          <span class="party-text">${members > 1 ? `You and ${members - 1} other${members > 2 ? 's' : ''}` : 'Just you'}</span>
        </div>
      </div>
      <footer class="dock">
        ${leader && html`<button class="btn gold xl" disabled=${busy || !lobby?.canStart} onClick=${find}>Find match</button>`}
        ${leader && html`<button class="btn quiet" onClick=${() => setChanging(true)}>Change mode</button>`}
      </footer>
      ${changing && html`
        <${Sheet} title="Change mode" onClose=${() => setChanging(false)}>
          <${QueueList} current=${lobby?.queueId} onPick=${(queueId) => { setChanging(false); if (queueId !== lobby?.queueId) send('createLobby', { queueId }); }} />
        </${Sheet}>`}
    </main>`;
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
  else if (current) dock = html`<button class="btn gold xl" disabled=${!selected || busy} onClick=${lock}>${selected ? `Lock in ${name}` : 'Choose a champion'}</button>`;
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
        <h2 class="me-name" key=${selected}>${selected > 0 ? champName(selected) : banning ? 'No ban yet' : 'No champion yet'}</h2>
        ${selected > 0 && title && html`<p class="me-title">${title}</p>`}
      </div>
      ${!sess.spectating && html`
        <div class="spells">
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
