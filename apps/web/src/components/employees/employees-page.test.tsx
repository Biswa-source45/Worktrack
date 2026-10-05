import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  BRANCHES,
  DEPARTMENTS,
  DESIGNATIONS,
  ROLES,
  SHIFTS,
  makeEmployee,
  makeMe,
} from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import type { Schemas } from '@/lib/api-client';
import { EmployeesPage } from './employees-page';

const WARNING =
  'Share this temporary password with the employee securely. It is shown only once and cannot be retrieved later. The employee must change it at first sign in.';

const admin = makeEmployee({
  id: 1,
  emp_code: 'ADMIN-1',
  name: 'Demo Admin',
  manager_id: null,
  role: { id: 1, name: 'Super Admin' },
});
const asha = makeEmployee();
const ravi = makeEmployee({ id: 3, emp_code: 'EMP-002', name: 'Ravi Kumar', status: 'inactive' });
const locked = makeEmployee({
  id: 4,
  emp_code: 'EMP-003',
  name: 'Locked Larry',
  locked_until: new Date(Date.now() + 3_600_000).toISOString(),
});
const EVERYONE = [admin, asha, ravi, locked];

type Options = {
  me?: Schemas['MeResponse'];
  list?: (call: Call) => unknown;
  routes?: Record<string, unknown>;
};

function setup({ me = makeMe(), list, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': me,
    'GET /admin/roles': ROLES,
    'GET /admin/masters/designations': DESIGNATIONS,
    'GET /admin/masters/departments': DEPARTMENTS,
    'GET /branches': BRANCHES,
    'GET /shifts': SHIFTS,
    'GET /admin/home-location-requests': { items: [], next_cursor: null },
    'GET /admin/employees': (call: Call) =>
      call.search.get('limit') === '200'
        ? { items: EVERYONE, next_cursor: null }
        : (list?.(call) ?? { items: EVERYONE, next_cursor: null }),
    ...routes,
  });
  const view = renderWithClient(<EmployeesPage />);
  return { calls, ...view, user: userEvent.setup() };
}

const row = (name: RegExp) => screen.getByRole('row', { name });

type User = ReturnType<typeof userEvent.setup>;
// Row actions live in a per-row menu; the trigger is named after the employee.
async function openMenu(user: User, name: RegExp, employee: string) {
  await user.click(within(row(name)).getByRole('button', { name: `Actions for ${employee}` }));
  return screen.findByRole('menu');
}
async function choose(user: User, name: RegExp, employee: string, item: string) {
  const menu = await openMenu(user, name, employee);
  await user.click(within(menu).getByRole('menuitem', { name: item }));
}

