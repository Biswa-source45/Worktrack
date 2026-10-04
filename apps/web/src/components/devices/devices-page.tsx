'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { RequirePermission } from '@/components/require-permission';
import { StatusBadge, StatusIcon } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';

type Device = Schemas['DeviceOut'];
type Action = Schemas['DeviceDecision']['action'];
type Status = Schemas['DeviceOut']['status'];

const PAGE_SIZE = 50;
const TABS = ['', 'pending', 'active', 'revoked'] as const;
const STATUS_ICON = { active: 'check-circle', pending: 'clock', revoked: 'x-circle' } as const;
const STATUS_VARIANT = { active: 'default', pending: 'secondary', revoked: 'destructive' } as const;
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
            <>
              {`${d.user_name} (${d.emp_code})`}
              {d.conflict && (
                <p
                  data-testid={`conflict-${d.id}`}
                  className="mt-1 flex items-center text-xs text-muted-foreground"
                >
                  <StatusIcon name="alert-circle" />
                  {t('devices.conflict', { name: d.conflict.name, code: d.conflict.emp_code })}
                </p>
              )}
            </>
          ),
        }),
        col.accessor('model', { header: t('devices.col.model') }),
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
              icon={STATUS_ICON[d.status]}
              variant={STATUS_VARIANT[d.status]}
              label={t(`devices.status.${d.status}`)}
            />
          ),
        }),
        col.display({
          id: 'actions',
          header: t('devices.col.actions'),
          cell: ({ row: { original: d } }) => (
            <span className="flex gap-1">
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
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{t('devices.title')}</h1>
      </div>
      <div role="tablist" aria-label={t('devices.col.status')} className="flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <Button
            key={tab}
            role="tab"
            aria-selected={status === tab}
            variant={status === tab ? 'default' : 'outline'}
            onClick={() => setStatus(tab)}
          >
            {t(`devices.status.${tab || 'all'}`)}{' '}
            <span data-testid={`count-${tab || 'all'}`} className="tabular-nums">
              {countOf(tab)}
            </span>
          </Button>
        ))}
      </div>
      {list.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, list.error)}
        </p>
      )}
      {list.isPending || list.isPlaceholderData ? (
        <p>{t('common.loading')}</p>
      ) : (
        <div role="tabpanel">
          <DataTable columns={columns} data={rows} empty={t(`devices.empty.${status || 'all'}`)} />
        </div>
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
    </section>
  );
}

export function DevicesPage() {
  return (
    <RequirePermission permission="devices.manage">
      <DevicesView />
    </RequirePermission>
  );
}
