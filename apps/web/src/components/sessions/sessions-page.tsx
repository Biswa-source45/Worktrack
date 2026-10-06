'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { Monitor, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/animated';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { Page, PageHeader } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { StatusBadge } from '@/components/status-badge';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatIst } from '@/lib/ist';
import { cn } from '@/lib/utils';

type Session = Schemas['SessionOut'];
type Status = Session['status'];
type Client = Session['client'];

const PAGE_SIZE = 50;
const TABS = ['', 'active', 'ended'] as const;
const STATUS_TONE = { active: 'success', ended: 'neutral' } as const;
const CLIENT_ICON = { web: Monitor, mobile: Smartphone };
// Status and the sign-out button must stay on screen without sideways scrolling, so the less
// important columns give way on narrower screens.
const COLUMN_CLASS = {
  os: 'hidden xl:table-cell',
  ip: 'hidden xl:table-cell',
  signedIn: 'hidden 2xl:table-cell',
  lastSeen: 'hidden lg:table-cell',
};
const col = columnHelper<Session>();

// What the session runs on: the browser for web, the phone model for mobile.
function deviceOf(t: TFunction, s: Session) {
  return s.client === 'web'
    ? (s.browser ?? t('sessions.unknownBrowser'))
    : (s.device_model ?? t('sessions.notRecorded'));
}

function SessionsView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status | ''>('active');
  const [client, setClient] = useState<Client | ''>('');
  const [pending, setPending] = useState<Session | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['sessions', { status, client }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/sessions', {
          params: {
            query: {
              status: status || undefined,
              client: client || undefined,
              limit: PAGE_SIZE,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // Keeps the tab counts on screen while another tab loads.
    placeholderData: keepPreviousData,
  });
  const counts = list.data?.pages.at(-1)?.counts;
  const countOf = (tab: Status | '') =>
    counts === undefined ? '' : tab === '' ? counts.active + counts.ended : counts[tab];
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const columns = useMemo(() => {
    const notRecorded = t('sessions.notRecorded');
    return col.columns([
      col.display({
        id: 'employee',
        header: t('sessions.col.employee'),
        cell: ({ row: { original: s } }) => (
          <div className="flex items-center gap-2 py-1">
            <Avatar name={s.user_name} />
            <span className="max-w-56 min-w-0 font-medium whitespace-normal break-words xl:max-w-88">
              {`${s.user_name} (${s.emp_code})`}
            </span>
          </div>
        ),
      }),
      col.display({
        id: 'type',
        header: t('sessions.col.type'),
        cell: ({ row: { original: s } }) => {
          const Icon = CLIENT_ICON[s.client];
          return (
            <span className="inline-flex items-center gap-1.5">
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              {t(`sessions.type.${s.client}`)}
            </span>
          );
        },
      }),
      col.accessor((s) => deviceOf(t, s), {
        id: 'device',
        header: t('sessions.col.device'),
        cell: ({ getValue }) => (
          <span title={getValue()} className="block max-w-32 truncate xl:max-w-48">
            {getValue()}
          </span>
        ),
      }),
      col.accessor((s) => s.os ?? notRecorded, { id: 'os', header: t('sessions.col.os') }),
      col.accessor((s) => s.ip ?? notRecorded, { id: 'ip', header: t('sessions.col.ip') }),
      col.accessor((s) => formatIst(s.created_at), {
        id: 'signedIn',
        header: t('sessions.col.signedIn'),
      }),
      col.accessor((s) => formatIst(s.last_seen_at), {
        id: 'lastSeen',
        header: t('sessions.col.lastSeen'),
      }),
      col.display({
        id: 'status',
        header: t('sessions.col.status'),
        cell: ({ row: { original: s } }) => (
          <div className="flex flex-col items-start gap-1 py-1">
            <StatusBadge
              testId={`status-${s.status}`}
              tone={STATUS_TONE[s.status]}
              label={t(`sessions.status.${s.status}`)}
            />
            {s.status === 'ended' && (
              <span className="text-caption text-muted-foreground">
                {t(`sessions.reason.${s.end_reason}`, {
                  defaultValue: t('sessions.reason.other'),
                })}
              </span>
            )}
            {s.current && (
              <Badge tone="info" data-testid="current-session">
                {t('sessions.current')}
              </Badge>
            )}
          </div>
        ),
      }),
      col.display({
        id: 'actions',
        header: t('sessions.col.actions'),
        cell: ({ row: { original: s } }) =>
          s.status === 'active' && (
            <Button
              size="xs"
              variant="destructive"
              // The header already has a "Sign out" button (the admin's own logout).
              aria-label={t('sessions.signOutOf', { name: s.user_name })}
              onClick={() => setPending(s)}
            >
              {t('sessions.signOut')}
            </Button>
          ),
      }),
    ]);
  }, [t]);

  async function revoke(session: Session) {
    await unwrap(
      proxyApi().POST('/api/v1/admin/sessions/{session_id}/revoke', {
        params: { path: { session_id: session.id } },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  return (
    <Page>
      <PageHeader title={t('sessions.title')} />
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label={t('sessions.col.status')}
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
                {t(`sessions.status.${tab || 'all'}`)}{' '}
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
        <Select
          aria-label={t('sessions.col.type')}
          className="w-36"
          value={client}
          onChange={(e) => setClient(e.target.value as Client | '')}
        >
          <option value="">{t('sessions.type.all')}</option>
          <option value="web">{t('sessions.type.web')}</option>
          <option value="mobile">{t('sessions.type.mobile')}</option>
        </Select>
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
            empty={t(`sessions.empty.${status || 'all'}`)}
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
          title={t('sessions.signOutTitle')}
          description={[
            t('sessions.signOutConfirm', {
              name: pending.user_name,
              device: deviceOf(t, pending),
            }),
            pending.current ? t('sessions.signOutSelf') : '',
          ]
            .join(' ')
            .trim()}
          confirmLabel={t('sessions.signOutTitle')}
          destructive
          onConfirm={() => revoke(pending)}
          onClose={() => setPending(null)}
        />
      )}
    </Page>
  );
}

export function SessionsPage() {
  return (
    <RequirePermission permission="devices.manage">
      <SessionsView />
    </RequirePermission>
  );
}
