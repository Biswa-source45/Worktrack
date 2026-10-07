'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Ellipsis, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/animated';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input, Select } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatClock, todayIst } from '@/lib/ist';
import { useMe } from '@/lib/me';
import { useDebounced } from '@/lib/use-debounced';
import { DayDialog } from './day-dialog';
import { OverrideDialog } from './override-dialog';
import { DayStatusBadge, FlagChips, Hours, Person } from './shared';

type Row = Schemas['RegisterRow'];

const STATUSES = [
  'working',
  'present',
  'half_day',
  'short_hours',
  'absent',
  'holiday',
  'weekly_off',
  'pending',
  'missed_punch_out',
  'leave',
  'work_from_home',
  'on_duty',
  'no_record',
] as const;
const PAGE_SIZE = 50;
const col = columnHelper<Row>();

type Dialog = { kind: 'day'; dayId: number } | { kind: 'override'; row: Row };

export function RegisterTab() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const canOverride = me?.permissions.includes('attendance.override') ?? false;
  const [date, setDate] = useState(todayIst);
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<'' | (typeof STATUSES)[number]>('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const q = useDebounced(search.trim(), 300);

  const branches = useQuery({
    queryKey: ['branches', 'names'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/branches')),
  });
  const list = useInfiniteQuery({
    queryKey: ['attendance', 'register', { date, branch, status, q }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/attendance', {
          params: {
            query: {
              date,
              branch_id: branch ? Number(branch) : undefined,
              status: status || undefined,
              q: q || undefined,
              limit: PAGE_SIZE,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // Typing in the search box keeps the current rows until the result arrives.
    placeholderData: keepPreviousData,
  });
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
        col.display({
          id: 'status',
          header: t('attendance.col.status'),
          cell: ({ row: { original: r } }) => <DayStatusBadge status={r.status} />,
        }),
        // A punch with no branch was made at the employee's approved home location.
        col.accessor((r) => r.branch ?? (r.first_in_at ? t('attendance.home') : '-'), {
          id: 'branch',
          header: t('attendance.col.branch'),
        }),
        col.accessor((r) => (r.first_in_at ? formatClock(r.first_in_at) : '-'), {
          id: 'in',
          header: t('attendance.col.in'),
        }),
        col.accessor((r) => (r.last_out_at ? formatClock(r.last_out_at) : '-'), {
          id: 'out',
          header: t('attendance.col.out'),
        }),
        col.display({
          id: 'hours',
          header: t('attendance.col.hours'),
          cell: ({ row: { original: r } }) =>
            r.first_in_at ? <Hours minutes={r.worked_minutes} /> : '-',
        }),
        col.accessor((r) => (r.late_minutes > 0 ? String(r.late_minutes) : '-'), {
          id: 'late',
          header: t('attendance.col.late'),
        }),
        col.display({
          id: 'flags',
          header: t('attendance.col.flags'),
          cell: ({ row: { original: r } }) => <FlagChips flags={r.flags} />,
        }),
        col.display({
          id: 'actions',
          header: t('attendance.col.actions'),
          cell: ({ row: { original: r } }) => {
            const dayId = r.day_id;
            // A day nobody punched on has no record to open; it can still be marked.
            if (dayId === null && !canOverride) return null;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    aria-label={t('common.actionsFor', { name: r.employee.name })}
                    className="size-11 px-0 md:size-9"
                  >
                    <Ellipsis aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {dayId !== null && (
                    <DropdownMenuItem onSelect={() => setDialog({ kind: 'day', dayId })}>
                      {t('attendance.details')}
                    </DropdownMenuItem>
                  )}
                  {canOverride && (
                    <DropdownMenuItem onSelect={() => setDialog({ kind: 'override', row: r })}>
                      {t('attendance.override')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          },
        }),
      ]),
    [t, canOverride],
  );

  return (
    <TabPanel className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="register-date" label={t('attendance.date')}>
          <Input
            id="register-date"
            type="date"
            className="w-44"
            max={todayIst()}
            value={date}
            // A half-typed date arrives as empty: keep the last whole one.
            onChange={(event) => event.target.value && setDate(event.target.value)}
          />
        </Field>
        <Field id="register-branch" label={t('attendance.col.branch')}>
          <Select
            id="register-branch"
            className="w-44"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          >
            <option value="">{t('attendance.allBranches')}</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="register-status" label={t('attendance.col.status')}>
          <Select
            id="register-status"
            className="w-44"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="">{t('attendance.allStatuses')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`attendance.dayStatus.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t('attendance.search')}
            placeholder={t('attendance.search')}
            className="w-64 pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
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
        <DataTable
          columns={columns}
          data={rows}
          empty={t('attendance.emptyRegister')}
          // Branch and late minutes also show in the day's details; dropping them keeps the flags
          // and the row menu in view at 768.
          columnClass={{ branch: 'hidden lg:table-cell', late: 'hidden lg:table-cell' }}
        />
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
      {dialog?.kind === 'day' && <DayDialog dayId={dialog.dayId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'override' && (
        <OverrideDialog
          employee={dialog.row.employee}
          date={date}
          onClose={() => setDialog(null)}
        />
      )}
    </TabPanel>
  );
}
