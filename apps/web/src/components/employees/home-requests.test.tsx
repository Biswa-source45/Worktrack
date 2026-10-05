import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  BRANCHES,
  DEPARTMENTS,
  DESIGNATIONS,
  ROLES,
  SHIFTS,
  makeEmployee,
  makeHomeRequest,
  makeMe,
} from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import type { Schemas } from '@/lib/api-client';
import { EmployeesPage } from './employees-page';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const asha = makeHomeRequest();
const ravi = makeHomeRequest({
  id: 32,
  employee: { id: 3, emp_code: 'EMP-002', name: 'Ravi Kumar' },
  accuracy_m: null,
});
const DETAIL: Schemas['HomeRequestDetail'] = {
  ...asha,
  lat: 20.4567,
  lng: 85.9123,
  radius_m: 80,
  decided_at: null,
  reject_reason: null,
};

function setup(routes: Record<string, unknown> = {}) {
  let pending = [asha, ravi];
  const decided = () => {
    pending = [ravi];
    return asha;
  };
  const calls = mockApi({
    'GET /me': makeMe(),
    'GET /admin/roles': ROLES,
    'GET /admin/masters/designations': DESIGNATIONS,
    'GET /admin/masters/departments': DEPARTMENTS,
    'GET /branches': BRANCHES,
    'GET /shifts': SHIFTS,
    'GET /admin/employees': { items: [makeEmployee()], next_cursor: null },
    'GET /admin/home-location-requests': () => ({ items: pending, next_cursor: null }),
    'GET /admin/home-location-requests/31': DETAIL,
    'POST /admin/home-location-requests/31/approve': decided,
    'POST /admin/home-location-requests/31/reject': decided,
    ...routes,
  });
  const view = renderWithClient(<EmployeesPage />);
  return { calls, ...view, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

async function openTab(user: User) {
  await user.click(await screen.findByRole('tab', { name: /Home requests/ }));
}

async function openReview(user: User) {
  await openTab(user);
  await user.click(await screen.findByRole('button', { name: 'Review the request of Asha Rao' }));
  const dialog = await screen.findByRole('dialog', { name: 'Home location request' });
  await within(dialog).findByTestId('map');
  return dialog;
}

describe('Home requests tab', () => {
  it('shows the number of pending requests on the tab and asks only for pending ones', async () => {
    const { calls } = setup();
    await waitFor(() => expect(screen.getByTestId('count-requests')).toHaveTextContent('2'));
    expect(screen.getByRole('tab', { name: 'Employees' })).toHaveAttribute('aria-selected', 'true');
    const list = calls.find((c) => c.path.endsWith('/admin/home-location-requests')) as Call;
    expect(list.search.get('status')).toBe('pending');
  });

  it('lists who asked and when, never where', async () => {
    const { user } = setup();
    await openTab(user);
    const row = await screen.findByRole('row', { name: /Asha Rao/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 3)
        .map((c) => c.textContent),
    ).toEqual(['Asha Rao (EMP-001)', '12 m', '1 Feb 2026, 10:00 am']);
    expect(
      within(screen.getByRole('row', { name: /Ravi Kumar/ })).getByText('Not recorded'),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent('20.4567');
    expect(document.body).not.toHaveTextContent('85.9123');
    expect(screen.queryByTestId('map')).not.toBeInTheDocument();
    // The employee tools belong to the other tab.
    expect(screen.queryByRole('button', { name: 'New employee' })).not.toBeInTheDocument();
  });

  it('shows the empty and error states', async () => {
    let fail = false;
    const { user, client } = setup({
      'GET /admin/home-location-requests': () =>
        fail ? apiError(500, 'INTERNAL_ERROR') : { items: [], next_cursor: null },
    });
    await openTab(user);
    expect(await screen.findByText('No pending home location requests.')).toBeVisible();
    expect(screen.getByTestId('count-requests')).toHaveTextContent('0');
    fail = true;
    await client.invalidateQueries({ queryKey: ['home-requests'] });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });
});

describe('Home request review dialog', () => {
  it('loads the request and shows the pin with its circle', async () => {
    const { user } = setup();
    const dialog = await openReview(user);
    expect(dialog).toHaveTextContent('Asha Rao (EMP-001) asked to work from this location');
    const map = within(dialog).getByTestId('map');
    expect(map).toHaveAttribute('data-center', '20.4567,85.9123');
    expect(map).toHaveAttribute('data-radius', '80');
    // A preview only: the admin cannot move the employee's pin.
    expect(within(dialog).queryByRole('button', { name: 'move pin' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('20.4567, 85.9123')).toBeVisible();
  });

  it('shows no pin for a request whose coordinates are no longer kept', async () => {
    const { user } = setup({
      'GET /admin/home-location-requests/31': {
        ...DETAIL,
        status: 'rejected',
        lat: null,
        lng: null,
      },
    });
    const dialog = await openReview(user);
    expect(within(dialog).getByText('Not recorded')).toBeVisible();
    expect(within(dialog).getByTestId('map')).not.toHaveAttribute('data-center', '20.4567,85.9123');
  });

  it('approves with the chosen radius and refreshes the list', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    const radius = within(dialog).getByLabelText('Radius (30 to 500 m)');
    await user.clear(radius);
    await user.type(radius, '150');
    expect(within(dialog).getByTestId('map')).toHaveAttribute('data-radius', '150');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].path).toMatch(/\/31\/approve$/);
    expect(jsonBody(posts(calls)[0])).toEqual({ radius_m: 150 });
    await waitFor(() => expect(screen.getByTestId('count-requests')).toHaveTextContent('1'));
    expect(screen.queryByRole('row', { name: /Asha Rao/ })).not.toBeInTheDocument();
  });

  it.each(['29', '501'])('does not approve with a radius of %s', async (value) => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    const radius = within(dialog).getByLabelText('Radius (30 to 500 m)');
    await user.clear(radius);
    await user.type(radius, value);
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('Enter a whole number from 30 to 500.')).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
  });

  it('needs a reason to reject, then sends it', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Give a reason for rejecting.')).toBeVisible();
    expect(within(dialog).getByLabelText('Reason (needed to reject)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(posts(calls)).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Reason (needed to reject)'), ' Not a home ');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(calls)[0].path).toMatch(/\/31\/reject$/);
    expect(jsonBody(posts(calls)[0])).toEqual({ reason: 'Not a home' });
  });

  it('does not accept a reason longer than 255 characters', async () => {
    const { calls, user } = setup();
    const dialog = await openReview(user);
    await user.click(within(dialog).getByLabelText('Reason (needed to reject)'));
    await user.paste('x'.repeat(256));
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('This is too long.')).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
  });

  it('says so when someone else already decided, and refreshes the list', async () => {
    const listCalls = (calls: Call[]) =>
      calls.filter((c) => c.path.endsWith('/admin/home-location-requests'));
    const { calls, user } = setup({
      'POST /admin/home-location-requests/31/approve': () =>
        apiError(409, 'REQUEST_ALREADY_DECIDED'),
    });
    const dialog = await openReview(user);
    const before = listCalls(calls).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This request has already been decided.',
    );
    await waitFor(() => expect(listCalls(calls).length).toBeGreaterThan(before));
  });

  it('shows an error when the request cannot be loaded', async () => {
    const { user } = setup({
      'GET /admin/home-location-requests/31': () => apiError(404, 'NOT_FOUND'),
    });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Review the request of Asha Rao' }));
    const dialog = await screen.findByRole('dialog', { name: 'Home location request' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Not found');
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('keeps the coordinates out of the cache once the dialog is closed', async () => {
    const { client, user } = setup();
    const dialog = await openReview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        JSON.stringify(
          client
            .getQueryCache()
            .getAll()
            .map((q) => [q.queryKey, q.state.data]),
        ),
      ).not.toContain('20.4567'),
    );
  });
});
