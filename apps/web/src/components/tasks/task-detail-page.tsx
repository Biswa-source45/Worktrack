'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Pencil, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { GeofenceMap } from '@/components/map/pin-picker';
import { Page } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { useMe } from '@/lib/me';
import { newKey } from './task-api';
import { AssignDialog, CancelDialog, CloseDialog, ReopenDialog } from './task-dialogs';
import { TaskDialog } from './task-dialog';
import { ReachReviewDialog, TaskAssignees } from './task-assignees';
import { TaskAttachments, TaskComments, TaskTimeline } from './task-extras';
import { PriorityBadge, TaskStatusBadge } from './task-status';
import { useApplyResult, useTask } from './use-task';

type Task = Schemas['TaskDetail'];
type Assignee = Schemas['AssigneeOut'];

type Dialog =
  | { kind: 'edit' }
  | { kind: 'assign' }
  | { kind: 'cancel' }
  | { kind: 'close' }
  | { kind: 'reopen' }
  | { kind: 'review'; assignee: Assignee }
  | { kind: 'remove'; assignee: Assignee };

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function TaskInfo({ task }: { task: Task }) {
  const { t } = useTranslation();
  return (
    <Card role="group" aria-label={t('tasks.detail.info')} className="space-y-3">
      <h2 className="text-h3">{t('tasks.detail.info')}</h2>
      <Facts
        rows={[
          [t('tasks.col.type'), task.type.name],
          [t('tasks.col.client'), task.client_name],
          [t('tasks.col.scheduled'), formatIst(task.scheduled_at)],
          [
            t('tasks.form.duration'),
            task.expected_minutes === null
              ? null
              : t('tasks.metric.minutes', { m: task.expected_minutes }),
          ],
          [t('tasks.form.address'), task.site.address],
          [t('tasks.form.radius'), t('tasks.metric.metres', { m: task.site.radius_m })],
          [t('tasks.form.contactName'), task.contact_name],
          [
            t('tasks.form.contactPhone'),
            task.contact_phone && (
              <a href={`tel:${task.contact_phone}`} className="text-primary-text underline">
                {task.contact_phone}
              </a>
            ),
          ],
          [t('tasks.form.description'), task.description],
          [t('tasks.detail.createdBy'), `${task.created_by.name}, ${formatIst(task.created_at)}`],
          [
            t('tasks.detail.closedBy'),
            task.closed_by &&
              task.closed_at &&
              `${task.closed_by.name}, ${formatIst(task.closed_at)}`,
          ],
          [t('tasks.detail.closeRemarks'), task.close_remarks],
          [
            t('tasks.detail.cancelledBy'),
            task.cancelled_by &&
              task.cancelled_at &&
              `${task.cancelled_by.name}, ${formatIst(task.cancelled_at)}`,
          ],
          [t('tasks.detail.cancelReason'), task.cancel_reason],
        ]}
      />
    </Card>
  );
}

/** The site and the circle that counts as arrived, with a dot where each person reached it. */
function TaskMap({ task }: { task: Task }) {
  const { t } = useTranslation();
  // Positions come only to people who manage the task.
  const points = useMemo(
    () =>
      task.assignees.flatMap((a) =>
        a.reach?.lat != null && a.reach.lng != null ? [{ lat: a.reach.lat, lng: a.reach.lng }] : [],
      ),
    [task.assignees],
  );
  return (
    <Card role="group" aria-label={t('tasks.detail.map')} className="space-y-2">
      <h2 className="text-h3">{t('tasks.detail.map')}</h2>
      <GeofenceMap
        center={{ lat: task.site.lat, lng: task.site.lng }}
        radiusM={task.site.radius_m}
        points={points}
      />
      {points.length > 0 && (
        <p className="text-caption text-muted-foreground">{t('tasks.detail.mapPoints')}</p>
      )}
    </Card>
  );
}

