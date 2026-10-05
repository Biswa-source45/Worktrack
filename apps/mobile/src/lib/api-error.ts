import type { TFunction } from 'i18next';
import { z } from 'zod';

// The backend's standard error envelope is not part of the OpenAPI schema, so it is parsed here.
const envelope = z.object({
  error: z.object({ code: z.string(), details: z.unknown().optional() }),
});
const lockedDetails = z.object({ retry_after_seconds: z.number() });

/** Maps a server error body to a user-facing message. Never reveals which credential was wrong. */
export function apiErrorMessage(t: TFunction, body: unknown): string {
  const parsed = envelope.safeParse(body);
  if (!parsed.success) return t('errors.generic');
  const { code, details } = parsed.data.error;
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return t('errors.invalidCredentials');
    case 'INVALID_CURRENT_PASSWORD':
      return t('errors.invalidCurrentPassword');
    case 'RATE_LIMITED':
      return t('errors.rateLimited');
    case 'ACCOUNT_LOCKED': {
      const locked = lockedDetails.safeParse(details);
      return locked.success
        ? t('errors.accountLocked', {
            count: Math.max(1, Math.ceil(locked.data.retry_after_seconds / 60)),
          })
        : t('errors.accountLockedNoTime');
    }
    default:
      return t('errors.generic');
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** What the server attached to the error, such as the fields a 422 refused. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const serverError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** Resolves to the data of an api call; a failed call throws the server's own error. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (response.ok) return data as T;
  const parsed = serverError.safeParse(error);
  if (!parsed.success) throw new ApiError(response.status, `HTTP_${response.status}`, '');
  const { code, message, details } = parsed.data.error;
  throw new ApiError(response.status, code, message, details);
}

/** The server's message for a failed admin or session call (403, 409 and so on). */
export function errorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    // An answer that is not the server's own error format (a gateway page, a proxy limit) has no
    // message; the status still tells what happened.
    return error.message || t('errors.server', { status: error.status });
  }
  return error instanceof TypeError ? t('errors.network') : t('errors.generic');
}

/** A short technical line for a failure, to show under the message so it can be reported. */
export function errorDetail(error: unknown): string {
  if (error instanceof ApiError) return `${error.status} ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 160);
  return String(error).slice(0, 160);
}
