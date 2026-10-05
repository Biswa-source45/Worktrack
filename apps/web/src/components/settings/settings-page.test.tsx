import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, SETTINGS, makeMe } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { SettingsPage } from './settings-page';

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /admin/settings': SETTINGS,
    ...routes,
  });
  renderWithClient(<SettingsPage />);
  return { calls, user: userEvent.setup() };
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const branchRadius = () => screen.findByLabelText('Default branch radius (m)');

describe('SettingsPage', () => {
  it('groups every setting in its card, with a helper text', async () => {
    setup();
    const geofence = await screen.findByRole('group', { name: 'Geofence' });
    expect(within(geofence).getByLabelText('Default branch radius (m)')).toHaveValue('120');
    expect(within(geofence).getByLabelText('Default home radius (m)')).toHaveValue('80');
    expect(within(geofence).getByLabelText('GPS maximum accuracy (m)')).toHaveValue('50');
    expect(within(geofence).getByLabelText('Accuracy buffer cap (m)')).toHaveValue('30');
    expect(within(geofence).getByText(/Used for a new branch.*30 to 500 m/)).toBeVisible();

    const approvals = screen.getByRole('group', { name: 'Approvals' });
    expect(within(approvals).getByLabelText('Punch-out approval levels')).toHaveValue('1');
    expect(
      within(within(approvals).getByLabelText('Regularization approval levels'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['1 level', '2 levels']);

    const app = screen.getByRole('group', { name: 'App' });
    expect(within(app).getByLabelText('Minimum app version')).toHaveValue('1.0.0');
  });

  it('shows a loading state, then an error', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    setup({
      routes: {
        'GET /admin/settings': async () => {
          await gate;
          return apiError(500, 'INTERNAL_ERROR');
        },
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
    release();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('saves only the changed fields and confirms inline', async () => {
    const { calls, user } = setup({
      routes: {
        'PATCH /admin/settings': (call: Call) => ({ ...SETTINGS, ...jsonBody(call) }),
      },
    });
    const radius = await branchRadius();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(radius);
    await user.type(radius, '150');
    await user.selectOptions(screen.getByLabelText('Regularization approval levels'), '2 levels');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Settings saved.')).toBeVisible();
    expect(patches(calls)).toHaveLength(1);
    expect(jsonBody(patches(calls)[0])).toEqual({
      geofence_default_radius_m: 150,
      regularization_approval_levels: 2,
    });
    expect(radius).toHaveValue('150');
    // Saved values are the new baseline: nothing left to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(radius, '0');
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument();
  });

  it.each([
    ['Default branch radius (m)', '29'],
    ['Default home radius (m)', '501'],
    ['GPS maximum accuracy (m)', '4'],
    ['Accuracy buffer cap (m)', '101'],
    ['Accuracy buffer cap (m)', '2.5'],
  ])('rejects %s = %s', async (label, value) => {
    const { calls, user } = setup();
    const input = await screen.findByLabelText(label);
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number within the allowed range.')).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(patches(calls)).toHaveLength(0);
  });

  it('rejects a malformed app version', async () => {
    const { calls, user } = setup();
    const input = await screen.findByLabelText('Minimum app version');
    await user.clear(input);
    await user.type(input, '1.4');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Use three numbers separated by dots/)).toBeVisible();
    expect(patches(calls)).toHaveLength(0);
  });

  it('maps a server validation error to its field', async () => {
    const { user } = setup({
      routes: {
        'PATCH /admin/settings': () =>
          apiError(422, 'VALIDATION_ERROR', [
            { loc: ['body', 'gps_max_accuracy_m'], message: 'too small', type: 'x' },
          ]),
      },
    });
    const input = await screen.findByLabelText('GPS maximum accuracy (m)');
    await user.clear(input);
    await user.type(input, '60');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/The server did not accept this value/)).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Some of the details are not valid/)).toBeVisible();
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument();
  });

  it('is read-only without settings.manage: disabled inputs, a note and no Save', async () => {
    const { calls } = setup({ permissions: ['web.access', 'settings.view'] });
    expect(await branchRadius()).toBeDisabled();
    expect(screen.getByLabelText('Punch-out approval levels')).toBeDisabled();
    expect(screen.getByLabelText('Minimum app version')).toBeDisabled();
    expect(screen.getByText(/Only a Super Admin can change settings/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await waitFor(() => expect(patches(calls)).toHaveLength(0));
  });

  it('shows no access without settings.view and asks for nothing', async () => {
    const { calls } = setup({ permissions: ['web.access', 'branches.manage'] });
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/admin/settings'))).toBe(false);
  });
});
