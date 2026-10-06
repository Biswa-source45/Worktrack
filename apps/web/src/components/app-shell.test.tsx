import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, makeMe } from '@/test/fixtures';
import { mockApi, renderWithClient } from '@/test/render';
import { AppShell } from './app-shell';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/employees',
}));

beforeEach(() => router.replace.mockReset());

function shell(me: ReturnType<typeof makeMe>) {
  const calls = mockApi({
    'GET /me': me,
    'POST /api/auth/logout': new Response(null, { status: 204 }),
  });
  renderWithClient(
    <AppShell>
      <p>page content</p>
    </AppShell>,
  );
  return calls;
}

describe('AppShell', () => {
  it('shows the nav items the permissions allow', async () => {
    shell(makeMe({ permissions: ['web.access', 'employees.manage'] }));
    expect(await screen.findByRole('link', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Devices' })).not.toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('shows both items for an admin', async () => {
    shell(makeMe());
    expect(await screen.findByRole('link', { name: 'Devices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Employees' })).toBeInTheDocument();
  });

  it('shows Sessions only with the devices.manage permission', async () => {
    shell(makeMe());
    const sessions = await screen.findByRole('link', { name: 'Sessions' });
    expect(sessions).toHaveAttribute('href', '/sessions');
    expect(
      within(screen.getByRole('navigation'))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Employees', 'Attendance', 'Devices', 'Sessions']);
    cleanup();

    shell(makeMe({ permissions: ['web.access', 'employees.manage'] }));
    expect(await screen.findByRole('link', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sessions' })).not.toBeInTheDocument();
  });

  it('shows Branches, Shifts and Settings to those who may use them', async () => {
    shell(makeMe({ permissions: ADMIN }));
    await screen.findByRole('link', { name: 'Branches' });
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Employees', '/employees'],
      ['Attendance', '/attendance'],
      ['Branches', '/branches'],
      ['Shifts', '/shifts'],
      ['Devices', '/devices'],
      ['Sessions', '/sessions'],
      ['Settings', '/settings'],
    ]);
    cleanup();

    // Branches and shifts go with branches.manage; Settings needs only settings.view.
    shell(makeMe({ permissions: ['web.access', 'settings.view'] }));
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Branches' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Shifts' })).not.toBeInTheDocument();
    cleanup();

    shell(makeMe({ permissions: ['web.access', 'branches.manage'] }));
    expect(await screen.findByRole('link', { name: 'Shifts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Branches' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it.each([['team.view'], ['attendance.view_all'], ['punchout.approve'], ['face.review']])(
    'shows Attendance to anyone holding %s, and to no one else',
    async (permission) => {
      shell(makeMe({ permissions: ['web.access', permission] }));
      const link = await screen.findByRole('link', { name: 'Attendance' });
      expect(link).toHaveAttribute('href', '/attendance');
      expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
      cleanup();

      shell(makeMe({ permissions: ['web.access', 'devices.manage'] }));
      expect(await screen.findByRole('link', { name: 'Devices' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Attendance' })).not.toBeInTheDocument();
    },
  );

  it('has the seven links of a full admin', async () => {
    shell(makeMe({ permissions: [...ADMIN, 'attendance.view_all'] }));
    await screen.findByRole('link', { name: 'Attendance' });
    expect(within(screen.getByRole('navigation')).getAllByRole('link')).toHaveLength(7);
  });

  it('tells a user with neither permission that there is no access', async () => {
    shell(makeMe({ permissions: ['web.access', 'tasks.view'] }));
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')?.children).toHaveLength(0);
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('sends a user who must change the password to /change-password', async () => {
    shell(makeMe({ must_change_password: true }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/change-password'));
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('shows the backend health indicator in the header', async () => {
    shell(makeMe());
    expect(await screen.findByTestId('health-indicator')).toBeInTheDocument();
  });

  it('signs out through the logout route and returns to /login', async () => {
    const calls = shell(makeMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/logout')).toBe(true);
  });
});
