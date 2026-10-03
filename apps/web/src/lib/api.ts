import createClient from 'openapi-fetch';
import type { paths } from 'api-types';

type ApiOptions = { baseUrl: string; appEnv?: string; fetch?: typeof globalThis.fetch };

// The ngrok interstitial header is a dev-tunnel workaround; only sent when NEXT_PUBLIC_APP_ENV=development.
export function createApiClient({ baseUrl, appEnv, fetch }: ApiOptions) {
  return createClient<paths>({
    baseUrl,
    fetch,
    headers: appEnv === 'development' ? { 'ngrok-skip-browser-warning': 'true' } : undefined,
  });
}

// NEXT_PUBLIC_* must be referenced literally so Next inlines them into the client bundle.
export const api = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000',
  appEnv: process.env.NEXT_PUBLIC_APP_ENV,
});
