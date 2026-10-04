// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

const at = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

describe('route protection', () => {
  it('redirects to /login without a session cookie', () => {
    const response = proxy(at('/employees'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('lets a request with a session cookie through', () => {
    const response = proxy(at('/employees', 'wt_refresh=r'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not run for /login, the API routes, Next internals or static files', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const path of [
      '/login',
      '/api/auth/login',
      '/api/proxy/api/v1/me',
      '/_next/static/a.js',
      '/favicon.ico',
    ]) {
      expect(pattern.test(path)).toBe(false);
    }
    for (const path of ['/', '/employees', '/devices', '/change-password']) {
      expect(pattern.test(path)).toBe(true);
    }
  });
});
