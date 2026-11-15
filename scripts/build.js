// Builds the Hover desktop app (Electron) for both platforms:
//   dist/Hover-mac.zip      Hover.app, for Apple Silicon and Intel Macs
//   dist/Hover-windows.zip  Hover\Hover.exe
// Run with `npm run build` on a Mac. The first run downloads Electron for each platform.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const step = (s) => console.log(`\n▸ ${s}`);
const mb = (p) => `${(fs.statSync(p).size / 1e6).toFixed(0)} MB`;

if (process.platform !== 'darwin') throw new Error('Build on a Mac: it makes both the Mac and Windows apps.');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const common = {
  dir: root, out: dist, name: 'Hover', executableName: 'Hover', appVersion: pkg.version,
  overwrite: true, asar: true, prune: true, quiet: true,
  // Only the bridge, the phone app and the desktop shell ship.
  ignore: [/^\/(mock|scripts|dist|\.claude|\.git|\.env.*|\.gitignore|README\.md)(\/|$)/],
};

step('Building Hover for Mac (Apple Silicon + Intel)');
const [macOut] = await packager({
  ...common, platform: 'darwin', arch: 'universal',
  icon: path.join(root, 'desktop/assets/Hover.icns'),
  appBundleId: 'app.hover.desktop', appCategoryType: 'public.app-category.games',
});
const macApp = path.join(macOut, 'Hover.app');
// Ad-hoc signature: enough for macOS to run it (no Apple developer certificate).
run('codesign', ['--force', '--deep', '--sign', '-', macApp]);

step('Building Hover for Windows');
const [winOut] = await packager({ ...common, platform: 'win32', arch: 'x64' });

step('Packaging');
const readme = (mac) => [
  'Hover: champ select from your iPhone',
  '',
  mac ? '1. Drag Hover into Applications, then open it.' : '1. Open the Hover folder and double-click Hover.exe.',
  mac
    ? '   First time only: if macOS says it can\'t check the app, right-click Hover > Open > Open.'
    : '   First time only: if Windows SmartScreen appears, click More info > Run anyway.',
  mac
    ? '   Allow incoming connections if asked, so your iPhone can reach it.'
    : '   When Windows Firewall asks, allow Hover on private networks so your iPhone can reach it.',
  '2. A window shows a QR code. On your iPhone (same Wi-Fi), point the Camera at it.',
  '3. In Safari, tap Share > Add to Home Screen to use Hover like an app.',
  '',
  `Closing the window keeps Hover running in the ${mac ? 'menu bar (top right)' : 'system tray (bottom right; check the ^ arrow)'}.`,
  'Click the Hover icon there to show the QR code again, start Hover at login, or quit.',
  '',
].join('\n');

// Mac: Hover.app + read-me, zipped with ditto so the app bundle stays intact.
const macDir = path.join(dist, 'Hover-mac');
fs.mkdirSync(macDir);
fs.renameSync(macApp, path.join(macDir, 'Hover.app'));
fs.writeFileSync(path.join(macDir, 'Read me.txt'), readme(true));
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', macDir, path.join(dist, 'Hover-mac.zip')]);

// Windows: a Hover folder with Hover.exe inside, plus the read-me.
const winDir = path.join(dist, 'Hover-windows');
fs.mkdirSync(winDir);
fs.renameSync(winOut, path.join(winDir, 'Hover'));
fs.writeFileSync(path.join(winDir, 'Read me.txt'), readme(false));
run('zip', ['-q', '-r', '-y', 'Hover-windows.zip', 'Hover-windows'], { cwd: dist });

for (const p of [macOut, ...fs.readdirSync(dist).filter((f) => f.startsWith('Hover-') && f.includes('-x64') || f.includes('-universal')).map((f) => path.join(dist, f))]) fs.rmSync(p, { recursive: true, force: true });
console.log(`\n  dist/Hover-mac.zip      ${mb(path.join(dist, 'Hover-mac.zip'))}`);
console.log(`  dist/Hover-windows.zip  ${mb(path.join(dist, 'Hover-windows.zip'))}`);
console.log('\nDone.');
