import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { todayIst } from '@/lib/ist';
import {
  ATTENDANCE_ADMIN,
  BRANCHES,
  PEOPLE,
  makeDayDetail,
  makeMe,
  makeRegisterRow,
} from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { AttendancePage } from './attendance-page';

const present = makeRegisterRow();
const absent = makeRegisterRow({
  employee: PEOPLE.RAVI,
  status: 'absent',
  day_id: 82,
  branch: null,
  first_in_at: null,
  last_out_at: null,
  worked_minutes: 0,
});
const nobody = makeRegisterRow({
  employee: { id: 4, emp_code: 'EMP-003', name: 'Meena Das' },
  status: 'no_record',
  day_id: null,
  branch: null,
  first_in_at: null,
  last_out_at: null,
  worked_minutes: 0,
});
const flagged = makeRegisterRow({
  employee: { id: 5, emp_code: 'EMP-004', name: 'Kiran Pal' },
  day_id: 83,
  status: 'half_day',
  branch: null,
  late_minutes: 25,
  flags: ['offline', 'mock', 'face_review', 'jump'],
});

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ATTENDANCE_ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /branches': BRANCHES,
    'GET /admin/attendance': { items: [present, absent, nobody, flagged], next_cursor: null },
    'GET /admin/attendance/81': makeDayDetail(),
    'POST /admin/attendance/overrides': (call: Call) => ({
      employee: PEOPLE.RAVI,
      day: { ...makeDayDetail().day, status: jsonBody(call).kind },
    }),
    // The requests and reviews queries behind the tab counts.
    'GET /admin/punch-out-requests': { items: [], next_cursor: null },
    'GET /admin/punch-reviews': { items: [], next_cursor: null },
    ...routes,
  });
  renderWithClient(<AttendancePage />);
  return { calls, user: userEvent.setup() };
}

const registers = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.endsWith('/admin/attendance'));
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

async function table() {
  return within(await screen.findByRole('table'));
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
}

