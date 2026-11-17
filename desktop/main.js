// Hover desktop app: runs the bridge, shows the Connect window (QR code + pairing code),
// and lives in the menu bar (Mac) or system tray (Windows) when the window is closed.
import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HOVER_PORT || 7373);
const BASE = `http://127.0.0.1:${PORT}`;
const MAC = process.platform === 'darwin';
const WHERE = MAC ? 'menu bar' : 'system tray';

let win = null, tray = null, quitting = false, last = null;

// Remembers small things between launches, like whether we've explained the tray yet.
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const prefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } };
const setPref = (k, v) => { try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...prefs(), [k]: v })); } catch {} };
if (!MAC) app.setAppUserModelId('app.hover.desktop'); // Windows needs this to show notifications

// One Hover at a time: opening it again just brings the window back.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow()); // Mac: clicking the Dock icon
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {}); // keep running in the menu bar / tray
  app.whenReady().then(start);
}

async function start() {
  if (MAC) app.dock?.hide();
  makeTray();
  makeAppMenu();
  // The bridge calls back once it's listening (or if it can't start).
  globalThis.__hoverHost = {
    onReady: () => { showWindow(); poll(); },
    onError: async (message) => {
      await dialog.showMessageBox({ type: 'error', title: 'Hover', message: 'Hover couldn’t start', detail: `${message}\n\nQuit any other copy of Hover and open it again.` });
      quitting = true;
      app.quit();
    },
  };
  await import(pathToFileURL(path.join(here, '../bridge/index.js')).href);
}

function showWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 380, height: 660, resizable: false, maximizable: false, fullscreenable: false,
      title: 'Hover', backgroundColor: '#010a13', show: false, autoHideMenuBar: true,
      ...(MAC ? {} : { icon: path.join(here, 'assets', 'icon.png') }), // Windows taskbar
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadURL(`${BASE}/connect`);
    win.once('ready-to-show', () => win.show());
    // It only ever shows the Connect page.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${BASE}/connect`)) e.preventDefault(); });
    // Closing the window (red button, ⌘W, ⌘Q, Alt+F4, the X) tucks Hover into the menu bar / tray.
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      toTray();
    });
  } else {
    win.reload(); // fresh status and code
  }
  if (MAC) app.dock?.show();
  win.show();
  win.focus();
}

function toTray() {
  if (!win?.isVisible()) return;
  win.hide();
  if (MAC) app.dock?.hide();
  if (!prefs().toldAboutTray) {
    // First time: say clearly where Hover went.
    setPref('toldAboutTray', true);
    dialog.showMessageBox({
      type: 'info', title: 'Hover', buttons: ['Got it'],
      message: `Hover is still running in the ${WHERE}`,
      detail: MAC
        ? 'Look for the Hover icon (a small hexagon) at the top right of your screen. Click it to show the QR code again or to quit Hover.'
        : 'Look for the Hover icon (a small gold hexagon) at the bottom right of your screen. If you don’t see it, click the ^ arrow next to the clock. Click it to show the QR code again; right-click it to quit Hover.',
    });
  } else if (!MAC && tray) {
    tray.displayBalloon({ title: 'Hover is still running', content: 'It’s in the system tray. Right-click the icon to quit.', iconType: 'info' });
  }
}

// Mac: ⌘Q and ⌘W close the window to the menu bar like the red button; quitting is in the menu bar menu.
function makeAppMenu() {
  if (!MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hover', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Close to Menu Bar', accelerator: 'Command+Q', click: () => toTray() },
      { label: 'Quit Hover', accelerator: 'Command+Option+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ label: 'Close Window', accelerator: 'Command+W', click: () => toTray() }, { role: 'minimize' }] },
  ]));
}

function makeTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'assets', MAC ? 'trayTemplate.png' : 'tray.png'));
  if (MAC) icon.setTemplateImage(true); // follows light/dark menu bar
  tray = new Tray(icon);
  tray.setToolTip('Hover');
  if (!MAC) tray.on('click', () => showWindow()); // Windows: left-click opens, right-click shows the menu
  updateMenu();
}

function updateMenu() {
  const st = last;
  const loginOn = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: !st ? 'Starting…' : st.lcu ? 'League connected' : 'Waiting for League', enabled: false },
    ...(st ? [{ label: `Pairing code ${st.code.slice(0, 3)} ${st.code.slice(3)}`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Show QR code', click: () => showWindow() },
    { label: 'Start Hover at login', type: 'checkbox', checked: loginOn, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: 'Quit Hover', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(!st ? 'Hover' : st.lcu ? 'Hover: League connected' : 'Hover: waiting for League');
}

// Keep the tray menu's status line current.
function poll() {
  const tick = async () => {
    try {
      const s = await (await fetch(`${BASE}/api/status`, { cache: 'no-store' })).json();
      const changed = !last || s.lcu !== last.lcu || s.code !== last.code;
      last = s;
      if (changed) updateMenu();
    } catch {}
    setTimeout(tick, 3000);
  };
  tick();
}
