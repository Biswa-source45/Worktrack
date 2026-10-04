import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { ApiError, errorMessage, rejectedFields, toApiError, unwrap } from './api-client';
import { changed, isIntBetween, latitude, longitude, optionalRadius, radius } from './form';
import { formatDate, formatIst, todayIst, weekdayOf } from './ist';

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

describe('errorMessage with a scope', () => {
  it('prefers the message of the screen over the general one', () => {
    const duplicate = new ApiError(409, 'DUPLICATE', null);
    expect(errorMessage(t, duplicate, 'branches')).toBe('A branch with that name already exists.');
    expect(errorMessage(t, duplicate, 'holidays')).toContain('already a holiday on that date');
    expect(errorMessage(t, duplicate)).toContain('employee code');
  });

  it('falls back to the general message, then to the generic one', () => {
    expect(errorMessage(t, new ApiError(403, 'FORBIDDEN', null), 'branches')).toContain(
      'do not have permission',
    );
    expect(errorMessage(t, new ApiError(400, 'SOMETHING_NEW', null), 'branches')).toContain(
      'Something went wrong',
    );
  });
});

describe('rejectedFields', () => {
  it('names the body fields of a validation error', () => {
    const error = new ApiError(422, 'VALIDATION_ERROR', [
      { loc: ['body', 'radius_m'], message: 'too big', type: 'less_than_equal' },
      { loc: ['body', 'weekly_offs', 0, 'weeks'], message: 'bad', type: 'value_error' },
      { loc: ['body'], message: 'whole body', type: 'value_error' },
    ]);
    expect(rejectedFields(error)).toEqual(['radius_m', 'weekly_offs']);
  });

  it('is empty for anything else', () => {
    expect(rejectedFields(new ApiError(409, 'DUPLICATE', { fields: ['name'] }))).toEqual([]);
    expect(rejectedFields(new ApiError(422, 'VALIDATION_ERROR', null))).toEqual([]);
    expect(rejectedFields(new TypeError('Failed to fetch'))).toEqual([]);
  });
});

describe('form helpers', () => {
  it('changed keeps only the fields that differ', () => {
    const before = {
      name: 'A',
      radius_m: 100,
      offs: [{ weekday: 6, weeks: null as number[] | null }],
    };
    expect(changed({ ...before }, before)).toEqual({});
    expect(
      changed({ name: 'B', radius_m: 100, offs: [{ weekday: 6, weeks: [1] }] }, before),
    ).toEqual({ name: 'B', offs: [{ weekday: 6, weeks: [1] }] });
    expect(changed({ address: null as string | null }, { address: 'x' })).toEqual({
      address: null,
    });
  });

  it.each([
    ['30', true],
    ['500', true],
    [' 120 ', true],
    ['29', false],
    ['501', false],
    ['99.5', false],
    ['', false],
    ['abc', false],
  ])('radius %j -> %s', (value, ok) => {
    expect(radius.safeParse(value).success).toBe(ok);
  });

  it('an optional radius may be empty, but not out of range', () => {
    expect(optionalRadius.safeParse('').success).toBe(true);
    expect(optionalRadius.safeParse('29').success).toBe(false);
  });

  it('checks latitude and longitude ranges', () => {
    expect(latitude.safeParse('-90').success).toBe(true);
    expect(latitude.safeParse('90.01').success).toBe(false);
    expect(latitude.safeParse('').success).toBe(false);
    expect(longitude.safeParse('180').success).toBe(true);
    expect(longitude.safeParse('-180.5').success).toBe(false);
  });

  it('isIntBetween includes both ends', () => {
    const grace = isIntBetween(0, 120);
    expect([grace('0'), grace('120'), grace('121'), grace('-1'), grace('1.5')]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('calendar dates', () => {
  it('formats a date without shifting it across time zones', () => {
    expect(formatDate('2026-03-01')).toBe('1 Mar 2026');
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('counts weekdays from Monday = 0, like the API', () => {
    expect(weekdayOf('2026-03-02')).toBe(0);
    expect(weekdayOf('2026-03-07')).toBe(5);
    expect(weekdayOf('2026-03-08')).toBe(6);
  });
});
