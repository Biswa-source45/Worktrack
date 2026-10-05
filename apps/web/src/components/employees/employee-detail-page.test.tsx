import type { TFunction } from 'i18next';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { todayIst } from '@/lib/ist';
import { ADMIN, SETTINGS, makeEmployee, makeMe } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import type { Schemas } from '@/lib/api-client';
import { EmployeeDetailPage } from './employee-detail-page';
import { scheduleSummary, toDays } from './schedule-card';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const t = i18n.t.bind(i18n) as TFunction;
const TODAY = todayIst();

const asha = makeEmployee({
  home_branch: { id: 1, name: 'Head Office' },
  shift: { id: 1, name: 'General' },
});
const ROW: Schemas['ScheduleRowOut'] = {
  id: 4,
  effective_from: '2026-01-05',
  days: ['office', 'office', 'home', 'home', 'office', null, null],
  created_at: '2026-01-02T04:30:00Z',
};
const SCHEDULE: Schemas['ScheduleOut'] = {
  rows: [
    {
      ...ROW,
      id: 3,
      effective_from: '2025-06-02',
      days: [null, null, null, null, null, null, null],
    },
    ROW,
  ],
  resolved: [
    { date: '2026-03-02', kind: 'office', reason: 'schedule' },
    { date: '2026-03-04', kind: 'home', reason: 'schedule' },
    { date: '2026-03-07', kind: 'off', reason: 'weekly_off' },
    { date: '2026-03-09', kind: 'off', reason: 'holiday' },
    { date: '2026-03-10', kind: 'office', reason: 'shift' },
  ],
};
const APPROVED: Schemas['ApprovedHome'] = {
  id: 11,
  lat: 20.31,
  lng: 85.82,
  radius_m: 90,
  source: 'admin',
  decided_at: '2026-02-01T04:30:00Z',
};
const PENDING: Schemas['PendingHome'] = {
  id: 31,
  lat: 20.4,
  lng: 85.9,
  radius_m: 80,
  accuracy_m: 12.4,
  created_at: '2026-02-03T04:30:00Z',
};
const NONE: Schemas['AdminHomeOut'] = { approved: null, pending: null };

type Options = {
  permissions?: string[];
  home?: Schemas['AdminHomeOut'];
  routes?: Record<string, unknown>;
};

function setup({ permissions = ADMIN, home = NONE, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /admin/settings': SETTINGS,
    'GET /admin/employees/2': asha,
    'GET /admin/employees/2/schedule': SCHEDULE,
    'GET /admin/employees/2/home-location': home,
    ...routes,
  });
  const view = renderWithClient(<EmployeeDetailPage employeeId={2} />);
  return { calls, ...view, user: userEvent.setup() };
}

const sent = (calls: Call[], method: string) => calls.filter((c) => c.method === method);
const scheduleCard = () => screen.findByRole('region', { name: 'Weekly schedule' });
// The card with its schedule loaded.
async function loadedSchedule() {
  const card = await scheduleCard();
  await within(card).findByRole('table', { name: 'Next 14 days' });
  return card;
}
const homeCard = () => screen.findByRole('region', { name: 'Home work location' });

describe('EmployeeDetailPage', () => {
  it('shows the name, code, branch and shift, and a way back', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Asha Rao' })).toBeVisible();
    expect(screen.getByText('EMP-001 · Head Office · General')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Employees' })).toHaveAttribute('href', '/employees');
  });

  it('says so when no branch or shift is set', async () => {
    setup({ routes: { 'GET /admin/employees/2': makeEmployee() } });
    expect(await screen.findByText('EMP-001 · No home branch · No shift')).toBeVisible();
  });

  it('shows no access without employees.manage and asks for nothing', async () => {
    const { calls } = setup({ permissions: ['web.access', 'devices.manage'] });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('/admin/employees'))).toBe(false);
  });

  it('shows no access when the server refuses this employee (403)', async () => {
    setup({ routes: { 'GET /admin/employees/2': () => apiError(403, 'FORBIDDEN') } });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows the error when the employee does not exist', async () => {
    setup({ routes: { 'GET /admin/employees/2': () => apiError(404, 'NOT_FOUND') } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found');
  });
});

