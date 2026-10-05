'use client';

import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, RotateCcw } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { Avatar } from '@/components/ui/avatar';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';

type Item = Schemas['EnrollmentItem'];
type Detail = Schemas['EnrollmentDetail'];
export type FaceStatus = 'pending' | 'approved' | 'rejected';
const STATUSES: FaceStatus[] = ['pending', 'approved', 'rejected'];

// The list says who and when, never the face. One page of 200 covers ~35 employees.
export const useFaceEnrollments = (status: FaceStatus, enabled = true) =>
  useQuery({
    queryKey: ['face-enrollments', status],
    enabled,
    queryFn: async () =>
      (
        await unwrap(
          proxyApi().GET('/api/v1/admin/face-enrollments', {
            params: { query: { status, limit: 200 } },
          }),
        )
      ).items,
  });

const STATUS_LOOK: Record<string, { tone: Tone; icon: typeof Clock }> = {
  pending: { tone: 'warning', icon: Clock },
  approved: { tone: 'success', icon: CircleCheck },
  rejected: { tone: 'danger', icon: CircleX },
  reset: { tone: 'neutral', icon: RotateCcw },
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const look = STATUS_LOOK[status] ?? STATUS_LOOK.reset;
  const Icon = look.icon;
  return (
    <Badge tone={look.tone}>
      <Icon aria-hidden="true" />
      {t(`face.status.${status}`)}
    </Badge>
  );
}

const schema = z.object({ reason: z.string().trim().max(255, 'validation.tooLong') });
type Values = z.infer<typeof schema>;
type Action = 'approve' | 'reject' | 'reset';

