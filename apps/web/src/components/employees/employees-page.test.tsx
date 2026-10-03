import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DEPARTMENTS, DESIGNATIONS, ROLES, makeEmployee, makeMe } from '@/test/fixtures';
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
    setup();
    await screen.findByText('Locked Larry');
    const names = (r: HTMLElement) =>
      within(r)
        .getAllByRole('button')
        .map((b) => b.textContent);
    expect(names(row(/EMP-001/))).toEqual(['Edit', 'Deactivate', 'Reset password']);
    expect(names(row(/EMP-002/))).toEqual(['Edit', 'Reactivate', 'Reset password']);
    expect(names(row(/EMP-003/))).toEqual(['Edit', 'Deactivate', 'Unlock', 'Reset password']);
    expect(names(row(/ADMIN-1/))).toEqual(['Edit', 'Reset password']);
    expect(within(row(/EMP-003/)).getByText('Locked')).toBeInTheDocument();
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
    await user.click(within(row(/EMP-001/)).getByRole('button', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(jsonBody(patch as Call)).toEqual({ status: 'inactive' });
  });

  it('reactivates an inactive employee', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/employees/3': ravi } });
    await screen.findByText('Ravi Kumar');
    await user.click(within(row(/EMP-002/)).getByRole('button', { name: 'Reactivate' }));
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
    await user.click(within(row(/EMP-001/)).getByRole('button', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still has active reports');
  });

  it('unlocks a locked account', async () => {
    const { calls, user } = setup({ routes: { 'POST /admin/employees/4/unlock': locked } });
    await screen.findByText('Locked Larry');
    await user.click(within(row(/EMP-003/)).getByRole('button', { name: 'Unlock' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/employees/4/unlock'))).toBe(true),
    );
  });

  it('shows the temporary password once after a reset, then forgets it', async () => {
    const { client, user } = setup({
      routes: { 'POST /admin/employees/2/reset-password': { temporary_password: 'Zk7mPq2xVb9n' } },
    });
    await screen.findByText('Asha Rao');
    await user.click(within(row(/EMP-001/)).getByRole('button', { name: 'Reset password' }));
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
    await user.click(within(row(/EMP-001/)).getByRole('button', { name: 'Reset password' }));
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

  it('edits an employee and sends only the changed fields', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/employees/2': asha } });
    await screen.findByText('Asha Rao');
    await user.click(within(row(/EMP-001/)).getByRole('button', { name: 'Edit' }));
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
