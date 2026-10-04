import path from 'node:path';

export const E2E_DATABASE = 'worktrack_e2e';

// The e2e stack runs against its own database (next to the test one), never the dev data, and
// never the backend test database whose tests expect an empty system. Redis and S3 come from the
// root .env. The login rate limit is raised because every run signs in from 127.0.0.1.
export function e2eDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
  return testUrl.replace(/\/[^/?]+(\?.*)?$/, `/${E2E_DATABASE}$1`);
}

// A separate Redis database keeps the login rate-limit counters of this stack apart from the dev
// backend's (both see the same client IP, 127.0.0.1).
export function e2eRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is not set (see .env.example)');
  return redisUrl.replace(/\/\d+$/, '/14');
}

export function backendEnv(): Record<string, string> {
  return {
    DATABASE_URL: e2eDatabaseUrl(),
    REDIS_URL: e2eRedisUrl(),
    JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-test-only-jwt-secret-e2e-test-only-jwt-secret',
    APP_ENV: 'test',
    CORS_ORIGINS: 'http://localhost:3100',
    LOGIN_IP_LIMIT: '1000',
  };
}

export const BACKEND_DIR = path.resolve(__dirname, '../../backend');
