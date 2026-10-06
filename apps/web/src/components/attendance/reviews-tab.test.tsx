import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_ADMIN,
  PEOPLE,
  makeMe,
  makeRegisterRow,
  makeReview,
  makeReviewDetail,
} from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { AttendancePage } from './attendance-page';

const mismatch = makeReview();
const offline = makeReview({
  id: 92,
  employee: PEOPLE.RAVI,
  review_reasons: ['offline'],
  face_decision: 'VERIFIED',
  face_score: 0.7,
  offline: true,
});

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ATTENDANCE_ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /branches': [],
    'GET /admin/attendance': { items: [makeRegisterRow()], next_cursor: null },
    'GET /admin/punch-out-requests': { items: [], next_cursor: null },
    'GET /admin/punch-reviews': (call: Call) => ({
      items:
        call.search.get('status') === 'approved'
          ? [makeReview({ id: 90, review_status: 'approved' })]
          : [mismatch, offline],
      next_cursor: null,
    }),
    'GET /admin/punch-reviews/91': makeReviewDetail(),
    'GET /admin/punch-reviews/92': makeReviewDetail({
      ...offline,
      offline: true,
      time: '2026-02-03T11:30:00Z',
      server_time: '2026-02-03T11:30:00Z',
      device_time: '2026-02-03T10:50:00Z',
      selfie_url: '/api/v1/files/tok.offline',
    }),
    'POST /admin/punch-reviews/91/decision': makeReview({ review_status: 'approved' }),
    'POST /admin/punch-reviews/92/decision': makeReview({ id: 92, review_status: 'approved' }),
    ...routes,
  });
  renderWithClient(<AttendancePage />);
  return { calls, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');
const lists = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.endsWith('/admin/punch-reviews'));

async function openTab(user: User) {
  await user.click(await screen.findByRole('tab', { name: /^Review/ }));
}

async function openReview(user: User, name = 'Asha Rao') {
  await openTab(user);
  await user.click(await screen.findByRole('button', { name: `Review the punch of ${name}` }));
  const dialog = await screen.findByRole('dialog', { name: 'Punch review' });
  await within(dialog).findByText(/recorded in the audit log/);
  return dialog;
}

