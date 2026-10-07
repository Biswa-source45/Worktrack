'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabPanel } from '@/components/animated';
import { Field } from '@/components/field';
import { Page, PageHeader } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import { useMe } from '@/lib/me';
import { useDebounced } from '@/lib/use-debounced';
import { TaskBoard } from './task-board';
import { TaskDialog } from './task-dialog';
import { TaskList } from './task-list';
import { ALL_STATUSES, BOARD_STATUSES, CLOSED_STATUSES } from './task-status';

const PAGE_SIZE = 100;
type View = 'all' | 'assigned_by_me' | 'team';
type Tab = 'board' | 'list';

function TasksView() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const permissions = me?.permissions;
  const canCreate = permissions?.includes('tasks.create') ?? false;
  // Same order as the server default: everyone's tasks, then the ones I created, then my team's.
  const views = useMemo(
    () =>
      (
        [
          ['all', permissions?.includes('tasks.view_all')],
          ['assigned_by_me', canCreate],
          ['team', permissions?.includes('team.view')],
        ] as const
      )
        .filter(([, allowed]) => allowed)
        .map(([view]) => view),
    [permissions, canCreate],
  );
  const [tab, setTab] = useState<Tab>('board');
  const [chosenView, setView] = useState<View | null>(null);
  const view: View | undefined = chosenView ?? views[0];
  const [status, setStatus] = useState('');
  const [assignee, setAssignee] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [typeId, setTypeId] = useState('');
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim(), 300);

  const types = useQuery({
    queryKey: ['task-types'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/task-types')),
  });
  // Who the employee filter offers: any field-eligible person for an assigner, the team for a
  // manager. Both are small lists (a company of about 35).
  const people = useQuery({
    queryKey: ['tasks', 'people', canCreate],
    queryFn: async () =>
      canCreate
        ? (await unwrap(proxyApi().GET('/api/v1/tasks/candidates'))).items
        : (
            await unwrap(
              proxyApi().GET('/api/v1/employees/team', { params: { query: { limit: 100 } } }),
            )
          ).items,
  });

  const boardColumns = status
    ? [status]
    : [...BOARD_STATUSES, ...(showClosed ? CLOSED_STATUSES : [])];
  // The board asks for its own columns; the list shows every status unless one is chosen.
  const statuses = status ? [status] : tab === 'board' ? boardColumns : undefined;
  const list = useInfiniteQuery({
    queryKey: ['tasks', 'list', { view, statuses, assignee, from, to, typeId, q }],
    enabled: view !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/tasks', {
          params: {
            query: {
              view,
              status: statuses,
              assignee: assignee ? Number(assignee) : undefined,
              from: from || undefined,
              to: to || undefined,
              type_id: typeId ? Number(typeId) : undefined,
              q: q || undefined,
              limit: PAGE_SIZE,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const tasks = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  return (
    <Page>
      <PageHeader title={t('tasks.title')}>
        {canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {t('tasks.create')}
          </Button>
        )}
      </PageHeader>

      <Tabs
        label={t('tasks.title')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'board', label: t('tasks.board') },
          { id: 'list', label: t('tasks.list') },
        ]}
      />

      <div className="flex flex-wrap items-end gap-3">
        {views.length > 1 && (
          <Field id="tasks-view" label={t('tasks.view.label')}>
            <Select
              id="tasks-view"
              className="w-44"
              value={view}
              onChange={(e) => setView(e.target.value as View)}
            >
              {views.map((v) => (
                <option key={v} value={v}>
                  {t(`tasks.view.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field id="tasks-status" label={t('tasks.col.status')}>
          <Select
            id="tasks-status"
            className="w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t('tasks.allStatuses')}</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`tasks.status.${s}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="tasks-assignee" label={t('tasks.filter.employee')}>
          <Select
            id="tasks-assignee"
            className="w-48"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">{t('tasks.filter.anyone')}</option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="tasks-type" label={t('tasks.col.type')}>
          <Select
            id="tasks-type"
            className="w-44"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
          >
            <option value="">{t('tasks.filter.anyType')}</option>
            {(types.data ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="tasks-from" label={t('tasks.filter.from')}>
          <Input
            id="tasks-from"
            type="date"
            className="w-40"
            max={to || undefined}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field id="tasks-to" label={t('tasks.filter.to')}>
          <Input
            id="tasks-to"
            type="date"
            className="w-40"
            min={from || undefined}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t('tasks.search')}
            placeholder={t('tasks.search')}
            className="w-56 pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tab === 'board' && !status && (
          <label className="flex h-9 items-center gap-2 text-small">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            {t('tasks.showClosed')}
          </label>
        )}
      </div>

      {list.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, list.error, 'tasks')}
        </p>
      )}
      <TabPanel key={tab}>
        {list.isPending ? (
          <TableSkeleton />
        ) : tab === 'board' ? (
          <TaskBoard tasks={tasks} statuses={boardColumns} />
        ) : (
          <TaskList tasks={tasks} />
        )}
      </TabPanel>
      {list.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {t('common.loadMore')}
        </Button>
      )}
      {creating && <TaskDialog onClose={() => setCreating(false)} />}
    </Page>
  );
}

export function TasksPage() {
  return (
    <RequirePermission permission={['tasks.create', 'tasks.view_all', 'team.view']}>
      <TasksView />
    </RequirePermission>
  );
}
