'use client';

import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { TabPanel } from '@/components/animated';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { columnHelper, DataTable } from '@/components/data-table';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { TableSkeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { changed, markRejected } from '@/lib/form';
import { formatDate, todayIst } from '@/lib/ist';

type Holiday = Schemas['HolidayOut'];
type Branches = Schemas['Ref'][];
type Open = { kind: 'form'; holiday?: Holiday } | { kind: 'delete'; holiday: Holiday };

const schema = z.object({
  date: z.string().min(1, 'validation.required'),
  name: z.string().trim().min(1, 'validation.required').max(120, 'validation.tooLong'),
  branch_id: z.string(),
});
type Values = z.infer<typeof schema>;

const toBody = (v: Values): Schemas['HolidayCreate'] => ({
  date: v.date,
  name: v.name.trim(),
  branch_id: v.branch_id === '' ? null : Number(v.branch_id),
});

function BranchOptions({ branches }: { branches: Branches }) {
  const { t } = useTranslation();
  return (
    <>
      <option value="">{t('holidays.allBranches')}</option>
      {branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
        </option>
      ))}
    </>
  );
}

function HolidayDialog({
  holiday,
  branches,
  defaults,
  onClose,
}: {
  holiday?: Holiday;
  branches: Branches;
  defaults: Values;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const initial: Values = holiday
    ? {
        date: holiday.date,
        name: holiday.name,
        branch_id: holiday.branch_id === null ? '' : String(holiday.branch_id),
      }
    : defaults;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: initial });

  const save = useMutation({
    mutationFn: async (values: Values) => {
      if (!holiday) {
        return unwrap(proxyApi().POST('/api/v1/admin/holidays', { body: toBody(values) }));
      }
      const body = changed(toBody(values), toBody(initial));
      if (Object.keys(body).length === 0) return holiday;
      return unwrap(
        proxyApi().PATCH('/api/v1/admin/holidays/{holiday_id}', {
          params: { path: { holiday_id: holiday.id } },
          body,
        }),
      );
    },
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      await save.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ['holidays'] });
      onClose();
    } catch (error) {
      markRejected(error, values, setError);
      setServerError(errorMessage(t, error, 'holidays'));
    }
  }

  const field = (name: keyof Values) => ({ invalid: !!errors[name], ...register(name) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{holiday ? t('holidays.editTitle') : t('holidays.createTitle')}</DialogTitle>
        <DialogDescription>{t('holidays.dialogHint')}</DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <Field id="date" label={t('holidays.form.date')} error={errors.date?.message}>
            <Input id="date" type="date" {...field('date')} />
          </Field>
          <Field id="name" label={t('holidays.form.name')} error={errors.name?.message}>
            <Input id="name" {...field('name')} />
          </Field>
          <Field id="branch_id" label={t('holidays.form.branch')} error={errors.branch_id?.message}>
            <Select id="branch_id" {...field('branch_id')}>
              <BranchOptions branches={branches} />
            </Select>
          </Field>
          {serverError && (
            <p role="alert" className="text-small text-danger">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const col = columnHelper<Holiday>();

export function HolidaysTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [thisYear] = useState(() => Number(todayIst().slice(0, 4)));
  const [year, setYear] = useState(thisYear);
  const [branchId, setBranchId] = useState('');
  const [open, setOpen] = useState<Open | null>(null);

  const branches = useQuery({
    queryKey: ['branches', 'names'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/branches')),
  });
  // One page of 200 covers every holiday of a year.
  const list = useQuery({
    queryKey: ['holidays', { year, branchId }],
    queryFn: async () =>
      (
        await unwrap(
          proxyApi().GET('/api/v1/admin/holidays', {
            params: {
              query: {
                year,
                branch_id: branchId === '' ? undefined : Number(branchId),
                limit: 200,
              },
            },
          }),
        )
      ).items,
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const names = new Map((branches.data ?? []).map((b) => [b.id, b.name]));
    return col.columns([
      col.accessor((h) => formatDate(h.date), { id: 'date', header: t('holidays.col.date') }),
      col.accessor('name', { header: t('holidays.col.name') }),
      col.accessor(
        (h) =>
          h.branch_id === null
            ? t('holidays.allBranches')
            : (names.get(h.branch_id) ?? `#${h.branch_id}`),
        { id: 'branch', header: t('holidays.col.branch') },
      ),
      col.display({
        id: 'actions',
        header: t('holidays.col.actions'),
        cell: ({ row: { original: h } }) => (
          <span className="flex gap-1.5">
            <Button
              size="xs"
              variant="outline"
              aria-label={t('holidays.editOf', { name: h.name })}
              onClick={() => setOpen({ kind: 'form', holiday: h })}
            >
              {t('common.edit')}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              aria-label={t('holidays.deleteOf', { name: h.name })}
              onClick={() => setOpen({ kind: 'delete', holiday: h })}
            >
              {t('common.delete')}
            </Button>
          </span>
        ),
      }),
    ]);
  }, [t, branches.data]);

  async function remove(holiday: Holiday) {
    await unwrap(
      proxyApi().DELETE('/api/v1/admin/holidays/{holiday_id}', {
        params: { path: { holiday_id: holiday.id } },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: ['holidays'] });
  }

  const close = () => setOpen(null);
  return (
    <TabPanel className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={t('holidays.year')}
          className="w-28"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('holidays.branchFilter')}
          className="w-48"
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <BranchOptions branches={branches.data ?? []} />
        </Select>
        <Button className="ml-auto" onClick={() => setOpen({ kind: 'form' })}>
          <Plus aria-hidden="true" />
          {t('holidays.create')}
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
        <DataTable columns={columns} data={list.data ?? []} empty={t('holidays.empty')} />
      )}

      {open?.kind === 'form' && (
        <HolidayDialog
          holiday={open.holiday}
          branches={branches.data ?? []}
          // A new holiday starts in the year and branch being looked at.
          defaults={{
            date: year === thisYear ? todayIst() : `${year}-01-01`,
            name: '',
            branch_id: branchId,
          }}
          onClose={close}
        />
      )}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={t('holidays.deleteTitle')}
          description={t('holidays.deleteConfirm', {
            name: open.holiday.name,
            date: formatDate(open.holiday.date),
          })}
          confirmLabel={t('common.delete')}
          destructive
          onConfirm={() => remove(open.holiday)}
          onClose={close}
        />
      )}
    </TabPanel>
  );
}
