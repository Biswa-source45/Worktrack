import { execFileSync } from 'node:child_process';
import { BACKEND_DIR, backendEnv } from './env';
import { apiLogin, changePassword, uniqueMobile, uniqueSuffix } from './helpers';

const INITIAL_PASSWORD = 'E2e-Initial-Pass-1';
const READY_PASSWORD = 'E2e-Ready-Pass-3';
const READY_NAME = 'E2E Ready Admin';

function createAdmin(code: string, name: string) {
  execFileSync(
    'uv',
    [
      'run',
      'python',
      'scripts/create_admin.py',
      '--emp-code',
      code,
      '--name',
      name,
      '--mobile',
      uniqueMobile(),
    ],
    {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...backendEnv(), WORKTRACK_ADMIN_PASSWORD: INITIAL_PASSWORD },
      stdio: 'inherit',
    },
  );
}

// Bootstraps two Super Admins in the e2e database (created and migrated by the config):
// one still on its bootstrap password (the smoke test walks the forced change in the browser),
// and one whose forced change was already done through the API, for every other spec.
export default async function globalSetup() {
  const suffix = uniqueSuffix();
  const smokeCode = `E2E${suffix}`;
  const readyCode = `E2R${suffix}`;
  createAdmin(smokeCode, 'E2E Admin');
  createAdmin(readyCode, READY_NAME);

  const first = await apiLogin(readyCode, INITIAL_PASSWORD);
  await changePassword(first.access_token, INITIAL_PASSWORD, READY_PASSWORD);

  // Workers start after this and inherit these.
  process.env.E2E_ADMIN_CODE = smokeCode;
  process.env.E2E_ADMIN_PASSWORD = INITIAL_PASSWORD;
  process.env.E2E_READY_ADMIN_CODE = readyCode;
  process.env.E2E_READY_ADMIN_PASSWORD = READY_PASSWORD;
  process.env.E2E_READY_ADMIN_NAME = READY_NAME;
}
