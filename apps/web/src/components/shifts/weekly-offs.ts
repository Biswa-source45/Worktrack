import type { TFunction } from 'i18next';
import type { Schemas } from '@/lib/api-client';
import i18n from '@/lib/i18n';

type WeeklyOff = Schemas['WeeklyOff'];

// API weekday: 0 = Monday .. 6 = Sunday. Weeks: the 1st..5th occurrence of that weekday in a month.
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export const WEEKS = [1, 2, 3, 4, 5] as const;

/** One row of the weekly-off editor: a weekday that is worked, off every week, or off on some weeks. */
export type OffRow = { mode: 'work' | 'every' | 'weeks'; weeks: boolean[] };

export function toOffRows(offs: WeeklyOff[]): OffRow[] {
  return WEEKDAYS.map((weekday) => {
    const off = offs.find((o) => o.weekday === weekday);
    return {
      mode: !off ? 'work' : off.weeks ? 'weeks' : 'every',
      weeks: WEEKS.map((week) => off?.weeks?.includes(week) ?? false),
    };
  });
}

export function toWeeklyOffs(rows: OffRow[]): WeeklyOff[] {
  return rows.flatMap((row, weekday) =>
    row.mode === 'work'
      ? []
      : [
          {
            weekday,
            weeks: row.mode === 'every' ? null : WEEKS.filter((week) => row.weeks[week - 1]),
          },
        ],
  );
}

/** Weekly offs in words: whole days first, e.g. "Sunday; 2nd and 4th Saturday". */
export function weeklyOffWords(t: TFunction, offs: WeeklyOff[]): string {
  if (offs.length === 0) return t('shifts.offs.none');
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' });
  return [...offs]
    .sort((a, b) => Number(!!a.weeks) - Number(!!b.weeks) || a.weekday - b.weekday)
    .map((off) =>
      off.weeks
        ? t('shifts.offs.some', {
            weeks: list.format(off.weeks.map((week) => t(`ordinal.${week}`))),
            day: t(`weekday.${off.weekday}`),
          })
        : t(`weekday.${off.weekday}`),
    )
    .join('; ');
}
