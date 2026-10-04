import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeDevice, makeMe } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { DevicesPage } from './devices-page';

const pending = makeDevice();
// A first-login phone is auto-activated, so it is "active" without any admin decision.
const active = makeDevice({
  id: 8,
  user_name: 'Ravi Kumar',
  emp_code: 'EMP-002',
  model: 'iPhone 15',
  status: 'active',
  last_seen_at: '2026-02-01T18:45:00Z',
});
const revoked = makeDevice({ id: 9, model: 'Old Nokia', status: 'revoked' });

function setup(me = makeMe()) {
  let counts = { pending: 1, active: 1, revoked: 1 };
  const byStatus = { pending: [pending], active: [active], revoked: [revoked] };
  const calls = mockApi({
    'GET /me': me,
    'GET /admin/devices': (call: Call) => {
      const status = call.search.get('status') as keyof typeof byStatus | null;
      return {
        items: status ? byStatus[status] : [pending, active, revoked],
        counts,
        next_cursor: null,
      };
    },
    'PATCH /admin/devices/7': () => {
      counts = { pending: 0, active: 2, revoked: 1 };
      return pending;
    },
    'PATCH /admin/devices/8': active,
  });
  renderWithClient(<DevicesPage />);
  return { calls, user: userEvent.setup() };
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('DevicesPage', () => {
  it('lists every device by default, including an auto-activated first phone', async () => {
    const { calls } = setup();
    const row = await screen.findByRole('row', { name: /iPhone 15/ });
    expect(calls.find((c) => c.path.endsWith('/admin/devices'))?.search.has('status')).toBe(false);
    expect(tab(/^All/)).toHaveAttribute('aria-selected', 'true');
    expect(within(row).getByTestId('status-active')).toHaveTextContent('Active');
    expect(screen.getByRole('row', { name: /Pixel 8/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Old Nokia/ })).toBeInTheDocument();
  });

  it('shows the active phone under the Active tab and the counts on every tab', async () => {
    const { calls, user } = setup();
    await screen.findByText('iPhone 15');
    expect(screen.getByTestId('count-all')).toHaveTextContent('3');
    expect(screen.getByTestId('count-pending')).toHaveTextContent('1');
    expect(screen.getByTestId('count-active')).toHaveTextContent('1');
    expect(screen.getByTestId('count-revoked')).toHaveTextContent('1');
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s*\d+$/, ''))).toEqual([
      'All',
      'Pending',
      'Active',
      'Revoked',
    ]);

    await user.click(tab(/^Active/));
    const row = await screen.findByRole('row', { name: /iPhone 15/ });
    expect(tab(/^Active/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('row', { name: /Pixel 8/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.search.get('status') === 'active')).toBe(true);
    // Counts ignore the filter and stay visible.
    expect(screen.getByTestId('count-all')).toHaveTextContent('3');
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('shows last seen in IST and a status icon with its label', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /iPhone 15/ });
    // 18:45 UTC on 1 Feb is 12:15 am on 2 Feb in Asia/Kolkata.
    expect(within(row).getByText(/2 Feb 2026.*12:15/i)).toBeInTheDocument();
    expect(within(row).getByTestId('status-active').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('status-pending')).toHaveTextContent('Pending');
    expect(screen.getByTestId('status-revoked')).toHaveTextContent('Revoked');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Employee',
      'Model',
      'OS',
      'App version',
      'Last seen (IST)',
      'Status',
      'Actions',
    ]);
  });

  it('offers Approve and Reject on a pending device', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('tab', { name: /^Pending/ }));
    const row = await screen.findByRole('row', { name: /Pixel 8/ });
    expect(within(row).getByText('Asha Rao (EMP-001)')).toBeInTheDocument();
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Approve', 'Reject']);
  });

  it('explains that approving revokes the current phone, sends approve and refreshes the counts', async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole('tab', { name: /^Pending/ }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("revokes the employee's current phone");
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].path).toBe('/api/proxy/api/v1/admin/devices/7');
    expect(jsonBody(patches(calls)[0])).toEqual({ action: 'approve' });
    await waitFor(() => expect(screen.getByTestId('count-pending')).toHaveTextContent('0'));
    expect(screen.getByTestId('count-active')).toHaveTextContent('2');
  });

  it('sends reject', async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject' }),
    );
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(jsonBody(patches(calls)[0])).toEqual({ action: 'reject' });
  });

  it('sends revoke for an active device after confirmation', async () => {
    const { calls, user } = setup();
    const row = await screen.findByRole('row', { name: /iPhone 15/ });
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].path).toBe('/api/proxy/api/v1/admin/devices/8');
    expect(jsonBody(patches(calls)[0])).toEqual({ action: 'revoke' });
  });

  it('shows a clear empty state for a filter without devices', async () => {
    mockApi({
      'GET /me': makeMe(),
      'GET /admin/devices': {
        items: [],
        counts: { pending: 0, active: 0, revoked: 0 },
        next_cursor: null,
      },
    });
    renderWithClient(<DevicesPage />);
    expect(await screen.findByText('No devices found.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /^Revoked/ }));
    expect(await screen.findByText('No revoked devices found.')).toBeInTheDocument();
  });

  it('keeps the dialog open and shows the reason when the decision fails', async () => {
    mockApi({
      'GET /me': makeMe(),
      'GET /admin/devices': {
        items: [pending],
        counts: { pending: 1, active: 0, revoked: 0 },
        next_cursor: null,
      },
      'PATCH /admin/devices/7': () => apiError(409, 'CONFLICT'),
    });
    renderWithClient(<DevicesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no longer possible');
  });

  it('shows no-access without the devices.manage permission', async () => {
    const { calls } = setup(makeMe({ permissions: ['web.access', 'employees.manage'] }));
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/admin/devices'))).toBe(false);
  });
});
