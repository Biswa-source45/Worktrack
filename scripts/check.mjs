// Pre-commit gate: every lint, type and test command, stopping at the first failure.
import { infraUp, loadEnv, root, run } from './env.mjs';
import { join } from 'node:path';

loadEnv();
const backend = join(root, 'apps/backend');

run(infraUp);
run('pnpm format:check');
run('uv run ruff check .', backend);
run('uv run ruff format --check .', backend);
run('uv run mypy app', backend);
run('uv run pytest -q', backend);
run('node scripts/api-types-check.mjs');
for (const app of ['web', 'mobile']) {
  run(`pnpm --filter ${app} lint`);
  run(`pnpm --filter ${app} typecheck`);
  run(`pnpm --filter ${app} test`);
}
run('pnpm --filter web e2e');