describe('EmployeesPage table', () => {
  it('renders the employees with manager name, role, field flag and status', async () => {
    setup();
    const ashaRow = await screen.findByRole('row', { name: /EMP-001/ });
    const cells = within(ashaRow)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells.slice(0, 9)).toEqual([
      'EMP-001',
      'Asha Rao',
      '9876543210',
      'Engineer',
      'Operations',
      'Field Employee',
      'Demo Admin',
      'Yes',
      'Active',
    ]);
    expect(within(row(/EMP-002/)).getByText('Inactive')).toBeInTheDocument();
  });

  it('sends the search text and status filter to the server', async () => {
    const { calls, user } = setup();
    await screen.findByText('Asha Rao');
    await user.type(
      screen.getByRole('textbox', { name: 'Search by name, code or mobile' }),
      'asha',
    );
    await waitFor(() => expect(calls.some((c) => c.search.get('q') === 'asha')).toBe(true));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'inactive');
    await waitFor(() =>
      expect(
        calls.some((c) => c.search.get('q') === 'asha' && c.search.get('status') === 'inactive'),
      ).toBe(true),
    );
  });

  it('keeps the current rows on screen while a new search is loading', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { user } = setup({
      list: async (call) => {
        if (call.search.get('q') !== 'ravi') return { items: [asha], next_cursor: null };
        await gate;
        return { items: [ravi], next_cursor: null };
      },
    });
    await screen.findByText('Asha Rao');
    await user.type(
      screen.getByRole('textbox', { name: 'Search by name, code or mobile' }),
      'ravi',
    );
    // The request for "ravi" is held open: the old table (and its row menus) must stay in place.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.queryByText('Asha Rao')).not.toBeInTheDocument();
  });

  it('loads the next page with the cursor', async () => {
    const { calls, user } = setup({
      list: (call) =>
        call.search.get('cursor') === 'c1'
          ? { items: [ravi], next_cursor: null }
          : { items: [asha], next_cursor: 'c1' },
    });
    await screen.findByText('Asha Rao');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(calls.some((c) => c.search.get('cursor') === 'c1')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows row actions by state: unlock only when locked, no deactivate on your own row', async () => {
    const { user } = setup();
    await screen.findByText('Locked Larry');
    const items = async (name: RegExp, employee: string) => {
      const menu = await openMenu(user, name, employee);
      const names = within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      return names;
    };
    expect(await items(/EMP-001/, 'Asha Rao')).toEqual([
      'Edit',
      'Schedule and home location',
      'Deactivate',
      'Reset password',
    ]);
    expect(await items(/EMP-002/, 'Ravi Kumar')).toEqual([
      'Edit',
      'Schedule and home location',
      'Reactivate',
      'Reset password',
    ]);
    expect(await items(/EMP-003/, 'Locked Larry')).toEqual([
      'Edit',
      'Schedule and home location',
      'Deactivate',
      'Reset password',
      'Unlock',
    ]);
    expect(await items(/ADMIN-1/, 'Demo Admin')).toEqual([
      'Edit',
      'Schedule and home location',
      'Reset password',
    ]);
    expect(within(row(/EMP-003/)).getByText('Locked')).toBeInTheDocument();
  });

  it('puts only the menu trigger in the actions cell and marks wide columns for 2xl', async () => {
    setup();
    const ashaRow = await screen.findByRole('row', { name: /EMP-001/ });
    expect(within(ashaRow).getAllByRole('button')).toHaveLength(1);
    expect(within(ashaRow).getByRole('button')).toHaveAccessibleName('Actions for Asha Rao');
    const hidden = (el: HTMLElement) => el.className.includes('hidden 2xl:table-cell');
    const heads = screen.getAllByRole('columnheader');
    expect(heads.filter(hidden).map((h) => h.textContent)).toEqual([
      'Mobile',
      'Department',
      'Manager',
      'Field-eligible',
    ]);
    expect(within(ashaRow).getAllByRole('cell').filter(hidden)).toHaveLength(4);
    expect(within(ashaRow).getByTestId('status-active')).toHaveTextContent('Active');
  });

  it('links each row to its schedule and home location page', async () => {
    const { user } = setup();
    await screen.findByText('Asha Rao');
    const menu = await openMenu(user, /EMP-001/, 'Asha Rao');
    expect(
      within(menu).getByRole('menuitem', { name: 'Schedule and home location' }),
    ).toHaveAttribute('href', '/employees/2');
  });

  it('shows a no-access message without the employees.manage permission', async () => {
    const { calls } = setup({ me: makeMe({ permissions: ['web.access', 'devices.manage'] }) });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/admin/employees'))).toBe(false);
  });
});

