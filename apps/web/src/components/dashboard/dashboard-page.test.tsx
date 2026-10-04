import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeMe } from '@/test/fixtures';
import { apiError, mockApi, renderWithClient } from '@/test/render';
import { DashboardPage } from './dashboard-page';

const STATS = {
  employees_total: 31,
  employees_active: 28,
  employees_inactive: 3,
  pending_devices: 2,
};

describe('DashboardPage', () => {
  it('greets the user and shows the real counts', async () => {
    mockApi({ 'GET /me': makeMe(), 'GET /admin/dashboard': STATS });
    renderWithClient(<DashboardPage />);
    expect(await screen.findByRole('heading', { name: 'Welcome, Demo Admin' })).toBeInTheDocument();
    expect(await screen.findByTestId('stat-total')).toHaveTextContent('31');
    expect(screen.getByTestId('stat-active')).toHaveTextContent('28');
    expect(screen.getByTestId('stat-inactive')).toHaveTextContent('3');
    expect(screen.getByTestId('stat-pending-devices')).toHaveTextContent('2');
    const card = screen.getByRole('group', { name: 'Pending devices' });
    expect(within(card).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/devices');
  });

  it('shows a loading state before the counts arrive', async () => {
    mockApi({ 'GET /me': makeMe(), 'GET /admin/dashboard': () => new Promise(() => {}) });
    renderWithClient(<DashboardPage />);
    expect(await screen.findByText('Loading...')).toBeInTheDocument();
  });

  it('shows only the greeting, without any request, when employees.manage is missing', async () => {
    const calls = mockApi({
      'GET /me': makeMe({ name: 'Tara Assign', permissions: ['web.access', 'team.view'] }),
    });
    renderWithClient(<DashboardPage />);
    expect(
      await screen.findByRole('heading', { name: 'Welcome, Tara Assign' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/administrators who manage employees/)).toBeInTheDocument();
    expect(screen.queryByTestId('stat-total')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/admin/dashboard'))).toBe(false);
  });

  it('hides the Review link without devices.manage', async () => {
    mockApi({
      'GET /me': makeMe({ permissions: ['web.access', 'employees.manage'] }),
      'GET /admin/dashboard': STATS,
    });
    renderWithClient(<DashboardPage />);
    expect(await screen.findByTestId('stat-total')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
  });

  it('shows the error and retries', async () => {
    let fail = true;
    mockApi({
      'GET /me': makeMe(),
      'GET /admin/dashboard': () => (fail ? apiError(500, 'GENERIC') : STATS),
    });
    renderWithClient(<DashboardPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('stat-total')).toHaveTextContent('31');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