describe('Weekly schedule card', () => {
  it('lists the resolved days with date, weekday, kind (icon and label) and reason', async () => {
    setup();
    const table = within(await loadedSchedule()).getByRole('table', { name: 'Next 14 days' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      );
    expect(rows).toEqual([
      ['2 Mar 2026', 'Monday', 'Office', 'Own schedule'],
      ['4 Mar 2026', 'Wednesday', 'Home', 'Own schedule'],
      ['7 Mar 2026', 'Saturday', 'Off', 'Weekly off'],
      ['9 Mar 2026', 'Monday', 'Off', 'Holiday'],
      ['10 Mar 2026', 'Tuesday', 'Office', 'Shift'],
    ]);
    for (const kind of ['office', 'home', 'off']) {
      expect(within(table).getAllByTestId(`kind-${kind}`)[0].querySelector('svg')).not.toBeNull();
    }
  });

  it('shows the history newest first, in words', async () => {
    setup();
    const history = within(await loadedSchedule()).getByRole('region', {
      name: 'Schedule history',
    });
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'From 5 Jan 2026Office: Mon, Tue, Fri; Home: Wed, Thu; Follow shift: Sat, Sun',
      'From 2 Jun 2025Follow shift: Mon, Tue, Wed, Thu, Fri, Sat, Sun',
    ]);
  });

  it('starts the editor from the week in force and saves seven days, Monday first', async () => {
    const { calls, user } = setup({ routes: { 'PUT /admin/employees/2/schedule': ROW } });
    const card = await loadedSchedule();
    expect(within(card).getByLabelText('Wednesday')).toHaveValue('home');
    expect(within(card).getByLabelText('Sunday')).toHaveValue('');
    const date = within(card).getByLabelText('Effective from');
    expect(date).toHaveValue(TODAY);
    expect(date).toHaveAttribute('min', TODAY);

    await user.selectOptions(within(card).getByLabelText('Monday'), 'Home');
    await user.selectOptions(within(card).getByLabelText('Wednesday'), 'Follow shift');
    await user.selectOptions(within(card).getByLabelText('Saturday'), 'Off');
    await user.click(within(card).getByRole('button', { name: 'Save schedule' }));

    expect(await within(card).findByText('Schedule saved.')).toBeVisible();
    expect(jsonBody(sent(calls, 'PUT')[0])).toEqual({
      effective_from: TODAY,
      days: ['home', 'office', null, 'home', 'office', 'off', null],
    });
    // The resolved days and the history are fetched again.
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith('/schedule'))).toHaveLength(2);
  });

  it('follows the shift everywhere when there is no schedule yet', async () => {
    setup({
      routes: { 'GET /admin/employees/2/schedule': { rows: [], resolved: SCHEDULE.resolved } },
    });
    const card = await loadedSchedule();
    for (const day of ['Monday', 'Thursday', 'Sunday']) {
      expect(within(card).getByLabelText(day)).toHaveValue('');
    }
    expect(within(card).getByText(/No own schedule yet/)).toBeVisible();
  });

  it('shows a backdated schedule at the date field', async () => {
    const { user } = setup({
      routes: { 'PUT /admin/employees/2/schedule': () => apiError(422, 'SCHEDULE_BACKDATED') },
    });
    const card = await loadedSchedule();
    await user.click(within(card).getByRole('button', { name: 'Save schedule' }));
    expect(
      await within(card).findByText('A schedule cannot start in the past. Choose today or later.'),
    ).toBeVisible();
    expect(within(card).getByLabelText('Effective from')).toHaveAttribute('aria-invalid', 'true');
    expect(within(card).queryByText('Schedule saved.')).not.toBeInTheDocument();
  });

  it('shows the loading and error states', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    setup({
      routes: {
        'GET /admin/employees/2/schedule': async () => {
          await gate;
          return apiError(500, 'INTERNAL_ERROR');
        },
      },
    });
    const card = await scheduleCard();
    expect(within(card).getByRole('status')).toHaveTextContent('Loading...');
    release();
    expect(await within(card).findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('renders no access on a 403', async () => {
    setup({ routes: { 'GET /admin/employees/2/schedule': () => apiError(403, 'FORBIDDEN') } });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weekly schedule' })).not.toBeInTheDocument();
  });
});

describe('schedule helpers', () => {
  it('maps the editor values to days[7] with null for "follow shift"', () => {
    expect(toDays(['office', '', 'home', 'off', '', '', ''])).toEqual([
      'office',
      null,
      'home',
      'off',
      null,
      null,
      null,
    ]);
  });

  it('summarises a week by kind', () => {
    expect(scheduleSummary(t, ['off', 'office', 'office', 'office', 'office', 'home', 'off'])).toBe(
      'Office: Tue, Wed, Thu, Fri; Home: Sat; Off: Mon, Sun',
    );
  });
});

