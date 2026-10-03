import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { prepareDatabase } from './e2e/database';
import { BACKEND_DIR, backendEnv } from './e2e/env';

// Same root .env as the dev scripts; CI may provide the variables directly instead.
const rootEnv = path.resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
prepareDatabase();

const BACKEND_PORT = 8001;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  outputDir: './node_modules/.cache/playwright',
  globalSetup: './e2e/global-setup.ts',
  reporter: 'list',
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `uv run uvicorn app.main:app --port ${BACKEND_PORT}`,
      cwd: BACKEND_DIR,
      env: backendEnv(),
      url: `http://127.0.0.1:${BACKEND_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // A production build, because a second `next dev` in this directory is refused while the
      // normal dev server runs. Cookies are Secure there, which browsers allow on localhost.
      command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT}`,
      cwd: __dirname,
      env: { API_URL: `http://127.0.0.1:${BACKEND_PORT}` },
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
