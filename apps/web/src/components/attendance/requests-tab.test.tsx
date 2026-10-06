import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ATTENDANCE_ADMIN,
  PEOPLE,
  makeMe,
  makeRegisterRow,
  makeRequest,
  makeRequestDetail,
} from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { AttendancePage } from './attendance-page';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const asha = makeRequest();
const ravi = makeRequest({
  id: 72,
  employee: PEOPLE.RAVI,
  status: 'pending_admin',
  reason: 'Supplier meeting',
});
const MANAGER = ['web.access', 'team.view', 'punchout.approve'];

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ATTENDANCE_ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /branches': [],
    'GET /admin/attendance': { items: [makeRegisterRow()], next_cursor: null },
    'GET /admin/punch-reviews': { items: [], next_cursor: null },
    'GET /admin/punch-out-requests': (call: Call) => ({
      items:
        call.search.get('status') === 'approved'
          ? [makeRequest({ id: 70, status: 'approved' })]
          : [asha, ravi],
      next_cursor: null,
    }),
    'GET /admin/punch-out-requests/71': makeRequestDetail(),
    'GET /admin/punch-out-requests/72': makeRequestDetail({
      ...ravi,
      status: 'pending_admin',
      first_approver: PEOPLE.ASHA,
      final_by_admin: true,
    }),
    'PATCH /admin/punch-out-requests/71/decision': makeRequest({ status: 'approved' }),
    ...routes,
  });
  renderWithClient(<AttendancePage />);
  return { calls, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const lists = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.endsWith('/admin/punch-out-requests'));

async function openTab(user: User) {
  await user.click(await screen.findByRole('tab', { name: /Punch-out requests/ }));
}