describe('Register tab', () => {
  it('asks for today in IST and shows each employee with status, branch and times', async () => {
    const { calls } = setup();
    const rows = await table();
    expect(await rows.findByText('Asha Rao')).toBeVisible();
    expect(registers(calls)[0].search.get('date')).toBe(todayIst());
    expect(registers(calls)[0].search.get('limit')).toBe('50');
    const asha = within(rows.getByText('Asha Rao').closest('tr') as HTMLElement);
    expect(asha.getByText('EMP-001')).toBeVisible();
    expect(asha.getByText('Present')).toBeVisible();
    expect(asha.getByText('Head Office')).toBeVisible();
    // The server sends UTC; the register shows IST.
    expect(asha.getByText(/09:35/)).toBeVisible();
    expect(asha.getByText(/06:10/)).toBeVisible();
    expect(asha.getByText('8h 35m')).toBeVisible();
  });

  it('gives every status its own icon and label, and says Home for a punch with no branch', async () => {
    setup();
    const rows = await table();
    await rows.findByText('Asha Rao');
    expect(rows.getByTestId('day-present')).toHaveTextContent('Present');
    expect(rows.getByTestId('day-half_day')).toHaveTextContent('Half day');
    expect(rows.getByTestId('day-absent')).toHaveTextContent('Absent');
    expect(rows.getByTestId('day-no_record')).toHaveTextContent('No record');
    for (const id of ['day-present', 'day-half_day', 'day-absent', 'day-no_record']) {
      expect(rows.getByTestId(id).querySelector('svg')).not.toBeNull();
    }
    const kiran = within(rows.getByText('Kiran Pal').closest('tr') as HTMLElement);
    expect(kiran.getByText('Home')).toBeVisible();
    // A day nobody punched shows dashes, not a time.
    const ravi = within(rows.getByText('Ravi Kumar').closest('tr') as HTMLElement);
    expect(ravi.getAllByText('-').length).toBeGreaterThanOrEqual(3);
  });

  it('shows flags as chips with accessible names', async () => {
    setup();
    const rows = await table();
    const kiran = within((await rows.findByText('Kiran Pal')).closest('tr') as HTMLElement);
    for (const name of [
      'Punched offline',
      'Mock location or untrusted device',
      'Face check needs review',
      'Impossible jump',
    ]) {
      expect(kiran.getByRole('img', { name })).toBeVisible();
    }
    expect(kiran.getByText('25')).toBeVisible();
  });

  it('marks a day that began with a field punch-in at a task site', async () => {
    setup({
      routes: {
        'GET /admin/attendance': {
          items: [{ ...present, flags: ['field_punch'] }],
          next_cursor: null,
        },
      },
    });
    const rows = await table();
    const asha = within((await rows.findByText('Asha Rao')).closest('tr') as HTMLElement);
    expect(asha.getByRole('img', { name: 'Field punch-in at a task site' })).toBeVisible();
  });

  it('sends the chosen filters, searching after a pause', async () => {
    const { calls, user } = setup();
    await screen.findByText('Asha Rao');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-01' } });
    await user.selectOptions(await screen.findByLabelText('Branch'), 'Warehouse');
    await user.selectOptions(screen.getByLabelText('Status'), 'No record');
    await user.type(screen.getByRole('textbox', { name: 'Search by name or code' }), 'asha');
    await waitFor(() => {
      const last = registers(calls).at(-1)?.search;
      expect(last?.get('date')).toBe('2026-02-01');
      expect(last?.get('branch_id')).toBe('2');
      expect(last?.get('status')).toBe('no_record');
      expect(last?.get('q')).toBe('asha');
    });
    // One request for the whole word, not one per key.
    expect(registers(calls).filter((c) => c.search.get('q') === 'a')).toHaveLength(0);
  });

  it('offers every status and "all branches" in the filters', async () => {
    setup();
    await screen.findByText('Asha Rao');
    const statuses = within(screen.getByLabelText('Status')).getAllByRole('option');
    expect(statuses.map((o) => o.textContent)).toEqual([
      'All statuses',
      'On the job',
      'Present',
      'Half day',
      'Short hours',
      'Absent',
      'Holiday',
      'Weekly off',
      'Pending',
      'Missed punch-out',
      'Leave',
      'Work from home',
      'On duty',
      'No record',
    ]);
    expect(within(await screen.findByLabelText('Branch')).getAllByRole('option')).toHaveLength(3);
  });

  it('loads the next page on request', async () => {
    const { calls, user } = setup({
      routes: {
        'GET /admin/attendance': (call: Call) =>
          call.search.get('cursor')
            ? { items: [absent], next_cursor: null }
            : { items: [present], next_cursor: 'c1' },
      },
    });
    await screen.findByText('Asha Rao');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Ravi Kumar')).toBeVisible();
    expect(registers(calls).at(-1)?.search.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says so when nobody matches', async () => {
    setup({ routes: { 'GET /admin/attendance': { items: [], next_cursor: null } } });
    expect(await screen.findByText('No employees match.')).toBeVisible();
  });

  it('shows the server error', async () => {
    setup({ routes: { 'GET /admin/attendance': () => apiError(403, 'FORBIDDEN') } });
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
  });
});

describe('Day details dialog', () => {
  it('shows each punch with its selfie through the proxy, the server verdict and both clocks', async () => {
    const { calls, user } = setup();
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    expect(await within(dialog).findByText(/recorded in the audit log/)).toBeVisible();
    const selfies = await within(dialog).findAllByRole('img');
    expect(selfies.map((img) => img.getAttribute('src'))).toEqual([
      '/api/proxy/api/v1/files/tok.in',
      '/api/proxy/api/v1/files/tok.out',
    ]);
    expect(selfies[0]).toHaveAccessibleName('Selfie of the Punch-in');
    expect(selfies[1]).toHaveAccessibleName('Selfie of the Punch-out');
    expect(within(dialog).getAllByText('Face verified')).toHaveLength(2);
    expect(within(dialog).getByText('score 0.71')).toBeVisible();
    expect(within(dialog).getAllByText(/Phone time \(not trusted\)/)).toHaveLength(2);
    expect(within(dialog).getAllByText('Head Office, 12 m from the centre')).toHaveLength(2);
    expect(calls.filter((c) => c.path.endsWith('/admin/attendance/81'))).toHaveLength(1);
  });

  it('lists the overrides of the day with their reasons', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/attendance/81': makeDayDetail({
          overrides: [
            {
              kind: 'on_duty',
              reason: 'Sent to the depot',
              created_by: 1,
              created_at: '2026-02-03T06:00:00Z',
            },
          ],
        }),
      },
    });
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    expect(await within(dialog).findByText(/Sent to the depot/)).toBeVisible();
    expect(within(dialog).getByText('On duty')).toBeVisible();
  });

  it('lists the tasks of the day after the punches, and a punch made at a task site', async () => {
    const detail = makeDayDetail();
    const { user } = setup({
      routes: {
        'GET /admin/attendance/81': makeDayDetail({
          punches: [
            { ...detail.punches[0], place: { type: 'task', task: 'T-00007', distance_m: 42 } },
          ],
          tasks: [
            {
              id: 7,
              code: 'T-00007',
              title: 'Collect the contract',
              status: 'completed',
              reached_at: '2026-02-03T05:10:00Z',
              completed_at: '2026-02-03T06:30:00Z',
            },
          ],
        }),
      },
    });
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    const tasks = await within(dialog).findByRole('region', { name: 'Tasks that day' });
    expect(
      within(tasks).getByRole('link', { name: /T-00007 Collect the contract/ }),
    ).toHaveAttribute('href', '/tasks/7');
    expect(within(tasks).getByTestId('task-status-completed')).toBeInTheDocument();
    expect(within(tasks).getByText(/Reached 10:40.*, Completed 12:00/i)).toBeVisible();
    expect(within(dialog).getByText('At the site of T-00007, 42 m from the pin')).toBeVisible();
  });

  it('has no Tasks section on a day without tasks', async () => {
    const { user } = setup();
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    await within(dialog).findByText(/recorded in the audit log/);
    expect(
      within(dialog).queryByRole('region', { name: 'Tasks that day' }),
    ).not.toBeInTheDocument();
  });

  it('shows review reasons, integrity flags and offline punches', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/attendance/81': makeDayDetail({
          punches: [
            {
              ...makeDayDetail().punches[0],
              offline: true,
              review_status: 'pending',
              review_reasons: ['face_borderline', 'offline'],
              face_decision: 'PENDING_REVIEW',
              integrity_flags: ['mock'],
            },
          ],
        }),
      },
    });
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    expect(await within(dialog).findByText('Face borderline, Punched offline')).toBeVisible();
    expect(within(dialog).getByText('Mock location app on')).toBeVisible();
    expect(within(dialog).getByText('Waiting for review')).toBeVisible();
  });

  it('says so when a selfie link does not work', async () => {
    const { user } = setup();
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    fireEvent.error((await within(dialog).findAllByRole('img'))[0]);
    expect(await within(dialog).findByText(/could not be loaded/)).toBeVisible();
  });

  it('explains why the day could not be opened', async () => {
    const { user } = setup({
      routes: { 'GET /admin/attendance/81': () => apiError(404, 'NOT_FOUND') },
    });
    await openMenu(user, 'Asha Rao');
    await user.click(await screen.findByRole('menuitem', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Attendance day' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This record no longer exists, or is outside your team.',
    );
  });

  it('has no Details for a day nobody punched on', async () => {
    const { user } = setup();
    await openMenu(user, 'Meena Das');
    expect(await screen.findByRole('menuitem', { name: 'Override' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Details' })).not.toBeInTheDocument();
  });
});

describe('Override dialog', () => {
  async function openOverride(user: ReturnType<typeof userEvent.setup>, name = 'Ravi Kumar') {
    await openMenu(user, name);
    await user.click(await screen.findByRole('menuitem', { name: 'Override' }));
    return screen.findByRole('dialog', { name: 'Override this day' });
  }

  it('needs a reason of at least five characters before it asks the server', async () => {
    const { calls, user } = setup();
    const dialog = await openOverride(user);
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }));
    expect(
      await within(dialog).findByText('Give a reason of at least 5 characters.'),
    ).toBeVisible();
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }));
    expect(
      await within(dialog).findByText('Give a reason of at least 5 characters.'),
    ).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
  });

  it('sends the kind, the date shown and the trimmed reason, then refreshes the register', async () => {
    const { calls, user } = setup();
    const dialog = await openOverride(user);
    await user.selectOptions(within(dialog).getByLabelText('Mark the day as'), 'Work from home');
    await user.type(
      within(dialog).getByLabelText('Reason (required)'),
      '  Power cut at the office  ',
    );
    const before = registers(calls).length;
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(posts(calls)[0])).toEqual({
      user_id: 3,
      date: todayIst(),
      kind: 'work_from_home',
      reason: 'Power cut at the office',
    });
    await waitFor(() => expect(registers(calls).length).toBeGreaterThan(before));
  });

  it('can mark a day nobody punched on', async () => {
    const { calls, user } = setup();
    const dialog = await openOverride(user, 'Meena Das');
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'Approved leave');
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(jsonBody(posts(calls)[0])).toMatchObject({ user_id: 4, kind: 'leave' });
  });

  it('shows what the server refused and stays open', async () => {
    const { user } = setup({
      routes: { 'POST /admin/attendance/overrides': () => apiError(422, 'INVALID_DATE') },
    });
    const dialog = await openOverride(user);
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'Approved leave');
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Choose a date from the employee's joining date up to today.",
    );
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('is absent without attendance.override', async () => {
    const { user } = setup({ permissions: ['web.access', 'team.view'] });
    await openMenu(user, 'Asha Rao');
    expect(await screen.findByRole('menuitem', { name: 'Details' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Override' })).not.toBeInTheDocument();
    // Nothing to open for a day without a record either.
    expect(screen.queryByRole('button', { name: 'Actions for Meena Das' })).not.toBeInTheDocument();
  });
});
