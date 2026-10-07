import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, SETTINGS, TASK_TYPES, makeMe } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { SettingsPage } from './settings-page';

type Options = { permissions?: string[]; routes?: Record<string, unknown> };

function setup({ permissions = ADMIN, routes = {} }: Options = {}) {
  const calls = mockApi({
    'GET /me': makeMe({ permissions }),
    'GET /admin/settings': SETTINGS,
    'GET /admin/task-types': [
      ...TASK_TYPES,
      { ...TASK_TYPES[0], id: 3, name: 'Old Type', is_active: false },
    ],
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

  it('shows the face matching settings with their current values', async () => {
    setup();
    const face = await screen.findByRole('group', { name: 'Face matching' });
    expect(within(face).getByLabelText('Verify threshold')).toHaveValue('0.4');
    expect(within(face).getByLabelText('Review threshold')).toHaveValue('0.3');
    expect(within(face).getByLabelText('Minimum face confidence')).toHaveValue('0.9');
    expect(within(face).getByLabelText('Minimum face width (px)')).toHaveValue('80');
    expect(within(face).getByLabelText('Minimum sharpness')).toHaveValue('60');
    expect(within(face).getByLabelText('Minimum brightness')).toHaveValue('50');
    expect(within(face).getByLabelText('Maximum brightness')).toHaveValue('200');
    expect(within(face).getByLabelText('Keep face data after exit (days)')).toHaveValue('30');
    expect(within(face).getByLabelText('Verify threshold')).toHaveAttribute('inputmode', 'decimal');
    expect(within(face).getByText(/accepted automatically/)).toBeVisible();
  });

  it('shows the attendance settings with their current values', async () => {
    setup();
    const attendance = await screen.findByRole('group', { name: 'Attendance' });
    const cutoff = within(attendance).getByLabelText('Attendance cut-off time (IST)');
    expect(cutoff).toHaveValue('23:59');
    expect(cutoff).toHaveAttribute('type', 'time');
    expect(
      within(attendance).getByLabelText('Punch-out reminder after shift end (min)'),
    ).toHaveValue('30');
    expect(within(attendance).getByLabelText('Punch-out request expiry (hours)')).toHaveValue('48');
    expect(within(attendance).getByLabelText('Maximum travel speed (km/h)')).toHaveValue('150');
    expect(within(attendance).getByLabelText('Offline punch maximum age (hours)')).toHaveValue(
      '12',
    );
    expect(within(attendance).getByText(/After this time a day is closed/)).toBeVisible();
    // It sits after Face matching, as its own card.
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups.indexOf('Attendance')).toBe(groups.indexOf('Face matching') + 1);
  });

  it('saves the attendance settings, sending only what changed', async () => {
    const { calls, user } = setup({
      routes: { 'PATCH /admin/settings': (call: Call) => ({ ...SETTINGS, ...jsonBody(call) }) },
    });
    const speed = await screen.findByLabelText('Maximum travel speed (km/h)');
    await user.clear(speed);
    await user.type(speed, '120');
    fireEvent.change(screen.getByLabelText('Attendance cut-off time (IST)'), {
      target: { value: '22:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeVisible();
    expect(jsonBody(patches(calls)[0])).toEqual({
      punch_max_speed_kmh: 120,
      attendance_cutoff_time: '22:30',
    });
  });

  it.each([
    ['Punch-out reminder after shift end (min)', '241'],
    ['Punch-out request expiry (hours)', '0'],
    ['Punch-out request expiry (hours)', '241'],
    ['Maximum travel speed (km/h)', '19'],
    ['Maximum travel speed (km/h)', '1001'],
    ['Offline punch maximum age (hours)', '0'],
    ['Offline punch maximum age (hours)', '25'],
    ['Offline punch maximum age (hours)', '2.5'],
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

  it('accepts the edges of the allowed ranges', async () => {
    const { calls, user } = setup({
      routes: { 'PATCH /admin/settings': (call: Call) => ({ ...SETTINGS, ...jsonBody(call) }) },
    });
    for (const [label, value] of [
      ['Punch-out reminder after shift end (min)', '0'],
      ['Punch-out request expiry (hours)', '240'],
      ['Maximum travel speed (km/h)', '20'],
      ['Offline punch maximum age (hours)', '24'],
    ]) {
      const input = await screen.findByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeVisible();
    expect(jsonBody(patches(calls)[0])).toEqual({
      punch_reminder_after_shift_end_min: 0,
      punch_out_request_expiry_hours: 240,
      punch_max_speed_kmh: 20,
      offline_punch_max_age_hours: 24,
    });
  });

  it('rejects an empty cut-off time', async () => {
    const { calls, user } = setup();
    const cutoff = await screen.findByLabelText('Attendance cut-off time (IST)');
    fireEvent.change(cutoff, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a time as HH:MM, for example 23:59.')).toBeVisible();
    expect(cutoff).toHaveAttribute('aria-invalid', 'true');
    expect(patches(calls)).toHaveLength(0);
  });

  it('saves a pair of thresholds with decimals', async () => {
    const { calls, user } = setup({
      routes: { 'PATCH /admin/settings': (call: Call) => ({ ...SETTINGS, ...jsonBody(call) }) },
    });
    const verify = await screen.findByLabelText('Verify threshold');
    const review = screen.getByLabelText('Review threshold');
    await user.clear(verify);
    await user.type(verify, '0.45');
    await user.clear(review);
    await user.type(review, '0.35');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeVisible();
    expect(jsonBody(patches(calls)[0])).toEqual({
      face_verify_threshold: 0.45,
      face_review_threshold: 0.35,
    });
  });

  it.each([
    ['Verify threshold', '0.95'],
    ['Verify threshold', 'high'],
    ['Review threshold', '0.05'],
    ['Minimum face confidence', '1'],
    ['Minimum face width (px)', '10.5'],
    ['Minimum sharpness', '0'],
    ['Maximum brightness', '256'],
    ['Keep face data after exit (days)', '-1'],
  ])('rejects %s = %s', async (label, value) => {
    const { calls, user } = setup();
    const input = await screen.findByLabelText(label);
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Enter a (whole )?number within the allowed range\./),
    ).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(patches(calls)).toHaveLength(0);
  });

  it.each([
    ['Review threshold', '0.4', 'The review threshold must be below the verify threshold.'],
    ['Review threshold', '0.5', 'The review threshold must be below the verify threshold.'],
    ['Minimum brightness', '200', 'The minimum brightness must be below the maximum.'],
  ])('rejects %s = %s when it breaks a rule between two settings', async (label, value, rule) => {
    const { calls, user } = setup();
    const input = await screen.findByLabelText(label);
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(rule)).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(patches(calls)).toHaveLength(0);
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
    expect(screen.getByLabelText('Maximum travel speed (km/h)')).toBeDisabled();
    expect(screen.getByLabelText('Attendance cut-off time (IST)')).toBeDisabled();
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

describe('SettingsPage: field tasks', () => {
  it('shows the task defaults and saves a changed radius', async () => {
    const { calls, user } = setup({ routes: { 'PATCH /admin/settings': SETTINGS } });
    const card = await screen.findByRole('group', { name: 'Field tasks' });
    expect(within(card).getByLabelText('Default site radius (m)')).toHaveValue('200');
    expect(within(card).getByLabelText('Not-accepted alert after (min)')).toHaveValue('30');
    const radius = within(card).getByLabelText('Default site radius (m)');
    await user.clear(radius);
    await user.type(radius, '250');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(jsonBody(patches(calls)[0])).toEqual({ task_default_site_radius_m: 250 });
  });

  it('refuses an alert time the server would refuse', async () => {
    const { calls, user } = setup();
    const alert = await screen.findByLabelText('Not-accepted alert after (min)');
    await user.clear(alert);
    await user.type(alert, '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Enter a whole number within the allowed range.'),
    ).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });
});

describe('SettingsPage: task types', () => {
  it('lists every type with its proof rule, and marks a switched-off one', async () => {
    setup();
    const card = await screen.findByRole('group', { name: 'Task types' });
    const site = (await within(card).findByText('Site Visit')).closest('li') as HTMLElement;
    expect(within(site).getByText('Photo')).toBeInTheDocument();
    const documents = within(card).getByText('Document Submission').closest('li') as HTMLElement;
    expect(within(documents).getByText('Receipt photo')).toBeInTheDocument();
    const old = within(card).getByText('Old Type').closest('li') as HTMLElement;
    expect(within(old).getByText('Inactive')).toBeInTheDocument();
  });

  it('adds a type, and needs a name first', async () => {
    const { calls, user } = setup({
      routes: { 'POST /admin/task-types': { ...TASK_TYPES[0], id: 9, name: 'Survey' } },
    });
    const card = await screen.findByRole('group', { name: 'Task types' });
    await user.click(await within(card).findByRole('button', { name: 'Add type' }));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('This field is required.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(card).getByLabelText('Name'), '  Survey  ');
    await user.selectOptions(within(card).getByLabelText('Proof is a'), 'receipt');
    await user.click(within(card).getByRole('checkbox', { name: /proof photo is required/ }));
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(jsonBody(calls.find((c) => c.method === 'POST') as Call)).toEqual({
      name: 'Survey',
      proof_photo_required: false,
      proof_kind: 'receipt',
    });
  });

  it('renames a type and can switch it off', async () => {
    const { calls, user } = setup({
      routes: { 'PATCH /admin/task-types/1': { ...TASK_TYPES[0], name: 'Visit' } },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit Site Visit' }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Site Visit');
    await user.clear(name);
    await user.type(name, 'Visit');
    await user.click(screen.getByRole('checkbox', { name: /Active/ }));
    await user.click(
      within(screen.getByRole('group', { name: 'Task types' })).getByRole('button', {
        name: 'Save',
      }),
    );
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(jsonBody(patches(calls)[0])).toEqual({
      name: 'Visit',
      proof_photo_required: true,
      proof_kind: 'photo',
      is_active: false,
    });
  });

  it('says so when the name is taken', async () => {
    const { user } = setup({
      routes: { 'PATCH /admin/task-types/1': () => apiError(409, 'DUPLICATE') },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit Site Visit' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Task types' })).getByRole('button', {
        name: 'Save',
      }),
    );
    expect(
      await screen.findByText('A task type with this name already exists.'),
    ).toBeInTheDocument();
  });

  it('is read-only without settings.manage', async () => {
    setup({ permissions: ['web.access', 'settings.view'] });
    const card = await screen.findByRole('group', { name: 'Task types' });
    expect(await within(card).findByText('Site Visit')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Add type' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });
});
