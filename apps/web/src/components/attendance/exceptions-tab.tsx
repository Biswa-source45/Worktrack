'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Bot,
  MapPinOff,
  Navigation,
  ScanFace,
  ShieldX,
  Smartphone,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { StatusBadge } from '@/components/status-badge';
import type { Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { Person } from './shared';

type Item = Schemas['ExceptionItem'];

// Attempts that were refused or flagged. Integrity ones (a faked location, a rooted phone) are
// danger; the rest are things that can happen to an honest person.
const KINDS = [
  { id: 'MOCK_LOCATION', tone: 'danger', icon: MapPinOff },
  { id: 'ROOTED_DEVICE', tone: 'danger', icon: Smartphone },
  { id: 'EMULATOR', tone: 'danger', icon: Bot },
  { id: 'OUTSIDE_GEOFENCE', tone: 'warning', icon: Navigation },
  { id: 'GPS_ACCURACY_POOR', tone: 'warning', icon: ShieldX },
  { id: 'IMPOSSIBLE_JUMP', tone: 'danger', icon: Zap },
  { id: 'FACE_MISMATCH', tone: 'danger', icon: ScanFace },
] as const satisfies readonly { id: string; tone: Tone; icon: LucideIcon }[];
type Kind = (typeof KINDS)[number]['id'];
const PAGE_SIZE = 50;
const col = columnHelper<Item>();

export function ExceptionsTab() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'' | Kind>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['attendance', 'exceptions', { kind, from, to }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/attendance-exceptions', {
          params: {
            query: {
              kind: kind || undefined,
              from_date: from || undefined,
              to_date: to || undefined,
              limit: PAGE_SIZE,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor((r) => formatIst(r.at), { id: 'at', header: t('attendance.col.time') }),
        col.display({
          id: 'employee',
          header: t('attendance.col.employee'),
          cell: ({ row: { original: r } }) => (
            <Person name={r.employee.name} code={r.employee.emp_code} />
          ),
        }),
        col.display({
          id: 'kind',
          header: t('attendance.col.kind'),
          cell: ({ row: { original: r } }) => {
            const look = KINDS.find((k) => k.id === r.kind);
            return (
              <StatusBadge
                tone={look?.tone ?? 'neutral'}
                icon={look?.icon}
                label={t(`attendance.kind.${r.kind}`, { defaultValue: r.kind })}
              />
            );
          },
        }),
        col.accessor((r) => r.nearest_branch ?? '-', {
          id: 'branch',
          header: t('attendance.nearestBranch'),
        }),
        col.accessor(
          (r) =>
            r.distance_m === null ? '-' : t('attendance.metres', { m: Math.round(r.distance_m) }),
          {
            id: 'distance',
            header: t('attendance.col.distance'),
          },
        ),
      ]),
    [t],
  );

  return (
    <div role="tabpanel" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="exception-kind" label={t('attendance.col.kind')}>
          <Select
            id="exception-kind"
            className="w-56"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind | '')}
          >
            <option value="">{t('attendance.allKinds')}</option>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {t(`attendance.kind.${k.id}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="exception-from" label={t('attendance.from')}>
          <Input
            id="exception-from"
            type="date"
            className="w-44"
            max={to || undefined}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <Field id="exception-to" label={t('attendance.to')}>
          <Input
            id="exception-to"
            type="date"
            className="w-44"
            min={from || undefined}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
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
        <DataTable
          columns={columns}
          data={rows}
          empty={t('attendance.emptyExceptions')}
          // The distance says how far it was; the branch name can wait for a wider screen.
          columnClass={{ branch: 'hidden lg:table-cell' }}
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
    </div>
  );
}
