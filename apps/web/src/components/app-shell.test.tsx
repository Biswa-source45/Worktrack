import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMe } from '@/test/fixtures';
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

  it('tells a user with neither permission that there is no access', async () => {
    shell(makeMe({ permissions: ['web.access', 'team.view'] }));
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')?.children).toHaveLength(0);
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('sends a user who must change the password to /change-password', async () => {
    shell(makeMe({ must_change_password: true }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/change-password'));
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('signs out through the logout route and returns to /login', async () => {
    const calls = shell(makeMe());
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/logout')).toBe(true);
  });
});