function Photos({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  if (detail.photos.length === 0) {
    return <p className="text-small text-muted-foreground">{t('face.deleted')}</p>;
  }
  return (
    <ul className="grid grid-cols-3 gap-3">
      {detail.photos.map((url, index) => {
        const quality = detail.qualities[index];
        return (
          <li key={url} className="grid gap-1">
            {/* The signed link is relative; the proxy adds the backend's base. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/proxy${url}`}
              alt={t('face.photoAlt', { n: index + 1 })}
              className="aspect-square w-full rounded-md border bg-raised object-cover"
            />
            {quality && (
              <span className="text-caption text-muted-foreground tabular-nums">
                {t('face.quality', {
                  px: quality.face_px,
                  sharpness: Math.round(quality.sharpness),
                  brightness: Math.round(quality.brightness),
                })}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ReviewForm({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    getValues,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });
  const pending = detail.status === 'pending';
  const approved = detail.status === 'approved';

  const decide = useMutation({
    mutationFn: (action: Action) => {
      const params = { path: { enrollment_id: detail.id } };
      const body = { reason: getValues('reason').trim() };
      if (action === 'approve') {
        return unwrap(
          proxyApi().POST('/api/v1/admin/face-enrollments/{enrollment_id}/approve', { params }),
        );
      }
      return unwrap(
        action === 'reject'
          ? proxyApi().POST('/api/v1/admin/face-enrollments/{enrollment_id}/reject', {
              params,
              body,
            })
          : proxyApi().POST('/api/v1/admin/face-enrollments/{enrollment_id}/reset', {
              params,
              body,
            }),
      );
    },
  });

  async function run(action: Action) {
    setServerError(null);
    if (action !== 'approve' && getValues('reason').trim() === '') {
      setError('reason', { message: 'validation.reasonRequired' });
      return;
    }
    let failed = false;
    try {
      await decide.mutateAsync(action);
    } catch (error) {
      failed = true;
      setServerError(errorMessage(t, error, 'face'));
    }
    // Also after a failure: "already decided" means the lists on screen are out of date.
    await queryClient.invalidateQueries({ queryKey: ['face-enrollments'] });
    if (!failed) onClose();
  }

  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate className="grid gap-4">
      <Photos detail={detail} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-small">
        <dt className="text-muted-foreground">{t('face.consent')}</dt>
        <dd>{formatIst(detail.consent_at)}</dd>
        <dt className="text-muted-foreground">{t('face.submitted')}</dt>
        <dd>{detail.submitted_at ? formatIst(detail.submitted_at) : '-'}</dd>
        <dt className="text-muted-foreground">{t('face.consistency')}</dt>
        <dd className="tabular-nums">
          {detail.consistency_score === null ? '-' : detail.consistency_score.toFixed(2)}
        </dd>
        <dt className="text-muted-foreground">{t('face.model')}</dt>
        <dd>{detail.model_version ?? '-'}</dd>
        {detail.reason && (
          <>
            <dt className="text-muted-foreground">{t('face.reason')}</dt>
            <dd>{detail.reason}</dd>
          </>
        )}
      </dl>
      {(pending || approved) && (
        <Field
          id="reason"
          label={t(pending ? 'face.rejectReason' : 'face.resetReason')}
          error={errors.reason?.message}
        >
          <Input id="reason" invalid={!!errors.reason} {...register('reason')} />
        </Field>
      )}
      {serverError && (
        <p role="alert" className="text-small text-danger">
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('common.close')}
        </Button>
        {pending && (
          <>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void run('reject')}
              disabled={decide.isPending}
            >
              {t('face.reject')}
            </Button>
            <Button type="button" onClick={() => void run('approve')} disabled={decide.isPending}>
              {t('face.approve')}
            </Button>
          </>
        )}
        {approved && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => void run('reset')}
            disabled={decide.isPending}
          >
            {t('face.reset')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/** Shows an enrollment's photos (the only place they are shown) and lets an admin decide. */
export function FaceReviewDialog({
  enrollmentId,
  onClose,
}: {
  enrollmentId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // gcTime 0: the signed photo links must not linger in the cache. Opening it is audited.
  const detail = useQuery({
    queryKey: ['face-enrollments', 'detail', enrollmentId],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/face-enrollments/{enrollment_id}', {
          params: { path: { enrollment_id: enrollmentId } },
        }),
      ),
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{t('face.reviewTitle')}</DialogTitle>
        <DialogDescription>
          {detail.data
            ? t('face.reviewFor', {
                name: detail.data.employee.name,
                code: detail.data.employee.emp_code,
              })
            : t('face.reviewHint')}
        </DialogDescription>
        {detail.error && (
          <p role="alert" className="text-small text-danger">
            {errorMessage(t, detail.error, 'face')}
          </p>
        )}
        {detail.isPending && <Skeleton className="h-64 w-full rounded-md" />}
        {detail.data && <ReviewForm detail={detail.data} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

const col = columnHelper<Item>();

export function FaceEnrollmentsTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<FaceStatus>('pending');
  const [reviewing, setReviewing] = useState<number | null>(null);
  const list = useFaceEnrollments(status);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'employee',
          header: t('face.col.employee'),
          cell: ({ row: { original: r } }) => (
            <span className="flex items-center gap-2">
              <Avatar name={r.employee.name} />
              {`${r.employee.name} (${r.employee.emp_code})`}
            </span>
          ),
        }),
        col.display({
          id: 'status',
          header: t('face.col.status'),
          cell: ({ row: { original: r } }) => <StatusBadge status={r.status} />,
        }),
        col.accessor((r) => formatIst(r.consent_at), {
          id: 'consent',
          header: t('face.col.consent'),
        }),
        col.accessor((r) => (r.submitted_at ? formatIst(r.submitted_at) : '-'), {
          id: 'submitted',
          header: t('face.col.submitted'),
        }),
        col.display({
          id: 'actions',
          header: t('face.col.actions'),
          cell: ({ row: { original: r } }) => (
            <Button
              size="xs"
              aria-label={t('face.reviewOf', { name: r.employee.name })}
              onClick={() => setReviewing(r.id)}
            >
              {t('face.review')}
            </Button>
          ),
        }),
      ]),
    [t],
  );

  return (
    <div role="tabpanel" className="space-y-4">
      <div className="max-w-56">
        <Field id="face-status" label={t('face.filter')}>
          <Select
            id="face-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as FaceStatus)}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`face.status.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error, 'face')}
        </p>
      )}
      {list.isPending ? (
        <TableSkeleton />
      ) : (
        <DataTable columns={columns} data={list.data ?? []} empty={t(`face.empty.${status}`)} />
      )}
      {reviewing !== null && (
        <FaceReviewDialog enrollmentId={reviewing} onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}
