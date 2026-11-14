// Builds Hover as one double-click app per platform, with the phone web app inside:
//   dist/Hover-mac.zip      (Hover for Apple Silicon and Intel Macs)
//   dist/Hover-windows.zip  (Hover.exe)
// Run with `npm run build`. Needs Node 25.5+ (for --build-sea) and internet the first
// time, to fetch the matching Node runtimes from nodejs.org (cached in dist/.cache).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const cache = path.join(dist, '.cache');
const VERSION = process.version; // the runtimes match the Node doing the build
fs.mkdirSync(cache, { recursive: true });

const step = (s) => console.log(`\n▸ ${s}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// 1. One CommonJS file for the bridge and its dependencies.
step('Bundling the bridge');
const bundle = path.join(dist, 'hover.cjs');
await build({
  entryPoints: [path.join(root, 'bridge/index.js')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  // ws works without its optional native speedups.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

// 2. The phone app, embedded as assets keyed by URL path.
const assets = { 'vendor/preact.js': path.join(root, 'node_modules/htm/preact/standalone.mjs') };
for (const f of fs.readdirSync(path.join(root, 'web'))) {
  const p = path.join(root, 'web', f);
  if (fs.statSync(p).isFile()) assets[f] = p;
}
console.log(`  ${Object.keys(assets).length} web files embedded`);

// 3. Node runtimes for each target, verified against nodejs.org's published checksums.
const TARGETS = [
  { name: 'mac-arm64', archive: `node-${VERSION}-darwin-arm64.tar.gz`, bin: `node-${VERSION}-darwin-arm64/bin/node`, out: 'Hover' },
  { name: 'mac-x64', archive: `node-${VERSION}-darwin-x64.tar.gz`, bin: `node-${VERSION}-darwin-x64/bin/node`, out: 'Hover' },
  { name: 'win-x64', archive: `node-${VERSION}-win-x64.zip`, bin: `node-${VERSION}-win-x64/node.exe`, out: 'Hover.exe' },
];
let sums;
async function runtime(t) {
  const bin = path.join(cache, t.bin);
  if (fs.existsSync(bin)) return bin;
  sums ??= await (await fetch(`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith(`  ${t.archive}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`nodejs.org has no ${t.archive}`);
  console.log(`  downloading ${t.archive}`);
  const res = await fetch(`https://nodejs.org/dist/${VERSION}/${t.archive}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${t.archive}`);
  const file = path.join(cache, t.archive);
  fs.writeFileSync(file, buf);
  if (t.archive.endsWith('.zip')) run('unzip', ['-q', '-o', file, t.bin, '-d', cache]);
  else run('tar', ['-xzf', file, '-C', cache, t.bin]);
  fs.rmSync(file);
  return bin;
}

// 4. Stamp the bundle and assets into each runtime. Some Node builds (Homebrew's, for
// one) ship without single-executable support, so the stamping runs on the official
// runtime for this machine.
const host = TARGETS.find((t) => t.name === `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`);
if (!host) throw new Error(`Build on a Mac or Windows PC (this is ${process.platform}-${process.arch})`);
const builder = await runtime(host);
for (const t of TARGETS) {
  step(`Building ${t.name}`);
  const dir = path.join(dist, t.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, t.out);
  const config = path.join(dist, `sea-${t.name}.json`);
  fs.writeFileSync(config, JSON.stringify({
    main: bundle, output, executable: await runtime(t), assets,
    disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
  }, null, 2));
  run(builder, ['--build-sea', config], { cwd: root });
  fs.rmSync(config);
  // macOS won't run a modified binary without a signature; an ad-hoc one is enough locally.
  if (t.name.startsWith('mac') && process.platform === 'darwin') run('codesign', ['--sign', '-', '--force', output]);
  console.log(`  ${path.relative(root, output)} (${(fs.statSync(output).size / 1e6).toFixed(0)} MB)`);
}

// 5. Zips people can download: one Mac app that picks the right chip, one Windows exe.
step('Packaging');
const macDir = path.join(dist, 'Hover-mac');
fs.rmSync(macDir, { recursive: true, force: true });
fs.mkdirSync(macDir);
if (process.platform === 'darwin') {
  // A universal binary runs natively on Apple Silicon and Intel.
  run('lipo', ['-create', path.join(dist, 'mac-arm64/Hover'), path.join(dist, 'mac-x64/Hover'), '-output', path.join(macDir, 'Hover')]);
  run('codesign', ['--sign', '-', '--force', path.join(macDir, 'Hover')]);
} else {
  fs.copyFileSync(path.join(dist, 'mac-arm64/Hover'), path.join(macDir, 'Hover'));
}
fs.chmodSync(path.join(macDir, 'Hover'), 0o755);
const winDir = path.join(dist, 'Hover-windows');
fs.rmSync(winDir, { recursive: true, force: true });
fs.mkdirSync(winDir);
fs.copyFileSync(path.join(dist, 'win-x64/Hover.exe'), path.join(winDir, 'Hover.exe'));
const readme = (os) => [
  'Hover: champ select from your iPhone',
  '',
  `1. Double-click ${os === 'mac' ? 'Hover' : 'Hover.exe'}. A window opens with a QR code.`,
  os === 'mac'
    ? '   First time only: if macOS says it can\'t check the app, right-click Hover > Open > Open.'
    : '   First time only: if Windows SmartScreen appears, click More info > Run anyway.',
  os === 'mac'
    ? '   Allow incoming connections when asked, so your iPhone can reach it.'
    : '   When Windows Firewall asks, allow Hover on private networks so your iPhone can reach it.',
  '2. On your iPhone (same Wi-Fi), open the Camera and scan the QR code.',
  '3. In Safari, tap Share > Add to Home Screen to use Hover like an app.',
  '',
  'Start League before or after Hover. Keep the Hover window open while you play.',
  '',
].join('\n');
fs.writeFileSync(path.join(macDir, 'Read me.txt'), readme('mac'));
fs.writeFileSync(path.join(winDir, 'Read me.txt'), readme('win'));
for (const [dir, zip] of [[macDir, 'Hover-mac.zip'], [winDir, 'Hover-windows.zip']]) {
  fs.rmSync(path.join(dist, zip), { force: true });
  // -y keeps the executable bit on the Mac binary.
  run('zip', ['-q', '-r', '-y', zip, path.basename(dir)], { cwd: dist });
  console.log(`  dist/${zip} (${(fs.statSync(path.join(dist, zip)).size / 1e6).toFixed(0)} MB)`);
}
console.log('\nDone.');
