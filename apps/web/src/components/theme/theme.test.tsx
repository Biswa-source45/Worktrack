import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { themeScript } from '@/lib/theme';
import { themeCss } from '@/lib/theme-css';
import { setSystemDark } from '@/test/setup';
import { ThemeProvider, useTheme } from './theme-provider';
import { ThemeToggle } from './theme-toggle';

const isDark = () => document.documentElement.classList.contains('dark');
const pressed = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';

function Probe() {
  const { theme, resolved } = useTheme();
  return <p data-testid="probe">{`${theme}/${resolved}`}</p>;
}

function mount() {
  render(
    <ThemeProvider>
      <ThemeToggle />
      <Probe />
    </ThemeProvider>,
  );
  return screen.getByTestId('probe');
}

describe('ThemeProvider', () => {
  it('defaults to System and follows a light system', () => {
    const probe = mount();
    expect(probe).toHaveTextContent('system/light');
    expect(isDark()).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(pressed('System')).toBe(true);
    expect(localStorage.getItem('wt-theme')).toBeNull();
  });

  it('follows a dark system, and a live change of the system setting', () => {
    setSystemDark(true);
    const probe = mount();
    expect(probe).toHaveTextContent('system/dark');
    expect(isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    act(() => setSystemDark(false));
    expect(probe).toHaveTextContent('system/light');
    expect(isDark()).toBe(false);
  });

  it('choosing Dark or Light sets the class, persists, and ignores the system', async () => {
    const user = userEvent.setup();
    const probe = mount();

    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(isDark()).toBe(true);
    expect(localStorage.getItem('wt-theme')).toBe('dark');
    expect(probe).toHaveTextContent('dark/dark');

    setSystemDark(true);
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem('wt-theme')).toBe('light');
    expect(probe).toHaveTextContent('light/light');

    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(localStorage.getItem('wt-theme')).toBe('system');
    expect(isDark()).toBe(true);
  });

  it('restores a stored choice on mount', () => {
    localStorage.setItem('wt-theme', 'dark');
    expect(mount()).toHaveTextContent('dark/dark');
    expect(isDark()).toBe(true);
    expect(pressed('Dark')).toBe(true);
  });

  it('treats an unknown stored value as System', () => {
    localStorage.setItem('wt-theme', 'purple');
    expect(mount()).toHaveTextContent('system/light');
  });

  it('follows the system when storage is blocked', () => {
    setSystemDark(true);
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(mount()).toHaveTextContent('system/dark');
    blocked.mockRestore();
  });
});

describe('ThemeToggle', () => {
  it('is a group named Theme whose aria-pressed reflects the choice', async () => {
    const user = userEvent.setup();
    mount();
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(group.querySelectorAll('button')).toHaveLength(3);
    expect([pressed('Light'), pressed('Dark'), pressed('System')]).toEqual([false, false, true]);

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect([pressed('Light'), pressed('Dark'), pressed('System')]).toEqual([true, false, false]);
  });
});

describe('head script', () => {
  // The script is the provider's own resolve-and-apply function, so the two cannot disagree.
  const run = () => new Function(themeScript)();

  it('applies a stored dark choice before React runs', () => {
    localStorage.setItem('wt-theme', 'dark');
    run();
    expect(isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('follows the system without a stored choice, and a stored light beats a dark system', () => {
    setSystemDark(true);
    run();
    expect(isDark()).toBe(true);
    localStorage.setItem('wt-theme', 'light');
    run();
    expect(isDark()).toBe(false);
  });
});

describe('themeCss', () => {
  it('defines light tokens on :root and dark tokens under .dark', () => {
    const [light, dark] = themeCss.split('.dark{');
    expect(light).toMatch(/^:root\{/);
    for (const block of [light, dark]) {
      for (const name of [
        'background',
        'surface',
        'raised',
        'text',
        'muted',
        'primary',
        'primary-foreground',
        'primary-text',
        'border',
        'border-strong',
        'ring',
        'success-fg',
        'success-subtle',
        'warning-fg',
        'danger-subtle',
        'info-fg',
        'shadow-sm',
        'shadow-md',
        'shadow-lg',
      ]) {
        expect(block).toContain(`--wt-${name}:`);
      }
    }
    expect(light).toContain('color-scheme:light');
    expect(dark).toContain('color-scheme:dark');
    expect(light).toContain('--wt-background:#F8F5F1');
    expect(dark).toContain('--wt-background:#131417');
  });
});
