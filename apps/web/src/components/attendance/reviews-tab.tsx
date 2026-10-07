'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/animated';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatDate, formatIst, toIstLocal } from '@/lib/ist';
import { DecisionForm, type Decision } from './decision-form';
import { FaceBadge, PlaceText, Person, ReviewBadge, Selfie, words } from './shared';

type Item = Schemas['ReviewItem'];
type Detail = Schemas['ReviewDetail'];
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type ReviewReason = '' | 'face_borderline' | 'face_mismatch' | 'offline' | 'impossible_jump';
const STATUSES: ReviewStatus[] = ['pending', 'approved', 'rejected'];
const REASONS: ReviewReason[] = ['face_borderline', 'face_mismatch', 'offline', 'impossible_jump'];
const PAGE_SIZE = 50;

// The list also feeds the count on the page's tab: the same key means one request for both.
export const useReviews = (status: ReviewStatus, reason: ReviewReason = '', enabled = true) =>
  useInfiniteQuery({
    queryKey: ['attendance', 'reviews', status, reason],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/punch-reviews', {
          params: {
            query: { status, reason: reason || undefined, limit: PAGE_SIZE, cursor: pageParam },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

/** The thresholds the server used for this punch, as the two numbers a reviewer compares the score with. */
function thresholdsOf(raw: Detail['thresholds']) {
  const verify = raw.verify;
  const review = raw.review;
  return typeof verify === 'number' && typeof review === 'number' ? { verify, review } : null;
}

function ReviewBody({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const decide = ({ decision, remarks, time }: Decision) =>
    unwrap(
      proxyApi().POST('/api/v1/admin/punch-reviews/{event_id}/decision', {
        params: { path: { event_id: detail.id } },
        body: { decision, remarks, effective_time: time },
      }),
    );
  const thresholds = thresholdsOf(detail.thresholds);
  const type = t(`attendance.punchType.${detail.type}`);
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
        <Selfie url={detail.selfie_url} alt={t('attendance.selfieAlt', { type })} />
        <dl className="grid grid-cols-[auto_1fr] content-start items-center gap-x-4 gap-y-1 text-small">
          <dt className="text-muted-foreground">{t('attendance.col.status')}</dt>
          <dd>
            <ReviewBadge status={detail.review_status} />
          </dd>
          <dt className="text-muted-foreground">{t('attendance.punch')}</dt>
          <dd className="flex flex-wrap items-center gap-1.5 font-medium">
            {type} {formatIst(detail.time)}
            {detail.offline && <Badge tone="warning">{t('attendance.flag.offline')}</Badge>}
          </dd>
          <dt className="text-muted-foreground">{t('attendance.col.reason')}</dt>
          <dd>{words(t, 'reason', detail.review_reasons) || '-'}</dd>
          <dt className="text-muted-foreground">{t('attendance.faceCheck')}</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <FaceBadge decision={detail.face_decision} />
            <span className="tabular-nums">
              {t('attendance.score', { score: detail.face_score.toFixed(2) })}
            </span>
          </dd>
          {thresholds && (
            <>
              <dt className="text-muted-foreground">{t('attendance.thresholds')}</dt>
              <dd className="tabular-nums">
                {t('attendance.thresholdsValue', {
                  verify: thresholds.verify.toFixed(2),
                  review: thresholds.review.toFixed(2),
                })}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('attendance.place.label')}</dt>
          <dd>
            <PlaceText place={detail.place} />
          </dd>
          <dt className="text-muted-foreground">{t('attendance.accuracy')}</dt>
          <dd className="tabular-nums">
            {t('attendance.metres', { m: Math.round(detail.accuracy_m) })}
          </dd>
          <dt className="text-muted-foreground">{t('attendance.serverTime')}</dt>
          <dd>{formatIst(detail.server_time)}</dd>
          <dt className="text-muted-foreground">{t('attendance.deviceTime')}</dt>
          <dd>{detail.device_time ? formatIst(detail.device_time) : '-'}</dd>
          {detail.integrity_flags.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t('attendance.integrityLabel')}</dt>
              <dd className="text-danger">{words(t, 'integrity', detail.integrity_flags)}</dd>
            </>
          )}
          {detail.review_remarks && (
            <>
              <dt className="text-muted-foreground">{t('attendance.remarks')}</dt>
              <dd>{detail.review_remarks}</dd>
            </>
          )}
        </dl>
      </div>
      {detail.review_status === 'pending' && !detail.can_decide && (
        <p className="flex items-start gap-2 text-small text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('attendance.cannotReviewOwn')}
        </p>
      )}
      <DecisionForm
        canDecide={detail.can_decide}
        // Only an offline punch may be counted at another time; it starts at the time it arrived.
        time={
          detail.offline
            ? {
                label: t('attendance.timeToCount'),
                initial: toIstLocal(detail.time),
                date: detail.date,
              }
            : undefined
        }
        submit={decide}
        onClose={onClose}
      />
    </div>
  );
}

/** One punch waiting for a person to look at it. Opening it is audited. */
export function ReviewDialog({ eventId, onClose }: { eventId: number; onClose: () => void }) {
  const { t } = useTranslation();
  // gcTime 0: the signed selfie link must not linger in the cache.
  const detail = useQuery({
    queryKey: ['attendance-review', eventId],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/punch-reviews/{event_id}', {
          params: { path: { event_id: eventId } },
        }),
      ),
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t('attendance.reviewTitle')}</DialogTitle>
        <DialogDescription>
          {detail.data
            ? t('attendance.reviewFor', {
                name: detail.data.employee.name,
                code: detail.data.employee.emp_code,
                date: formatDate(detail.data.date),
              })
            : t('attendance.reviewHint')}
        </DialogDescription>
        {detail.error && (
          <p role="alert" className="text-small text-danger">
            {errorMessage(t, detail.error, 'attendance')}
          </p>
        )}
        {detail.isPending && <Skeleton className="h-64 w-full rounded-md" />}
        {detail.data && <ReviewBody detail={detail.data} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

const col = columnHelper<Item>();

export function ReviewsTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReviewStatus>('pending');
  const [reason, setReason] = useState<ReviewReason>('');
  const [open, setOpen] = useState<number | null>(null);
  const list = useReviews(status, reason);
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
        col.accessor((r) => `${t(`attendance.punchType.${r.type}`)} ${formatIst(r.time)}`, {
          id: 'punch',
          header: t('attendance.punch'),
        }),
        col.accessor((r) => words(t, 'reason', r.review_reasons), {
          id: 'reason',
          header: t('attendance.col.reason'),
        }),
        col.display({
          id: 'face',
          header: t('attendance.faceCheck'),
          cell: ({ row: { original: r } }) => <FaceBadge decision={r.face_decision} />,
        }),
        col.display({
          id: 'actions',
          header: t('attendance.col.actions'),
          cell: ({ row: { original: r } }) => (
            <Button
              size="xs"
              aria-label={t('attendance.openReviewOf', { name: r.employee.name })}
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
    <TabPanel className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div className="w-56">
          <Field id="review-status" label={t('attendance.filter')}>
            <Select
              id="review-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as ReviewStatus)}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`attendance.reviewFilter.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-56">
          <Field id="review-reason" label={t('attendance.col.reason')}>
            <Select
              id="review-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value as ReviewReason)}
            >
              <option value="">{t('attendance.allReasons')}</option>
              {REASONS.map((value) => (
                <option key={value} value={value}>
                  {t(`attendance.reason.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error, 'attendance')}
        </p>
      )}
      {list.isPending ? (
        <TableSkeleton />
      ) : (
        <DataTable columns={columns} data={rows} empty={t(`attendance.emptyReviews.${status}`)} />
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
      {open !== null && <ReviewDialog eventId={open} onClose={() => setOpen(null)} />}
    </TabPanel>
  );
}
