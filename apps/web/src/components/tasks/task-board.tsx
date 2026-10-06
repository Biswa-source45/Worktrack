'use client';

import { TriangleAlert } from 'lucide-react';
import { m } from 'motion/react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { itemEnter } from '@/lib/motion';
import type { Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { PriorityBadge, TaskStatusBadge } from './task-status';

type Task = Schemas['TaskBrief'];

const SHOWN_NAMES = 3;

/** Names of the people on a task; a flag chip when someone has not accepted in time or a Reached waits for review. */
export function AssigneeFlags({ task }: { task: Task }) {
  const { t } = useTranslation();
  const escalated = task.assignees.some((a) => a.escalated && a.status === 'assigned');
  const review = task.assignees.some((a) => a.reach_review === 'pending');
  return (
    <>
      {escalated && (
        <Badge tone="warning">
          <TriangleAlert aria-hidden="true" />
          {t('tasks.flag.notAccepted')}
        </Badge>
      )}
      {review && (
        <Badge tone="warning">
          <TriangleAlert aria-hidden="true" />
          {t('tasks.flag.reviewPending')}
        </Badge>
      )}
    </>
  );
}

export function assigneeNames(task: Task, limit = SHOWN_NAMES) {
  const names = task.assignees.map((a) => a.user.name);
  const extra = names.length - limit;
  return extra > 0 ? `${names.slice(0, limit).join(', ')} +${extra}` : names.join(', ');
}

function TaskCard({ task, index }: { task: Task; index: number }) {
  return (
    <m.li {...itemEnter(index)}>
      <Card className="relative space-y-2 p-3 transition-shadow hover:shadow-md">
        <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
          <span>{task.code}</span>
          <PriorityBadge priority={task.priority} />
        </div>
        <Link
          href={`/tasks/${task.id}`}
          className="block rounded-sm text-body font-semibold after:absolute after:inset-0"
        >
          {task.title}
        </Link>
        <p className="truncate text-small text-muted-foreground">{task.client_name}</p>
        <p className="text-caption text-muted-foreground">{formatIst(task.scheduled_at)}</p>
        <p
          className="truncate text-small"
          title={task.assignees.map((a) => a.user.name).join(', ')}
        >
          {assigneeNames(task)}
        </p>
        <div className="flex flex-wrap gap-1 empty:hidden">
          <AssigneeFlags task={task} />
        </div>
      </Card>
    </m.li>
  );
}

/** One column per status, side by side; the strip scrolls sideways inside the page, never the page. */
export function TaskBoard({ tasks, statuses }: { tasks: Task[]; statuses: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {statuses.map((status) => {
        const inColumn = tasks.filter((task) => task.status === status);
        return (
          <section
            key={status}
            aria-label={t(`tasks.status.${status}`)}
            className="w-72 shrink-0 space-y-2 rounded-lg bg-raised p-2"
          >
            <header className="flex items-center justify-between px-1">
              <TaskStatusBadge status={status} />
              <span data-testid={`column-count-${status}`} className="text-small tabular-nums">
                {inColumn.length}
              </span>
            </header>
            {inColumn.length === 0 ? (
              <p className="px-1 py-4 text-center text-caption text-muted-foreground">
                {t('tasks.columnEmpty')}
              </p>
            ) : (
              <ul className="space-y-2">
                {inColumn.map((task, index) => (
                  <TaskCard key={task.id} task={task} index={index} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
