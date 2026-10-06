import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { components } from 'api-types';
import AttendanceScreen from '@/app/(app)/attendance';
import { calls, failure, mockApi } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';

// The screen reads its month on each return to it; that hook needs a navigator (see home.test.tsx).
jest.mock('@/lib/use-refetch-on-focus', () => ({ useRefetchOnFocus: jest.fn() }));

type Day = components['schemas']['MonthDay'];
type Month = components['schemas']['MonthOut'];

const ME_MONTH = 'GET /api/v1/attendance/me';
const TODAY = '2026-10-05';

/** A month as the server reports it; `byDate` gives the days that have an outcome. */
function monthBody(month: string, byDate: Record<string, Partial<Day>> = {}): Month {
  const [year, number] = month.split('-').map(Number);
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const days: Day[] = Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    return {
      date,
      kind: 'office',
      reason: 'shift',
      status: null,
      first_in_at: null,
      last_out_at: null,
      worked_minutes: 0,
      late_minutes: 0,
      flags: [],
      ...byDate[date],
    };
  });
  return {
    month,
    today: TODAY,
    days,
    summary: {
      present: 2,
      half_day: 1,
      short_hours: 0,
      absent: 1,
      late: 1,
      missed_punch_out: 0,
      worked_minutes: 1_575,
    },
  };
}

const OCTOBER = {
  '2026-10-01': { status: 'present', worked_minutes: 540 },
  '2026-10-02': { status: 'absent' },
  '2026-10-03': { status: 'weekly_off', kind: 'off', reason: 'weekly_off' },
  '2026-10-04': { status: 'holiday', kind: 'off', reason: 'holiday' },
  '2026-10-05': {
    status: 'present',
    first_in_at: '2026-10-05T03:50:00Z',
    last_out_at: '2026-10-05T12:30:00Z',
    worked_minutes: 525,
    late_minutes: 20,
    flags: ['offline', 'face_review', 'jump'],
  },
} satisfies Record<string, Partial<Day>>;

const requested = () =>
  calls.filter((call) => call.url.includes('/attendance/me')).map((call) => new URL(call.url));
const cell = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  jest.clearAllMocks();
  // 10:30 IST on 5 October 2026.
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-05T05:00:00Z'));
});
afterEach(() => jest.restoreAllMocks());

