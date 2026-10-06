// Pre-commit gate: every lint, type and test command, stopping at the first failure.
// `--fast` (pnpm check:fast) skips the slow backend tests and Playwright, for use between sub-tasks.
import { infraUp, loadEnv, root, run } from './env.mjs';
import { join } from 'node:path';

loadEnv();
const backend = join(root, 'apps/backend');
const fast = process.argv.includes('--fast');

run(infraUp);
run('pnpm format:check');
run('uv run ruff check .', backend);
run('uv run ruff format --check .', backend);
run('uv run mypy app', backend);
run(fast ? 'uv run pytest -q -m "not slow"' : 'uv run pytest -q', backend);
run('node scripts/api-types-check.mjs');
for (const app of ['web', 'mobile']) {
  run(`pnpm --filter ${app} lint`);
  run(`pnpm --filter ${app} typecheck`);
  run(`pnpm --filter ${app} test`);
}
if (!fast) run('pnpm --filter web e2e');
