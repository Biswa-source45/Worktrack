import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { ThemeProvider } from '@/components/theme/theme-provider';
import '@/lib/i18n';

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <ThemeProvider>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </ThemeProvider>,
    ),
  };
}

export type Call = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: string | FormData | null;
};
type Handler = (call: Call) => unknown;

const PREFIX = '/api/proxy/api/v1';

/**
 * Routes the stubbed global fetch by "METHOD /path". Paths not starting with /api are
 * relative to the proxied API (/api/proxy/api/v1). A handler returns a Response, or any JSON value.
 * Every call is recorded in the returned array.
 */
export function mockApi(routes: Record<string, Handler | unknown>) {
  const calls: Call[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), 'http://localhost:3000');
    const method = (request?.method ?? init?.method ?? 'GET').toUpperCase();
    let body: Call['body'] = null;
    if (request) body = (await request.clone().text()) || null;
    else if (init?.body instanceof FormData) body = init.body;
    else if (typeof init?.body === 'string') body = init.body;
    const call = { method, path: url.pathname, search: url.searchParams, body };
    calls.push(call);

    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (p.startsWith('/api/') ? p : `${PREFIX}${p}`) === url.pathname;
    });
    if (!key) throw new Error(`Unmocked request: ${method} ${url.pathname}${url.search}`);
    const route = routes[key];
    const result = typeof route === 'function' ? await (route as Handler)(call) : route;
    return result instanceof Response ? result : Response.json(result);
  });
  return calls;
}

export const apiError = (status: number, code: string, details: unknown = null) =>
  Response.json({ error: { code, message: code, details } }, { status });

export const jsonBody = (call: Call) => JSON.parse(call.body as string) as Record<string, unknown>;
