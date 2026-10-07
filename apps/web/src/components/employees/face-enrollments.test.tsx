import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  BRANCHES,
  DEPARTMENTS,
  DESIGNATIONS,
  ROLES,
  SHIFTS,
  makeEmployee,
  makeEnrollment,
  makeEnrollmentDetail,
  makeMe,
} from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { EmployeesPage } from './employees-page';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const asha = makeEnrollment();
const ravi = makeEnrollment({
  id: 52,
  employee: { id: 3, emp_code: 'EMP-002', name: 'Ravi Kumar' },
  submitted_at: null,
});
const REVIEWER = [...ADMIN, 'face.review'];

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = REVIEWER, routes = {} }: Options = {}) {
  let pending = [asha, ravi];
  const decided = () => {
    pending = [ravi];
    return { ...asha, status: 'approved' };
  };
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /admin/roles': ROLES,
    'GET /admin/masters/designations': DESIGNATIONS,
    'GET /admin/masters/departments': DEPARTMENTS,
    'GET /branches': BRANCHES,
    'GET /shifts': SHIFTS,
    'GET /admin/employees': { items: [makeEmployee()], next_cursor: null },
    'GET /admin/home-location-requests': { items: [], next_cursor: null },
    'GET /admin/face-enrollments': (call: Call) => ({
      items:
        call.search.get('status') === 'approved'
          ? [makeEnrollment({ id: 60, status: 'approved', decided_at: '2026-02-02T05:00:00Z' })]
          : pending,
      next_cursor: null,
    }),
    'GET /admin/face-enrollments/51': makeEnrollmentDetail(),
    'POST /admin/face-enrollments/51/approve': decided,
    'POST /admin/face-enrollments/51/reject': decided,
    'POST /admin/face-enrollments/60/reset': makeEnrollment({ id: 60, status: 'reset' }),
    ...routes,
  });
  renderWithClient(<EmployeesPage />);
  return { calls, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');
const faceLists = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.endsWith('/admin/face-enrollments'));

async function openTab(user: User) {
  await user.click(await screen.findByRole('tab', { name: /Face enrollments/ }));
}

async function openReview(user: User, name = 'Asha Rao') {
  await openTab(user);
  await user.click(
    await screen.findByRole('button', { name: `Review the face enrollment of ${name}` }),
  );
  return screen.findByRole('dialog', { name: 'Face enrollment' });
}

describe('Face enrollments tab', () => {
  it('shows the number waiting on the tab and lists only people waiting for review', async () => {
    const { calls, user } = setup();
    expect(await screen.findByTestId('count-faces')).toHaveTextContent('2');
    expect(faceLists(calls)[0].search.get('status')).toBe('pending');
    await openTab(user);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Asha Rao (EMP-001)')).toBeVisible();
    expect(within(table).getByText('Ravi Kumar (EMP-002)')).toBeVisible();
    // The list is filtered by status, so rows carry no status of their own.
    expect(within(table).queryByText('Waiting for review')).not.toBeInTheDocument();
    // Ravi has not sent photos yet: the column says so instead of showing a date.
    expect(within(table).getByText('-')).toBeVisible();
  });

  it('is absent, and asks the server for nothing, without face.review', async () => {
    const { calls } = setup({ permissions: ADMIN });
    await screen.findByRole('tab', { name: /Home requests/ });
    expect(screen.queryByRole('tab', { name: /Face enrollments/ })).not.toBeInTheDocument();
    expect(faceLists(calls)).toHaveLength(0);
  });

  it('switches the list by status', async () => {
    const { calls, user } = setup();
    await openTab(user);
    await screen.findByText('Asha Rao (EMP-001)');
    await user.selectOptions(screen.getByLabelText('Show'), 'Approved');
    await waitFor(() => expect(faceLists(calls).at(-1)?.search.get('status')).toBe('approved'));
    expect(await screen.findAllByText('Approved')).not.toHaveLength(0);
  });

  it('says so when nothing is waiting', async () => {
    const { user } = setup({
      routes: { 'GET /admin/face-enrollments': { items: [], next_cursor: null } },
    });
    await openTab(user);
    expect(await screen.findByText('No face enrollments are waiting for review.')).toBeVisible();
  });
});