function TaskView({ id }: { id: number }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const task = useTask(id);
  const apply = useApplyResult(id);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const back = (
    <Link
      href="/tasks"
      className="flex w-fit items-center gap-1 rounded-sm text-small text-primary-text hover:underline"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t('tasks.detail.back')}
    </Link>
  );

  if (task.error) {
    const missing = task.error instanceof ApiError && task.error.status === 404;
    return (
      <Page>
        {back}
        <Card className="space-y-3">
          <p role="alert" className="text-danger">
            {missing ? t('tasks.errors.TASK_NOT_FOUND') : errorMessage(t, task.error, 'tasks')}
          </p>
          {!missing && (
            <Button variant="outline" onClick={() => void task.refetch()}>
              {t('common.retry')}
            </Button>
          )}
        </Card>
      </Page>
    );
  }
  if (!task.data) {
    return (
      <Page>
        {back}
        <div role="status" className="grid gap-4 lg:grid-cols-2">
          <span className="sr-only">{t('common.loading')}</span>
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </Page>
    );
  }

  const data = task.data;
  const manage = data.can_manage;
  const open = !['completed', 'closed', 'cancelled'].includes(data.status);
  const notOver = !['closed', 'cancelled'].includes(data.status);
  // Cancelling is refused once anyone is on site or finished.
  const cancellable =
    notOver &&
    data.assignees.every((a) =>
      ['assigned', 'accepted', 'declined', 'cancelled'].includes(a.status),
    );

  return (
    <Page>
      {back}
      <header className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <p className="text-small text-muted-foreground">{data.code}</p>
          <h1 className="text-h1 break-words">{data.title}</h1>
        </div>
        <TaskStatusBadge status={data.status} />
        <PriorityBadge priority={data.priority} />
      </header>
      {manage && (
        <div className="flex flex-wrap gap-2">
          {open && (
            <Button variant="outline" onClick={() => setDialog({ kind: 'edit' })}>
              <Pencil aria-hidden="true" />
              {t('tasks.detail.edit')}
            </Button>
          )}
          {notOver && (
            <Button variant="outline" onClick={() => setDialog({ kind: 'assign' })}>
              <UserPlus aria-hidden="true" />
              {t('tasks.detail.addPeople')}
            </Button>
          )}
          {data.status === 'completed' && (
            <>
              <Button onClick={() => setDialog({ kind: 'close' })}>
                {t('tasks.detail.close')}
              </Button>
              <Button variant="outline" onClick={() => setDialog({ kind: 'reopen' })}>
                {t('tasks.detail.reopen')}
              </Button>
            </>
          )}
          {cancellable && (
            <Button variant="destructive" onClick={() => setDialog({ kind: 'cancel' })}>
              {t('tasks.detail.cancel')}
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <TaskInfo task={data} />
        <TaskMap task={data} />
      </div>
      <TaskAssignees
        task={data}
        myId={me?.id ?? 0}
        onReview={(assignee) => setDialog({ kind: 'review', assignee })}
        onRemove={(assignee) => setDialog({ kind: 'remove', assignee })}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <TaskAttachments task={data} />
        <TaskComments task={data} />
      </div>
      <TaskTimeline task={data} />

      {dialog?.kind === 'edit' && <TaskDialog task={data} onClose={close} />}
      {dialog?.kind === 'assign' && <AssignDialog task={data} onClose={close} />}
      {dialog?.kind === 'cancel' && <CancelDialog task={data} onClose={close} />}
      {dialog?.kind === 'close' && <CloseDialog task={data} onClose={close} />}
      {dialog?.kind === 'reopen' && <ReopenDialog task={data} onClose={close} />}
      {dialog?.kind === 'review' && (
        <ReachReviewDialog task={data} assignee={dialog.assignee} onClose={close} />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title={t('tasks.assignee.removeTitle')}
          description={t('tasks.assignee.removeHint', { name: dialog.assignee.user.name })}
          confirmLabel={t('tasks.assignee.removeAction')}
          destructive
          onClose={close}
          onConfirm={async () => {
            apply(
              await unwrap(
                proxyApi().DELETE('/api/v1/tasks/{task_id}/assignees/{user_id}', {
                  params: {
                    path: { task_id: data.id, user_id: dialog.assignee.user.id },
                    header: { 'Idempotency-Key': newKey() },
                  },
                }),
              ),
            );
          }}
        />
      )}
    </Page>
  );
}

export function TaskDetailPage({ id }: { id: number }) {
  return (
    <RequirePermission permission={['tasks.create', 'tasks.view_all', 'team.view']}>
      <TaskView id={id} />
    </RequirePermission>
  );
}
