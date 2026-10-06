// Month arithmetic for the attendance calendar, on plain "YYYY-MM" and "YYYY-MM-DD" strings so
// no device time zone can shift a day.

/** How far back the history can be browsed. */
export const MONTHS_BACK = 12;

const pad = (n: number) => String(n).padStart(2, '0');

export const monthOf = (isoDay: string) => isoDay.slice(0, 7);

/** The month `delta` months from `month` ("2026-01", -1 gives "2025-12"). */
export function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/**
 * The months that can be shown: this month back to `MONTHS_BACK` months ago.
 * ponytail: the server does not tell the phone the joining date, so the floor is a fixed
 * twelve months; months before joining simply have no records. Use the joining month when
 * /me carries it.
 */
export const monthLimits = (today: string) => ({
  earliest: shiftMonth(monthOf(today), -MONTHS_BACK),
  latest: monthOf(today),
});

/** Monday = 0 ... Sunday = 6, for the first day of the month. */
export function leadingBlanks(month: string): number {
  const [year, number] = month.split('-').map(Number);
  return (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
}

/** "March 2026" */
export const monthTitle = (month: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

/** "12 March" (the spoken form for a day cell). */
export const dayTitle = (isoDay: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${isoDay}T00:00:00Z`),
  );
