'use client';

import { useState, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import '@/lib/i18n';

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(() => {
    // The proxy answers 401 only after its single refresh attempt failed: the session is over.
    // Clearing the cache keeps the next person who signs in from seeing this one's data.
    function onSessionError(error: Error) {
      if (error instanceof ApiError && error.status === 401) {
        client.clear();
        router.replace('/login');
      }
    }
    const client = new QueryClient({
      queryCache: new QueryCache({ onError: onSessionError }),
      mutationCache: new MutationCache({ onError: onSessionError }),
      defaultOptions: {
        queries: { retry: (count, error) => !(error instanceof ApiError) && count < 2 },
      },
    });
    return client;
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
