import { useQuery } from '@tanstack/react-query';
import { proxyApi, unwrap } from '@/lib/api-client';

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/me')),
    staleTime: 60_000,
  });
