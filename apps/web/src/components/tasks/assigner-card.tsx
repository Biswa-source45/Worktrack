'use client';

import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { assigneeNames } from './task-board';
import { BOARD_STATUSES, TaskStatusBadge } from './task-status';

type Task = Schemas['TaskBrief'];

/** Why a task wants its assigner: someone has not accepted, a Reached waits, or the work is done. */
export function attention(task: Task): string[] {
  const reasons: string[] = [];
  if (task.assignees.some((a) => a.escalated && a.status === 'assigned')) {
    reasons.push('notAccepted');
  }
  if (task.assignees.some((a) => a.reach_review === 'pending')) reasons.push('reviewPending');
  if (task.status === 'completed') reasons.push('awaitingClose');
  return reasons;
}

/** The tasks I assigned, counted by status, and the ones that need me now. */
export function AssignerCard() {
  const { t } = useTranslation();
  // Open tasks only: a closed or cancelled one needs nothing. A company this size has well under
  // 100 open tasks at once; the Tasks page has the full list.
  const open = useQuery({
    queryKey: ['tasks', 'list', 'landing'],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/tasks', {
          params: { query: { view: 'assigned_by_me', status: [...BOARD_STATUSES], limit: 100 } },
        }),
      ),
  });

  if (open.error) {
    return (
      <Card className="space-y-3">
        <p role="alert" className="text-danger">
          {errorMessage(t, open.error, 'tasks')}
        </p>
        <Button variant="outline" onClick={() => void open.refetch()}>
          {t('common.retry')}
        </Button>
      </Card>
    );
  }
  if (open.isPending) {
    return (
      <Card role="status" className="space-y-3">
        <span className="sr-only">{t('common.loading')}</span>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  const tasks = open.data.items;
  const needing = tasks
    .map((task) => ({ task, reasons: attention(task) }))
    .filter((x) => x.reasons.length);
  return (
    <Card role="group" aria-label={t('tasks.landing.title')} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3">{t('tasks.landing.title')}</h2>
        <Button asChild variant="outline" size="sm">
          <Link href="/tasks">{t('tasks.landing.all')}</Link>
        </Button>
      </div>
      <ul
        aria-label={t('tasks.landing.counts')}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7"
      >
        {BOARD_STATUSES.map((status) => (
          <li key={status} className="grid gap-1 rounded-md bg-raised p-3">
            <TaskStatusBadge status={status} />
            <span data-testid={`count-${status}`} className="text-h2 tabular-nums">
              {tasks.filter((task) => task.status === status).length}
            </span>
          </li>
        ))}
      </ul>
      <section aria-label={t('tasks.landing.attention')} className="space-y-2">
        <h3 className="text-small font-semibold">{t('tasks.landing.attention')}</h3>
        {needing.length === 0 ? (
          <p className="text-small text-muted-foreground">{t('tasks.landing.nothing')}</p>
        ) : (
          <ul className="grid gap-2">
            {needing.map(({ task, reasons }) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
              >
                <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                  {task.title}
                </Link>
                <span className="text-caption text-muted-foreground">
                  {task.code}, {assigneeNames(task, 2)}
                </span>
                <span className="ml-auto flex flex-wrap gap-1">
                  {reasons.map((reason) => (
                    <Badge key={reason} tone="warning">
                      <TriangleAlert aria-hidden="true" />
                      {t(`tasks.landing.reason.${reason}`)}
                    </Badge>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}
