export const THEME_KEY = 'wt-theme';
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = 'light' | 'dark';

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

/**
 * Resolves the stored choice against the system setting, returns "<theme> <resolved>" and,
 * with `apply`, puts the result on <html>. The blocking head script is this function's own
 * source, so it must not use anything outside its body and arguments.
 */
function sync(key: string, systemDark: string, apply: boolean): string {
  let theme = 'system';
  try {
    const stored = localStorage.getItem(key);
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch {
    // Storage is blocked (privacy mode): follow the system.
    theme = 'system';
  }
  const dark = theme === 'dark' || (theme === 'system' && matchMedia(systemDark).matches);
  if (apply) {
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }
  return theme + ' ' + (dark ? 'dark' : 'light');
}

export function syncTheme(apply: boolean) {
  const [theme, resolved] = sync(THEME_KEY, SYSTEM_DARK, apply).split(' ');
  return { theme: theme as Theme, resolved: resolved as ResolvedTheme };
}

export const systemDarkQuery = () => matchMedia(SYSTEM_DARK);

/** Runs in <head> before the first paint, so the wrong theme never flashes. */
export const themeScript = `(${sync.toString()})(${JSON.stringify(THEME_KEY)},${JSON.stringify(SYSTEM_DARK)},true)`;