describe('AttendanceScreen', () => {
  it('shows this month as a calendar with a marker of icon, short label and colour on each day', async () => {
    mockApi({ [ME_MONTH]: () => Response.json(monthBody('2026-10', OCTOBER)) });
    await renderWithTheme(<AttendanceScreen />);

    expect(await screen.findByRole('header', { name: 'October 2026' })).toBeOnTheScreen();
    expect(requested()[0].searchParams.get('month')).toBe('2026-10');
    // Own data only: nothing but the month goes to the server.
    expect([...requested()[0].searchParams.keys()]).toEqual(['month']);
    expect(screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)).toHaveLength(7);
    expect(cell('1 October, Present')).toBeOnTheScreen();
    expect(cell('2 October, Absent')).toBeOnTheScreen();
    expect(cell('3 October, Weekly off')).toBeOnTheScreen();
    expect(cell('4 October, Holiday')).toBeOnTheScreen();
    expect(within(cell('2 October, Absent')).getByText('Abs')).toBeOnTheScreen();
    expect(within(cell('4 October, Holiday')).getByText('Hol')).toBeOnTheScreen();
    // A day without an outcome yet has no marker.
    expect(cell('20 October, No record')).toBeOnTheScreen();
    expect(within(cell('20 October, No record')).queryByText('Pres')).toBeNull();
  });

  it('shows a skeleton while the month loads', async () => {
    let release: (response: Response) => void = () => undefined;
    mockApi({ [ME_MONTH]: () => new Promise<Response>((resolve) => (release = resolve)) });
    await renderWithTheme(<AttendanceScreen />);
    expect(screen.getByRole('progressbar', { name: 'Loading...' })).toBeOnTheScreen();
    release(Response.json(monthBody('2026-10', OCTOBER)));
    expect(await screen.findByRole('header', { name: 'This month' })).toBeOnTheScreen();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('explains every marker in a legend', async () => {
    mockApi({ [ME_MONTH]: () => Response.json(monthBody('2026-10', OCTOBER)) });
    await renderWithTheme(<AttendanceScreen />);
    await screen.findByRole('header', { name: 'Legend' });
    for (const label of [
      'Present',
      'Half day',
      'Short hours',
      'Absent',
      'Missed punch out',
      'Work from home',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows the totals of the month', async () => {
    mockApi({ [ME_MONTH]: () => Response.json(monthBody('2026-10', OCTOBER)) });
    await renderWithTheme(<AttendanceScreen />);
    const summary = await screen.findByTestId('month-summary');
    for (const text of [
      'Present: 2',
      'Half day: 1',
      'Short hours: 0',
      'Absent: 1',
      'Late: 1',
      'Worked: 26 h 15 min',
    ]) {
      expect(within(summary).getByLabelText(text)).toBeOnTheScreen();
    }
  });

  it('opens on today, with the times in IST, the hours, the late minutes and the notes', async () => {
    mockApi({ [ME_MONTH]: () => Response.json(monthBody('2026-10', OCTOBER)) });
    await renderWithTheme(<AttendanceScreen />);
    const detail = await screen.findByTestId('day-detail');
    expect(within(detail).getByRole('header', { name: 'Mon, 5 Oct' })).toBeOnTheScreen();
    expect(within(detail).getByText('Present')).toBeOnTheScreen();
    expect(within(detail).getByText('In: 9:20 am')).toBeOnTheScreen();
    expect(within(detail).getByText('Out: 6:00 pm')).toBeOnTheScreen();
    expect(within(detail).getByText('Hours worked: 8 h 45 min')).toBeOnTheScreen();
    expect(within(detail).getByText('Late by 20 min')).toBeOnTheScreen();
    expect(within(detail).getByText('Sent offline')).toBeOnTheScreen();
    // Two internal flags read the same to the employee, and are listed once.
    expect(within(detail).getAllByText('Under review')).toHaveLength(1);
    expect(cell('5 October, Present').props.accessibilityState.selected).toBe(true);
  });

  it('shows another day when it is chosen', async () => {
    mockApi({ [ME_MONTH]: () => Response.json(monthBody('2026-10', OCTOBER)) });
    await renderWithTheme(<AttendanceScreen />);
    await screen.findByTestId('day-detail');
    await fireEvent.press(cell('4 October, Holiday'));

    const detail = screen.getByTestId('day-detail');
    expect(within(detail).getByRole('header', { name: 'Sun, 4 Oct' })).toBeOnTheScreen();
    expect(within(detail).getByText('Holiday')).toBeOnTheScreen();
    expect(within(detail).getByText('No punches')).toBeOnTheScreen();
    expect(cell('4 October, Holiday').props.accessibilityState.selected).toBe(true);
    expect(cell('5 October, Present').props.accessibilityState.selected).toBe(false);
  });

  it('shows a status it does not know as no record, never as a guess', async () => {
    mockApi({
      [ME_MONTH]: () =>
        Response.json(monthBody('2026-10', { '2026-10-05': { status: 'on_moon' } })),
    });
    await renderWithTheme(<AttendanceScreen />);
    expect(await screen.findByRole('button', { name: '5 October, No record' })).toBeOnTheScreen();
    expect(within(screen.getByTestId('day-detail')).getByText('No record')).toBeOnTheScreen();
  });

  it('says so when the month has no records', async () => {
    mockApi({ [ME_MONTH]: () => Response.json(monthBody('2026-10')) });
    await renderWithTheme(<AttendanceScreen />);
    expect(await screen.findByText('No attendance recorded this month.')).toBeOnTheScreen();
    expect(screen.queryByTestId('month-summary')).toBeNull();
  });

  it('says why it failed, with Retry', async () => {
    let up = false;
    mockApi({
      [ME_MONTH]: () =>
        up ? Response.json(monthBody('2026-10', OCTOBER)) : failure(500, 'INTERNAL', 'Down.'),
    });
    await renderWithTheme(<AttendanceScreen />);
    expect(await screen.findByText('Could not load your attendance.')).toBeOnTheScreen();
    up = true;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('header', { name: 'This month' })).toBeOnTheScreen();
  });
});

describe('month navigation', () => {
  const answer = (request: Request) =>
    Response.json(monthBody(new URL(request.url).searchParams.get('month') ?? '2026-10'));

  it('goes back a month and forward again, and cannot go past this month', async () => {
    mockApi({ [ME_MONTH]: answer });
    await renderWithTheme(<AttendanceScreen />);
    await screen.findByRole('header', { name: 'October 2026' });
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByRole('header', { name: 'September 2026' })).toBeOnTheScreen();
    expect(requested().at(-1)?.searchParams.get('month')).toBe('2026-09');
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('header', { name: 'October 2026' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('stops twelve months back', async () => {
    mockApi({ [ME_MONTH]: answer });
    await renderWithTheme(<AttendanceScreen />);
    await screen.findByRole('header', { name: 'October 2026' });
    for (let step = 0; step < 12; step++) {
      await fireEvent.press(screen.getByRole('button', { name: 'Previous month' }));
    }
    expect(await screen.findByRole('header', { name: 'October 2025' })).toBeOnTheScreen();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled(),
    );
  });
});
