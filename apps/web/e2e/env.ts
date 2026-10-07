import path from 'node:path';

// E2E_DATABASE lets a run start from an empty database (CI does) without touching the usual one.
export const E2E_DATABASE = process.env.E2E_DATABASE ?? 'worktrack_e2e';

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

// Photos go to a bucket of their own (the dev one holds real enrollments under the same keys).
export const E2E_BUCKET = 'worktrack-e2e';

export function backendEnv(): Record<string, string> {
  return {
    DATABASE_URL: e2eDatabaseUrl(),
    REDIS_URL: e2eRedisUrl(),
    JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-test-only-jwt-secret-e2e-test-only-jwt-secret',
    // Any valid key works here: the e2e database is thrown away like the test one.
    FACE_ENCRYPTION_KEY:
      process.env.FACE_ENCRYPTION_KEY ?? 'dGVzdC1vbmx5LWZhY2Uta2V5LXRlc3Qtb25seS0xMjM=',
    S3_BUCKET: E2E_BUCKET,
    APP_ENV: 'test',
    CORS_ORIGINS: 'http://localhost:3100',
    LOGIN_IP_LIMIT: '1000',
  };
}

export const BACKEND_DIR = path.resolve(__dirname, '../../backend');
