import createClient from 'openapi-fetch';
import type { paths } from 'api-types';
import { clearTokens, getTokens, setTokens } from './token-store';

type Fetch = typeof globalThis.fetch;
type ApiOptions = { baseUrl: string; appEnv?: string; fetch?: Fetch };

// The ngrok interstitial header is a dev-tunnel workaround; only sent when EXPO_PUBLIC_APP_ENV=development.
export function createApiClient({ baseUrl, appEnv, fetch }: ApiOptions) {
  return createClient<paths>({
    baseUrl,
    fetch,
    headers: appEnv === 'development' ? { 'ngrok-skip-browser-warning': 'true' } : undefined,
  });
}

// These carry their own credentials (or none), so a 401 from them is an answer, not an expired token.
const UNAUTHENTICATED_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout'];

let onSessionExpired: () => void = () => undefined;
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

export function createRefresher(client: ReturnType<typeof createApiClient>) {
  let inflight: Promise<string | null> | null = null;

  async function refresh(): Promise<string | null> {
    const tokens = await getTokens();
    if (!tokens) return null;
    const { data, response } = await client.POST('/api/v1/auth/refresh', {
      body: { refresh_token: tokens.refresh },
    });
    if (data) {
      await setTokens({ access: data.access_token, refresh: data.refresh_token });
      return data.access_token;
    }
    if (response.status === 401) {
      await clearTokens();
      onSessionExpired();
      return null;
    }
    // Transient failure (429, 5xx): keep the tokens so the user can retry later.
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  // Single flight: the backend rotates refresh tokens and revokes the session when one is reused,
  // so concurrent 401s must share one refresh call.
  return () => (inflight ??= refresh().finally(() => (inflight = null)));
}

/** Adds the bearer token; on a 401 refreshes once (shared) and retries the request once. */
export function createAuthFetch(base: Fetch, refresh: () => Promise<string | null>): Fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (UNAUTHENTICATED_PATHS.some((path) => new URL(request.url).pathname.endsWith(path))) {
      return base(request);
    }
    const retry = request.clone();
    const sent = await getTokens();
    if (sent) request.headers.set('Authorization', `Bearer ${sent.access}`);
    const response = await base(request);
    if (response.status !== 401 || !sent) return response;

    // Another request may have refreshed while this one was in flight; then just use the new token.
    const current = await getTokens();
    if (!current) return response;
    let access: string | null = current.access;
    if (access === sent.access) {
      try {
        access = await refresh();
      } catch {
        // Transient refresh failure: surface the original 401; the tokens are still stored.
        return response;
      }
    }
    if (!access) return response;
    retry.headers.set('Authorization', `Bearer ${access}`);
    return base(retry);
  };
}

// EXPO_PUBLIC_* must be referenced literally so Metro inlines them into the bundle.
const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? '';
const appEnv = process.env.EXPO_PUBLIC_APP_ENV;
// Resolved at call time so tests can replace global fetch.
const rawFetch: Fetch = (input, init) => globalThis.fetch(input, init);

export const api = createApiClient({
  baseUrl,
  appEnv,
  fetch: createAuthFetch(
    rawFetch,
    createRefresher(createApiClient({ baseUrl, appEnv, fetch: rawFetch })),
  ),
});
