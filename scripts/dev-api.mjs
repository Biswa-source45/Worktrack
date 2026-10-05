// The backend API alone: `pnpm dev:api`, or `pnpm dev:api --reload` to restart on code changes.
// Any other argument goes to uvicorn (for example `--port 8001`).
//
// Reload is done here, not with uvicorn's own --reload: on Windows uvicorn restarts its worker
// with a console Ctrl+C event, and Windows delivers that to every process attached to the same
// console, so one reload under `pnpm dev:all` also stopped ngrok, the worker, web and Metro.
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { root } from './env.mjs';

const args = process.argv.slice(2);
const reload = args.includes('--reload');
const uvicorn = ['run', 'uvicorn', 'app.main:app', '--host', '0.0.0.0'].concat(
  args.filter((arg) => arg !== '--reload'),
);
const backend = join(root, 'apps/backend');

let child;
function start() {
  // No shell: uv is a real executable, so the process ID below is uv's own.
  child = spawn('uv', uvicorn, { cwd: backend, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function restart(file) {
  console.log(`[dev-api] ${file} changed, restarting the API`);
  const old = child;
  old.removeAllListeners('exit'); // this exit is ours, not a crash
  // Exactly the process tree started above, by its ID (uv -> python).
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(old.pid), '/T', '/F']);
  else old.kill();
  start();
}

start();
if (reload) {
  let timer;
  watch(join(backend, 'app'), { recursive: true }, (_event, file) => {
    if (!file?.endsWith('.py')) return;
    clearTimeout(timer); // an editor save is several events: restart once
    timer = setTimeout(() => restart(file), 300);
  });
}
