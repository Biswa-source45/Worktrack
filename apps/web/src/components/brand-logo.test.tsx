import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN, makeMe } from '@/test/fixtures';
import { mockApi, renderWithClient } from '@/test/render';
import { AppShell } from './app-shell';
import { AuthLayout } from './auth/auth-layout';
import { BrandLogo } from './brand-logo';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/employees',
}));

const files = (logo: HTMLElement) =>
  within(logo)
    .getAllByRole('presentation', { hidden: true })
    .map((img) => img.getAttribute('src'));

describe('BrandLogo', () => {
  it('is one labelled image for a screen reader, with both theme files inside it', () => {
    render(<BrandLogo variant="full" label="WorkTrack" className="w-72" />);
    const logo = screen.getByRole('img', { name: 'WorkTrack' });
    expect(logo).toHaveClass('w-72');
    expect(files(logo)).toEqual(['/brand/logo-light.png', '/brand/logo-dark.png']);
  });

  it('shows the light file on a light theme and the dark file on a dark theme (CSS, no script)', () => {
    render(<BrandLogo variant="compact" label="WorkTrack" />);
    const [light, dark] = within(screen.getByRole('img', { name: 'WorkTrack' })).getAllByRole(
      'presentation',
      { hidden: true },
    );
    expect(light).toHaveClass('dark:hidden');
    expect(dark).toHaveClass('hidden', 'dark:block');
  });

  it.each([
    ['full', ['/brand/logo-light.png', '/brand/logo-dark.png']],
    ['compact', ['/brand/logo-compact-light.png', '/brand/logo-compact-dark.png']],
    ['mark', ['/brand/mark-light.png', '/brand/mark-dark.png']],
  ] as const)('uses the %s files', (variant, expected) => {
    render(<BrandLogo variant={variant} label="WorkTrack" />);
    expect(files(screen.getByRole('img', { name: 'WorkTrack' }))).toEqual(expected);
  });
});

describe('where the logo is placed', () => {
  it('shows the full logo on the sign-in pages, named WorkTrack, with no duplicate tagline text', () => {
    renderWithClient(
      <AuthLayout>
        <p>the form</p>
      </AuthLayout>,
    );
    const logo = screen.getByRole('img', { name: 'WorkTrack' });
    expect(files(logo)).toEqual(['/brand/logo-light.png', '/brand/logo-dark.png']);
    expect(screen.queryByText(/Attendance and field tasks/)).not.toBeInTheDocument();
  });

  it('shows the compact logo as the sidebar home link, and only the W once the rail is collapsed', async () => {
    cleanup();
    localStorage.clear();
    mockApi({ 'GET /me': makeMe({ permissions: ADMIN }) });
    renderWithClient(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );
    const home = await screen.findAllByRole('link', { name: 'WorkTrack Admin' });
    expect(files(within(home[0]).getByRole('img'))).toEqual([
      '/brand/logo-compact-light.png',
      '/brand/logo-compact-dark.png',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const rail = (await screen.findAllByRole('link', { name: 'WorkTrack Admin' }))[0];
    expect(files(within(rail).getByRole('img'))).toEqual([
      '/brand/mark-light.png',
      '/brand/mark-dark.png',
    ]);
    localStorage.clear();
  });
});
