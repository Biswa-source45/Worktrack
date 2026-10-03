import createClient from 'openapi-fetch';
import type { paths } from 'api-types';

type ApiOptions = { baseUrl: string; appEnv?: string; fetch?: typeof globalThis.fetch };

// The ngrok interstitial header is a dev-tunnel workaround; only sent when EXPO_PUBLIC_APP_ENV=development.
export function createApiClient({ baseUrl, appEnv, fetch }: ApiOptions) {
  return createClient<paths>({
    baseUrl,
    fetch,
    headers: appEnv === 'development' ? { 'ngrok-skip-browser-warning': 'true' } : undefined,
  });
}

// EXPO_PUBLIC_* must be referenced literally so Metro inlines them into the bundle.
export const api = createApiClient({
  baseUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
});
