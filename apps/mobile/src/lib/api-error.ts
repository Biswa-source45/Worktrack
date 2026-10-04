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
