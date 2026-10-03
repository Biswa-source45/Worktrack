// Shared by the root scripts: load the one root .env, fail clearly if it is missing.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(...required) {
  const file = join(root, '.env');
  if (!existsSync(file)) {
    console.error('Missing .env at the repo root. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  process.loadEnvFile(file);
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')} in .env.`);
    process.exit(1);
  }
}

// Runs a shell command line (so pnpm/uv/docker resolve on Windows) and exits on failure.
export function run(command, cwd = root) {
  console.log(`\n> ${command}${cwd === root ? '' : `   (in ${cwd})`}`);
  const { status } = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (status !== 0) process.exit(status ?? 1);
}

export const infraUp = 'docker compose -f infra/docker-compose.dev.yml up -d --wait';
