'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';

type Device = Schemas['DeviceOut'];
type Action = Schemas['DeviceDecision']['action'];
type Status = Schemas['DeviceOut']['status'];

const PAGE_SIZE = 50;
const col = columnHelper<Device>();

function DevicesView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status | ''>('pending');
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
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor((d) => `${d.user_name} (${d.emp_code})`, {
          id: 'employee',
          header: t('devices.col.employee'),
        }),
        col.accessor('model', { header: t('devices.col.model') }),
        col.accessor('os', { header: t('devices.col.os') }),
        col.accessor('app_version', { header: t('devices.col.appVersion') }),
        col.display({
          id: 'status',
          header: t('devices.col.status'),
          cell: ({ row: { original: d } }) => (
            <Badge variant={d.status === 'active' ? 'default' : 'secondary'}>
              {t(`devices.status.${d.status}`)}
            </Badge>
          ),
        }),
        col.accessor((d) => formatIst(d.created_at), {
          id: 'requested',
          header: t('devices.col.requestedAt'),
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
        <Select
          aria-label={t('devices.col.status')}
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | '')}
        >
          <option value="">{t('devices.status.all')}</option>
          {(['pending', 'active', 'revoked'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`devices.status.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      {list.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, list.error)}
        </p>
      )}
      {list.isPending ? (
        <p>{t('common.loading')}</p>
      ) : (
        <DataTable columns={columns} data={rows} empty={t('devices.empty')} />
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
          description={t(`devices.${pending.action}Confirm`, {
            name: pending.device.user_name,
            model: pending.device.model,
          })}
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
