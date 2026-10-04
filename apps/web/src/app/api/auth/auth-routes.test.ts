// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as changePassword } from './change-password/route';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';

const API = 'http://api.test';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN,
  cookies = '',
) {
  return new NextRequest(`http://localhost:3000/api/auth/${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      host: 'localhost:3000',
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookies } : {}),
      ...headers,
    },
  });
}

const backendTokens = {
  access_token: 'secret-access-token',
  refresh_token: 'secret-refresh-token',
  token_type: 'bearer',
  expires_in: 900,
  must_change_password: true,
  device_status: null,
};

type Sent = { url: string; auth: string | null; body: string; forwardedFor: string | null };
let sent: Sent[];

function backend(respond: (call: Sent) => Response) {
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(url),
      auth: headers.get('authorization'),
      body:
        init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : String(init?.body),
      forwardedFor: headers.get('x-forwarded-for'),
    };
    sent.push(call);
    return respond(call);
  });
}

beforeEach(() => {
  vi.stubEnv('API_URL', API);
  sent = [];
});

describe('POST /api/auth/login', () => {
  it('sets httpOnly SameSite=Strict cookies and returns no tokens', async () => {
    backend(() => Response.json(backendTokens));
    const response = await login(
      post(
        'login',
        { identifier: 'ADMIN-1', password: 'pw' },
        { ...SAME_ORIGIN, 'x-forwarded-for': '203.0.113.9' },
      ),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ must_change_password: true });
    expect(text).not.toContain('secret');
    expect(response.cookies.get('wt_access')).toMatchObject({
      value: 'secret-access-token',
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
    expect(response.cookies.get('wt_refresh')).toMatchObject({
      value: 'secret-refresh-token',
      httpOnly: true,
      sameSite: 'strict',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(sent[0].url).toBe(`${API}/api/v1/auth/login`);
    expect(JSON.parse(sent[0].body)).toEqual({
      identifier: 'ADMIN-1',
      password: 'pw',
      client: 'web',
    });
    expect(sent[0].forwardedFor).toBe('203.0.113.9');
  });

  it('marks the cookies Secure in production only', async () => {
    backend(() => Response.json(backendTokens));
    vi.stubEnv('NODE_ENV', 'production');
    const response = await login(post('login', { identifier: 'a', password: 'b' }));
    expect(response.cookies.get('wt_access')?.secure).toBe(true);
    vi.stubEnv('NODE_ENV', 'test');
    const dev = await login(post('login', { identifier: 'a', password: 'b' }));
    expect(dev.cookies.get('wt_access')?.secure).toBeFalsy();
  });

  it('relays the backend error without setting cookies', async () => {
    backend(() =>
      Response.json(
        {
          error: {
            code: 'ACCOUNT_LOCKED',
            message: 'locked',
            details: { retry_after_seconds: 600 },
          },
        },
        { status: 429 },
      ),
    );
    const response = await login(post('login', { identifier: 'a', password: 'b' }));
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: { retry_after_seconds: 600 },
    });
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it('rejects cross-origin requests and malformed bodies without calling the backend', async () => {
    backend(() => Response.json(backendTokens));
    expect(
      (
        await login(
          post('login', { identifier: 'a', password: 'b' }, { origin: 'http://evil.test' }),
        )
      ).status,
    ).toBe(403);
    expect((await login(post('login', { identifier: '', password: 'b' }))).status).toBe(422);
    expect((await login(post('login', 'not json'))).status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('answers 502 when the backend is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    const response = await login(post('login', { identifier: 'a', password: 'b' }));
    expect(response.status).toBe(502);
    expect(response.cookies.getAll()).toHaveLength(0);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token on the backend and clears both cookies', async () => {
    backend(() => new Response(null, { status: 204 }));
    const response = await logout(
      post('logout', '', SAME_ORIGIN, 'wt_access=a; wt_refresh=refresh-xyz'),
    );
    expect(response.status).toBe(204);
    expect(sent[0].url).toBe(`${API}/api/v1/auth/logout`);
    expect(JSON.parse(sent[0].body)).toEqual({ refresh_token: 'refresh-xyz' });
    expect(response.cookies.get('wt_access')).toMatchObject({ value: '', maxAge: 0 });
    expect(response.cookies.get('wt_refresh')).toMatchObject({ value: '', maxAge: 0 });
  });

  it('still clears the cookies when the backend is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('down'));
    const response = await logout(post('logout', '', SAME_ORIGIN, 'wt_refresh=r'));
    expect(response.status).toBe(204);
    expect(response.cookies.get('wt_refresh')).toMatchObject({ maxAge: 0 });
  });

  it('rejects cross-origin requests', async () => {
    backend(() => new Response(null, { status: 204 }));
    const response = await logout(
      post('logout', '', { origin: 'http://evil.test' }, 'wt_refresh=r'),
    );
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe('POST /api/auth/change-password', () => {
  const body = { current_password: 'old-temp-pass', new_password: 'a-brand-new-pass' };

  it('forwards with the cookie bearer and swaps the cookies for the new tokens', async () => {
    backend(() => Response.json({ ...backendTokens, must_change_password: false }));
    const response = await changePassword(
      post('change-password', body, SAME_ORIGIN, 'wt_access=cur; wt_refresh=r'),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ must_change_password: false });
    expect(text).not.toContain('secret');
    expect(sent[0].url).toBe(`${API}/api/v1/auth/change-password`);
    expect(sent[0].auth).toBe('Bearer cur');
    expect(JSON.parse(sent[0].body)).toEqual(body);
    expect(response.cookies.get('wt_access')).toMatchObject({
      value: 'secret-access-token',
      httpOnly: true,
    });
  });

  it('relays a wrong current password and keeps the session cookies', async () => {
    backend(() =>
      Response.json(
        { error: { code: 'INVALID_CURRENT_PASSWORD', message: 'x', details: null } },
        { status: 400 },
      ),
    );
    const response = await changePassword(
      post('change-password', body, SAME_ORIGIN, 'wt_access=cur; wt_refresh=r'),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it('answers 401 without cookies and rejects cross-origin requests', async () => {
    backend(() => Response.json(backendTokens));
    expect((await changePassword(post('change-password', body))).status).toBe(401);
    expect(
      (
        await changePassword(
          post(
            'change-password',
            body,
            { origin: 'http://evil.test' },
            'wt_access=a; wt_refresh=r',
          ),
        )
      ).status,
    ).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
