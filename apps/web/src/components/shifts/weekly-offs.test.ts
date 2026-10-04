import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { toOffRows, toWeeklyOffs, weeklyOffWords } from './weekly-offs';

const t = i18n.t.bind(i18n) as TFunction;

describe('weeklyOffWords', () => {
  it.each([
    [[], 'No weekly off'],
    [[{ weekday: 6, weeks: null }], 'Sunday'],
    [
      [
        { weekday: 5, weeks: [2, 4] },
        { weekday: 6, weeks: null },
      ],
      'Sunday; 2nd and 4th Saturday',
    ],
    [
      [
        { weekday: 6, weeks: null },
        { weekday: 5, weeks: null },
      ],
      'Saturday; Sunday',
    ],
    [[{ weekday: 0, weeks: [1] }], '1st Monday'],
    [[{ weekday: 4, weeks: [1, 3, 5] }], '1st, 3rd, and 5th Friday'],
    // The API may leave `weeks` out for "every week".
    [[{ weekday: 2 }], 'Wednesday'],
  ])('%j', (offs, words) => {
    expect(weeklyOffWords(t, offs)).toBe(words);
  });
});

describe('weekly-off editor rows', () => {
  const offs = [
    { weekday: 5, weeks: [2, 4] },
    { weekday: 6, weeks: null },
  ];

  it('gives one row per weekday, Monday first', () => {
    const rows = toOffRows(offs);
    expect(rows.map((row) => row.mode)).toEqual([
      'work',
      'work',
      'work',
      'work',
      'work',
      'weeks',
      'every',
    ]);
    expect(rows[5].weeks).toEqual([false, true, false, true, false]);
  });

  it('maps the rows back to the API shape', () => {
    expect(toWeeklyOffs(toOffRows(offs))).toEqual(offs);
    expect(toWeeklyOffs(toOffRows([]))).toEqual([]);
  });

  it('forgets ticked weeks once the day is off every week or worked', () => {
    const rows = toOffRows(offs);
    rows[5].mode = 'every';
    rows[6].mode = 'work';
    expect(toWeeklyOffs(rows)).toEqual([{ weekday: 5, weeks: null }]);
  });
});
