// Infra first (must be healthy), then backend, worker, ngrok, web and Metro side by side.
import { concurrently } from 'concurrently';
import { infraUp, loadEnv, run } from './env.mjs';

loadEnv('NGROK_DOMAIN');
run(infraUp);

const reload = process.argv.includes('--reload');

const { result } = concurrently(
  [
    // No auto-reload by default: restart the API by hand after backend changes, or pass
    // `pnpm dev:all --reload` (see scripts/dev-api.mjs for why reload needs its own console).
    { name: 'api', command: `node scripts/dev-api.mjs${reload ? ' --reload' : ''}` },
    { name: 'worker', command: 'uv run arq app.workers.main.WorkerSettings', cwd: 'apps/backend' },
    { name: 'ngrok', command: 'node scripts/ngrok.mjs' },
    { name: 'web', command: 'pnpm --filter web dev' },
    { name: 'mobile', command: 'pnpm --filter mobile start' },
  ],
  {
    prefixColors: ['cyan', 'magenta', 'yellow', 'green', 'blue'],
    killOthersOn: [],
    handleInput: true,
  },
);
// One crashed process must not take the others down; Ctrl+C stops everything.
result.catch(() => {});
