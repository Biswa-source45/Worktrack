'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { Page, PageHeader } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { useSettings } from '@/components/settings/use-settings';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { BranchDialog } from './branch-dialog';

type Branch = Schemas['BranchOut'];
type Open = { kind: 'form'; branch?: Branch } | { kind: 'status'; branch: Branch };

const col = columnHelper<Branch>();

function BranchesView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [open, setOpen] = useState<Open | null>(null);

  // ponytail: one page of 200; the company has 2 branches. Add "load more" if that ever grows.
  const list = useQuery({
    queryKey: ['branches', 'list'],
    queryFn: async () =>
      (
        await unwrap(
          proxyApi().GET('/api/v1/admin/branches', { params: { query: { limit: 200 } } }),
        )
      ).items,
  });

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('name', { header: t('branches.col.name') }),
        col.accessor((b) => b.address ?? '', {
          id: 'address',
          header: t('branches.col.address'),
          cell: ({ getValue }) => (
            <span title={getValue()} className="block max-w-96 truncate">
              {getValue()}
            </span>
          ),
        }),
        col.accessor((b) => t('branches.radiusValue', { radius: b.radius_m }), {
          id: 'radius',
          header: t('branches.col.radius'),
        }),
        col.display({
          id: 'status',
          header: t('branches.col.status'),
          cell: ({ row: { original: b } }) => (
            <StatusBadge
              testId={b.is_active ? 'status-active' : 'status-inactive'}
              tone={b.is_active ? 'success' : 'neutral'}
              label={t(b.is_active ? 'common.active' : 'common.inactive')}
            />
          ),
        }),
        col.display({
          id: 'actions',
          header: t('branches.col.actions'),
          cell: ({ row: { original: b } }) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  aria-label={t('common.actionsFor', { name: b.name })}
                  className="size-11 px-0 md:size-9"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setOpen({ kind: 'form', branch: b })}>
                  {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setOpen({ kind: 'status', branch: b })}>
                  {t(b.is_active ? 'common.deactivate' : 'common.activate')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
        }),
      ]),
    [t],
  );

  async function setActive(branch: Branch) {
    await unwrap(
      proxyApi().PATCH('/api/v1/admin/branches/{branch_id}', {
        params: { path: { branch_id: branch.id } },
        body: { is_active: !branch.is_active },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: ['branches'] });
  }

  const close = () => setOpen(null);
  return (
    <Page>
      <PageHeader title={t('branches.title')}>
        {/* Waits for Settings so a new branch opens with the organisation's default radius. */}
        <Button onClick={() => setOpen({ kind: 'form' })} disabled={settings.isLoading}>
          <Plus aria-hidden="true" />
          {t('branches.create')}
        </Button>
      </PageHeader>
      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error)}
        </p>
      )}
      {list.isPending ? (
        <TableSkeleton />
      ) : (
        <DataTable columns={columns} data={list.data ?? []} empty={t('branches.empty')} />
      )}

      {open?.kind === 'form' && (
        <BranchDialog
          branch={open.branch}
          defaultRadius={settings.data?.geofence_default_radius_m}
          onClose={close}
        />
      )}
      {open?.kind === 'status' && (
        <ConfirmDialog
          title={t(open.branch.is_active ? 'common.deactivate' : 'common.activate')}
          description={t(
            open.branch.is_active ? 'branches.deactivateConfirm' : 'branches.activateConfirm',
            { name: open.branch.name },
          )}
          confirmLabel={t(open.branch.is_active ? 'common.deactivate' : 'common.activate')}
          destructive={open.branch.is_active}
          onConfirm={() => setActive(open.branch)}
          onClose={close}
        />
      )}
    </Page>
  );
}

export function BranchesPage() {
  return (
    <RequirePermission permission="branches.manage">
      <BranchesView />
    </RequirePermission>
  );
}
