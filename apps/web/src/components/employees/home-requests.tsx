'use client';

import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { GeofenceMap } from '@/components/map/pin-picker';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { radius, RADIUS_MAX_M, RADIUS_MIN_M } from '@/lib/form';
import { formatIst } from '@/lib/ist';

type Item = Schemas['HomeRequestItem'];
type Detail = Schemas['HomeRequestDetail'];

// The list says who asked and when, never where. One page of 200 covers ~35 employees, each
// with at most one pending request.
export const usePendingHomeRequests = () =>
  useQuery({
    queryKey: ['home-requests', 'pending'],
    queryFn: async () =>
      (
        await unwrap(
          proxyApi().GET('/api/v1/admin/home-location-requests', {
            params: { query: { status: 'pending', limit: 200 } },
          }),
        )
      ).items,
  });

const schema = z.object({
  radius_m: radius,
  reason: z.string().trim().max(255, 'validation.tooLong'),
});
type Values = z.infer<typeof schema>;
type Action = 'approve' | 'reject';

function ReviewForm({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    control,
    getValues,
    trigger,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { radius_m: String(detail.radius_m), reason: '' },
  });
  const radiusM = useWatch({ control, name: 'radius_m' });

  const decide = useMutation({
    mutationFn: (action: Action) => {
      const params = { path: { request_id: detail.id } };
      return unwrap(
        action === 'approve'
          ? proxyApi().POST('/api/v1/admin/home-location-requests/{request_id}/approve', {
              params,
              body: { radius_m: Number(getValues('radius_m')) },
            })
          : proxyApi().POST('/api/v1/admin/home-location-requests/{request_id}/reject', {
              params,
              body: { reason: getValues('reason').trim() },
            }),
      );
    },
  });

  async function run(action: Action) {
    setServerError(null);
    if (action === 'reject' && getValues('reason').trim() === '') {
      setError('reason', { message: 'validation.reasonRequired' });
      return;
    }
    if (!(await trigger(action === 'approve' ? 'radius_m' : 'reason'))) return;
    let failed = false;
    try {
      await decide.mutateAsync(action);
    } catch (error) {
      failed = true;
      setServerError(errorMessage(t, error, 'home'));
    }
    // Also after a failure: "already decided" means the lists on screen are out of date.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['home-requests'] }),
      queryClient.invalidateQueries({ queryKey: ['employees'] }),
    ]);
    if (!failed) onClose();
  }

  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate className="grid gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-small">
        <dt className="text-muted-foreground">{t('home.requested')}</dt>
        <dd>{formatIst(detail.created_at)}</dd>
        <dt className="text-muted-foreground">{t('home.accuracy')}</dt>
        <dd>
          {detail.accuracy_m === null
            ? t('home.notRecorded')
            : t('home.metres', { value: Math.round(detail.accuracy_m) })}
        </dd>
        <dt className="text-muted-foreground">{t('home.coordinates')}</dt>
        <dd className="tabular-nums">{`${detail.lat}, ${detail.lng}`}</dd>
      </dl>
      <GeofenceMap center={{ lat: detail.lat, lng: detail.lng }} radiusM={Number(radiusM)} />
      <Field id="radius_m" label={t('home.radius')} error={errors.radius_m?.message}>
        <Input
          id="radius_m"
          type="number"
          min={RADIUS_MIN_M}
          max={RADIUS_MAX_M}
          invalid={!!errors.radius_m}
          {...register('radius_m')}
        />
      </Field>
      <Field id="reason" label={t('home.rejectReason')} error={errors.reason?.message}>
        <Input id="reason" invalid={!!errors.reason} {...register('reason')} />
      </Field>
      {serverError && (
        <p role="alert" className="text-small text-danger">
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => void run('reject')}
          disabled={decide.isPending}
        >
          {t('home.reject')}
        </Button>
        <Button type="button" onClick={() => void run('approve')} disabled={decide.isPending}>
          {t('home.approve')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Shows where the employee asked to work from (the only place a request's pin is shown). */
export function ReviewDialog({ requestId, onClose }: { requestId: number; onClose: () => void }) {
  const { t } = useTranslation();
  // gcTime 0: the coordinates of someone's home must not linger in the cache.
  const detail = useQuery({
    queryKey: ['home-requests', requestId],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/home-location-requests/{request_id}', {
          params: { path: { request_id: requestId } },
        }),
      ),
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{t('home.reviewTitle')}</DialogTitle>
        <DialogDescription>
          {detail.data
            ? t('home.reviewFor', {
                name: detail.data.employee.name,
                code: detail.data.employee.emp_code,
              })
            : t('home.reviewHint')}
        </DialogDescription>
        {detail.error && (
          <p role="alert" className="text-small text-danger">
            {errorMessage(t, detail.error)}
          </p>
        )}
        {detail.isPending && <Skeleton className="h-64 w-full rounded-md" />}
        {detail.data && <ReviewForm detail={detail.data} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

const col = columnHelper<Item>();

type Requests = ReturnType<typeof usePendingHomeRequests>;

export function HomeRequestsTab({ requests }: { requests: Requests }) {
  const { t } = useTranslation();
  const [reviewing, setReviewing] = useState<number | null>(null);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'employee',
          header: t('home.col.employee'),
          cell: ({ row: { original: r } }) => (
            <span className="flex items-center gap-2">
              <Avatar name={r.employee.name} />
              {`${r.employee.name} (${r.employee.emp_code})`}
            </span>
          ),
        }),
        col.accessor(
          (r) =>
            r.accuracy_m === null
              ? t('home.notRecorded')
              : t('home.metres', { value: Math.round(r.accuracy_m) }),
          { id: 'accuracy', header: t('home.col.accuracy') },
        ),
        col.accessor((r) => formatIst(r.created_at), {
          id: 'requested',
          header: t('home.col.requested'),
        }),
        col.display({
          id: 'actions',
          header: t('home.col.actions'),
          cell: ({ row: { original: r } }) => (
            <Button
              size="xs"
              aria-label={t('home.reviewOf', { name: r.employee.name })}
              onClick={() => setReviewing(r.id)}
            >
              {t('home.review')}
            </Button>
          ),
        }),
      ]),
    [t],
  );

  return (
    <div role="tabpanel" className="space-y-4">
      {requests.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, requests.error)}
        </p>
      )}
      {requests.isPending ? (
        <TableSkeleton />
      ) : (
        <DataTable columns={columns} data={requests.data ?? []} empty={t('home.emptyRequests')} />
      )}
      {reviewing !== null && (
        <ReviewDialog requestId={reviewing} onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}
