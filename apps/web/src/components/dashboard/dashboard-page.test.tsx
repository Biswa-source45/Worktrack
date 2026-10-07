import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeMe, makeTaskBrief } from '@/test/fixtures';
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

describe('DashboardPage: tasks I assigned', () => {
  const ASSIGNER = ['web.access', 'tasks.create', 'team.view'];
  const person = { id: 2, name: 'Asha Rao', emp_code: 'EMP-001' };
  const open = [
    makeTaskBrief({ id: 1, code: 'T-1', title: 'Plain job', status: 'accepted' }),
    makeTaskBrief({
      id: 2,
      code: 'T-2',
      title: 'Late job',
      status: 'assigned',
      assignees: [{ user: person, status: 'assigned', escalated: true, reach_review: 'none' }],
    }),
    makeTaskBrief({
      id: 3,
      code: 'T-3',
      title: 'Far away job',
      status: 'reached',
      assignees: [{ user: person, status: 'reached', escalated: false, reach_review: 'pending' }],
    }),
    makeTaskBrief({ id: 4, code: 'T-4', title: 'Finished job', status: 'completed' }),
    makeTaskBrief({ id: 5, code: 'T-5', title: 'Second plain job', status: 'accepted' }),
  ];

  it('counts my open tasks by status, and lists the ones that need me with the reason', async () => {
    const calls = mockApi({
      'GET /me': makeMe({ name: 'Tara Assign', permissions: ASSIGNER }),
      'GET /tasks': { items: open, next_cursor: null },
    });
    renderWithClient(<DashboardPage />);
    const card = await screen.findByRole('group', { name: 'Tasks I assigned' });
    expect(await within(card).findByTestId('count-accepted')).toHaveTextContent('2');
    expect(within(card).getByTestId('count-assigned')).toHaveTextContent('1');
    expect(within(card).getByTestId('count-reached')).toHaveTextContent('1');
    expect(within(card).getByTestId('count-completed')).toHaveTextContent('1');
    expect(within(card).getByTestId('count-in_progress')).toHaveTextContent('0');

    const attention = within(card).getByRole('region', { name: 'Needs your attention' });
    const items = within(attention).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByRole('link', { name: 'Late job' })).toHaveAttribute(
      'href',
      '/tasks/2',
    );
    expect(items[0]).toHaveTextContent('Not accepted in time');
    expect(items[1]).toHaveTextContent('Reached waits for review');
    expect(items[2]).toHaveTextContent('Done, waiting to be closed');
    expect(within(attention).queryByText('Plain job')).not.toBeInTheDocument();

    const request = calls.find((c) => c.path.endsWith('/tasks'));
    expect(request?.search.get('view')).toBe('assigned_by_me');
    expect(request?.search.getAll('status')).not.toContain('closed');
  });

  it('says nothing needs attention when nothing does', async () => {
    mockApi({
      'GET /me': makeMe({ permissions: ASSIGNER }),
      'GET /tasks': { items: [open[0]], next_cursor: null },
    });
    renderWithClient(<DashboardPage />);
    expect(await screen.findByText('Nothing needs your attention.')).toBeInTheDocument();
  });

  it('is not shown, and asks for nothing, without tasks.create', async () => {
    const calls = mockApi({
      'GET /me': makeMe(),
      'GET /admin/dashboard': STATS,
    });
    renderWithClient(<DashboardPage />);
    await screen.findByTestId('stat-total');
    expect(screen.queryByRole('group', { name: 'Tasks I assigned' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/tasks'))).toBe(false);
  });

  it('shows the error and retries', async () => {
    let attempts = 0;
    mockApi({
      'GET /me': makeMe({ permissions: ASSIGNER }),
      'GET /tasks': () =>
        ++attempts === 1 ? apiError(500, 'INTERNAL') : { items: [], next_cursor: null },
    });
    renderWithClient(<DashboardPage />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('group', { name: 'Tasks I assigned' })).toBeInTheDocument();
  });
});
