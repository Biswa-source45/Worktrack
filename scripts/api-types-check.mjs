// Fails when packages/api-types/src/schema.d.ts is out of date with the backend's OpenAPI schema.
// Exports the schema straight from the app (no running server needed).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, root, run } from './env.mjs';

loadEnv();
const dir = mkdtempSync(join(tmpdir(), 'worktrack-openapi-'));
const json = join(dir, 'openapi.json');
const generated = join(dir, 'schema.d.ts');

run(
  `uv run python -c "import json; from app.main import app; print(json.dumps(app.openapi()))" > "${json}"`,
  join(root, 'apps/backend'),
);
run(`pnpm --filter api-types exec openapi-typescript "${json}" -o "${generated}"`);

const norm = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
if (norm(generated) !== norm(join(root, 'packages/api-types/src/schema.d.ts'))) {
  console.error(
    '\napi-types is out of date. Start the backend and run: pnpm --filter api-types generate',
  );
  process.exit(1);
}
console.log('api-types is up to date.');
