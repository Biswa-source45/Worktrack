// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH, POST } from './route';

const API = 'http://api.test';

type Init = {
  method?: string;
  cookies?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
};

function request(path: string, { method = 'GET', cookies, headers, body }: Init = {}) {
  return new NextRequest(`http://localhost:3000/api/proxy/${path}`, {
    method,
    body,
    headers: {
      host: 'localhost:3000',
      ...(cookies ? { cookie: cookies } : {}),
      ...headers,
    },
  });
}

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });
const sameOrigin = { 'sec-fetch-site': 'same-origin' };

type Sent = { url: string; method?: string; auth: string | null; body?: unknown; headers: Headers };
let sent: Sent[];
let tokenCounter = 0;

// The backend as a function of (url, bearer): `respond` decides each answer.
function backend(respond: (call: Sent) => Response) {
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(url),
      method: init?.method,
      auth: headers.get('authorization'),
      body: init?.body,
      headers,
    };
    sent.push(call);
    return respond(call);
  });
}

const tokens = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  must_change_password: false,
});

beforeEach(() => {
  vi.stubEnv('API_URL', API);
  sent = [];
  tokenCounter += 1;
});

describe('proxy route', () => {
  it('attaches the bearer from the cookie and forwards query and client IP', async () => {
    backend(() => Response.json({ items: [] }));
    const path = 'api/v1/admin/employees';
    const response = await GET(
      request(`${path}?q=asha&limit=5`, {
        cookies: 'wt_access=tok-a; wt_refresh=ref-a',
        headers: { 'x-forwarded-for': '203.0.113.9', accept: 'application/json' },
      }),
      ctx(path),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${API}/api/v1/admin/employees?q=asha&limit=5`);
    expect(sent[0].auth).toBe('Bearer tok-a');
    expect(sent[0].headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('on 401 refreshes once, retries once and stores the new tokens in httpOnly cookies', async () => {
    const fresh = tokens(tokenCounter);
    backend((call) => {
      if (call.url.endsWith('/auth/refresh')) return Response.json(fresh);
      return call.auth === `Bearer ${fresh.access_token}`
        ? Response.json({ id: 1 })
        : Response.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 });
    });
    const response = await GET(
      request('api/v1/me', { cookies: `wt_access=old; wt_refresh=old-refresh-${tokenCounter}` }),
      ctx('api/v1/me'),
    );
    expect(response.status).toBe(200);
    expect(sent.map((c) => c.url.replace(API, ''))).toEqual([
      '/api/v1/me',
      '/api/v1/auth/refresh',
      '/api/v1/me',
    ]);
    expect(JSON.parse(sent[1].body as string)).toEqual({
      refresh_token: `old-refresh-${tokenCounter}`,
    });
    const access = response.cookies.get('wt_access');
    const refresh = response.cookies.get('wt_refresh');
    expect(access).toMatchObject({ value: fresh.access_token, httpOnly: true, sameSite: 'strict' });
    expect(refresh).toMatchObject({ value: fresh.refresh_token, httpOnly: true, path: '/' });
  });

  it('does not loop when the retry is still 401', async () => {
    const fresh = tokens(tokenCounter);
    backend((call) =>
      call.url.endsWith('/auth/refresh')
        ? Response.json(fresh)
        : Response.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 }),
    );
    const response = await GET(
      request('api/v1/me', { cookies: `wt_access=old; wt_refresh=loop-${tokenCounter}` }),
      ctx('api/v1/me'),
    );
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(3);
  });

  it('shares one refresh between parallel requests', async () => {
    const fresh = tokens(tokenCounter);
    backend((call) =>
      call.url.endsWith('/auth/refresh')
        ? Response.json(fresh)
        : call.auth === `Bearer ${fresh.access_token}`
          ? Response.json({})
          : new Response(null, { status: 401 }),
    );
    const cookies = `wt_access=old; wt_refresh=parallel-${tokenCounter}`;
    const [a, b] = await Promise.all([
      GET(request('api/v1/me', { cookies }), ctx('api/v1/me')),
      GET(request('api/v1/me', { cookies }), ctx('api/v1/me')),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sent.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('clears the cookies and answers 401 when the refresh token is rejected', async () => {
    backend((call) =>
      call.url.endsWith('/auth/refresh')
        ? Response.json({ error: { code: 'INVALID_TOKEN' } }, { status: 401 })
        : new Response(null, { status: 401 }),
    );
    const response = await GET(
      request('api/v1/me', { cookies: `wt_access=old; wt_refresh=dead-${tokenCounter}` }),
      ctx('api/v1/me'),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
    expect(response.cookies.get('wt_access')).toMatchObject({ value: '', maxAge: 0 });
    expect(response.cookies.get('wt_refresh')).toMatchObject({ value: '', maxAge: 0 });
    // One call with the stale token, one refresh, no retry.
    expect(sent).toHaveLength(2);
  });

  it('keeps the cookies and answers 502 when the backend is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    const response = await GET(
      request('api/v1/me', { cookies: 'wt_access=a; wt_refresh=r' }),
      ctx('api/v1/me'),
    );
    expect(response.status).toBe(502);
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it('answers 401 without calling the backend when there are no cookies', async () => {
    backend(() => Response.json({}));
    const response = await GET(request('api/v1/me'), ctx('api/v1/me'));
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it.each([
    'api/v1/auth/login',
    'api/v1/auth/refresh',
    'api/v1/health',
    'api/v1/employees',
    'api/v1/administrator',
    'api/v1/branches/1',
    'api/v1/files',
    'api/v1/files/a/b',
    'api/v1/files/a%20b',
    'api/v1/admin/../auth/refresh',
    'api/v1/admin/%2e%2e/auth/refresh',
    'me',
    'api/v2/me',
  ])('rejects the non-allow-listed path %s', async (path) => {
    backend(() => Response.json({}));
    const response = await GET(
      request(path, { cookies: 'wt_access=a; wt_refresh=r' }),
      ctx(decodeURIComponent(path)),
    );
    expect(response.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('rejects a decoded segment that contains a slash', async () => {
    backend(() => Response.json({}));
    const response = await GET(
      request('api/v1/admin/x', { cookies: 'wt_access=a; wt_refresh=r' }),
      {
        params: Promise.resolve({ path: ['api', 'v1', 'admin', 'a/b'] }),
      },
    );
    expect(response.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it.each([
    'api/v1/me',
    'api/v1/admin/devices',
    'api/v1/admin/employees/import/template',
    'api/v1/employees/team',
    'api/v1/branches',
    'api/v1/shifts',
    'api/v1/files/eyJhbGciOi.eyJzdWIi-_x.sig-nature_1',
  ])('allows %s', async (path) => {
    backend(() => Response.json({}));
    const response = await GET(request(path, { cookies: 'wt_access=a; wt_refresh=r' }), ctx(path));
    expect(response.status).toBe(200);
  });

  it('rejects cross-origin writes before any backend call', async () => {
    backend(() => Response.json({}));
    const path = 'api/v1/admin/employees';
    const crossOrigin: Record<string, string>[] = [
      { origin: 'http://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      {},
    ];
    for (const headers of crossOrigin) {
      const response = await POST(
        request(path, {
          method: 'POST',
          cookies: 'wt_access=a; wt_refresh=r',
          headers,
          body: '{}',
        }),
        ctx(path),
      );
      expect(response.status).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });

  it('accepts same-origin writes (Sec-Fetch-Site or Origin) and forwards the body and key', async () => {
    backend(() => Response.json({ id: 7 }));
    const path = 'api/v1/admin/devices/7';
    const cookies = 'wt_access=a; wt_refresh=r';
    const viaFetchMetadata = await PATCH(
      request(path, {
        method: 'PATCH',
        cookies,
        headers: { ...sameOrigin, 'content-type': 'application/json', 'idempotency-key': 'k1' },
        body: '{"action":"approve"}',
      }),
      ctx(path),
    );
    const viaOrigin = await PATCH(
      request(path, {
        method: 'PATCH',
        cookies,
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: '{"action":"reject"}',
      }),
      ctx(path),
    );
    expect([viaFetchMetadata.status, viaOrigin.status]).toEqual([200, 200]);
    expect(sent[0].method).toBe('PATCH');
    expect(new TextDecoder().decode(sent[0].body as ArrayBuffer)).toBe('{"action":"approve"}');
    expect(sent[0].headers.get('idempotency-key')).toBe('k1');
  });

  it('passes multipart uploads through byte for byte', async () => {
    backend(() => Response.json({ total_rows: 1 }));
    const form = new FormData();
    form.append(
      'file',
      new File(['emp_code,name\nE1,Asha\n'], 'employees.csv', { type: 'text/csv' }),
    );
    const incoming = new Request('http://x.test', { method: 'POST', body: form });
    const contentType = incoming.headers.get('content-type') as string;
    const bytes = new Uint8Array(await incoming.arrayBuffer());
    const path = 'api/v1/admin/employees/import';
    const response = await POST(
      request(`${path}?dry_run=true`, {
        method: 'POST',
        cookies: 'wt_access=a; wt_refresh=r',
        headers: { ...sameOrigin, 'content-type': contentType },
        body: bytes,
      }),
      ctx(path),
    );
    expect(response.status).toBe(200);
    expect(sent[0].url).toBe(`${API}/api/v1/admin/employees/import?dry_run=true`);
    expect(sent[0].headers.get('content-type')).toBe(contentType);
    expect(new Uint8Array(sent[0].body as ArrayBuffer)).toEqual(bytes);
  });

  it('relays errors and file downloads unchanged', async () => {
    backend((call) =>
      call.url.includes('template')
        ? new Response('emp_code\n', {
            headers: {
              'content-type': 'text/csv',
              'content-disposition': 'attachment; filename="employees-template.csv"',
            },
          })
        : Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const cookies = 'wt_access=a; wt_refresh=r';
    const denied = await GET(
      request('api/v1/admin/devices', { cookies }),
      ctx('api/v1/admin/devices'),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe('FORBIDDEN');
    const template = 'api/v1/admin/employees/import/template';
    const file = await GET(request(template, { cookies }), ctx(template));
    expect(file.headers.get('content-disposition')).toContain('employees-template.csv');
    expect(await file.text()).toBe('emp_code\n');
  });
});
