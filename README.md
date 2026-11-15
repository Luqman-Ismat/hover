# Hover

Champ select from your iPhone. Hover runs on the computer that has League on it (Mac or Windows) and puts the client on your phone over your Wi‑Fi: open a lobby, invite friends, pick roles, queue, accept, ban, pick, swap with teammates, set spells and edit runes. It also tells you when your pick timer is about to run out and when the game has loaded in.

```
iPhone (Safari / home‑screen app)  ⇄  Wi‑Fi  ⇄  Hover on your computer  ⇄  League client
```

## Use it

1. **Get Hover for your computer**: `Hover-mac.zip` or `Hover-windows.zip` (see [Build the apps](#build-the-apps)). Unzip it.
   - **Mac:** drag **Hover.app** into Applications and open it. First time only: if macOS says it can't check the app, right‑click **Hover → Open → Open**. Allow incoming connections if asked.
   - **Windows:** open the **Hover** folder and double‑click **Hover.exe**. First time only: if SmartScreen appears, click **More info → Run anyway**. When the firewall asks, allow Hover on **private networks**.
2. **A window shows a QR code.** On your iPhone (same Wi‑Fi), point the Camera at it and open the link. That pairs the phone; you only do it once.
3. In Safari, tap **Share → Add to Home Screen**. Hover now opens full‑screen like an app.

**Closing the window doesn't quit Hover** (the close button, ⌘W/⌘Q on Mac, Alt+F4 on Windows). It keeps running in the **menu bar** (Mac, top right) or the **system tray** (Windows, bottom right; check the **^** arrow), and says so the first time. Click the ring icon there to show the QR code again, turn on **Start Hover at login**, or **Quit Hover**. Opening Hover again while it's running just brings the window back.

Start League before or after Hover; it finds the client by itself.

### Notifications when Hover isn't open

On your phone, tap the **bell** at the top of Hover and turn on **Alerts with Hover closed**. It walks you through it:

1. Get the free [ntfy](https://ntfy.sh) app from the App Store.
2. In ntfy, tap **+**, paste the topic Hover shows you (there's a Copy button), and tap **Subscribe**.
3. Tap **Send a test**.

From then on, when you've left Safari or locked your phone you get a notification for party invites, match found, champ select starting, your turn to ban or pick (and 10 seconds left), swap offers, someone dodging, the game loading in and AFK warnings. Tapping one opens Hover. While Hover is open on your phone, you hear and feel these in the app instead.

Safari can't receive real iPhone push notifications from a page served over your home Wi‑Fi (Apple requires a secure, internet‑hosted site), so Hover sends them through ntfy.sh. The topic is random and saved in `~/.hover/config.json`; the notifications only say things like "Match found".

### What the alerts mean

- **Party invite / Match found / Champ select started / Your turn to ban or pick / Swap offer:** something is waiting for you to tap it.
- **Pick or ban now:** 10 seconds left on your turn. If it runs out you're removed from champ select.
- **Game loaded:** the game's own timer has started (Hover reads League's in‑game API).
- **AFK warning coming:** about 75 seconds in, you still haven't bought anything, which usually means you're not at your computer. League doesn't expose its real AFK timer, so this is an estimate.

## Build the apps

Hover's desktop app is built with [Electron](https://www.electronjs.org). On a Mac:

```bash
npm install
npm run build
```

That writes `dist/Hover-mac.zip` (`Hover.app`, for Apple Silicon and Intel Macs) and `dist/Hover-windows.zip` (a `Hover` folder with `Hover.exe`). Everything Hover needs is inside, so nothing else has to be installed. The first build downloads Electron for each platform.

The apps aren't signed with an Apple or Microsoft developer certificate, which is why macOS and Windows ask for confirmation the first time. `Hover.exe` uses Electron's default program icon, because setting a custom one from a Mac needs Wine; the tray icon is Hover's own.

## Develop without League

```bash
npm run app    # the desktop app (window + menu bar / tray) from source
npm start      # just the bridge, in a terminal, against the real client
npm run dev    # mock League client + Hover
npm test       # end-to-end: pairing, notifications, parties, roles, runes, queue, draft, swaps, ARAM, live game
```

The mock (`mock/lcu.js`) simulates the client: friends and invites, a ranked draft with bot teammates and opponents, swap requests, ARAM, rune pages and the in‑game API. It pulls game data and art from CommunityDragon. Set `MOCK_SPEED=4` to run it faster.

## How it works

- `bridge/lcu.js` reads the client's credentials and talks to its local HTTPS API and event WebSocket.
- `bridge/state.js` mirrors the lobby, party, queue, ready check, champ select, rune pages and live game. It turns phone intents (`hover`, `lock`, `swap`, `runeSave`, …) into client calls. The phone can't send arbitrary endpoints.
- `bridge/index.js` handles pairing, serves the web app, proxies game art and runs the phone's WebSocket.
- `web/` is a Preact app with no build step.
- `desktop/main.js` is the desktop app: it runs the bridge, shows the Connect window (QR code, pairing code, League status; only reachable from the computer itself) and keeps Hover in the menu bar or system tray.
- `scripts/build.js` packages the desktop app for Mac and Windows.

## Security

- Pairing needs the 6‑digit code shown on your computer (the QR code includes it). The code changes every launch, and Hover allows 5 tries per minute.
- A paired device gets a long random token in an HttpOnly cookie. Only its hash is stored, in `~/.hover/devices.json`. Delete that file to unpair everything.
- The phone socket checks the token and the origin. Only allowlisted, validated commands reach the client.
- Traffic is plain HTTP on your local network. Don't run Hover on networks you don't trust.

## Riot policy notes

The League Client API is unofficial and Riot doesn't support it for third‑party apps. Endpoints can change with any patch. Hover only takes an action when you tap something: no auto‑accept, no auto‑pick, no auto‑lock. That's deliberate, because Riot's policy forbids apps that take actions on your behalf. If you distribute Hover, register it in the Riot Developer Portal first. LCU apps aren't allowed in Korea.

Hover isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties.
