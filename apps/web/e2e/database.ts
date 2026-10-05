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

const CREATE_BUCKET = `
import os, boto3
from botocore.exceptions import ClientError
s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT_URL"],
    aws_access_key_id=os.environ["S3_ACCESS_KEY"],
    aws_secret_access_key=os.environ["S3_SECRET_KEY"],
    region_name=os.environ.get("S3_REGION", "us-east-1"),
)
try:
    s3.create_bucket(Bucket=os.environ["S3_BUCKET"])
except ClientError as error:
    if error.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
        raise
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
  uv(['run', 'python', '-c', CREATE_BUCKET], env);
  process.env.E2E_DB_READY = '1';
}
