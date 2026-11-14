# Hover

Champ select from your iPhone. Hover runs on the computer that has League on it (Mac or Windows) and puts the client on your phone over your Wi‑Fi: open a lobby, invite friends, pick roles, queue, accept, ban, pick, swap with teammates, set spells and edit runes. It also tells you when your pick timer is about to run out and when the game has loaded in.

```
iPhone (Safari / home‑screen app)  ⇄  Wi‑Fi  ⇄  Hover on your computer  ⇄  League client
```

## Use it

1. **Get Hover for your computer**: `Hover-mac.zip` or `Hover-windows.zip` (see [Build the apps](#build-the-apps)). Unzip it.
2. **Double‑click Hover** (`Hover.exe` on Windows). A window opens with a QR code. Keep it open while you play.
   - **Mac, first time:** if macOS says it can't check the app, right‑click **Hover → Open → Open**. Allow incoming connections when asked.
   - **Windows, first time:** if SmartScreen appears, click **More info → Run anyway**. When the firewall asks, allow Hover on **private networks**.
3. **On your iPhone** (same Wi‑Fi), point the Camera at the QR code and open the link. That pairs the phone; you only do it once.
4. In Safari, tap **Share → Add to Home Screen**. Hover now opens full‑screen like an app.

Start League before or after Hover; it finds the client by itself.

### Alerts when your phone is locked (optional)

A web app can only buzz while it's open. To get real notifications for queue pops, your pick timer, the game loading in and AFK warnings, install the free [ntfy](https://ntfy.sh) app on your iPhone, subscribe to a hard‑to‑guess topic, and put it in `~/.hover/config.json` (on Windows, `C:\Users\<you>\.hover\config.json`):

```json
{ "ntfyTopic": "hover-7f3k2q9x" }
```

Restart Hover after saving. Tapping a notification opens Hover.

### What the alerts mean

- **Pick or ban now:** 10 seconds left on your turn. If it runs out you're removed from champ select.
- **Game loaded:** the game's own timer has started (Hover reads League's in‑game API).
- **AFK warning coming:** about 75 seconds in, you still haven't bought anything, which usually means you're not at your computer. League doesn't expose its real AFK timer, so this is an estimate.

## Build the apps

On a Mac with Node 25.5 or newer:

```bash
npm install
npm run build
```

That writes `dist/Hover-mac.zip` (one app for Apple Silicon and Intel Macs) and `dist/Hover-windows.zip` (`Hover.exe`). Each is a single file with Node and the phone app built in, so nothing else needs installing. The first build downloads the matching Node runtimes from nodejs.org and checks them against their published checksums.

The apps aren't signed with an Apple or Microsoft developer certificate, which is why macOS and Windows ask for confirmation the first time.

## Develop without League

```bash
npm start      # run Hover from source against the real client
npm run dev    # mock League client + Hover
npm test       # end-to-end: pairing, parties, roles, runes, queue, draft, swaps, ARAM, live game
```

The mock (`mock/lcu.js`) simulates the client: friends and invites, a ranked draft with bot teammates and opponents, swap requests, ARAM, rune pages and the in‑game API. It pulls game data and art from CommunityDragon. Set `MOCK_SPEED=4` to run it faster.

## How it works

- `bridge/lcu.js` reads the client's credentials and talks to its local HTTPS API and event WebSocket.
- `bridge/state.js` mirrors the lobby, party, queue, ready check, champ select, rune pages and live game. It turns phone intents (`hover`, `lock`, `swap`, `runeSave`, …) into client calls. The phone can't send arbitrary endpoints.
- `bridge/index.js` handles pairing, serves the web app, proxies game art and runs the phone's WebSocket.
- `web/` is a Preact app with no build step.
- `scripts/build.js` bundles everything into one executable per platform with Node's single‑executable support.

## Security

- Pairing needs the 6‑digit code shown on your computer (the QR code includes it). The code changes every launch, and Hover allows 5 tries per minute.
- A paired device gets a long random token in an HttpOnly cookie. Only its hash is stored, in `~/.hover/devices.json`. Delete that file to unpair everything.
- The phone socket checks the token and the origin. Only allowlisted, validated commands reach the client.
- Traffic is plain HTTP on your local network. Don't run Hover on networks you don't trust.

## Riot policy notes

The League Client API is unofficial and Riot doesn't support it for third‑party apps. Endpoints can change with any patch. Hover only takes an action when you tap something: no auto‑accept, no auto‑pick, no auto‑lock. That's deliberate, because Riot's policy forbids apps that take actions on your behalf. If you distribute Hover, register it in the Riot Developer Portal first. LCU apps aren't allowed in Korea.

Hover isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties.
