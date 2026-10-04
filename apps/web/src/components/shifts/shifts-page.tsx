'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { Page, PageHeader } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { StatusBadge } from '@/components/status-badge';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { HolidaysTab } from './holidays-tab';
import { ShiftDialog } from './shift-dialog';
import { weeklyOffWords } from './weekly-offs';

type Shift = Schemas['ShiftOut'];
type Open = { kind: 'form'; shift?: Shift } | { kind: 'status'; shift: Shift };

const col = columnHelper<Shift>();
const hhmm = (time: string) => time.slice(0, 5);

function ShiftsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Open | null>(null);

  // One page of 200: a company this size has a handful of shifts.
  const list = useQuery({
    queryKey: ['shifts', 'list'],
    queryFn: async () =>
      (await unwrap(proxyApi().GET('/api/v1/admin/shifts', { params: { query: { limit: 200 } } })))
        .items,
  });

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('name', { header: t('shifts.col.name') }),
        col.accessor(
          (s) => t('shifts.timeRange', { start: hhmm(s.start_time), end: hhmm(s.end_time) }),
          {
            id: 'time',
            header: t('shifts.col.time'),
          },
        ),
        col.accessor((s) => t('shifts.graceValue', { count: s.grace_min }), {
          id: 'grace',
          header: t('shifts.col.grace'),
        }),
        col.accessor(
          (s) => t('shifts.hoursValue', { half: s.half_day_hours, full: s.full_day_hours }),
          { id: 'hours', header: t('shifts.col.hours') },
        ),
        col.accessor((s) => weeklyOffWords(t, s.weekly_offs), {
          id: 'offs',
          header: t('shifts.col.offs'),
          cell: ({ getValue }) => <span className="whitespace-normal">{getValue()}</span>,
        }),
        col.display({
          id: 'status',
          header: t('shifts.col.status'),
          cell: ({ row: { original: s } }) => (
            <StatusBadge
              testId={s.is_active ? 'status-active' : 'status-inactive'}
              tone={s.is_active ? 'success' : 'neutral'}
              label={t(s.is_active ? 'common.active' : 'common.inactive')}
            />
          ),
        }),
        col.display({
          id: 'actions',
          header: t('shifts.col.actions'),
          cell: ({ row: { original: s } }) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  aria-label={t('common.actionsFor', { name: s.name })}
                  className="size-11 px-0 md:size-9"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setOpen({ kind: 'form', shift: s })}>
                  {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setOpen({ kind: 'status', shift: s })}>
                  {t(s.is_active ? 'common.deactivate' : 'common.activate')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
        }),
      ]),
    [t],
  );

  async function setActive(shift: Shift) {
    await unwrap(
      proxyApi().PATCH('/api/v1/admin/shifts/{shift_id}', {
        params: { path: { shift_id: shift.id } },
        body: { is_active: !shift.is_active },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: ['shifts'] });
  }

  const close = () => setOpen(null);
  return (
    <div role="tabpanel" className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen({ kind: 'form' })}>
          <Plus aria-hidden="true" />
          {t('shifts.create')}
        </Button>
      </div>
      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error)}
        </p>
      )}
      {list.isPending ? (
        <TableSkeleton />
      ) : (
        <DataTable columns={columns} data={list.data ?? []} empty={t('shifts.empty')} />
      )}

      {open?.kind === 'form' && <ShiftDialog shift={open.shift} onClose={close} />}
      {open?.kind === 'status' && (
        <ConfirmDialog
          title={t(open.shift.is_active ? 'common.deactivate' : 'common.activate')}
          description={t(
            open.shift.is_active ? 'shifts.deactivateConfirm' : 'shifts.activateConfirm',
            { name: open.shift.name },
          )}
          confirmLabel={t(open.shift.is_active ? 'common.deactivate' : 'common.activate')}
          destructive={open.shift.is_active}
          onConfirm={() => setActive(open.shift)}
          onClose={close}
        />
      )}
    </div>
  );
}

function ShiftsView() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'shifts' | 'holidays'>('shifts');
  return (
    <Page>
      <PageHeader title={t('shifts.title')} />
      <Tabs
        label={t('shifts.title')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'shifts', label: t('shifts.tab') },
          { id: 'holidays', label: t('holidays.tab') },
        ]}
      />
      {tab === 'shifts' ? <ShiftsTab /> : <HolidaysTab />}
    </Page>
  );
}

export function ShiftsPage() {
  return (
    <RequirePermission permission="branches.manage">
      <ShiftsView />
    </RequirePermission>
  );
}
