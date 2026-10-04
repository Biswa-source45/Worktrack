import { formatIst, formatIstDate } from './ist';

describe('IST formatting', () => {
  it('shows a UTC time in IST, day first, with a 12-hour clock', () => {
    expect(formatIst('2026-10-04T09:12:00Z')).toBe('4 Oct 2026, 2:42 pm');
  });

  it('moves to the next day when IST is already past midnight', () => {
    expect(formatIst('2026-10-04T19:00:00Z')).toBe('5 Oct 2026, 12:30 am');
  });

  it('respects an explicit offset in the server time', () => {
    expect(formatIst('2026-10-04T14:42:00+05:30')).toBe('4 Oct 2026, 2:42 pm');
  });

  it('shows a plain date without a time', () => {
    expect(formatIstDate('2026-01-15')).toBe('15 Jan 2026');
  });
});
