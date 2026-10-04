import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, BRANCHES, makeMe, makeShift } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { todayIst } from '@/lib/ist';
import { ShiftsPage } from './shifts-page';

const general = makeShift();
const night = makeShift({
  id: 2,
  name: 'Late',
  start_time: '13:00:00',
  end_time: '22:00:00',
  weekly_offs: [],
  is_active: false,
});
const YEAR = Number(todayIst().slice(0, 4));
const diwali = { id: 5, date: `${YEAR}-11-08`, name: 'Diwali', branch_id: null };
const local = { id: 6, date: `${YEAR}-06-15`, name: 'Raja', branch_id: 2 };

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /admin/shifts': { items: [general, night], next_cursor: null },
    'GET /branches': BRANCHES,
    'GET /admin/holidays': { items: [diwali, local], next_cursor: null },
    ...routes,
  });
  renderWithClient(<ShiftsPage />);
  return { calls, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const sent = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

async function openCreate(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Add shift' }));
  return screen.findByRole('dialog', { name: 'Add shift' });
}

async function choose(user: User, shift: string, item: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${shift}` }));
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
}

async function fillShift(user: User, dialog: HTMLElement, start = '09:30', end = '18:30') {
  await user.type(within(dialog).getByLabelText('Shift name'), 'General');
  await user.type(within(dialog).getByLabelText('Starts at'), start);
  await user.type(within(dialog).getByLabelText('Ends at'), end);
  await user.type(within(dialog).getByLabelText('Grace period (0 to 120 minutes)'), '10');
  await user.type(within(dialog).getByLabelText('Half-day hours'), '4');
  await user.type(within(dialog).getByLabelText('Full-day hours'), '8');
}

const save = (user: User, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: 'Save' }));

describe('Shifts tab', () => {
  it('lists shifts with hours, grace, day lengths, weekly offs in words and status', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /General/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 6)
        .map((c) => c.textContent),
    ).toEqual([
      'General',
      '09:30 to 18:30',
      '10 min',
      '4 h / 8 h',
      'Sunday; 2nd and 4th Saturday',
      'Active',
    ]);
    const late = screen.getByRole('row', { name: /Late/ });
    expect(within(late).getByText('No weekly off')).toBeInTheDocument();
    expect(within(late).getByTestId('status-inactive')).toHaveTextContent('Inactive');
    expect(screen.getByRole('tab', { name: 'Shifts' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a skeleton while loading, then the empty state', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    setup({
      routes: {
        'GET /admin/shifts': async () => {
          await gate;
          return { items: [], next_cursor: null };
        },
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
    release();
    expect(await screen.findByText(/No shifts yet/)).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    setup({ routes: { 'GET /admin/shifts': () => apiError(500, 'INTERNAL_ERROR') } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('shows no access without branches.manage', async () => {
    const { calls } = setup({ permissions: ['web.access', 'employees.manage'] });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/admin/shifts'))).toBe(false);
  });

  it('creates a shift with weekly offs', async () => {
    const { calls, user } = setup({ routes: { 'POST /admin/shifts': general } });
    const dialog = await openCreate(user);
    await fillShift(user, dialog);
    await user.selectOptions(within(dialog).getByLabelText('Sunday'), 'Off every week');
    await user.selectOptions(within(dialog).getByLabelText('Saturday'), 'Off on selected weeks');
    const weeks = within(dialog).getByRole('group', { name: 'Weeks of the month off on Saturday' });
    await user.click(within(weeks).getByLabelText('4th'));
    await user.click(within(weeks).getByLabelText('2nd'));
    await save(user, dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'POST')[0])).toEqual({
      name: 'General',
      start_time: '09:30',
      end_time: '18:30',
      grace_min: 10,
      half_day_hours: 4,
      full_day_hours: 8,
      weekly_offs: [
        { weekday: 5, weeks: [2, 4] },
        { weekday: 6, weeks: null },
      ],
    });
  });

  it('only shows the week checkboxes for "selected weeks"', async () => {
    const { user } = setup();
    const dialog = await openCreate(user);
    expect(within(dialog).queryByRole('group', { name: /^Weeks of/ })).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Friday'), 'Off on selected weeks');
    expect(
      within(dialog).getByRole('group', { name: 'Weeks of the month off on Friday' }),
    ).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Friday'), 'Working day');
    expect(within(dialog).queryByRole('group', { name: /^Weeks of/ })).not.toBeInTheDocument();
  });

  it('rejects an end time that is not after the start', async () => {
    const { calls, user } = setup();
    const dialog = await openCreate(user);
    await fillShift(user, dialog, '18:00', '09:00');
    await save(user, dialog);
    expect(
      await within(dialog).findByText('The shift must end after it starts on the same day.'),
    ).toBeVisible();
    expect(within(dialog).getByLabelText('Ends at')).toHaveAttribute('aria-invalid', 'true');
    expect(sent(calls, 'POST')).toHaveLength(0);
  });

  it('rejects half-day hours above full-day hours, and hours out of range', async () => {
    const { calls, user } = setup();
    const dialog = await openCreate(user);
    await fillShift(user, dialog);
    const half = within(dialog).getByLabelText('Half-day hours');
    const full = within(dialog).getByLabelText('Full-day hours');
    await user.clear(half);
    await user.type(half, '9');
    await save(user, dialog);
    expect(
      await within(dialog).findByText('Half-day hours cannot be more than full-day hours.'),
    ).toBeVisible();

    await user.clear(half);
    await user.type(half, '0');
    await user.clear(full);
    await user.type(full, '25');
    await save(user, dialog);
    await waitFor(() =>
      expect(within(dialog).getAllByText(/Enter hours above 0 and up to 24/)).toHaveLength(2),
    );
    expect(sent(calls, 'POST')).toHaveLength(0);
  });

  it('needs at least one week for "selected weeks"', async () => {
    const { calls, user } = setup();
    const dialog = await openCreate(user);
    await fillShift(user, dialog);
    await user.selectOptions(within(dialog).getByLabelText('Saturday'), 'Off on selected weeks');
    await save(user, dialog);
    expect(await within(dialog).findByText('Choose at least one week.')).toBeVisible();
    expect(sent(calls, 'POST')).toHaveLength(0);
  });

  it('edits a shift and sends only what changed', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/shifts/1': general } });
    await choose(user, 'General', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit shift' });
    expect(within(dialog).getByLabelText('Starts at')).toHaveValue('09:30');
    expect(within(dialog).getByLabelText('Saturday')).toHaveValue('weeks');
    const weeks = within(dialog).getByRole('group', { name: 'Weeks of the month off on Saturday' });
    expect(within(weeks).getByLabelText('2nd')).toBeChecked();
    expect(within(weeks).getByLabelText('3rd')).not.toBeChecked();
    await user.click(within(weeks).getByLabelText('4th'));
    const grace = within(dialog).getByLabelText('Grace period (0 to 120 minutes)');
    await user.clear(grace);
    await user.type(grace, '15');
    await save(user, dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'PATCH')[0])).toEqual({
      grace_min: 15,
      weekly_offs: [
        { weekday: 5, weeks: [2] },
        { weekday: 6, weeks: null },
      ],
    });
  });

  it('shows a duplicate name and a server-side rule in the dialog', async () => {
    let code = 'DUPLICATE';
    const { user } = setup({
      routes: { 'POST /admin/shifts': () => apiError(code === 'DUPLICATE' ? 409 : 422, code) },
    });
    const dialog = await openCreate(user);
    await fillShift(user, dialog);
    await save(user, dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A shift with that name already exists.',
    );
    code = 'VALIDATION_ERROR';
    await save(user, dialog);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'These shift details do not fit together.',
      ),
    );
  });

  it('deactivates and activates after confirmation', async () => {
    const { calls, user } = setup({
      routes: { 'PATCH /admin/shifts/1': general, 'PATCH /admin/shifts/2': night },
    });
    await choose(user, 'General', 'Deactivate');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Deactivate' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'PATCH')[0])).toEqual({ is_active: false });

    await choose(user, 'Late', 'Activate');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Activate' }),
    );
    await waitFor(() => expect(sent(calls, 'PATCH')).toHaveLength(2));
    expect(jsonBody(sent(calls, 'PATCH')[1])).toEqual({ is_active: true });
  });
});

describe('Holidays tab', () => {
  async function openTab(options: Options = {}) {
    const ctx = setup(options);
    await ctx.user.click(await screen.findByRole('tab', { name: 'Holidays' }));
    return ctx;
  }
  const holidayCalls = (calls: Call[]) =>
    calls.filter((c) => c.method === 'GET' && c.path.endsWith('/admin/holidays'));

  it('lists the holidays of this year with the branch or "All branches"', async () => {
    const { calls } = await openTab();
    const row = await screen.findByRole('row', { name: /Diwali/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 3)
        .map((c) => c.textContent),
    ).toEqual([`8 Nov ${YEAR}`, 'Diwali', 'All branches']);
    expect(within(screen.getByRole('row', { name: /Raja/ })).getByText('Warehouse')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Year' })).toHaveValue(String(YEAR));
    expect(holidayCalls(calls)[0].search.get('year')).toBe(String(YEAR));
    expect(holidayCalls(calls)[0].search.has('branch_id')).toBe(false);
  });

  it('filters by year and branch on the server', async () => {
    const { calls, user } = await openTab();
    await screen.findByText('Diwali');
    expect(
      within(screen.getByRole('combobox', { name: 'Year' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([String(YEAR - 1), String(YEAR), String(YEAR + 1)]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Year' }), String(YEAR + 1));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Branch' }), 'Warehouse');
    await waitFor(() =>
      expect(
        holidayCalls(calls).some(
          (c) => c.search.get('year') === String(YEAR + 1) && c.search.get('branch_id') === '2',
        ),
      ).toBe(true),
    );
  });

  it('shows the empty and error states', async () => {
    let fail = false;
    const { user } = await openTab({
      routes: {
        'GET /admin/holidays': () =>
          fail ? apiError(500, 'INTERNAL_ERROR') : { items: [], next_cursor: null },
      },
    });
    expect(await screen.findByText('No holidays found for this year.')).toBeInTheDocument();
    fail = true;
    await user.selectOptions(screen.getByRole('combobox', { name: 'Year' }), String(YEAR - 1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('adds a holiday for one branch', async () => {
    const { calls, user } = await openTab({ routes: { 'POST /admin/holidays': local } });
    await user.click(await screen.findByRole('button', { name: 'Add holiday' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add holiday' });
    const date = within(dialog).getByLabelText('Date');
    await user.clear(date);
    await user.type(date, `${YEAR}-06-15`);
    await user.type(within(dialog).getByLabelText('Holiday name'), 'Raja');
    await user.selectOptions(within(dialog).getByLabelText('Branch'), 'Warehouse');
    await save(user, dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'POST')[0])).toEqual({
      date: `${YEAR}-06-15`,
      name: 'Raja',
      branch_id: 2,
    });
  });

  it('requires a name and shows a duplicate inline', async () => {
    const { calls, user } = await openTab({
      routes: { 'POST /admin/holidays': () => apiError(409, 'DUPLICATE') },
    });
    await user.click(await screen.findByRole('button', { name: 'Add holiday' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add holiday' });
    await save(user, dialog);
    expect(await within(dialog).findByText('This field is required.')).toBeVisible();
    expect(sent(calls, 'POST')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Holiday name'), 'Diwali');
    await save(user, dialog);
    expect(
      await within(dialog).findByText('There is already a holiday on that date for that branch.'),
    ).toBeVisible();
    expect(jsonBody(sent(calls, 'POST')[0])).toMatchObject({ name: 'Diwali', branch_id: null });
  });

  it('edits a holiday and sends only what changed', async () => {
    const { calls, user } = await openTab({ routes: { 'PATCH /admin/holidays/6': local } });
    await user.click(await screen.findByRole('button', { name: 'Edit Raja' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit holiday' });
    expect(within(dialog).getByLabelText('Branch')).toHaveValue('2');
    await user.selectOptions(within(dialog).getByLabelText('Branch'), 'All branches');
    await save(user, dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'PATCH')[0])).toEqual({ branch_id: null });
  });

  it('deletes a holiday after confirmation', async () => {
    const { calls, user } = await openTab({
      routes: { 'DELETE /admin/holidays/5': new Response(null, { status: 204 }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Delete Diwali' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete holiday' });
    expect(dialog).toHaveTextContent(`Delete Diwali on 8 Nov ${YEAR}?`);
    expect(sent(calls, 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent(calls, 'DELETE')).toHaveLength(1);
  });
});
