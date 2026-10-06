import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ATTENDANCE_ADMIN, PEOPLE, makeException, makeMe, makeRegisterRow } from '@/test/fixtures';
import { apiError, mockApi, renderWithClient, type Call } from '@/test/render';
import { AttendancePage } from './attendance-page';

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ATTENDANCE_ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /branches': [],
    'GET /admin/attendance': { items: [makeRegisterRow()], next_cursor: null },
    'GET /admin/punch-out-requests': { items: [], next_cursor: null },
    'GET /admin/punch-reviews': { items: [], next_cursor: null },
    'GET /admin/attendance-exceptions': {
      items: [
        makeException(),
        makeException({
          id: 302,
          employee: PEOPLE.RAVI,
          kind: 'MOCK_LOCATION',
          nearest_branch: null,
          distance_m: null,
        }),
      ],
      next_cursor: null,
    },
    ...routes,
  });
  renderWithClient(<AttendancePage />);
  return { calls, user: userEvent.setup() };
}

const lists = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.endsWith('/admin/attendance-exceptions'));

async function openTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Exceptions' }));
}

describe('Exceptions tab', () => {
  it('lists refused and flagged attempts in IST, with an icon and a label for each kind', async () => {
    const { user } = setup();
    await openTab(user);
    const table = within(await screen.findByRole('table'));
    const outside = within((await table.findByText('Asha Rao')).closest('tr') as HTMLElement);
    expect(outside.getByText(/3 Feb 2026.*9:40 am/)).toBeVisible();
    expect(outside.getByText('Outside the geofence').querySelector('svg')).not.toBeNull();
    expect(outside.getByText('Head Office')).toBeVisible();
    expect(outside.getByText('1830 m')).toBeVisible();
    const mock = within(table.getByText('Ravi Kumar').closest('tr') as HTMLElement);
    expect(mock.getByText('Mock location')).toBeVisible();
    // Where it was refused is not known for a faked location: dashes, never coordinates.
    expect(mock.getAllByText('-')).toHaveLength(2);
  });

  it('sends the kind and the dates it is given', async () => {
    const { calls, user } = setup();
    await openTab(user);
    await screen.findByText('Asha Rao');
    await user.selectOptions(screen.getByLabelText('Kind'), 'Outside the geofence');
    await user.type(screen.getByLabelText('From'), '2026-02-01');
    await user.type(screen.getByLabelText('To'), '2026-02-03');
    await waitFor(() => {
      const last = lists(calls).at(-1)?.search;
      expect(last?.get('kind')).toBe('OUTSIDE_GEOFENCE');
      expect(last?.get('from_date')).toBe('2026-02-01');
      expect(last?.get('to_date')).toBe('2026-02-03');
    });
    expect(
      within(screen.getByLabelText('Kind'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'All kinds',
      'Mock location',
      'Rooted device',
      'Emulator',
      'Outside the geofence',
      'GPS too weak',
      'Impossible jump',
      'Face mismatch',
    ]);
  });

  it('loads the next page on request', async () => {
    const { calls, user } = setup({
      routes: {
        'GET /admin/attendance-exceptions': (call: Call) =>
          call.search.get('cursor')
            ? { items: [makeException({ id: 303, employee: PEOPLE.RAVI })], next_cursor: null }
            : { items: [makeException()], next_cursor: 'c1' },
      },
    });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Ravi Kumar')).toBeVisible();
    expect(lists(calls).at(-1)?.search.get('cursor')).toBe('c1');
  });

  it('says so when there is nothing, and shows the server error', async () => {
    const { user } = setup({
      routes: { 'GET /admin/attendance-exceptions': { items: [], next_cursor: null } },
    });
    await openTab(user);
    expect(
      await screen.findByText('No attempts were refused or flagged in this period.'),
    ).toBeVisible();
  });

  it('shows why the feed could not be loaded', async () => {
    const { user } = setup({
      routes: { 'GET /admin/attendance-exceptions': () => apiError(403, 'FORBIDDEN') },
    });
    await openTab(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
  });

  it('is absent, and asks the server for nothing, without attendance.view_all', async () => {
    const { calls } = setup({ permissions: ['web.access', 'team.view', 'punchout.approve'] });
    await screen.findByRole('table');
    expect(screen.queryByRole('tab', { name: 'Exceptions' })).not.toBeInTheDocument();
    expect(lists(calls)).toHaveLength(0);
  });
});
