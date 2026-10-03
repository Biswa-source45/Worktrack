import { execFileSync } from 'node:child_process';
import { BACKEND_DIR, E2E_DATABASE, backendEnv } from './env';

const CREATE_DATABASE = `
import asyncio, os, asyncpg
async def main():
    dsn = os.environ["TEST_DATABASE_URL"].replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        if not await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", "${E2E_DATABASE}"):
            await conn.execute('CREATE DATABASE "${E2E_DATABASE}"')
    finally:
        await conn.close()
asyncio.run(main())
`;

// Playwright starts the web servers before global setup, and the backend's health check needs
// the database, so this runs while the config is loaded (once: workers inherit the flag).
export function prepareDatabase() {
  if (process.env.E2E_DB_READY) return;
  const env = { ...process.env, ...backendEnv() };
  const uv = (args: string[], e: NodeJS.ProcessEnv) =>
    execFileSync('uv', args, { cwd: BACKEND_DIR, env: e, stdio: 'inherit' });
  uv(['run', 'python', '-c', CREATE_DATABASE], process.env);
  uv(['run', 'alembic', 'upgrade', 'head'], env);
  process.env.E2E_DB_READY = '1';
}
