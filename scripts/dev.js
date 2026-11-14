// Runs the mock League client and the bridge together for development.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env, HOVER_LOCKFILE: path.join(root, 'mock/.lockfile'), HOVER_LIVE_URL: 'http://127.0.0.1:52438' };
const kids = [
  spawn(process.execPath, ['mock/lcu.js'], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, ['--env-file-if-exists=.env', 'bridge/index.js'], { cwd: root, env, stdio: 'inherit' }),
];
const stop = () => { kids.forEach((k) => k.kill('SIGTERM')); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
kids.forEach((k) => k.on('exit', stop));
