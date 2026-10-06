'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/animated';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { Page, PageHeader } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { StatusBadge } from '@/components/status-badge';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { cn } from '@/lib/utils';

type Device = Schemas['DeviceOut'];
type Action = Schemas['DeviceDecision']['action'];
type Status = Schemas['DeviceOut']['status'];

const PAGE_SIZE = 50;
const TABS = ['', 'pending', 'active', 'revoked'] as const;
const STATUS_TONE = { active: 'success', pending: 'warning', revoked: 'danger' } as const;
// Status and the action buttons must stay on screen without sideways scrolling, so the less
// important columns give way on narrower screens.
const COLUMN_CLASS = {
  os: 'hidden xl:table-cell',
  app_version: 'hidden 2xl:table-cell',
  lastSeen: 'hidden lg:table-cell',
};
const col = columnHelper<Device>();

function DevicesView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status | ''>('');
  const [pending, setPending] = useState<{ device: Device; action: Action } | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['devices', { status }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/devices', {
          params: { query: { status: status || undefined, limit: PAGE_SIZE, cursor: pageParam } },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // Keeps the tab counts on screen while another tab loads.
    placeholderData: keepPreviousData,
  });
  const counts = list.data?.pages.at(-1)?.counts;
  const countOf = (tab: Status | '') =>
    counts === undefined
      ? ''
      : tab === ''
        ? counts.pending + counts.active + counts.revoked
        : counts[tab];
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'employee',
          header: t('devices.col.employee'),
          cell: ({ row: { original: d } }) => (
            <div className="flex items-center gap-2 py-1">
              <Avatar name={d.user_name} />
              <div className="max-w-56 min-w-0 whitespace-normal break-words xl:max-w-88">
                <span className="font-medium">{`${d.user_name} (${d.emp_code})`}</span>
                {d.conflict && (
                  <p
                    data-testid={`conflict-${d.id}`}
                    className="flex items-start gap-1 text-caption text-warning"
                  >
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    {t('devices.conflict', { name: d.conflict.name, code: d.conflict.emp_code })}
                  </p>
                )}
              </div>
            </div>
          ),
        }),
        col.accessor('model', {
          header: t('devices.col.model'),
          cell: ({ getValue }) => (
            <span title={getValue()} className="block max-w-32 truncate xl:max-w-48">
              {getValue()}
            </span>
          ),
        }),
        col.accessor('os', { header: t('devices.col.os') }),
        col.accessor('app_version', { header: t('devices.col.appVersion') }),
        col.accessor((d) => formatIst(d.last_seen_at), {
          id: 'lastSeen',
          header: t('devices.col.lastSeen'),
        }),
        col.display({
          id: 'status',
          header: t('devices.col.status'),
          cell: ({ row: { original: d } }) => (
            <StatusBadge
              testId={`status-${d.status}`}
              tone={STATUS_TONE[d.status]}
              label={t(`devices.status.${d.status}`)}
            />
          ),
        }),
        col.display({
          id: 'actions',
          header: t('devices.col.actions'),
          cell: ({ row: { original: d } }) => (
            <span className="flex gap-1.5">
              {d.status === 'pending' && (
                <>
                  <Button size="xs" onClick={() => setPending({ device: d, action: 'approve' })}>
                    {t('devices.approve')}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setPending({ device: d, action: 'reject' })}
                  >
                    {t('devices.reject')}
                  </Button>
                </>
              )}
              {d.status === 'active' && (
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => setPending({ device: d, action: 'revoke' })}
                >
                  {t('devices.revoke')}
                </Button>
              )}
            </span>
          ),
        }),
      ]),
    [t],
  );

  async function decide({ device, action }: { device: Device; action: Action }) {
    await unwrap(
      proxyApi().PATCH('/api/v1/admin/devices/{device_id}', {
        params: { path: { device_id: device.id } },
        body: { action },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: ['devices'] });
  }

  return (
    <Page>
      <PageHeader title={t('devices.title')} />
      <div
        role="tablist"
        aria-label={t('devices.col.status')}
        className="inline-flex flex-wrap gap-1 rounded-full border bg-card p-1 shadow-sm"
      >
        {TABS.map((tab) => {
          const selected = status === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setStatus(tab)}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-full px-3 text-small font-medium transition-transform active:scale-(--wt-press-scale)',
                selected
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'text-muted-foreground hover:bg-raised hover:text-foreground',
              )}
            >
              {t(`devices.status.${tab || 'all'}`)}{' '}
              <span
                data-testid={`count-${tab || 'all'}`}
                className={cn(
                  'rounded-full px-1.5 text-caption tabular-nums',
                  !selected && 'bg-raised text-foreground',
                )}
              >
                {countOf(tab)}
              </span>
            </button>
          );
        })}
      </div>
      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error)}
        </p>
      )}
      {list.isPending || list.isPlaceholderData ? (
        <TableSkeleton />
      ) : (
        <TabPanel>
          <DataTable
            columns={columns}
            data={rows}
            empty={t(`devices.empty.${status || 'all'}`)}
            columnClass={COLUMN_CLASS}
          />
        </TabPanel>
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
      {pending && (
        <ConfirmDialog
          title={t(`devices.${pending.action}`)}
          description={
            pending.action === 'approve' && pending.device.conflict
              ? t('devices.approveConflictConfirm', {
                  name: pending.device.user_name,
                  model: pending.device.model,
                  other: pending.device.conflict.name,
                  code: pending.device.conflict.emp_code,
                })
              : t(`devices.${pending.action}Confirm`, {
                  name: pending.device.user_name,
                  model: pending.device.model,
                })
          }
          confirmLabel={t(`devices.${pending.action}`)}
          destructive={pending.action !== 'approve'}
          onConfirm={() => decide(pending)}
          onClose={() => setPending(null)}
        />
      )}
    </Page>
  );
}

export function DevicesPage() {
  return (
    <RequirePermission permission="devices.manage">
      <DevicesView />
    </RequirePermission>
  );
}
