import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { proxyApi, unwrap, type Schemas } from '@/lib/api-client';

export const detailKey = (id: number) => ['tasks', 'detail', id] as const;

/**
 * One task with everything on it. gcTime 0: the selfie and attachment links in it are signed and
 * expire in minutes, so a cached copy must not outlive the page.
 */
export function useTask(id: number) {
  return useQuery({
    queryKey: detailKey(id),
    queryFn: () =>
      unwrap(proxyApi().GET('/api/v1/tasks/{task_id}', { params: { path: { task_id: id } } })),
    gcTime: 0,
  });
}

/** Puts what a state change answered straight on the page, and refreshes the lists behind it. */
export function useApplyResult(id: number) {
  const queryClient = useQueryClient();
  return useCallback(
    (result: Schemas['ActionOut']) => {
      queryClient.setQueryData(detailKey(id), result.task);
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'list'] });
    },
    [queryClient, id],
  );
}
