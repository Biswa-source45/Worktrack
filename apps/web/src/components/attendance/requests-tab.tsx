'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Clock,
  CircleCheck,
  CircleX,
  Info,
  ShieldAlert,
  TimerOff,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { GeofenceMap } from '@/components/map/pin-picker';
import { StatusBadge } from '@/components/status-badge';
import type { Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatClock, formatDate, formatIst, toIstLocal } from '@/lib/ist';
import { DecisionForm, type Decision } from './decision-form';
import { FaceBadge, Person, Selfie, words } from './shared';

type Item = Schemas['RequestItem'];
type Detail = Schemas['RequestDetail'];
export type RequestFilter = 'waiting' | 'approved' | 'rejected' | 'expired';
const FILTERS: RequestFilter[] = ['waiting', 'approved', 'rejected', 'expired'];
const PAGE_SIZE = 50;

// The list also feeds the count on the page's tab: the same key means one request for both.
export const useRequests = (status: RequestFilter, enabled = true) =>
  useInfiniteQuery({
    queryKey: ['attendance', 'requests', status],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/punch-out-requests', {
          params: { query: { status, limit: PAGE_SIZE, cursor: pageParam } },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

const STATUS_LOOK: Record<string, { tone: Tone; icon: LucideIcon }> = {
  pending: { tone: 'warning', icon: Clock },
  pending_admin: { tone: 'warning', icon: ShieldAlert },
  approved: { tone: 'success', icon: CircleCheck },
  rejected: { tone: 'danger', icon: CircleX },
  expired: { tone: 'neutral', icon: TimerOff },
};

function RequestStatus({ status }: { status: string }) {
  const { t } = useTranslation();
  const look = STATUS_LOOK[status] ?? STATUS_LOOK.expired;
  return (
    <StatusBadge
      tone={look.tone}
      icon={look.icon}
      label={t(`attendance.requestStatus.${status}`, { defaultValue: status })}
    />
  );
}

function RequestBody({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const decide = ({ decision, remarks, time }: Decision) =>
    unwrap(
      proxyApi().PATCH('/api/v1/admin/punch-out-requests/{request_id}/decision', {
        params: { path: { request_id: detail.id } },
        body: { decision, remarks, approved_time: time },
      }),
    );
  const open = detail.status === 'pending' || detail.status === 'pending_admin';
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
        <Selfie
          url={detail.selfie_url}
          alt={t('attendance.selfieAlt', { type: t('attendance.punchType.out') })}
        />
        <div className="grid gap-1">
          <GeofenceMap center={{ lat: detail.lat, lng: detail.lng }} radiusM={0} />
          <p className="text-caption text-muted-foreground tabular-nums">
            {t('attendance.coordinates', {
              lat: detail.lat.toFixed(6),
              lng: detail.lng.toFixed(6),
              m: Math.round(detail.accuracy_m),
            })}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-small">
        <dt className="text-muted-foreground">{t('attendance.col.status')}</dt>
        <dd>
          <RequestStatus status={detail.status} />
        </dd>
        <dt className="text-muted-foreground">{t('attendance.punchedIn')}</dt>
        <dd>{detail.punched_in_at ? formatIst(detail.punched_in_at) : '-'}</dd>
        <dt className="text-muted-foreground">{t('attendance.col.requested')}</dt>
        <dd className="font-medium">{formatIst(detail.requested_time)}</dd>
        <dt className="text-muted-foreground">{t('attendance.col.reason')}</dt>
        <dd>{detail.reason}</dd>
        {detail.note && (
          <>
            <dt className="text-muted-foreground">{t('attendance.note')}</dt>
            <dd>{detail.note}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t('attendance.nearestBranch')}</dt>
        <dd>
          {detail.nearest_branch
            ? t('attendance.branchDistance', {
                name: detail.nearest_branch,
                m: Math.round(detail.distance_m ?? 0),
              })
            : '-'}
        </dd>
        <dt className="text-muted-foreground">{t('attendance.faceCheck')}</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <FaceBadge decision={detail.face_decision} />
          <span className="tabular-nums">
            {t('attendance.score', { score: detail.face_score.toFixed(2) })}
          </span>
        </dd>
        {detail.review_reasons.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('attendance.whyChecked')}</dt>
            <dd>{words(t, 'reason', detail.review_reasons)}</dd>
          </>
        )}
        {detail.first_approver && (
          <>
            <dt className="text-muted-foreground">{t('attendance.firstApprover')}</dt>
            <dd>{`${detail.first_approver.name} (${detail.first_approver.emp_code})`}</dd>
          </>
        )}
        {detail.approver && (
          <>
            <dt className="text-muted-foreground">{t('attendance.decidedBy')}</dt>
            <dd>
              {`${detail.approver.name} (${detail.approver.emp_code})`}
              {detail.decided_at && `, ${formatIst(detail.decided_at)}`}
            </dd>
          </>
        )}
        {detail.approved_time && (
          <>
            <dt className="text-muted-foreground">{t('attendance.approvedTime')}</dt>
            <dd>{formatIst(detail.approved_time)}</dd>
          </>
        )}
        {detail.remarks && (
          <>
            <dt className="text-muted-foreground">{t('attendance.remarks')}</dt>
            <dd>{detail.remarks}</dd>
          </>
        )}
      </dl>
      {open && detail.final_by_admin && (
        <p className="flex items-start gap-2 text-small text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('attendance.finalByAdmin')}
        </p>
      )}
      {open && !detail.can_decide && (
        <p className="flex items-start gap-2 text-small text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('attendance.cannotDecide')}
        </p>
      )}
      <DecisionForm
        canDecide={detail.can_decide}
        time={{
          label: t('attendance.approvedTimeField'),
          initial: toIstLocal(detail.requested_time),
          date: detail.date,
          toggleLabel: t('attendance.approveOtherTime'),
          keepLabel: t('attendance.keepRequestedTime'),
        }}
        submit={decide}
        onClose={onClose}
      />
    </div>
  );
}

/** One out-of-office punch-out request: where, who, the selfie, and the decision. Opening it is audited. */
export function RequestDialog({ requestId, onClose }: { requestId: number; onClose: () => void }) {
  const { t } = useTranslation();
  // gcTime 0: the signed selfie link must not linger in the cache. A decision refreshes the lists,
  // not this: another load would be another audited look.
  const detail = useQuery({
    queryKey: ['attendance-request', requestId],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/punch-out-requests/{request_id}', {
          params: { path: { request_id: requestId } },
        }),
      ),
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t('attendance.requestTitle')}</DialogTitle>
        <DialogDescription>
          {detail.data
            ? t('attendance.requestFor', {
                name: detail.data.employee.name,
                code: detail.data.employee.emp_code,
                date: formatDate(detail.data.date),
              })
            : t('attendance.requestHint')}
        </DialogDescription>
        {detail.error && (
          <p role="alert" className="text-small text-danger">
            {errorMessage(t, detail.error, 'attendance')}
          </p>
        )}
        {detail.isPending && <Skeleton className="h-64 w-full rounded-md" />}
        {detail.data && <RequestBody detail={detail.data} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

const col = columnHelper<Item>();

export function RequestsTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RequestFilter>('waiting');
  const [open, setOpen] = useState<number | null>(null);
  const list = useRequests(status);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'employee',
          header: t('attendance.col.employee'),
          cell: ({ row: { original: r } }) => (
            <Person name={r.employee.name} code={r.employee.emp_code} />
          ),
        }),
        col.accessor((r) => formatDate(r.date), { id: 'date', header: t('attendance.date') }),
        col.accessor((r) => formatClock(r.requested_time), {
          id: 'requested',
          header: t('attendance.col.requested'),
        }),
        col.display({
          id: 'reason',
          header: t('attendance.col.reason'),
          cell: ({ row: { original: r } }) => (
            <span className="block max-w-56 truncate" title={r.reason}>
              {r.reason}
            </span>
          ),
        }),
        col.display({
          id: 'status',
          header: t('attendance.col.status'),
          cell: ({ row: { original: r } }) => <RequestStatus status={r.status} />,
        }),
        col.display({
          id: 'actions',
          header: t('attendance.col.actions'),
          cell: ({ row: { original: r } }) => (
            <Button
              size="xs"
              aria-label={t('attendance.openRequestOf', { name: r.employee.name })}
              onClick={() => setOpen(r.id)}
            >
              {t('attendance.open')}
            </Button>
          ),
        }),
      ]),
    [t],
  );

  return (
    <div role="tabpanel" className="space-y-4">
      <div className="max-w-56">
        <Field id="request-status" label={t('attendance.filter')}>
          <Select
            id="request-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as RequestFilter)}
          >
            {FILTERS.map((value) => (
              <option key={value} value={value}>
                {t(`attendance.requestFilter.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error, 'attendance')}
        </p>
      )}
      {list.isPending ? (
        <TableSkeleton />
      ) : (
        <DataTable columns={columns} data={rows} empty={t(`attendance.emptyRequests.${status}`)} />
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {t('common.loadMore')}
        </Button>
      )}
      {open !== null && <RequestDialog requestId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
