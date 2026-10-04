import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The network boundary is the only thing mocked; openapi-fetch captures this reference at import.
vi.stubGlobal('fetch', vi.fn());

// jsdom has no matchMedia. This one answers the dark-scheme query from `systemDark`.
let systemDark = false;
const mediaListeners = new Set<() => void>();
vi.stubGlobal('matchMedia', (query: string) => ({
  media: query,
  get matches() {
    return systemDark && query.includes('prefers-color-scheme: dark');
  },
  addEventListener: (_: 'change', listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_: 'change', listener: () => void) => mediaListeners.delete(listener),
}));

/** Switches the simulated system colour scheme and tells every listener, like a live OS change. */
export function setSystemDark(dark: boolean) {
  systemDark = dark;
  mediaListeners.forEach((listener) => listener());
}

afterEach(() => {
  cleanup();
  vi.mocked(fetch).mockReset();
  systemDark = false;
  mediaListeners.clear();
  // Files that run in the node environment (route handlers, the lint rule) have no DOM to reset.
  if (typeof document === 'undefined') return;
  localStorage.clear();
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
});
