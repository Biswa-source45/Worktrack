import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { BACKEND_DIR, backendEnv } from './env';

const ADMIN_PASSWORD = 'E2e-Initial-Pass-1';

function uv(args: string[], env: NodeJS.ProcessEnv) {
  execFileSync('uv', args, { cwd: BACKEND_DIR, env, stdio: 'inherit' });
}

// Bootstraps a fresh Super Admin in the e2e database (created and migrated by the config).
export default function globalSetup() {
  const env = { ...process.env, ...backendEnv() };

  const code = `E2E${Date.now().toString(36).toUpperCase()}`;
  const mobile = `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  uv(
    [
      'run',
      'python',
      'scripts/create_admin.py',
      '--emp-code',
      code,
      '--name',
      'E2E Admin',
      '--mobile',
      mobile,
    ],
    { ...env, WORKTRACK_ADMIN_PASSWORD: ADMIN_PASSWORD },
  );
  // Workers start after this and inherit these.
  process.env.E2E_ADMIN_CODE = code;
  process.env.E2E_ADMIN_PASSWORD = ADMIN_PASSWORD;
}
