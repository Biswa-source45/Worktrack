import { useQuery } from '@tanstack/react-query';
import { proxyApi, unwrap } from '@/lib/api-client';
import { useMe } from '@/lib/me';

// Only asked for with settings.view; without it the forms leave the defaults to the server.
export function useSettings() {
  const { data: me } = useMe();
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/admin/settings')),
    enabled: me?.permissions.includes('settings.view') ?? false,
  });
}
