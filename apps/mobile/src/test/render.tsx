import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import '@/lib/i18n';
import { AuthProvider } from '@/lib/auth';

export async function renderWithAuth(ui: ReactElement) {
  // gcTime Infinity: the default 5 min GC timer would keep the jest process alive after unmount.
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  await render(
    <QueryClientProvider client={client}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
  return client;
}
