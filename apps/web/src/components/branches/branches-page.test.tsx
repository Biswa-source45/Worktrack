import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN, SETTINGS, makeBranch, makeMe } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { BranchesPage } from './branches-page';

vi.mock('@/components/map/geofence-map', () => import('@/test/map-stub'));

const head = makeBranch();
const depot = makeBranch({
  id: 2,
  name: 'Depot',
  address: null,
  radius_m: 250,
  is_active: false,
});

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /admin/settings': SETTINGS,
    'GET /admin/branches': { items: [head, depot], next_cursor: null },
    ...routes,
  });
  renderWithClient(<BranchesPage />);
  return { calls, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

async function openCreate(user: User) {
  const add = await screen.findByRole('button', { name: 'Add branch' });
  await waitFor(() => expect(add).toBeEnabled());
  await user.click(add);
  return screen.findByRole('dialog', { name: 'Add branch' });
}

async function choose(user: User, branch: string, item: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${branch}` }));
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
}

const sent = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

describe('BranchesPage list', () => {
  it('shows a skeleton, then name, address, radius and status with icon and label', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    setup({
      routes: {
        'GET /admin/branches': async () => {
          await gate;
          return { items: [head, depot], next_cursor: null };
        },
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
    release();
    const row = await screen.findByRole('row', { name: /Head Office/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 4)
        .map((c) => c.textContent),
    ).toEqual(['Head Office', '12 MG Road, Bhubaneswar', '100 m', 'Active']);
    const inactive = within(screen.getByRole('row', { name: /Depot/ })).getByTestId(
      'status-inactive',
    );
    expect(inactive).toHaveTextContent('Inactive');
    expect(inactive.querySelector('svg')).not.toBeNull();
  });

  it('shows the empty state', async () => {
    setup({ routes: { 'GET /admin/branches': { items: [], next_cursor: null } } });
    expect(await screen.findByText(/No branches yet/)).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    setup({ routes: { 'GET /admin/branches': () => apiError(500, 'INTERNAL_ERROR') } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('shows no access without branches.manage and asks for nothing', async () => {
    const { calls } = setup({ permissions: ['web.access', 'employees.manage'] });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/admin/branches'))).toBe(false);
  });
});

describe('Branch dialog', () => {
  it('creates a branch with the default radius from Settings and the pin from the map', async () => {
    const { calls, user } = setup({ routes: { 'POST /admin/branches': head } });
    const dialog = await openCreate(user);
    expect(within(dialog).getByLabelText('Geofence radius (30 to 500 m)')).toHaveValue(120);
    await user.type(within(dialog).getByLabelText('Branch name'), ' Head Office ');
    await user.click(await within(dialog).findByRole('button', { name: 'move pin' }));
    // The circle follows the radius field.
    expect(within(dialog).getByTestId('map')).toHaveAttribute('data-radius', '120');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'POST')[0])).toEqual({
      name: 'Head Office',
      address: null,
      lat: 12.971599,
      lng: 77.594563,
      radius_m: 120,
    });
    // The list is fetched again after the change.
    expect(sent(calls, 'GET').filter((c) => c.path.endsWith('/admin/branches'))).toHaveLength(2);
  });

  it('leaves the radius to the server when the user cannot read Settings', async () => {
    const { calls, user } = setup({
      permissions: ['web.access', 'branches.manage'],
      routes: { 'POST /admin/branches': head },
    });
    const dialog = await openCreate(user);
    expect(within(dialog).getByLabelText('Geofence radius (30 to 500 m)')).toHaveValue(null);
    expect(within(dialog).getByText('Leave empty to use the organisation default.')).toBeVisible();
    await user.type(within(dialog).getByLabelText('Branch name'), 'Depot');
    await user.type(within(dialog).getByLabelText('Address (optional)'), 'Plot 4');
    await user.type(within(dialog).getByLabelText('Latitude'), '20.3');
    await user.type(within(dialog).getByLabelText('Longitude'), '85.8');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent(calls, 'POST')).toHaveLength(1));
    expect(jsonBody(sent(calls, 'POST')[0])).toEqual({
      name: 'Depot',
      address: 'Plot 4',
      lat: 20.3,
      lng: 85.8,
    });
    expect(calls.some((c) => c.path.endsWith('/admin/settings'))).toBe(false);
  });

  it.each(['29', '501', '99.5'])('rejects a radius of %s and sends nothing', async (value) => {
    const { calls, user } = setup();
    const dialog = await openCreate(user);
    const radius = within(dialog).getByLabelText('Geofence radius (30 to 500 m)');
    await user.clear(radius);
    await user.type(radius, value);
    await user.type(within(dialog).getByLabelText('Branch name'), 'Depot');
    await user.click(await within(dialog).findByRole('button', { name: 'move pin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a whole number from 30 to 500.')).toBeVisible();
    expect(radius).toHaveAttribute('aria-invalid', 'true');
    expect(sent(calls, 'POST')).toHaveLength(0);
  });

  it('requires a name and a pin', async () => {
    const { calls, user } = setup();
    const dialog = await openCreate(user);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('This field is required.')).toBeVisible();
    expect(within(dialog).getByText('Enter a latitude from -90 to 90.')).toBeVisible();
    expect(within(dialog).getByText('Enter a longitude from -180 to 180.')).toBeVisible();
    expect(sent(calls, 'POST')).toHaveLength(0);
  });

  it('fills an empty name from a pasted link, but keeps a typed one', async () => {
    const { user } = setup({
      routes: {
        'POST /admin/geo/resolve-link': { lat: 20.2961, lng: 85.8245, name: 'Linked Place' },
      },
    });
    const dialog = await openCreate(user);
    const link = within(dialog).getByLabelText('Paste a Google Maps link');
    await user.type(link, 'https://maps.app.goo.gl/abc');
    await user.click(within(dialog).getByRole('button', { name: 'Use link' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Branch name')).toHaveValue('Linked Place'),
    );
    expect(within(dialog).getByLabelText('Latitude')).toHaveValue(20.2961);

    await user.clear(within(dialog).getByLabelText('Branch name'));
    await user.type(within(dialog).getByLabelText('Branch name'), 'My name');
    await user.type(link, 'https://maps.app.goo.gl/def');
    await user.click(within(dialog).getByRole('button', { name: 'Use link' }));
    await waitFor(() => expect(link).toHaveValue(''));
    expect(within(dialog).getByLabelText('Branch name')).toHaveValue('My name');
  });

  it('shows the link error inside the dialog', async () => {
    const { user } = setup({
      routes: { 'POST /admin/geo/resolve-link': () => apiError(422, 'LINK_NOT_RESOLVED') },
    });
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Paste a Google Maps link'), 'https://x.test');
    await user.click(within(dialog).getByRole('button', { name: 'Use link' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No location could be read from that link.',
    );
  });

  it('edits a branch and sends only what changed', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/branches/1': head } });
    await choose(user, 'Head Office', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit branch' });
    expect(within(dialog).getByLabelText('Branch name')).toHaveValue('Head Office');
    expect(within(dialog).getByTestId('map')).toHaveAttribute('data-center', '20.2961,85.8245');
    const radius = within(dialog).getByLabelText('Geofence radius (30 to 500 m)');
    await user.clear(radius);
    await user.type(radius, '150');
    await user.clear(within(dialog).getByLabelText('Address (optional)'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'PATCH')[0])).toEqual({ address: null, radius_m: 150 });
  });

  it('needs a radius when editing', async () => {
    const { calls, user } = setup();
    await choose(user, 'Head Office', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit branch' });
    await user.clear(within(dialog).getByLabelText('Geofence radius (30 to 500 m)'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a whole number from 30 to 500.')).toBeVisible();
    expect(sent(calls, 'PATCH')).toHaveLength(0);
  });

  it('shows a duplicate name from the server', async () => {
    const { user } = setup({
      routes: { 'POST /admin/branches': () => apiError(409, 'DUPLICATE') },
    });
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Branch name'), 'Head Office');
    await user.click(await within(dialog).findByRole('button', { name: 'move pin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A branch with that name already exists.',
    );
  });

  it('marks the field a server validation error names', async () => {
    const { user } = setup({
      routes: {
        'POST /admin/branches': () =>
          apiError(422, 'VALIDATION_ERROR', [
            {
              loc: ['body', 'lat'],
              message: 'Input should be less than or equal to 90',
              type: 'x',
            },
          ]),
      },
    });
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Branch name'), 'Depot');
    await user.click(await within(dialog).findByRole('button', { name: 'move pin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'The server did not accept this value. Check it and try again.',
      ),
    ).toBeVisible();
    expect(within(dialog).getByLabelText('Latitude')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText(/Some of the details are not valid/)).toBeVisible();
  });
});

describe('Branch activate and deactivate', () => {
  it('deactivates after confirmation', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/branches/1': head } });
    await choose(user, 'Head Office', 'Deactivate');
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate' });
    expect(dialog).toHaveTextContent('Deactivate Head Office?');
    expect(sent(calls, 'PATCH')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jsonBody(sent(calls, 'PATCH')[0])).toEqual({ is_active: false });
  });

  it('activates an inactive branch', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/branches/2': depot } });
    await choose(user, 'Depot', 'Activate');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Activate' }),
    );
    await waitFor(() => expect(sent(calls, 'PATCH')).toHaveLength(1));
    expect(jsonBody(sent(calls, 'PATCH')[0])).toEqual({ is_active: true });
  });
});
