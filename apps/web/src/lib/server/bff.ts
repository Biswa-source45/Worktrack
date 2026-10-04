import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, apiUrl, cookieOptions } from './config';

export type Tokens = {
  access_token: string;
  refresh_token: string;
  must_change_password: boolean;
};

export function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message, details: null } }, { status });
}

export const backendUnavailable = () =>
  errorResponse(502, 'UPSTREAM_UNAVAILABLE', 'The server could not be reached.');

// CSRF defence for cookie-authenticated writes: SameSite=Strict plus an explicit same-origin check.
export function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = request.headers.get('origin');
  try {
    return origin !== null && new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

export function setTokens(response: NextResponse, tokens: Tokens) {
  response.cookies.set(ACCESS_COOKIE, tokens.access_token, cookieOptions());
  response.cookies.set(REFRESH_COOKIE, tokens.refresh_token, cookieOptions());
  response.headers.set('cache-control', 'no-store');
}

export function clearTokens(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, '', cookieOptions(0));
  response.cookies.set(REFRESH_COOKIE, '', cookieOptions(0));
}

// The backend's per-IP login limit and its sessions list must see the real client (address and
// browser), not this server.
export function forwardedFor(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['x-forwarded-for', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function clientHeaders(request: NextRequest, token: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  for (const name of ['content-type', 'accept', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return { ...headers, ...forwardedFor(request) };
}

export function backendFetch(
  path: string,
  init: { method: string; headers: Record<string, string>; body?: BodyInit },
) {
  return fetch(`${apiUrl()}/api/v1/${path}`, { ...init, cache: 'no-store', redirect: 'manual' });
}

// Rotating refresh tokens are one-time: two parallel requests refreshing with the same token would
// look like token theft to the backend and end the whole login. Share one refresh per token, and
// keep the result briefly for requests the browser sent before it saw the new cookies.
// Limit: per-process map; a multi-instance deployment needs sticky sessions or a shared lock.
const refreshes = new Map<string, Promise<Tokens | null>>();
const REFRESH_SHARE_MS = 10_000;

async function refreshOnce(request: NextRequest, refreshToken: string): Promise<Tokens | null> {
  const response = await backendFetch('auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...forwardedFor(request) },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (response.ok) return (await response.json()) as Tokens;
  if (response.status >= 500) throw new Error(`Refresh failed with ${response.status}`);
  return null;
}

function refreshTokens(request: NextRequest, refreshToken: string) {
  let pending = refreshes.get(refreshToken);
  if (!pending) {
    pending = refreshOnce(request, refreshToken);
    refreshes.set(refreshToken, pending);
    setTimeout(() => refreshes.delete(refreshToken), REFRESH_SHARE_MS).unref();
    // A failed refresh (backend down) must not be remembered.
    pending.catch(() => refreshes.delete(refreshToken));
  }
  return pending;
}

export type Forwarded = {
  upstream: Response | null; // null: the session is gone
  refreshed: Tokens | null; // new tokens to put in cookies
};

// Calls the backend as the cookie's user. On 401 it refreshes exactly once and retries exactly once.
export async function forward(
  request: NextRequest,
  path: string,
  init: { method: string; body?: ArrayBuffer },
): Promise<Forwarded> {
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (access) {
    const upstream = await backendFetch(path, { ...init, headers: clientHeaders(request, access) });
    if (upstream.status !== 401) return { upstream, refreshed: null };
  }
  if (!refresh) return { upstream: null, refreshed: null };
  const tokens = await refreshTokens(request, refresh);
  if (!tokens) return { upstream: null, refreshed: null };
  const upstream = await backendFetch(path, {
    ...init,
    headers: clientHeaders(request, tokens.access_token),
  });
  return { upstream, refreshed: tokens };
}

// The session is gone (no or rejected refresh token): drop the cookies.
export function expired(): NextResponse {
  const response = errorResponse(
    401,
    'UNAUTHENTICATED',
    'Your session has expired. Sign in again.',
  );
  clearTokens(response);
  response.headers.set('cache-control', 'no-store');
  return response;
}

// Final response for a forwarded call: new cookies after a refresh.
export function finish(response: NextResponse, forwarded: Forwarded) {
  if (forwarded.refreshed) setTokens(response, forwarded.refreshed);
  response.headers.set('cache-control', 'no-store');
  return response;
}

export function toResponse(upstream: Response, body: ArrayBuffer) {
  const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  const headers = new Headers();
  for (const name of ['content-type', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(noBody ? null : body, { status: upstream.status, headers });
}
