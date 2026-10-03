import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { ApiError, errorMessage, toApiError, unwrap } from './api-client';
import { formatIst, todayIst } from './ist';

const t = i18n.t.bind(i18n) as TFunction;

describe('errorMessage', () => {
  it.each([
    ['INVALID_CREDENTIALS', null, 'Invalid employee ID or password.'],
    ['RATE_LIMITED', { retry_after_seconds: 61 }, 'Too many attempts. Try again in 2 minute(s).'],
    ['ACCOUNT_LOCKED', { retry_after_seconds: 5 }, 'Try again in 1 minute(s)'],
    ['PASSWORD_CHANGE_REQUIRED', null, 'Change your password to continue.'],
    ['DUPLICATE', { fields: ['mobile'] }, 'already in use'],
    ['HAS_REPORTS', null, 'active reports'],
    ['LAST_SUPER_ADMIN', null, 'at least one active Super Admin'],
    ['MANAGER_CYCLE', null, 'cannot report to themselves'],
    ['IN_USE', null, 'still in use'],
    ['FORBIDDEN', null, 'do not have permission'],
    ['VALIDATION_ERROR', null, 'not valid'],
    ['SOMETHING_NEW', null, 'Something went wrong'],
  ])('maps %s', (code, details, text) => {
    expect(errorMessage(t, new ApiError(400, code, details))).toContain(text);
  });

  it('falls back to a network or generic message for other errors', () => {
    expect(errorMessage(t, new TypeError('Failed to fetch'))).toContain(
      'Could not reach the server',
    );
    expect(errorMessage(t, new Error('boom'))).toContain('Something went wrong');
  });
});

describe('unwrap', () => {
  it('returns data on success and throws a typed error otherwise', async () => {
    const ok = { data: { a: 1 }, response: new Response(null, { status: 200 }) };
    await expect(unwrap(Promise.resolve(ok))).resolves.toEqual({ a: 1 });
    const bad = {
      error: { error: { code: 'FORBIDDEN', details: null } },
      response: new Response(null, { status: 403 }),
    };
    await expect(unwrap(Promise.resolve(bad))).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(toApiError(500, 'not json')).toMatchObject({ status: 500, code: 'HTTP_500' });
  });
});

describe('IST formatting', () => {
  it('shows UTC server times in Asia/Kolkata', () => {
    expect(formatIst('2026-01-15T04:30:00Z')).toMatch(/15 Jan 2026.*10:00/i);
    expect(formatIst('2026-01-15T20:00:00Z')).toMatch(/16 Jan 2026.*1:30/i);
  });

  it('gives today as an ISO date', () => {
    expect(todayIst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
