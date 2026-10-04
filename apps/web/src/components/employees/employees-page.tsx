'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { RequirePermission } from '@/components/require-permission';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input, Select } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import { useMe } from '@/lib/me';
import { EmployeeDialog, type TemporaryPassword } from './employee-dialog';
import type { Employee } from './employee-form';
import { ImportDialog } from './import-dialog';
import { TemporaryPasswordDialog } from './temp-password-dialog';
import { useLookups } from './use-lookups';

const PAGE_SIZE = 50;
const col = columnHelper<Employee>();
// Shown only from the 2xl breakpoint so the table fits at 1280px; the Edit dialog still has them.
const WIDE_ONLY = ['mobile', 'department', 'manager', 'field'];

const employeeCall = (employee: Employee) => ({ params: { path: { employee_id: employee.id } } });

type Dialog =
  | { kind: 'form'; employee?: Employee }
  | { kind: 'status'; employee: Employee }
  | { kind: 'reset'; employee: Employee }
  | { kind: 'import' };

const truncated = (text: string) => (
  <span className="block max-w-40 truncate" title={text}>
    {text}
  </span>
);

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function EmployeesView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const lookups = useLookups();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [temporary, setTemporary] = useState<TemporaryPassword | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Only for the "locked" display; unlocking is idempotent on the server, which owns the clock.
  const [now] = useState(() => Date.now());
  const q = useDebounced(search.trim(), 300);

  const list = useInfiniteQuery({
    queryKey: ['employees', 'list', { q, status }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        proxyApi().GET('/api/v1/admin/employees', {
          params: {
            query: {
              q: q || undefined,
              status: status || undefined,
              limit: PAGE_SIZE,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // Typing in the search box keeps the current rows (and any open row menu) until the result arrives.
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['employees'] });

  async function setEmployeeStatus(employee: Employee) {
    const next = employee.status === 'active' ? 'inactive' : 'active';
    await unwrap(
      proxyApi().PATCH('/api/v1/admin/employees/{employee_id}', {
        ...employeeCall(employee),
        body: { status: next },
      }),
    );
    await refresh();
  }

  async function resetPassword(employee: Employee) {
    const result = await unwrap(
      proxyApi().POST(
        '/api/v1/admin/employees/{employee_id}/reset-password',
        employeeCall(employee),
      ),
    );
    setTemporary({
      empCode: employee.emp_code,
      name: employee.name,
      password: result.temporary_password,
    });
  }

  const unlock = useCallback(
    async (employee: Employee) => {
      setActionError(null);
      try {
        await unwrap(
          proxyApi().POST('/api/v1/admin/employees/{employee_id}/unlock', employeeCall(employee)),
        );
        await queryClient.invalidateQueries({ queryKey: ['employees'] });
      } catch (error) {
        setActionError(errorMessage(t, error));
      }
    },
    [queryClient, t],
  );

  const columns = useMemo(() => {
    const names = new Map((lookups.employees ?? []).map((e) => [e.id, e.name]));
    return col.columns([
      col.accessor('emp_code', { header: t('employees.col.code') }),
      col.accessor('name', {
        header: t('employees.col.name'),
        cell: ({ getValue }) => truncated(getValue()),
      }),
      col.accessor('mobile', { header: t('employees.col.mobile') }),
      col.accessor((e) => e.designation.name, {
        id: 'designation',
        header: t('employees.col.designation'),
        cell: ({ getValue }) => truncated(getValue()),
      }),
      col.accessor((e) => e.department?.name ?? '', {
        id: 'department',
        header: t('employees.col.department'),
      }),
      col.accessor((e) => e.role.name, { id: 'role', header: t('employees.col.role') }),
      col.accessor(
        (e) => (e.manager_id === null ? '' : (names.get(e.manager_id) ?? `#${e.manager_id}`)),
        {
          id: 'manager',
          header: t('employees.col.manager'),
        },
      ),
      col.accessor((e) => (e.field_eligible ? t('common.yes') : t('common.no')), {
        id: 'field',
        header: t('employees.col.field'),
      }),
      col.display({
        id: 'status',
        header: t('employees.col.status'),
        cell: ({ row: { original: e } }) => (
          <span className="flex gap-1">
            <StatusBadge
              testId={`status-${e.status}`}
              icon={e.status === 'active' ? 'check-circle' : 'minus-circle'}
              variant={e.status === 'active' ? 'secondary' : 'outline'}
              label={t(`employees.status.${e.status}`)}
            />
            {e.locked_until && Date.parse(e.locked_until) > now && (
              <Badge variant="destructive">{t('employees.locked')}</Badge>
            )}
          </span>
        ),
      }),
      col.display({
        id: 'actions',
        header: t('employees.col.actions'),
        cell: ({ row: { original: e } }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label={t('employees.actionsFor', { name: e.name })}
                className="size-11 md:size-9"
              >
                <span aria-hidden="true">⋯</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'form', employee: e })}>
                {t('common.edit')}
              </DropdownMenuItem>
              {e.id !== me?.id && (
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'status', employee: e })}>
                  {e.status === 'active' ? t('employees.deactivate') : t('employees.reactivate')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'reset', employee: e })}>
                {t('employees.resetPassword')}
              </DropdownMenuItem>
              {e.locked_until && Date.parse(e.locked_until) > now && (
                <DropdownMenuItem onSelect={() => void unlock(e)}>
                  {t('employees.unlock')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      }),
    ]);
  }, [t, lookups.employees, me?.id, now, unlock]);

  const close = () => setDialog(null);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{t('employees.title')}</h1>
        <Input
          aria-label={t('employees.search')}
          placeholder={t('employees.search')}
          className="w-56"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label={t('employees.col.status')}
          className="w-36"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="">{t('employees.status.all')}</option>
          <option value="active">{t('employees.status.active')}</option>
          <option value="inactive">{t('employees.status.inactive')}</option>
        </Select>
        <Button variant="outline" onClick={() => setDialog({ kind: 'import' })}>
          {t('import.open')}
        </Button>
        <Button onClick={() => setDialog({ kind: 'form' })}>{t('employees.create')}</Button>
      </div>

      {(actionError || list.error) && (
        <p role="alert" className="text-sm text-destructive">
          {actionError ?? errorMessage(t, list.error)}
        </p>
      )}
      {list.isPending ? (
        <p>{t('common.loading')}</p>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          empty={t('employees.empty')}
          wideOnly={WIDE_ONLY}
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

      {dialog?.kind === 'form' && (
        <EmployeeDialog
          employee={dialog.employee}
          lookups={lookups}
          myPermissions={me?.permissions ?? []}
          onClose={close}
          onTemporaryPassword={setTemporary}
        />
      )}
      {dialog?.kind === 'status' && (
        <ConfirmDialog
          title={t(
            dialog.employee.status === 'active' ? 'employees.deactivate' : 'employees.reactivate',
          )}
          description={t(
            dialog.employee.status === 'active'
              ? 'employees.deactivateConfirm'
              : 'employees.reactivateConfirm',
            { name: dialog.employee.name },
          )}
          confirmLabel={t(
            dialog.employee.status === 'active' ? 'employees.deactivate' : 'employees.reactivate',
          )}
          destructive={dialog.employee.status === 'active'}
          onConfirm={() => setEmployeeStatus(dialog.employee)}
          onClose={close}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog
          title={t('employees.resetPassword')}
          description={t('employees.resetConfirm', { name: dialog.employee.name })}
          confirmLabel={t('employees.resetPassword')}
          onConfirm={() => resetPassword(dialog.employee)}
          onClose={close}
        />
      )}
      {dialog?.kind === 'import' && <ImportDialog onClose={close} />}
      {temporary && (
        <TemporaryPasswordDialog value={temporary} onClose={() => setTemporary(null)} />
      )}
    </section>
  );
}

export function EmployeesPage() {
  return (
    <RequirePermission permission="employees.manage">
      <EmployeesView />
    </RequirePermission>
  );
}
