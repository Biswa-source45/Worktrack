import { createApiClient } from './api';

const okResponse = () => Response.json({ status: 'ok', checks: {} });

async function sentHeaders(appEnv?: string) {
  const fetchMock = jest.fn().mockResolvedValue(okResponse());
  await createApiClient({ baseUrl: 'https://api.test', appEnv, fetch: fetchMock }).GET('/health');
  return (fetchMock.mock.calls[0][0] as Request).headers;
}

describe('createApiClient', () => {
  it('sends the ngrok header in development', async () => {
    expect((await sentHeaders('development')).get('ngrok-skip-browser-warning')).toBe('true');
  });

  it.each(['production', 'test', undefined])(
    'omits the ngrok header when appEnv is %s',
    async (env) => {
      expect((await sentHeaders(env)).has('ngrok-skip-browser-warning')).toBe(false);
    },
  );
});
