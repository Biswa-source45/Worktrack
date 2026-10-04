import { useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@/lib/api-error';

/**
 * Runs an admin call and then reloads every admin list, also when the call failed: a 403 or 409
 * means what is on screen is out of date. The error still reaches the caller's dialog.
 */
export function useAdminAction() {
  const queryClient = useQueryClient();
  return async <T>(call: Parameters<typeof unwrap<T>>[0]): Promise<T> => {
    try {
      return await unwrap(call);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    }
  };
}
