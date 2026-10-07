'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { TaskStatusBadge } from '@/components/tasks/task-status';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatClock, formatDate, formatIst } from '@/lib/ist';
import {
  DayStatusBadge,
  FaceBadge,
  FlagChips,
  Hours,
  PlaceText,
  ReviewBadge,
  Selfie,
  words,
} from './shared';

type Punch = Schemas['PunchDetail'];

function PunchCard({ punch }: { punch: Punch }) {
  const { t } = useTranslation();
  const type = t(`attendance.punchType.${punch.type}`);
  return (
    <li className="grid gap-3 rounded-md border p-3 sm:grid-cols-[8rem_1fr]">
      <Selfie url={punch.selfie_url} alt={t('attendance.selfieAlt', { type })} />
      <dl className="grid grid-cols-[auto_1fr] content-start items-center gap-x-4 gap-y-1 text-small">
        <dt className="text-muted-foreground">{t('attendance.punch')}</dt>
        <dd className="flex flex-wrap items-center gap-1.5 font-medium">
          {type} {formatIst(punch.time)}
          {punch.offline && <Badge tone="warning">{t('attendance.flag.offline')}</Badge>}
        </dd>
        <dt className="text-muted-foreground">{t('attendance.serverTime')}</dt>
        <dd>{formatIst(punch.server_time)}</dd>
        <dt className="text-muted-foreground">{t('attendance.deviceTime')}</dt>
        <dd>{punch.device_time ? formatIst(punch.device_time) : '-'}</dd>
        <dt className="text-muted-foreground">{t('attendance.place.label')}</dt>
        <dd>
          <PlaceText place={punch.place} />
        </dd>
        <dt className="text-muted-foreground">{t('attendance.accuracy')}</dt>
        <dd className="tabular-nums">
          {t('attendance.metres', { m: Math.round(punch.accuracy_m) })}
        </dd>
        <dt className="text-muted-foreground">{t('attendance.faceCheck')}</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <FaceBadge decision={punch.face_decision} />
          <span className="tabular-nums">
            {t('attendance.score', { score: punch.face_score.toFixed(2) })}
          </span>
        </dd>
        <dt className="text-muted-foreground">{t('attendance.reviewLabel')}</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <ReviewBadge status={punch.review_status} />
          {punch.review_reasons.length > 0 && words(t, 'reason', punch.review_reasons)}
        </dd>
        {punch.integrity_flags.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('attendance.integrityLabel')}</dt>
            <dd className="text-danger">{words(t, 'integrity', punch.integrity_flags)}</dd>
          </>
        )}
        {punch.review_remarks && (
          <>
            <dt className="text-muted-foreground">{t('attendance.remarks')}</dt>
            <dd>{punch.review_remarks}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

/** One day of one employee: every punch with its selfie, the checks the server made, and overrides. */
export function DayDialog({ dayId, onClose }: { dayId: number; onClose: () => void }) {
  const { t } = useTranslation();
  // gcTime 0: the signed selfie links must not linger in the cache. Opening it is audited.
  const detail = useQuery({
    queryKey: ['attendance-day', dayId],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/attendance/{day_id}', {
          params: { path: { day_id: dayId } },
        }),
      ),
    gcTime: 0,
  });
  const data = detail.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t('attendance.dayTitle')}</DialogTitle>
        <DialogDescription>
          {data
            ? t('attendance.dayFor', {
                name: data.employee.name,
                code: data.employee.emp_code,
                date: formatDate(data.day.date),
              })
            : t('attendance.dayHint')}
        </DialogDescription>
        {detail.error && (
          <p role="alert" className="text-small text-danger">
            {errorMessage(t, detail.error, 'attendance')}
          </p>
        )}
        {detail.isPending && <Skeleton className="h-64 w-full rounded-md" />}
        {data && (
          <div className="grid gap-4">
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-small">
              <dt className="text-muted-foreground">{t('attendance.col.status')}</dt>
              <dd>
                <DayStatusBadge status={data.day.status} />
              </dd>
              <dt className="text-muted-foreground">{t('attendance.col.hours')}</dt>
              <dd>
                <Hours minutes={data.day.worked_minutes} />
              </dd>
              <dt className="text-muted-foreground">{t('attendance.col.late')}</dt>
              <dd className="tabular-nums">
                {t('attendance.minutes', { m: data.day.late_minutes })}
              </dd>
              <dt className="text-muted-foreground">{t('attendance.overtime')}</dt>
              <dd className="tabular-nums">
                {t('attendance.minutes', { m: data.day.overtime_minutes })}
              </dd>
              <dt className="text-muted-foreground">{t('attendance.col.flags')}</dt>
              <dd>
                <FlagChips flags={data.day.flags} />
              </dd>
            </dl>
            <section aria-label={t('attendance.punches')} className="grid gap-2">
              <h3 className="text-large font-semibold">{t('attendance.punches')}</h3>
              {data.punches.length === 0 ? (
                <p className="text-small text-muted-foreground">{t('attendance.noPunches')}</p>
              ) : (
                <ul className="grid gap-2">
                  {data.punches.map((punch) => (
                    <PunchCard key={punch.id} punch={punch} />
                  ))}
                </ul>
              )}
            </section>
            {data.tasks.length > 0 && (
              <section aria-label={t('attendance.tasks')} className="grid gap-2">
                <h3 className="text-large font-semibold">{t('attendance.tasks')}</h3>
                <ul className="grid gap-1 text-small">
                  {data.tasks.map((task) => (
                    <li key={task.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                        {task.code} {task.title}
                      </Link>
                      <TaskStatusBadge status={task.status} />
                      <span className="text-muted-foreground">
                        {[
                          task.reached_at &&
                            t('attendance.taskReached', { time: formatClock(task.reached_at) }),
                          task.completed_at &&
                            t('attendance.taskCompleted', { time: formatClock(task.completed_at) }),
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {data.overrides.length > 0 && (
              <section aria-label={t('attendance.overrides')} className="grid gap-2">
                <h3 className="text-large font-semibold">{t('attendance.overrides')}</h3>
                <ul className="grid gap-1 text-small">
                  {data.overrides.map((o) => (
                    <li key={`${o.created_at}-${o.kind}`}>
                      <span className="font-medium">
                        {t(`attendance.overrideKind.${o.kind}`, { defaultValue: o.kind })}
                      </span>
                      {`, ${formatIst(o.created_at)}: ${o.reason}`}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
