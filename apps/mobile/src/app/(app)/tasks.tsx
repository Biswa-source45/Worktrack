import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PagedList } from '@/components/admin/paged-list';
import { SavedActionsBanner } from '@/components/saved-actions-banner';
import { TaskCard } from '@/components/task-card';
import { AppText } from '@/components/ui/app-text';
import { FilterPills } from '@/components/ui/filter-pills';
import { Screen } from '@/components/ui/screen';
import { can, useAuth } from '@/lib/auth';
import { TASKS_KEY, fetchTaskPage } from '@/lib/tasks';
import type { TaskList } from '@/lib/tasks';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';

/** The employee's tasks (active, done) and, for assigners, the tasks they assigned. */
export default function TasksScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { me } = useAuth();
  const [list, setList] = useState<TaskList>('active');
  const assigner = can(me, 'tasks.create') || can(me, 'tasks.view_all');
  const lists: TaskList[] = assigner ? ['active', 'done', 'assigned'] : ['active', 'done'];

  const query = useInfiniteQuery({
    queryKey: [...TASKS_KEY, list],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchTaskPage(list, pageParam),
    getNextPageParam: (page) => page.next_cursor,
    // No silent retries: a failure shows at once, with Retry and pull to refresh on screen.
    retry: false,
  });
  useRefetchOnFocus(query.refetch);

  return (
    <Screen edges={['top', 'left', 'right']} contentStyle={{ padding: 0, gap: 0 }}>
      <PagedList
        query={query}
        empty={t(`tasks.empty.${list}`)}
        renderItem={(task) => (
          <TaskCard task={task} onOpen={() => router.push(`/tasks/${task.id}` as Href)} />
        )}
        header={
          <>
            <AppText variant="h1" accessibilityRole="header">
              {t('tasks.title')}
            </AppText>
            <SavedActionsBanner />
            <FilterPills
              value={list}
              onChange={setList}
              options={lists.map((value) => ({ value, label: t(`tasks.list.${value}`) }))}
            />
          </>
        }
      />
    </Screen>
  );
}