describe('Home work location card', () => {
  it('shows an empty state and sets a location with the default radius from Settings', async () => {
    const { calls, user } = setup({
      routes: {
        'PUT /admin/employees/2/home-location': { approved: APPROVED, pending: null },
      },
    });
    const card = await homeCard();
    expect(await within(card).findByText(/No approved home work location/)).toBeVisible();
    expect(within(card).queryByTestId('map')).not.toBeInTheDocument();

    const set = within(card).getByRole('button', { name: 'Set location' });
    await waitFor(() => expect(set).toBeEnabled());
    await user.click(set);
    const dialog = await screen.findByRole('dialog', { name: 'Set home work location' });
    expect(within(dialog).getByLabelText('Radius (30 to 500 m)')).toHaveValue(80);
    await user.click(await within(dialog).findByRole('button', { name: 'move pin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'PUT')[0])).toEqual({
      lat: 12.971599,
      lng: 77.594563,
      radius_m: 80,
    });
  });

  it('validates the pin and radius in the dialog', async () => {
    const { calls, user } = setup();
    const set = await within(await homeCard()).findByRole('button', { name: 'Set location' });
    await waitFor(() => expect(set).toBeEnabled());
    await user.click(set);
    const dialog = await screen.findByRole('dialog');
    const radius = within(dialog).getByLabelText('Radius (30 to 500 m)');
    await user.clear(radius);
    await user.type(radius, '501');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a whole number from 30 to 500.')).toBeVisible();
    expect(within(dialog).getByText('Enter a latitude from -90 to 90.')).toBeVisible();
    expect(sent(calls, 'PUT')).toHaveLength(0);
  });

  it('shows the approved location with map, radius, source and time', async () => {
    setup({ home: { approved: APPROVED, pending: null } });
    const card = await homeCard();
    expect(await within(card).findByTestId('home-approved')).toHaveTextContent('Approved');
    const map = await within(card).findByTestId('map');
    expect(map).toHaveAttribute('data-center', '20.31,85.82');
    expect(map).toHaveAttribute('data-radius', '90');
    // A preview: the pin cannot be moved here.
    expect(within(card).queryByRole('button', { name: 'move pin' })).not.toBeInTheDocument();
    expect(within(card).getByText('90 m')).toBeVisible();
    expect(within(card).getByText('An administrator')).toBeVisible();
    expect(within(card).getByText('1 Feb 2026, 10:00 am')).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('opens Change with the current pin and radius', async () => {
    const { user } = setup({ home: { approved: APPROVED, pending: null } });
    const change = await within(await homeCard()).findByRole('button', { name: 'Change' });
    await waitFor(() => expect(change).toBeEnabled());
    await user.click(change);
    const dialog = await screen.findByRole('dialog', { name: 'Change home work location' });
    expect(within(dialog).getByLabelText('Latitude')).toHaveValue(20.31);
    expect(within(dialog).getByLabelText('Radius (30 to 500 m)')).toHaveValue(90);
  });

  it('removes the location after confirmation', async () => {
    const { calls, user } = setup({
      home: { approved: APPROVED, pending: null },
      routes: {
        'DELETE /admin/employees/2/home-location': new Response(null, { status: 204 }),
      },
    });
    await user.click(await within(await homeCard()).findByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove' });
    expect(dialog).toHaveTextContent('Remove the home work location of Asha Rao?');
    expect(sent(calls, 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent(calls, 'DELETE')).toHaveLength(1);
  });

  it('shows a pending request and approves it from the review dialog', async () => {
    const detail = {
      id: 31,
      employee: { id: 2, emp_code: 'EMP-001', name: 'Asha Rao' },
      status: 'pending',
      accuracy_m: 12.4,
      created_at: PENDING.created_at,
      lat: PENDING.lat,
      lng: PENDING.lng,
      radius_m: 80,
      decided_at: null,
      reject_reason: null,
    };
    const { calls, user } = setup({
      home: { approved: null, pending: PENDING },
      routes: {
        'GET /admin/home-location-requests/31': detail,
        'POST /admin/home-location-requests/31/approve': detail,
        'GET /admin/home-location-requests': { items: [], next_cursor: null },
        'GET /admin/employees': { items: [asha], next_cursor: null },
      },
    });
    const card = await homeCard();
    expect(await within(card).findByTestId('home-pending')).toHaveTextContent('Pending request');
    await user.click(within(card).getByRole('button', { name: 'Review request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Home location request' });
    await user.click(await within(dialog).findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'POST')[0])).toEqual({ radius_m: 80 });
    // The card is fetched again after the decision.
    expect(
      calls.filter((c) => c.method === 'GET' && c.path.endsWith('/home-location')),
    ).toHaveLength(2);
  });

  it('renders no access on a 403 and an error otherwise', async () => {
    const ctx = setup({
      routes: { 'GET /admin/employees/2/home-location': () => apiError(403, 'FORBIDDEN') },
    });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Home work location' })).not.toBeInTheDocument();
    ctx.unmount();

    setup({
      routes: {
        'GET /admin/employees/2/home-location': () => apiError(500, 'INTERNAL_ERROR'),
      },
    });
    expect(await within(await homeCard()).findByRole('alert')).toHaveTextContent(
      'Something went wrong',
    );
  });

  it('never puts the coordinates in a query key', async () => {
    const { client } = setup({ home: { approved: APPROVED, pending: PENDING } });
    await within(await homeCard()).findByTestId('home-approved');
    const keys = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    );
    for (const value of [APPROVED.lat, APPROVED.lng, PENDING.lat, PENDING.lng]) {
      expect(keys).not.toContain(String(value));
    }
  });
});