describe('Review tab', () => {
  it('shows the number waiting on the tab and lists the punches with their reasons', async () => {
    const { calls, user } = setup();
    expect(await screen.findByTestId('count-reviews')).toHaveTextContent('2');
    expect(lists(calls)).toHaveLength(1);
    expect(lists(calls)[0].search.get('status')).toBe('pending');
    await openTab(user);
    const table = within(await screen.findByRole('table'));
    const first = within((await table.findByText('Asha Rao')).closest('tr') as HTMLElement);
    expect(first.getByText('Face mismatch', { selector: 'td:nth-child(4)' })).toBeVisible();
    expect(first.getByText(/Punch-in 3 Feb 2026.*9:35 am/)).toBeVisible();
    const second = within(table.getByText('Ravi Kumar').closest('tr') as HTMLElement);
    expect(second.getByText('Punched offline')).toBeVisible();
    expect(second.getByText('Face verified')).toBeVisible();
  });

  it('filters by status and by reason', async () => {
    const { calls, user } = setup();
    await openTab(user);
    await screen.findByText('Asha Rao');
    await user.selectOptions(screen.getByLabelText('Reason'), 'Punched offline');
    await waitFor(() => expect(lists(calls).at(-1)?.search.get('reason')).toBe('offline'));
    await user.selectOptions(screen.getByLabelText('Show'), 'Approved');
    await waitFor(() => expect(lists(calls).at(-1)?.search.get('status')).toBe('approved'));
    expect(
      within(screen.getByLabelText('Reason'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'All reasons',
      'Face borderline',
      'Face mismatch',
      'Punched offline',
      'Impossible jump',
    ]);
  });

  it('says so when nothing is waiting', async () => {
    const { user } = setup({
      routes: { 'GET /admin/punch-reviews': { items: [], next_cursor: null } },
    });
    await openTab(user);
    expect(await screen.findByText('No punches are waiting for review.')).toBeVisible();
  });

  it('is absent, and asks the server for nothing, without face.review', async () => {
    const { calls } = setup({ permissions: ['web.access', 'team.view'] });
    await screen.findByRole('table');
    expect(screen.queryByRole('tab', { name: /^Review/ })).not.toBeInTheDocument();
    expect(lists(calls)).toHaveLength(0);
  });
});

describe('Punch review dialog', () => {
  it('shows the selfie, the score against the thresholds, the place and both clocks', async () => {
    const { user } = setup();
    const dialog = await openReview(user);
    expect(await within(dialog).findByRole('img')).toHaveAttribute(
      'src',
      '/api/proxy/api/v1/files/tok.review',
    );
    // Once as the reason it waits, once as the server's verdict on the selfie.
    expect(within(dialog).getAllByText('Face mismatch')).toHaveLength(2);
    expect(within(dialog).getByText('score 0.12')).toBeVisible();
    expect(within(dialog).getByText('accepted from 0.40, review from 0.30')).toBeVisible();
    expect(within(dialog).getByText('Head Office, 18 m from the centre')).toBeVisible();
    expect(within(dialog).getByText('11 m')).toBeVisible();
    expect(within(dialog).getByText(/Phone time \(not trusted\)/)).toBeVisible();
    // A punch made online has its time fixed: no time field.
    expect(within(dialog).queryByLabelText(/Time to count/)).not.toBeInTheDocument();
  });

  it('shows the integrity flags the phone reported', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/punch-reviews/91': makeReviewDetail({ integrity_flags: ['mock', 'rooted'] }),
      },
    });
    const dialog = await openReview(user);
    expect(await within(dialog).findByText('Mock location app on, Rooted phone')).toBeVisible();
  });

  it('approves, refreshes the lists and closes, without a time change for an online punch', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    const before = lists(calls).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(posts(calls)[0])).toEqual({ decision: 'approve' });
    await waitFor(() => expect(lists(calls).length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByTestId('count-reviews')).toBeVisible());
  });

  it('rejects only with a reason, and sends it trimmed', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Give a reason for rejecting.')).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText('Remarks (required to reject)'),
      '  Not the employee  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(posts(calls)[0])).toEqual({ decision: 'reject', remarks: 'Not the employee' });
  });

  it('offers a time to count for an offline punch, starting at the time it arrived', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user, 'Ravi Kumar');
    const time = await within(dialog).findByLabelText('Time to count (IST), a punch made offline');
    expect(time).toHaveValue('2026-02-03T17:00');
    expect(time).toHaveAttribute('min', '2026-02-03T00:00');
    expect(time).toHaveAttribute('max', '2026-02-03T23:59');
    expect(within(dialog).getByText('Punched offline', { selector: 'span' })).toBeVisible();
    fireEvent.change(time, { target: { value: '2026-02-03T16:20' } });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(jsonBody(posts(calls)[0])).toEqual({
      decision: 'approve',
      effective_time: '2026-02-03T16:20:00+05:30',
    });
  });

  it('leaves the time alone when the offline punch is approved as it arrived', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user, 'Ravi Kumar');
    await within(dialog).findByLabelText(/Time to count/);
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(jsonBody(posts(calls)[0])).toEqual({ decision: 'approve' });
  });

  it('refuses a time on another day without asking the server', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user, 'Ravi Kumar');
    fireEvent.change(await within(dialog).findByLabelText(/Time to count/), {
      target: { value: '2026-02-02T23:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(
      await within(dialog).findByText('Choose a time on the same day as the punch.'),
    ).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
  });

  it.each([
    ['ALREADY_DECIDED', 409, 'Someone has already decided this. The lists were refreshed.'],
    ['CANNOT_DECIDE_OWN', 403, 'You cannot decide your own request or punch.'],
    ['INVALID_TIME', 422, /That time is not allowed/],
    ['NOT_FOUND', 404, 'This record no longer exists, or is outside your team.'],
  ])('explains %s in words and keeps the dialog open', async (code, status, message) => {
    const { user } = setup({
      routes: { 'POST /admin/punch-reviews/91/decision': () => apiError(status, code) },
    });
    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('shows nobody a decision on their own punch, and says why', async () => {
    const { user } = setup({
      routes: { 'GET /admin/punch-reviews/91': makeReviewDetail({ can_decide: false }) },
    });
    const dialog = await openReview(user);
    expect(within(dialog).getByText('You cannot review your own punch.')).toBeVisible();
    for (const name of ['Approve', 'Reject']) {
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('shows a decided punch read-only with the reviewer remarks', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/punch-reviews/91': makeReviewDetail({
          review_status: 'rejected',
          review_remarks: 'Not the employee',
          can_decide: false,
        }),
      },
    });
    const dialog = await openReview(user);
    expect(within(dialog).getByText('Rejected')).toBeVisible();
    expect(within(dialog).getByText('Not the employee')).toBeVisible();
    expect(within(dialog).queryByText('You cannot review your own punch.')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
