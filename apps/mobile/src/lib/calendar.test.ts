import { dayTitle, leadingBlanks, monthLimits, monthOf, monthTitle, shiftMonth } from './calendar';

describe('calendar months', () => {
  it('moves across a year end in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(shiftMonth('2026-10', -12)).toBe('2025-10');
  });

  it('can be browsed from twelve months ago to this month, no further', () => {
    expect(monthLimits('2026-10-05')).toEqual({ earliest: '2025-10', latest: '2026-10' });
    expect(monthOf('2026-10-05')).toBe('2026-10');
  });

  it('counts the blank cells before the 1st with Monday as the first column', () => {
    expect(leadingBlanks('2026-06')).toBe(0); // 1 June 2026 is a Monday
    expect(leadingBlanks('2026-03')).toBe(6); // 1 March 2026 is a Sunday
    expect(leadingBlanks('2026-10')).toBe(3); // 1 October 2026 is a Thursday
  });

  it('names a month and a day', () => {
    expect(monthTitle('2026-03')).toBe('March 2026');
    expect(dayTitle('2026-03-12')).toBe('12 March');
  });
});