describe('EmployeesPage row actions', () => {
  it('deactivates after confirmation', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/employees/2': asha } });
    await screen.findByText('Asha Rao');
    await choose(user, /EMP-001/, 'Asha Rao', 'Deactivate');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(jsonBody(patch as Call)).toEqual({ status: 'inactive' });
  });

  it('reactivates an inactive employee', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/employees/3': ravi } });
    await screen.findByText('Ravi Kumar');
    await choose(user, /EMP-002/, 'Ravi Kumar', 'Reactivate');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reactivate' }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(jsonBody(calls.find((c) => c.method === 'PATCH') as Call)).toEqual({ status: 'active' });
  });

  it('shows the server reason when deactivation is refused', async () => {
    const { user } = setup({
      routes: { 'PATCH /admin/employees/2': () => apiError(409, 'HAS_REPORTS') },
    });
    await screen.findByText('Asha Rao');
    await choose(user, /EMP-001/, 'Asha Rao', 'Deactivate');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still has active reports');
  });

  it('unlocks a locked account', async () => {
    const { calls, user } = setup({ routes: { 'POST /admin/employees/4/unlock': locked } });
    await screen.findByText('Locked Larry');
    await choose(user, /EMP-003/, 'Locked Larry', 'Unlock');
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/employees/4/unlock'))).toBe(true),
    );
  });

  it('shows the temporary password once after a reset, then forgets it', async () => {
    const { client, user } = setup({
      routes: { 'POST /admin/employees/2/reset-password': { temporary_password: 'Zk7mPq2xVb9n' } },
    });
    await screen.findByText('Asha Rao');
    await choose(user, /EMP-001/, 'Asha Rao', 'Reset password');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset password' }),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(within(dialog).getByText(WARNING)).toBeInTheDocument();
    expect(within(dialog).getByText('Zk7mPq2xVb9n')).toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('Zk7mPq2xVb9n');

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent('Zk7mPq2xVb9n');
  });

  it('copies the temporary password to the clipboard', async () => {
    const { user } = setup({
      routes: { 'POST /admin/employees/2/reset-password': { temporary_password: 'Zk7mPq2xVb9n' } },
    });
    await screen.findByText('Asha Rao');
    await choose(user, /EMP-001/, 'Asha Rao', 'Reset password');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset password' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('Zk7mPq2xVb9n');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

const CREATED = {
  employee: makeEmployee({ id: 9, emp_code: 'EMP-009', name: 'New Person' }),
  temporary_password: 'Gen3ratedPw42',
};

describe('Employee create and edit dialogs', () => {
  async function openCreate(post: unknown = CREATED) {
    const ctx = setup({ routes: { 'POST /admin/employees': post } });
    await screen.findByText('Asha Rao');
    await ctx.user.click(screen.getByRole('button', { name: 'New employee' }));
    return { ...ctx, dialog: await screen.findByRole('dialog', { name: 'New employee' }) };
  }

  it('validates the form and sends nothing when invalid', async () => {
    const { calls, user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Employee code'), 'bad code!');
    await user.type(within(dialog).getByLabelText('Mobile number'), '123');
    await user.type(within(dialog).getByLabelText('Email (optional)'), 'nope');
    await user.type(within(dialog).getByLabelText('Password (optional)'), 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/Use letters, digits/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('Enter a valid mobile number (10 to 15 digits).'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Use 10 to 128 characters/)).toBeInTheDocument();
    expect(within(dialog).getAllByText('This field is required.').length).toBeGreaterThanOrEqual(3);
    expect(within(dialog).getByLabelText('Mobile number')).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('only offers roles within your own permissions and active managers', async () => {
    const { dialog } = await openCreate();
    const roles = within(within(dialog).getByLabelText('Role'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(roles).toEqual(['Select...', 'Field Employee', 'HR Admin']);
    const managers = within(within(dialog).getByLabelText('Manager (optional)'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(managers).toEqual(['None', 'Demo Admin', 'Asha Rao', 'Locked Larry']);
  });

  it('creates an employee and shows the generated password once', async () => {
    const { calls, user, dialog, client } = await openCreate();
    await user.type(within(dialog).getByLabelText('Employee code'), 'emp-009');
    await user.type(within(dialog).getByLabelText('Full name'), 'New Person');
    await user.type(within(dialog).getByLabelText('Mobile number'), '98765 43211');
    await user.selectOptions(within(dialog).getByLabelText('Designation'), 'Engineer');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Field Employee');
    await user.selectOptions(within(dialog).getByLabelText('Manager (optional)'), 'Demo Admin');
    await user.click(within(dialog).getByLabelText(/Field-eligible/));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    const shown = await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(within(shown).getByText(WARNING)).toBeInTheDocument();
    expect(within(shown).getByText('Gen3ratedPw42')).toBeInTheDocument();

    const post = calls.find((c) => c.method === 'POST') as Call;
    expect(jsonBody(post)).toMatchObject({
      emp_code: 'emp-009',
      name: 'New Person',
      mobile: '9876543211',
      email: null,
      designation_id: 2,
      department_id: null,
      role_id: 3,
      manager_id: 1,
      field_eligible: true,
      password: null,
    });
    // The one-time password never reaches a cache.
    const cached = JSON.stringify([
      ...client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      ...client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain('Gen3ratedPw42');

    await userEvent.click(within(shown).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent('Gen3ratedPw42');
  });

  it('shows the 403 message when the server refuses the role', async () => {
    const { user, dialog } = await openCreate(() => apiError(403, 'FORBIDDEN'));
    await user.type(within(dialog).getByLabelText('Employee code'), 'EMP-010');
    await user.type(within(dialog).getByLabelText('Full name'), 'Someone');
    await user.type(within(dialog).getByLabelText('Mobile number'), '9876543212');
    await user.selectOptions(within(dialog).getByLabelText('Designation'), 'Engineer');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'HR Admin');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You do not have permission to do this.',
    );
    expect(screen.queryByRole('dialog', { name: 'Temporary password' })).not.toBeInTheDocument();
  });

  it('shows the duplicate message', async () => {
    const { user, dialog } = await openCreate(() => apiError(409, 'DUPLICATE'));
    await user.type(within(dialog).getByLabelText('Employee code'), 'EMP-001');
    await user.type(within(dialog).getByLabelText('Full name'), 'Someone');
    await user.type(within(dialog).getByLabelText('Mobile number'), '9876543212');
    await user.selectOptions(within(dialog).getByLabelText('Designation'), 'Engineer');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Field Employee');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already in use');
  });

  it('sets the home branch, shift and the home-branch-only rule on create', async () => {
    const { calls, user, dialog } = await openCreate();
    const restrict = within(dialog).getByLabelText('Can punch only at the home branch');
    // Meaningless without a home branch: disabled, with the reason next to it.
    expect(restrict).toBeDisabled();
    expect(restrict).toHaveAccessibleDescription('Choose a home branch first.');
    expect(
      within(within(dialog).getByLabelText('Home branch (optional)'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None', 'Head Office', 'Warehouse']);

    await user.type(within(dialog).getByLabelText('Employee code'), 'EMP-011');
    await user.type(within(dialog).getByLabelText('Full name'), 'Branch Person');
    await user.type(within(dialog).getByLabelText('Mobile number'), '9876543213');
    await user.selectOptions(within(dialog).getByLabelText('Designation'), 'Engineer');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Field Employee');
    await user.selectOptions(within(dialog).getByLabelText('Home branch (optional)'), 'Warehouse');
    await user.selectOptions(within(dialog).getByLabelText('Shift (optional)'), 'General');
    expect(restrict).toBeEnabled();
    expect(within(dialog).queryByText('Choose a home branch first.')).not.toBeInTheDocument();
    await user.click(restrict);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(jsonBody(calls.find((c) => c.method === 'POST') as Call)).toMatchObject({
      home_branch_id: 2,
      shift_id: 1,
      restrict_to_home_branch: true,
    });
  });

  it('sends no branch, shift or restriction when none is chosen', async () => {
    const { calls, user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Employee code'), 'EMP-012');
    await user.type(within(dialog).getByLabelText('Full name'), 'Plain Person');
    await user.type(within(dialog).getByLabelText('Mobile number'), '9876543214');
    await user.selectOptions(within(dialog).getByLabelText('Designation'), 'Engineer');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Field Employee');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(jsonBody(calls.find((c) => c.method === 'POST') as Call)).toMatchObject({
      home_branch_id: null,
      shift_id: null,
      restrict_to_home_branch: false,
    });
  });

  it('edits the branch and shift, keeping an inactive current branch selectable', async () => {
    const closed = makeEmployee({
      id: 5,
      emp_code: 'EMP-005',
      name: 'Old Branch',
      home_branch: { id: 9, name: 'Closed Branch' },
      shift: { id: 1, name: 'General' },
      restrict_to_home_branch: true,
    });
    const { calls, user } = setup({
      list: () => ({ items: [closed], next_cursor: null }),
      routes: { 'PATCH /admin/employees/5': closed },
    });
    await screen.findByText('Old Branch');
    await choose(user, /EMP-005/, 'Old Branch', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit employee' });
    const branch = within(dialog).getByLabelText('Home branch (optional)');
    expect(branch).toHaveValue('9');
    expect(within(dialog).getByLabelText('Can punch only at the home branch')).toBeChecked();

    // Clearing the branch also drops the restriction, which cannot stand on its own.
    await user.selectOptions(branch, 'None');
    await user.selectOptions(within(dialog).getByLabelText('Shift (optional)'), 'None');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(calls.find((c) => c.method === 'PATCH') as Call)).toEqual({
      home_branch_id: null,
      shift_id: null,
      restrict_to_home_branch: false,
    });
  });

  it('edits an employee and sends only the changed fields', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/employees/2': asha } });
    await screen.findByText('Asha Rao');
    await choose(user, /EMP-001/, 'Asha Rao', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit employee' });
    expect(within(dialog).queryByLabelText('Employee code')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Password (optional)')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Full name')).toHaveValue('Asha Rao');
    await user.clear(within(dialog).getByLabelText('Full name'));
    await user.type(within(dialog).getByLabelText('Full name'), 'Asha R. Rao');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(calls.find((c) => c.method === 'PATCH') as Call)).toEqual({
      name: 'Asha R. Rao',
    });
  });
});
