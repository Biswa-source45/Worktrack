import {
  clockOffset,
  formatIst,
  formatIstClock,
  formatIstDate,
  formatIstDay,
  formatIstTime,
  istDay,
} from './ist';

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

  it('shows a plain date with its weekday', () => {
    expect(formatIstDay('2026-10-05')).toBe('Mon, 5 Oct');
  });

  it('gives the IST calendar day, which is ahead of UTC in the evening', () => {
    jest.useFakeTimers({ now: new Date('2026-10-04T19:00:00Z') });
    expect(istDay()).toBe('2026-10-05');
    expect(istDay(6)).toBe('2026-10-11');
    jest.useRealTimers();
  });
});

describe('IST clock', () => {
  it('shows a time without the date, and a ticking clock with seconds', () => {
    expect(formatIstTime('2026-10-04T09:12:00Z')).toBe('2:42 pm');
    expect(formatIstClock(Date.parse('2026-10-04T09:12:07Z'))).toBe('2:42:07 pm');
  });

  it('finds how far the server is ahead of the phone, and back again', () => {
    // The phone is 90 seconds slow: the server answered 12:00:00 while the phone read 11:58:30.
    const offset = clockOffset('2026-10-04T12:00:00Z', Date.parse('2026-10-04T11:58:30Z'));
    expect(offset).toBe(90_000);
    expect(formatIstClock(Date.parse('2026-10-04T11:58:40Z') + offset)).toBe('5:30:10 pm');
  });

  it('is negative when the phone is ahead of the server', () => {
    expect(clockOffset('2026-10-04T12:00:00Z', Date.parse('2026-10-04T12:05:00Z'))).toBe(-300_000);
  });
});
