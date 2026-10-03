import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api';

async function sentHeaders(appEnv?: string) {
  const fetchMock = vi.fn(async () => Response.json({}));
  await createApiClient({ baseUrl: 'http://api.test', appEnv, fetch: fetchMock }).GET('/health');
  return (fetchMock.mock.calls[0] as unknown as [Request])[0].headers;
}

describe('createApiClient', () => {
  it('sends the ngrok header in development', async () => {
    expect((await sentHeaders('development')).get('ngrok-skip-browser-warning')).toBe('true');
  });

  it.each(['production', undefined])('omits the ngrok header when env is %s', async (env) => {
    expect((await sentHeaders(env)).has('ngrok-skip-browser-warning')).toBe(false);
  });
});
