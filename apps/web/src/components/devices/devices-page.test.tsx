import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeDevice, makeMe } from '@/test/fixtures';
import { apiError, jsonBody, mockApi, renderWithClient, type Call } from '@/test/render';
import { DevicesPage } from './devices-page';

const pending = makeDevice();
const active = makeDevice({
  id: 8,
  user_name: 'Ravi Kumar',
  emp_code: 'EMP-002',
  model: 'iPhone 15',
  status: 'active',
});

function setup(me = makeMe()) {
  const calls = mockApi({
    'GET /me': me,
    'GET /admin/devices': (call: Call) => ({
      items: call.search.get('status') === 'active' ? [active] : [pending],
      next_cursor: null,
    }),
    'PATCH /admin/devices/7': pending,
    'PATCH /admin/devices/8': active,
  });
  renderWithClient(<DevicesPage />);
  return { calls, user: userEvent.setup() };
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');

describe('DevicesPage', () => {
  it('lists pending devices by default with times in IST', async () => {
    const { calls } = setup();
    const row = await screen.findByRole('row', { name: /Pixel 8/ });
    expect(calls.find((c) => c.path.endsWith('/admin/devices'))?.search.get('status')).toBe(
      'pending',
    );
    // 04:30 UTC is 10:00 in Asia/Kolkata.
    expect(within(row).getByText(/15 Jan 2026.*10:00/i)).toBeInTheDocument();
    expect(within(row).getByText('Asha Rao (EMP-001)')).toBeInTheDocument();
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Approve', 'Reject']);
  });

  it('explains that approving revokes the current phone, then sends approve', async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("revokes the employee's current phone");
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].path).toBe('/api/proxy/api/v1/admin/devices/7');
    expect(jsonBody(patches(calls)[0])).toEqual({ action: 'approve' });
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

  it('shows active devices with only a Revoke action and sends revoke', async () => {
    const { calls, user } = setup();
    await screen.findByText('Pixel 8');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'active');
    const row = await screen.findByRole('row', { name: /iPhone 15/ });
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Revoke']);
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].path).toBe('/api/proxy/api/v1/admin/devices/8');
    expect(jsonBody(patches(calls)[0])).toEqual({ action: 'revoke' });
  });

  it('keeps the dialog open and shows the reason when the decision fails', async () => {
    mockApi({
      'GET /me': makeMe(),
      'GET /admin/devices': { items: [pending], next_cursor: null },
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
