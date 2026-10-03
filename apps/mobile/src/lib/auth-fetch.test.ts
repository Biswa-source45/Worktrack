import { resetSecureStore } from '@/test/secure-store-mock';
import { createApiClient, createAuthFetch, createRefresher, setSessionExpiredHandler } from './api';
import { getTokens, setTokens } from './token-store';

type Handler = (request: Request) => Response | Promise<Response>;

const tokenPair = (access: string) => ({
  access_token: access,
  refresh_token: 'refresh-2',
  token_type: 'bearer',
  expires_in: 900,
  must_change_password: false,
  device_status: 'active',
});

// Fake backend: protected endpoints only accept the current access token; /auth/refresh rotates it.
function setup(opts: { refresh?: Handler; valid?: string } = {}) {
  const seen: { path: string; auth: string | null }[] = [];
  const validAccess = opts.valid ?? 'access-1';
  const base = jest.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    seen.push({ path, auth: request.headers.get('Authorization') });
    if (path === '/api/v1/auth/refresh') {
      if (opts.refresh) return opts.refresh(request);
      return Response.json(tokenPair('access-2'));
    }
    if (request.headers.get('Authorization') === `Bearer ${validAccess}`) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 });
  }) as unknown as typeof fetch;
  const refresh = createRefresher(createApiClient({ baseUrl: 'https://api.test', fetch: base }));
  const client = createApiClient({
    baseUrl: 'https://api.test',
    fetch: createAuthFetch(base, refresh),
  });
  const count = (path: string) => seen.filter((s) => s.path === path).length;
  return { client, seen, count };
}

const expired = jest.fn();

beforeEach(async () => {
  resetSecureStore();
  expired.mockClear();
  setSessionExpiredHandler(expired);
  await setTokens({ access: 'access-1', refresh: 'refresh-1' });
});

describe('auth fetch', () => {
  it('attaches the bearer token', async () => {
    const { client, seen } = setup();
    const { data } = await client.GET('/api/v1/me');
    expect(data).toEqual({ ok: true });
    expect(seen).toEqual([{ path: '/api/v1/me', auth: 'Bearer access-1' }]);
  });

  it('sends no Authorization header when signed out', async () => {
    resetSecureStore();
    const { client, seen } = setup();
    await client.GET('/api/v1/me');
    expect(seen[0].auth).toBeNull();
  });

  it('neither attaches the bearer to login nor refreshes after a login 401', async () => {
    const { client, seen } = setup();
    const { response } = await client.POST('/api/v1/auth/login', {
      body: { identifier: 'x', password: 'y', client: 'web' },
    });
    expect(response.status).toBe(401);
    expect(seen).toEqual([{ path: '/api/v1/auth/login', auth: null }]);
  });

  it('refreshes once on a 401, stores the new pair and replays the request body', async () => {
    const { client, seen } = setup({ valid: 'access-2' });
    const { response } = await client.POST('/api/v1/auth/change-password', {
      body: { current_password: 'old-pass-123', new_password: 'new-pass-1234' },
    });
    expect(response.status).toBe(200);
    expect(seen.map((s) => [s.path, s.auth])).toEqual([
      ['/api/v1/auth/change-password', 'Bearer access-1'],
      ['/api/v1/auth/refresh', null],
      ['/api/v1/auth/change-password', 'Bearer access-2'],
    ]);
    expect(await getTokens()).toEqual({ access: 'access-2', refresh: 'refresh-2' });
  });

  it('runs exactly one refresh for two concurrent 401s', async () => {
    const { client, count } = setup({ valid: 'access-2' });
    const [a, b] = await Promise.all([client.GET('/api/v1/me'), client.GET('/api/v1/me')]);
    expect(a.response.status).toBe(200);
    expect(b.response.status).toBe(200);
    expect(count('/api/v1/auth/refresh')).toBe(1);
  });

  it('shares one in-flight refresh between 401s that overlap it', async () => {
    // The slow refresh keeps both requests inside it, so only single-flight (not the token
    // comparison shortcut) can keep the count at one.
    const { client, count } = setup({
      valid: 'access-2',
      refresh: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json(tokenPair('access-2'));
      },
    });
    const results = await Promise.all([
      client.GET('/api/v1/me'),
      client.GET('/api/v1/me'),
      client.GET('/api/v1/me'),
    ]);
    expect(results.map((r) => r.response.status)).toEqual([200, 200, 200]);
    expect(count('/api/v1/auth/refresh')).toBe(1);
  });

  it('clears tokens and signs out when the refresh is rejected', async () => {
    const { client, count } = setup({
      valid: 'access-2',
      refresh: () => Response.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 }),
    });
    const { response } = await client.GET('/api/v1/me');
    expect(response.status).toBe(401);
    expect(await getTokens()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(count('/api/v1/auth/refresh')).toBe(1);
  });

  it('keeps the tokens when the refresh fails transiently, and does not loop', async () => {
    const { client, count } = setup({
      valid: 'access-2',
      refresh: () => new Response(null, { status: 503 }),
    });
    const { response } = await client.GET('/api/v1/me');
    expect(response.status).toBe(401);
    expect(await getTokens()).toEqual({ access: 'access-1', refresh: 'refresh-1' });
    expect(expired).not.toHaveBeenCalled();
    expect(count('/api/v1/auth/refresh')).toBe(1);
    expect(count('/api/v1/me')).toBe(1);
  });

  it('retries only once when the retried request is still 401', async () => {
    // The refresh succeeds but the backend keeps rejecting the new access token.
    const { client, count } = setup({
      valid: 'access-2',
      refresh: () => Response.json(tokenPair('access-bad')),
    });
    const { response } = await client.GET('/api/v1/me');
    expect(response.status).toBe(401);
    expect(count('/api/v1/me')).toBe(2);
    expect(count('/api/v1/auth/refresh')).toBe(1);
  });
});
