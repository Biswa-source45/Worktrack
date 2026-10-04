import createClient from 'openapi-fetch';
import type { components, paths } from 'api-types';
import type { TFunction } from 'i18next';
import i18n from '@/lib/i18n';

export type Schemas = components['schemas'];

let client: ReturnType<typeof createClient<paths>> | undefined;

// Browser calls go to the Next.js proxy, which attaches the session cookie's token server-side.
// Created lazily because the base URL needs window.location (this module is also imported by SSR).
export function proxyApi() {
  client ??= createClient<paths>({ baseUrl: `${window.location.origin}/api/proxy` });
  return client;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(code);
  }
}

type ErrorBody = { error?: { code?: unknown; details?: unknown } } | null;

export function toApiError(status: number, body: unknown): ApiError {
  const error = (body as ErrorBody)?.error;
  const code = typeof error?.code === 'string' ? error.code : `HTTP_${status}`;
  return new ApiError(status, code, error?.details);
}

export async function unwrap<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await result;
  if (!response.ok) throw toApiError(response.status, error);
  return data as T;
}

/** POST to one of the Next.js auth routes (login, change-password). */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, data);
  return data as T;
}

function retryAfterSeconds(details: unknown): number {
  const seconds = (details as { retry_after_seconds?: unknown } | null)?.retry_after_seconds;
  return typeof seconds === 'number' ? seconds : 60;
}

export function errorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiError && i18n.exists(`errors.${error.code}`)) {
    const fields = (error.details as { fields?: unknown } | null)?.fields;
    return t(`errors.${error.code}`, {
      minutes: Math.max(1, Math.ceil(retryAfterSeconds(error.details) / 60)),
      fields: Array.isArray(fields) ? fields.join(', ') : '',
    });
  }
  return error instanceof TypeError ? t('errors.NETWORK') : t('errors.GENERIC');
}