async function openRequest(user: User, name = 'Asha Rao') {
  await openTab(user);
  await user.click(
    await screen.findByRole('button', { name: `Open the punch-out request of ${name}` }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Punch-out request' });
  await within(dialog).findByText(/recorded in the audit log/);
  return dialog;
}

describe('Punch-out requests tab', () => {
  it('lists the waiting requests with their count', async () => {
    const { calls, user } = setup();
    expect(await screen.findByTestId('count-requests')).toHaveTextContent('2');
    // The count comes from the list's own query, not a second one.
    expect(lists(calls)).toHaveLength(1);
    await openTab(user);
    const table = within(await screen.findByRole('table'));
    expect(await table.findByText('Asha Rao')).toBeVisible();
    expect(table.getByText('Client site visit')).toBeVisible();
    expect(table.getByText('Waiting')).toBeVisible();
    expect(table.getByText('Waiting for an admin')).toBeVisible();
    expect(lists(calls)[0].search.get('status')).toBe('waiting');
    expect(lists(calls)[0].search.get('limit')).toBe('50');
  });

  it('switches the list by status', async () => {
    const { calls, user } = setup();
    await openTab(user);
    await screen.findByText('Asha Rao');
    await user.selectOptions(screen.getByLabelText('Show'), 'Approved');
    await waitFor(() => expect(lists(calls).at(-1)?.search.get('status')).toBe('approved'));
    expect(
      within(screen.getByLabelText('Show'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Waiting', 'Approved', 'Rejected', 'Expired']);
  });

  it('names the filter when nothing matches', async () => {
    const { user } = setup({
      routes: { 'GET /admin/punch-out-requests': { items: [], next_cursor: null } },
    });
    await openTab(user);
    expect(await screen.findByText('No punch-out requests are waiting.')).toBeVisible();
  });

  it('is absent, and asks the server for nothing, without punchout.approve', async () => {
    const { calls } = setup({ permissions: ['web.access', 'team.view'] });
    await screen.findByRole('table');
    expect(screen.queryByRole('tab', { name: /Punch-out requests/ })).not.toBeInTheDocument();
    expect(lists(calls)).toHaveLength(0);
  });
});

describe('Punch-out request dialog', () => {
  it('shows where it was made on a pin map, the selfie, the checks and the times in IST', async () => {
    const { calls, user } = setup();
    const dialog = await openRequest(user);
    const map = within(dialog).getByTestId('map');
    expect(map).toHaveAttribute('data-center', '20.4625,85.883');
    // A radius of 0 draws the pin only.
    expect(map).toHaveAttribute('data-radius', '0');
    expect(within(dialog).getByText(/20\.462500, 85\.883000 \(GPS accuracy 14 m\)/)).toBeVisible();
    expect(await within(dialog).findByRole('img')).toHaveAttribute(
      'src',
      '/api/proxy/api/v1/files/tok.request',
    );
    expect(within(dialog).getByText('Face verified')).toBeVisible();
    expect(within(dialog).getByText('score 0.69')).toBeVisible();
    expect(within(dialog).getByText('Head Office, 24500 m away')).toBeVisible();
    expect(within(dialog).getByText('Visited the Cuttack depot')).toBeVisible();
    expect(within(dialog).getByText(/3 Feb 2026.*9:35 am/i)).toBeVisible();
    expect(within(dialog).getByText(/3 Feb 2026.*5:00 pm/i)).toBeVisible();
    expect(calls.filter((c) => c.path.endsWith('/admin/punch-out-requests/71'))).toHaveLength(1);
  });

  it('approves the time that was asked for, refreshes the lists and closes', async () => {
    const { calls, user } = setup();
    const dialog = await openRequest(user);
    const before = lists(calls).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(patches(calls)[0])).toEqual({ decision: 'approve' });
    await waitFor(() => expect(lists(calls).length).toBeGreaterThan(before));
    // The decision refreshed the lists, not the detail: no second audited look.
    expect(calls.filter((c) => c.path.endsWith('/admin/punch-out-requests/71'))).toHaveLength(1);
  });

  it('approves with a different time, sent with the +05:30 offset and limited to that day', async () => {
    const { calls, user } = setup();
    const dialog = await openRequest(user);
    expect(within(dialog).queryByLabelText('Approved time (IST)')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve with a different time' }));
    const time = within(dialog).getByLabelText('Approved time (IST)');
    // The requested 11:30 UTC is 17:00 IST: the field starts there.
    expect(time).toHaveValue('2026-02-03T17:00');
    expect(time).toHaveAttribute('min', '2026-02-03T00:00');
    expect(time).toHaveAttribute('max', '2026-02-03T23:59');
    fireEvent.change(time, { target: { value: '2026-02-03T16:15' } });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(patches(calls)[0])).toEqual({
      decision: 'approve',
      approved_time: '2026-02-03T16:15:00+05:30',
    });
  });

  it('refuses a time on another day without asking the server', async () => {
    const { calls, user } = setup();
    const dialog = await openRequest(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve with a different time' }));
    fireEvent.change(within(dialog).getByLabelText('Approved time (IST)'), {
      target: { value: '2026-02-04T09:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await within(dialog).findByText('Choose a time on the same day as the punch.'),
    ).toBeVisible();
    expect(patches(calls)).toHaveLength(0);
  });

  it('sends the requested time when the edit is left unchanged or switched off', async () => {
    const { calls, user } = setup();
    const dialog = await openRequest(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve with a different time' }));
    fireEvent.change(within(dialog).getByLabelText('Approved time (IST)'), {
      target: { value: '2026-02-03T16:15' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Use the requested time' }));
    expect(within(dialog).queryByLabelText('Approved time (IST)')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(jsonBody(patches(calls)[0])).toEqual({ decision: 'approve' });
  });

  it('rejects only with a reason, and sends it trimmed', async () => {
    const { calls, user } = setup();
    const dialog = await openRequest(user);
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Give a reason for rejecting.')).toBeVisible();
    expect(patches(calls)).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText('Remarks (required to reject)'),
      '  Not on the visit list  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(patches(calls)[0])).toEqual({
      decision: 'reject',
      remarks: 'Not on the visit list',
    });
  });

  it('notes that an admin makes the final decision, and shows who passed it on', async () => {
    const { user } = setup({ permissions: MANAGER });
    const dialog = await openRequest(user, 'Ravi Kumar');
    expect(await within(dialog).findByText('An admin makes the final decision.')).toBeVisible();
    expect(within(dialog).getByText('Asha Rao (EMP-001)')).toBeVisible();
    expect(within(dialog).getByText('First approved by')).toBeVisible();
    expect(within(dialog).getByText('Waiting for an admin')).toBeVisible();
  });

  it.each([
    ['ADMIN_ONLY', 403, "This request now needs an admin's decision."],
    ['CANNOT_DECIDE_OWN', 403, 'You cannot decide your own request or punch.'],
    ['ALREADY_DECIDED', 409, 'Someone has already decided this. The lists were refreshed.'],
    ['INVALID_TIME', 422, /That time is not allowed/],
    ['REMARKS_REQUIRED', 422, 'Give a reason for rejecting.'],
    ['NOT_FOUND', 404, 'This record no longer exists, or is outside your team.'],
  ])('explains %s in words and keeps the dialog open', async (code, status, message) => {
    const { calls, user } = setup({
      routes: { 'PATCH /admin/punch-out-requests/71/decision': () => apiError(status, code) },
    });
    const dialog = await openRequest(user);
    const before = lists(calls).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog')).toBeVisible();
    // Also after a refusal: "already decided" means the lists on screen are out of date.
    await waitFor(() => expect(lists(calls).length).toBeGreaterThan(before));
  });

  it('shows a decided request read-only, with the trail of who decided and the time they set', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/punch-out-requests/71': makeRequestDetail({
          status: 'approved',
          can_decide: false,
          first_approver: PEOPLE.RAVI,
          approver: PEOPLE.ASHA,
          decided_at: '2026-02-04T05:00:00Z',
          approved_time: '2026-02-03T11:00:00Z',
          remarks: 'Checked with the client',
        }),
      },
    });
    const dialog = await openRequest(user);
    expect(within(dialog).getByText('Ravi Kumar (EMP-002)')).toBeVisible();
    expect(within(dialog).getByText(/Asha Rao \(EMP-001\), 4 Feb 2026/)).toBeVisible();
    expect(within(dialog).getByText('Checked with the client')).toBeVisible();
    for (const name of ['Approve', 'Reject', 'Approve with a different time']) {
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(dialog).queryByLabelText('Remarks (required to reject)')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('shows no actions, and says why, when this person cannot decide it', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/punch-out-requests/71': makeRequestDetail({ can_decide: false }),
      },
    });
    const dialog = await openRequest(user);
    expect(within(dialog).getByText('You cannot decide this request now.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows why the request could not be opened', async () => {
    const { user } = setup({
      routes: { 'GET /admin/punch-out-requests/71': () => apiError(404, 'NOT_FOUND') },
    });
    await openTab(user);
    await user.click(
      await screen.findByRole('button', { name: 'Open the punch-out request of Asha Rao' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Punch-out request' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no longer exists');
  });
});