describe('Face review dialog', () => {
  it('shows the three photos through the proxy, their quality and the audit note', async () => {
    const { user } = setup();
    const dialog = await openReview(user);
    expect(within(dialog).getByText(/recorded in the audit log/)).toBeVisible();
    expect(within(dialog).getByText('Waiting for review')).toBeVisible();
    const photos = await within(dialog).findAllByRole('img');
    expect(photos.map((p) => p.getAttribute('src'))).toEqual([
      '/api/proxy/api/v1/files/tok.one',
      '/api/proxy/api/v1/files/tok.two',
      '/api/proxy/api/v1/files/tok.three',
    ]);
    expect(photos[0]).toHaveAccessibleName('Enrollment photo 1');
    expect(within(dialog).getByText('281 px wide, sharpness 312, brightness 129')).toBeVisible();
    expect(within(dialog).getByText('0.83')).toBeVisible();
    expect(within(dialog).getByText('yunet-2023mar+sface-2021dec')).toBeVisible();
    // The storage keys never reach the browser.
    expect(dialog.innerHTML).not.toContain('face/');
  });

  it('approves what was on screen, refreshes the list and closes', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    await within(dialog).findAllByRole('img');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(calls).map((c) => c.path.split('/api/v1')[1])).toEqual([
      '/admin/face-enrollments/51/approve',
    ]);
    // The approval names the photos the admin saw; the server refuses it if they changed.
    expect(jsonBody(posts(calls)[0])).toEqual({ submitted_at: '2026-02-01T04:31:00Z' });
    // The decision refreshed the list, not the detail: no second audited look, no new links.
    const detailGets = calls.filter((c) => c.path.endsWith('/admin/face-enrollments/51'));
    expect(detailGets).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('count-faces')).toHaveTextContent('1'));
  });

  it('rejects only with a reason, and sends it trimmed', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    await within(dialog).findAllByRole('img');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Give a reason for rejecting.')).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText('Reason for rejecting (the employee sees it)'),
      '  Face is covered  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(posts(calls)[0])).toEqual({ reason: 'Face is covered' });
  });

  it('resets an approved enrollment, with a reason', async () => {
    const { calls, user } = setup({
      routes: {
        'GET /admin/face-enrollments/60': makeEnrollmentDetail({ id: 60, status: 'approved' }),
      },
    });
    await openTab(user);
    await user.selectOptions(await screen.findByLabelText('Show'), 'Approved');
    await user.click(
      await screen.findByRole('button', { name: 'Review the face enrollment of Asha Rao' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Face enrollment' });
    await within(dialog).findAllByRole('img');
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset enrollment' }));
    expect(await within(dialog).findByText('Give a reason for rejecting.')).toBeVisible();
    await user.type(within(dialog).getByLabelText(/Reason for resetting/), 'Grew a beard');
    await user.click(within(dialog).getByRole('button', { name: 'Reset enrollment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(posts(calls)[0])).toEqual({ reason: 'Grew a beard' });
  });

  it('shows a closed enrollment without photos or actions', async () => {
    const { user } = setup({
      routes: {
        'GET /admin/face-enrollments/51': makeEnrollmentDetail({
          status: 'rejected',
          photos: [],
          qualities: [],
          reason: 'Blurred',
        }),
      },
    });
    const dialog = await openReview(user);
    expect(await within(dialog).findByText(/were deleted/)).toBeVisible();
    expect(within(dialog).getByText('Blurred')).toBeVisible();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
    for (const name of ['Approve', 'Reject', 'Reset enrollment']) {
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('explains a decision someone else made first, and refreshes the list', async () => {
    const { calls, user } = setup({
      routes: {
        'POST /admin/face-enrollments/51/approve': () =>
          apiError(409, 'ENROLLMENT_ALREADY_DECIDED'),
      },
    });
    const dialog = await openReview(user);
    await within(dialog).findAllByRole('img');
    const before = faceLists(calls).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone has already decided this enrollment.',
    );
    await waitFor(() => expect(faceLists(calls).length).toBeGreaterThan(before));
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('shows why the photos could not be loaded', async () => {
    const { user } = setup({
      routes: { 'GET /admin/face-enrollments/51': () => apiError(403, 'FORBIDDEN') },
    });
    const dialog = await openReview(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "You may not review this employee's enrollment.",
    );
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('Face review dialog: changed photos and expired links', () => {
  it('explains that new photos arrived and keeps the dialog open to look again', async () => {
    const { user } = setup({
      routes: {
        'POST /admin/face-enrollments/51/approve': () => apiError(409, 'ENROLLMENT_CHANGED'),
      },
    });
    const dialog = await openReview(user);
    await within(dialog).findAllByRole('img');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The employee sent new photos after you opened this.',
    );
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('says so when a photo link no longer works, instead of a broken picture', async () => {
    const { user } = setup();
    const dialog = await openReview(user);
    const photos = await within(dialog).findAllByRole('img');
    fireEvent.error(photos[1]);
    expect(await within(dialog).findByText(/could not be loaded/)).toBeVisible();
    expect(within(dialog).getAllByRole('img')).toHaveLength(2);
  });
});

describe('Face enrollments tab: more than one page', () => {
  const paged = (call: Call) =>
    call.search.get('cursor') === '51'
      ? { items: [ravi], next_cursor: null }
      : { items: [asha], next_cursor: '51' };

  it('offers Load more when the server has another page, and appends it with the cursor', async () => {
    const { calls, user } = setup({ routes: { 'GET /admin/face-enrollments': paged } });
    await openTab(user);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Asha Rao (EMP-001)')).toBeVisible();
    expect(within(table).queryByText('Ravi Kumar (EMP-002)')).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await within(table).findByText('Ravi Kumar (EMP-002)')).toBeVisible();
    expect(within(table).getByText('Asha Rao (EMP-001)')).toBeVisible();
    expect(faceLists(calls).at(-1)?.search.get('cursor')).toBe('51');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('offers no Load more when everything fits one page', async () => {
    const { user } = setup();
    await openTab(user);
    await screen.findByText('Asha Rao (EMP-001)');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
