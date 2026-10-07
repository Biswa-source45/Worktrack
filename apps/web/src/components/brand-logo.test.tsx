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

describe('the sign-in card and the collapsed rail', () => {
  it('has the logo inside the form card, above the form', () => {
    renderWithClient(
      <AuthLayout>
        <p>the form</p>
      </AuthLayout>,
    );
    const card = screen.getByText('the form').parentElement as HTMLElement;
    const logo = within(card).getByRole('img', { name: 'WorkTrack' });
    expect(logo.compareDocumentPosition(screen.getByText('the form'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('makes every collapsed link a 44 px circle centred in the rail, so a background is round', async () => {
    localStorage.setItem('wt-sidebar-collapsed', '1');
    mockApi({ 'GET /me': makeMe({ permissions: ADMIN }) });
    renderWithClient(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );
    const link = await screen.findByRole('link', { name: 'Employees' });
    expect(link).toHaveClass('h-11', 'w-11', 'mx-auto', 'rounded-full');
    expect(link.closest('nav')).toHaveClass('px-2');
    localStorage.clear();
  });
});

describe('the collapsed rail keeps the icon centred', () => {
  it('hides the label with sr-only alone, so it takes no room beside the icon', async () => {
    localStorage.setItem('wt-sidebar-collapsed', '1');
    mockApi({ 'GET /me': makeMe({ permissions: ADMIN }) });
    renderWithClient(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );
    const link = await screen.findByRole('link', { name: 'Employees' });
    const label = within(link).getByText('Employees');
    // sr-only is position: absolute; a `relative` next to it would win and keep the label in the flow.
    expect(label).toHaveClass('sr-only');
    expect(label).not.toHaveClass('relative');
    localStorage.clear();
  });
});
