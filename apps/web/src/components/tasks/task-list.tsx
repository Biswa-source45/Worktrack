'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { columnHelper, DataTable } from '@/components/data-table';
import type { Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { AssigneeFlags, assigneeNames } from './task-board';
import { PriorityBadge, TaskStatusBadge } from './task-status';

type Task = Schemas['TaskBrief'];
const col = columnHelper<Task>();

export function TaskList({ tasks }: { tasks: Task[] }) {
  const { t } = useTranslation();
  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('code', { header: t('tasks.col.code') }),
        col.accessor('title', {
          header: t('tasks.col.title'),
          cell: ({ row: { original: task }, getValue }) => (
            <Link href={`/tasks/${task.id}`} className="rounded-sm font-medium hover:underline">
              {getValue()}
            </Link>
          ),
        }),
        col.accessor('client_name', { header: t('tasks.col.client') }),
        col.accessor((task) => task.type.name, { id: 'type', header: t('tasks.col.type') }),
        col.display({
          id: 'status',
          header: t('tasks.col.status'),
          cell: ({ row: { original: task } }) => (
            <span className="flex flex-wrap gap-1">
              <TaskStatusBadge status={task.status} />
              <AssigneeFlags task={task} />
            </span>
          ),
        }),
        col.display({
          id: 'priority',
          header: t('tasks.col.priority'),
          cell: ({ row: { original: task } }) => <PriorityBadge priority={task.priority} />,
        }),
        col.accessor((task) => formatIst(task.scheduled_at), {
          id: 'scheduled',
          header: t('tasks.col.scheduled'),
        }),
        col.accessor((task) => assigneeNames(task, 2), {
          id: 'assignees',
          header: t('tasks.col.assignees'),
        }),
      ]),
    [t],
  );
  return (
    <DataTable
      columns={columns}
      data={tasks}
      empty={t('tasks.empty')}
      columnClass={{ type: 'hidden lg:table-cell', assignees: 'hidden lg:table-cell' }}
    />
  );
}
