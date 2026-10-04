'use client';

import {
  createContext,
  use,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { motion } from 'design-tokens';
import { syncTheme, systemDarkQuery, THEME_KEY, type ResolvedTheme, type Theme } from '@/lib/theme';

type ThemeValue = { theme: Theme; resolved: ResolvedTheme; setTheme: (theme: Theme) => void };

const ThemeContext = createContext<ThemeValue | null>(null);
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

// The choice lives in localStorage and the system setting in matchMedia; React only mirrors them.
function subscribe(listener: () => void) {
  listeners.add(listener);
  const system = systemDarkQuery();
  system.addEventListener('change', listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    system.removeEventListener('change', listener);
    window.removeEventListener('storage', listener);
  };
}

const snapshot = () => {
  const { theme, resolved } = syncTheme(false);
  return `${theme} ${resolved}`;
};
// The server cannot know either source; the head script has already corrected <html> by hydration.
const serverSnapshot = () => 'system light';

function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage is blocked, so the choice cannot be kept: the theme keeps following the system.
    return;
  }
  const root = document.documentElement;
  root.classList.add('theme-fade');
  setTimeout(() => root.classList.remove('theme-fade'), motion.base);
  notify();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  // Also re-applies after React's dev Strict Mode remount, which resets <html>'s attributes.
  useLayoutEffect(() => {
    syncTheme(true);
  }, [current]);
  const value = useMemo(() => {
    const [theme, resolved] = current.split(' ') as [Theme, ResolvedTheme];
    return { theme, resolved, setTheme };
  }, [current]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeValue {
  const value = use(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
