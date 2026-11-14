# Hover

Champ select from your phone. A small bridge runs next to the League client on your computer and serves a mobile web app over your Wi‑Fi. From your phone you can open a lobby, queue, accept the match, ban, hover, lock in, and set summoner spells. ARAM rerolls and bench swaps work too.

```
Phone (web app)  ⇄  Wi‑Fi  ⇄  Hover bridge (your computer)  ⇄  League client API (localhost)
```

## Run it

```bash
npm install
npm start
```

The terminal shows a URL, a 6‑digit pairing code and a QR code. Scan the QR code with your phone, or open the URL and type the code. You only pair once per device. On iPhone, use **Share → Add to Home Screen** to open it full‑screen like an app.

Start League before or after Hover. The bridge finds the client by itself, using the lockfile or the `LeagueClientUx` process, on macOS and Windows.

### Queue‑pop notifications (optional)

Phones only run web apps while they're open. To get a push when the queue pops, install the free [ntfy](https://ntfy.sh) app, subscribe to a hard‑to‑guess topic, and put it in `.env`:

```
HOVER_NTFY_TOPIC=hover-7f3k2q9x
```

Tap the notification to jump straight to the accept screen.

## Develop without League

```bash
npm run dev    # mock League client + bridge
npm test       # end-to-end: pairing, queue, ready check, ban, pick, spells, ARAM
```

The mock (`mock/lcu.js`) simulates a ranked draft with bot teammates and opponents, plus ARAM. It pulls champion data and icons from CommunityDragon. Set `MOCK_SPEED=4` to run it faster.

## How it works

- `bridge/lcu.js` reads the client's credentials and talks to its local HTTPS API and event WebSocket.
- `bridge/state.js` mirrors the lobby, queue, ready check and champ select state. It turns phone intents (`hover`, `lock`, `spells`, …) into client calls. The phone can't send arbitrary endpoints.
- `bridge/index.js` handles pairing, serves the web app, proxies champion icons and runs the phone's WebSocket.
- `web/` is a Preact app with no build step.

## Security

- Pairing needs the 6‑digit code shown on your computer. The code changes every launch, and the bridge allows 5 tries per minute.
- A paired device gets a long random token in an HttpOnly cookie. Only its hash is stored, in `~/.hover/devices.json`. Delete that file to unpair everything.
- The phone socket checks the token and the origin. Only allowlisted commands reach the client.
- Traffic is plain HTTP on your local network. Don't run Hover on networks you don't trust.

## Riot policy notes

The League Client API is unofficial and Riot doesn't support it for third‑party apps. Endpoints can change with any patch. Hover only takes an action when you tap something: no auto‑accept, no auto‑pick, no auto‑lock. That's deliberate, because Riot's policy forbids apps that take actions on your behalf. If you distribute Hover, register it in the Riot Developer Portal first. LCU apps aren't allowed in Korea.

Hover isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties.
