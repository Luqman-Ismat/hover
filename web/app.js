import { html, render, useState, useEffect, useRef, useMemo } from '/vendor/preact.js';

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
const champIcon = (id) => (id > 0 ? asset(store.data?.champs.get(id)?.icon || `/lol-game-data/assets/v1/champion-icons/${id}.png`) : '');
const champName = (id) => store.data?.champs.get(id)?.name || '';
const fold = (s) => s.normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();
const POSITIONS = { top: 'Top', jungle: 'Jungle', middle: 'Mid', bottom: 'Bot', utility: 'Support' };
const clock = (sec) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function useTicker(ms = 200) {
  const [, f] = useState(0);
  useEffect(() => { const t = setInterval(() => f((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}
// Seconds elapsed since the last state message, for client-side timers.
const sinceState = () => (performance.now() - (store.state?.at ?? performance.now())) / 1000;

// Audio: unlocked on first touch so the queue-pop chime can play later.
let audio;
addEventListener('pointerdown', () => { audio ??= new AudioContext(); audio.resume(); }, { once: false, passive: true });
function chime() {
  if (!audio) return;
  const t = audio.currentTime;
  for (const [i, f] of [[0, 660], [1, 880]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.16);
    g.gain.linearRampToValueAtTime(0.18, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.5);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.55);
  }
}

const Icon = {
  search: html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.2 13.2 17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dice: html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.2" cy="7.2" r="1.2" fill="currentColor"/><circle cx="12.8" cy="12.8" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/></svg>`,
  x: html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
function App() {
  const st = useStore();
  const { link, state } = st;
  let screen;
  if (link === 'unpaired') screen = html`<${Pair} />`;
  else if (link === 'connecting' || (link === 'open' && !state)) screen = html`<div class="screen" />`;
  else if (link !== 'open') screen = html`<${Message} title="Can’t reach your computer" body="Make sure Hover is running there and your phone is on the same Wi‑Fi." waiting="Retrying" />`;
  else if (!state.lcu) screen = html`<${Message} title="Open League on your computer" body="Hover connects as soon as the client starts." waiting="Waiting for the client" />`;
  else screen = phaseScreen(state);

  return html`
    ${screen}
    ${st.toast && html`<div class="toast" key=${st.toast.key} role="status">${st.toast.text}</div>`}
  `;
}

function phaseScreen(s) {
  switch (s.phase) {
    case 'Lobby': return html`<${Lobby} s=${s} />`;
    case 'Matchmaking': return html`<${Queue} s=${s} />`;
    case 'ReadyCheck': return html`<${ReadyCheck} s=${s} />`;
    case 'ChampSelect': return s.session ? html`<${ChampSelect} s=${s} />` : html`<div class="screen" />`;
    case 'GameStart': return html`<${Message} title="Loading into game" body="Champ select is done. Good luck out there." />`;
    case 'InProgress': case 'Reconnect': return html`<${Message} title="In game" body="Hover will be ready when you’re back for the next one." />`;
    case 'WaitingForStats': case 'PreEndOfGame': case 'EndOfGame': return html`<${Modes} title="Game over" body="Start another when you’re ready." />`;
    default: return html`<${Modes} title="Start a lobby" body="Pick a mode to open a lobby on your computer." />`;
  }
}

function Message({ title, body, waiting }) {
  return html`
    <main class="screen message">
      <div class="message-body">
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

  return html`
    <main class="screen pair">
      <div class="message-body">
        <h1 class="title">Pair with your computer</h1>
        <p class="sub">Enter the code shown where Hover is running. You only do this once.</p>
        <form onSubmit=${(e) => { e.preventDefault(); submit(); }}>
          <input class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000"
            value=${code} onInput=${(e) => { setCode(e.target.value); setError(''); }} aria-label="Pairing code" />
          <p class="error" aria-live="polite">${error}</p>
        </form>
      </div>
      <footer class="dock"><button class="btn primary" disabled=${busy} onClick=${() => submit()}>${busy ? 'Pairing…' : 'Pair'}</button></footer>
    </main>`;
}

// ---------------------------------------------------------------------------
// Lobby, modes, queue
// ---------------------------------------------------------------------------
function QueueList({ current, onPick }) {
  const queues = store.data?.queues || [];
  return html`
    <ul class="modes">
      ${queues.map((q) => html`
        <li key=${q.id}>
          <button class=${'mode' + (q.id === current ? ' on' : '')} onClick=${() => onPick(q.id)}>
            <span>${q.name}</span>${q.id === current && html`<span class="mode-mark">Current</span>`}
          </button>
        </li>`)}
    </ul>`;
}

function Modes({ title, body }) {
  return html`
    <main class="screen">
      <div class="head-block">
        <h1 class="title">${title}</h1>
        <p class="sub">${body}</p>
      </div>
      <${QueueList} onPick=${(queueId) => send('createLobby', { queueId })} />
    </main>`;
}

function Lobby({ s }) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const lobby = s.lobby;
  const others = (lobby?.members ?? 1) - 1;
  const leader = lobby?.isLeader;
  const find = async () => { setBusy(true); await send('search'); setBusy(false); };
  return html`
    <main class="screen lobby">
      <div class="hero">
        <h1 class="display">${s.queueName || 'Lobby'}</h1>
        <p class="sub">${others ? `You and ${others} other${others > 1 ? 's' : ''}` : 'Just you'}${leader ? '' : '. Waiting for the party leader.'}</p>
      </div>
      <footer class="dock">
        ${leader && html`<button class="btn primary" disabled=${busy || !lobby?.canStart} onClick=${find}>Find match</button>`}
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
      <div class="hero">
        <p class="waiting"><span class="pulse" />In queue for ${s.queueName || 'a match'}</p>
        <p class="clock">${clock(elapsed)}</p>
        ${estimate > 0 && html`<p class="sub">Usually about ${clock(estimate)}</p>`}
      </div>
      <footer class="dock"><button class="btn secondary" onClick=${() => send('cancelSearch')}>Leave queue</button></footer>
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
  const R = 104, C = 2 * Math.PI * R;
  return html`
    <main class=${'screen ready ' + (response === 'Accepted' ? 'accepted' : response === 'Declined' ? 'declined' : '')}>
      <div class="ready-top">
        <h1 class="display">${response === 'Accepted' ? 'Accepted' : response === 'Declined' ? 'Declined' : 'Match found'}</h1>
        <p class="sub">${response === 'Accepted' ? 'Waiting for everyone else.' : response === 'Declined' ? 'Back to the lobby.' : s.queueName || ' '}</p>
      </div>
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 240 240" aria-hidden="true">
          <circle cx="120" cy="120" r=${R} class="ring-track" />
          <circle cx="120" cy="120" r=${R} class="ring-fill" style=${{ strokeDasharray: C, strokeDashoffset: C * (1 - frac) }} />
        </svg>
        <button class="accept" disabled=${response !== 'None'} onClick=${() => send('accept')} aria-label="Accept match">
          ${response === 'Accepted' ? Icon.check : html`<span>Accept</span>`}
        </button>
      </div>
      <footer class="dock">
        ${response === 'None' && html`<button class="btn quiet" onClick=${() => send('decline')}>Decline</button>`}
        <p class="ready-count">${Math.ceil(left)}s</p>
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
  const [optimistic, setOptimistic] = useState(null);
  const [spellSlot, setSpellSlot] = useState(0); // 0 closed, 1 = D, 2 = F
  const [busy, setBusy] = useState(false);

  const banning = current?.type === 'ban';
  const pool = new Set(banning ? s.bannable : s.pickable);
  const selected = optimistic ?? d.selected;
  useEffect(() => { if (optimistic && d.selected === optimistic) setOptimistic(null); }, [d.selected]);
  useEffect(() => setOptimistic(null), [current?.id]);

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
  const lock = async () => { setBusy(true); await send('lock'); setBusy(false); };

  const showPool = !d.aram && !sess.spectating && !d.pickDone && d.phase !== 'FINALIZATION' && d.phase !== 'GAME_STARTING';
  const q = fold(query);
  // Show what you can take, plus already-taken champions (dimmed). Unowned ones stay hidden.
  const list = (store.data?.list || []).filter((c) => (!pool.size || pool.has(c.id) || d.locked.has(c.id)) && (!q || fold(c.name).includes(q) || fold(c.alias).includes(q)));

  // Dock button
  let dock;
  const name = champName(selected);
  if (current && banning) dock = html`<button class="btn danger" disabled=${!selected || busy} onClick=${lock}>${selected ? `Ban ${name}` : 'Choose a ban'}</button>`;
  else if (current) dock = html`<button class="btn primary" disabled=${!selected || busy} onClick=${lock}>${selected ? `Lock in ${name}` : 'Choose a champion'}</button>`;
  else if (d.aram && sess.rerolls != null) dock = html`<button class="btn secondary" disabled=${!sess.rerolls} onClick=${() => send('reroll')}>${Icon.dice}<span>Reroll</span><span class="count">${sess.rerolls} left</span></button>`;
  else dock = html`<p class="dock-note">${d.pickDone ? (d.phase === 'GAME_STARTING' ? 'Loading in' : 'Locked in. Spells can still change.') : d.phase === 'PLANNING' ? 'Bans start after planning' : 'Waiting for your turn'}</p>`;

  return html`
    <main class=${'screen draft' + (current ? ' my-turn' : '') + (banning ? ' banning' : '') + (urgent ? ' urgent' : '')}>
      <header class="draft-head">
        <div>
          <h1 class="phase">${statusLine(d)}</h1>
          <p class="sub">${s.queueName || ''}${me.assignedPosition ? ` ${POSITIONS[me.assignedPosition] ? 'as ' + POSITIONS[me.assignedPosition] : ''}` : ''}</p>
        </div>
        ${left != null && html`<span class="timer" aria-label=${`${Math.ceil(left)} seconds left`}>${Math.ceil(left)}</span>`}
      </header>
      <div class=${'bar' + (current ? '' : !d.activeCells.size ? ' idle' : d.allyActive ? ' ally' : ' enemy')}><i style=${{ transform: `scaleX(${left == null ? 1 : Math.min(1, left / total)})` }} /></div>

      <${Teams} d=${d} />
      <${Bans} sess=${sess} />

      <section class="you">
        <div class=${'me-portrait' + (d.pickDone ? ' locked' : '')}>
          ${selected > 0 ? html`<img src=${champIcon(selected)} alt="" />` : html`<span class="empty-face" />`}
        </div>
        <div class="me-text">
          <p class="me-name">${selected > 0 ? champName(selected) : banning ? 'No ban yet' : 'No champion yet'}</p>
          <p class="sub">${meStatus(d, banning, selected)}</p>
        </div>
        ${!sess.spectating && html`
          <div class="spells">
            ${[me.spell1Id, me.spell2Id].map((id, i) => html`
              <button class="spell" key=${i} onClick=${() => setSpellSlot(i + 1)} aria-label=${`Change ${i ? 'F' : 'D'} spell`}>
                ${id > 0 && html`<img src=${asset(store.data?.spells.get(id)?.icon)} alt="" />`}
              </button>`)}
          </div>`}
      </section>

      ${d.aram && sess.bench && html`<${Bench} bench=${sess.bench} />`}

      ${showPool && html`
        <section class="pool">
          <label class="search">
            ${Icon.search}
            <input type="search" placeholder=${banning ? 'Search bans' : 'Search champions'} value=${query}
              onInput=${(e) => setQuery(e.target.value)} autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" />
            ${query && html`<button class="clear" onClick=${() => setQuery('')} aria-label="Clear search">${Icon.x}</button>`}
          </label>
          <ul class="grid">
            ${list.map((c) => {
              const ok = pool.size ? pool.has(c.id) : !d.locked.has(c.id);
              return html`
                <li key=${c.id}>
                  <button class=${'champ' + (selected === c.id ? ' on' : '')} disabled=${!ok} onClick=${() => hover(c.id)}>
                    <img src=${asset(c.icon)} alt="" loading="lazy" decoding="async" />
                    <span>${c.name}</span>
                  </button>
                </li>`;
            })}
            ${!list.length && html`<li class="none">No champion matches “${query}”.</li>`}
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
  if (d.current) return banning ? (selected ? 'Ready to ban' : 'Tap a champion to ban') : selected ? 'Hovering' : 'Tap a champion to hover';
  return selected ? 'Declared to your team' : 'Hover one to show your team';
}

function Teams({ d }) {
  const { sess, activeCells } = d;
  const slot = (m, ally) => {
    const id = m.championId || (ally ? m.championPickIntent : 0);
    const intent = !m.championId && id;
    const cls = ['slot', ally ? 'ally' : 'enemy', m.cellId === sess.me && 'me', activeCells.has(m.cellId) && 'active', intent && 'intent'].filter(Boolean).join(' ');
    return html`
      <li class=${cls} key=${m.cellId}>
        <span class="slot-face">${id > 0 && html`<img src=${champIcon(id)} alt=${champName(id)} />`}</span>
        <span class="slot-label">${ally ? (m.cellId === sess.me ? 'You' : POSITIONS[m.assignedPosition] || m.name || '') : ''}</span>
      </li>`;
  };
  return html`
    <section class="teams">
      <ul class="team" aria-label="Your team">${sess.myTeam.map((m) => slot(m, true))}</ul>
      <ul class="team theirs" aria-label="Enemy team">${sess.theirTeam.map((m) => slot(m, false))}</ul>
    </section>`;
}

function Bans({ sess }) {
  const { mine, theirs } = sess.bans;
  if (!mine.length && !theirs.length) return null;
  const row = (ids) => ids.map((id, i) => html`<li key=${i} class="ban">${id > 0 && html`<img src=${champIcon(id)} alt=${champName(id)} />`}</li>`);
  return html`
    <section class="bans" aria-label="Bans">
      <ul>${row(mine)}</ul>
      <ul class="theirs">${row(theirs)}</ul>
    </section>`;
}

function Bench({ bench }) {
  return html`
    <section class="bench">
      <h2 class="section-title">Bench</h2>
      ${bench.length ? html`
        <ul class="bench-row">
          ${bench.map((id) => html`
            <li key=${id}><button class="champ" onClick=${() => send('bench', { championId: id })}>
              <img src=${champIcon(id)} alt="" /><span>${champName(id)}</span>
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
            <button class=${'spell-opt' + (sp.id === current ? ' on' : '') + (sp.id === other ? ' other' : '')} onClick=${() => choose(sp.id)}>
              <img src=${asset(sp.icon)} alt="" /><span>${sp.name}</span>
            </button>
          </li>`)}
      </ul>
    </${Sheet}>`;
}

function Sheet({ title, onClose, children }) {
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); setTimeout(onClose, 160); };
  useEffect(() => { const k = (e) => e.key === 'Escape' && close(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return html`
    <div class=${'sheet-layer' + (closing ? ' closing' : '')}>
      <button class="scrim" aria-label="Close" onClick=${close} />
      <div class="sheet" role="dialog" aria-label=${title}>
        <div class="sheet-head"><h2 class="sheet-title">${title}</h2><button class="icon-btn" onClick=${close} aria-label="Close">${Icon.x}</button></div>
        ${children}
      </div>
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
connect();
