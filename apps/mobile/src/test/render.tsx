import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import '@/lib/i18n';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';

// gcTime Infinity: the default 5 min GC timer would keep the jest process alive after unmount.
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });

/** Renders like the app does, inside the theme, without a session. */
export async function renderWithTheme(ui: ReactElement, client = newClient()) {
  await render(
    <QueryClientProvider client={client}>
      <ThemeProvider>{ui}</ThemeProvider>
    </QueryClientProvider>,
  );
  return client;
}

export const renderWithAuth = (ui: ReactElement) =>
  renderWithTheme(<AuthProvider>{ui}</AuthProvider>);
