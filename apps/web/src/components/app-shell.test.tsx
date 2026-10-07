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
    ).toEqual(['Dashboard', 'Tasks', 'Attendance', 'Employees', 'Devices', 'Sessions']);
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
      ['Dashboard', '/'],
      ['Tasks', '/tasks'],
      ['Attendance', '/attendance'],
      ['Employees', '/employees'],
      ['Devices', '/devices'],
      ['Sessions', '/sessions'],
      ['Branches', '/branches'],
      ['Shifts', '/shifts'],
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

  // The top bar's seven links became a sidebar of nine in M5: Dashboard and Tasks were added.
  it('has the nine links of a full admin, in four groups', async () => {
    shell(makeMe({ permissions: [...ADMIN, 'attendance.view_all'] }));
    await screen.findByRole('link', { name: 'Attendance' });
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('link')).toHaveLength(9);
    expect(
      within(nav)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Overview', 'Work', 'People', 'Organisation']);
  });

  it.each([['tasks.create'], ['tasks.view_all'], ['team.view']])(
    'shows Tasks to anyone holding %s, and to no one else',
    async (permission) => {
      shell(makeMe({ permissions: ['web.access', permission] }));
      expect(await screen.findByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
      cleanup();

      shell(makeMe({ permissions: ['web.access', 'devices.manage'] }));
      await screen.findByRole('link', { name: 'Devices' });
      expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
    },
  );

  it('marks the current page and puts the sliding fill only behind it', async () => {
    shell(makeMe());
    const current = await screen.findByRole('link', { name: 'Employees' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.querySelector('.bg-primary')).not.toBeNull();
    const other = screen.getByRole('link', { name: 'Devices' });
    expect(other).not.toHaveAttribute('aria-current');
    expect(other.querySelector('.bg-primary')).toBeNull();
  });

  it('collapses to an icon rail, keeps the names as tooltips and remembers the choice', async () => {
    shell(makeMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('link', { name: 'Employees' })).toHaveAttribute('title', 'Employees');
    expect(localStorage.getItem('wt-sidebar-collapsed')).toBe('1');
    cleanup();

    // A new visit starts collapsed, and one more click expands it again.
    shell(makeMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Employees' })).not.toHaveAttribute('title');
    expect(localStorage.getItem('wt-sidebar-collapsed')).toBe('0');
  });

  it('still collapses when the browser refuses local storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    shell(makeMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('opens the menu as a drawer, and Escape or its close button closes it', async () => {
    shell(makeMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(drawer).getByRole('link', { name: 'Devices' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const again = await screen.findByRole('dialog', { name: 'Menu' });
    await userEvent.click(within(again).getByRole('button', { name: 'Close menu' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
