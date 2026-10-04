'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { Building2, CalendarOff, CircleCheck, House } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/field';
import { NoAccess } from '@/components/require-permission';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatDate, todayIst, weekdayOf } from '@/lib/ist';
import { WEEKDAYS } from '@/components/shifts/weekly-offs';

type Schedule = Schemas['ScheduleOut'];
type Days = Schemas['ScheduleSet']['days'];

const KIND = {
  office: { tone: 'info', icon: Building2 },
  home: { tone: 'success', icon: House },
  off: { tone: 'neutral', icon: CalendarOff },
} as const;
const KINDS = ['office', 'home', 'off'] as const;

// '' in the form is "follow the shift" (null for the API).
const schema = z.object({
  effective_from: z.string().min(1, 'validation.required'),
  days: z.array(z.enum(['', ...KINDS])),
});
type Values = z.infer<typeof schema>;

export const toDays = (days: Values['days']): Days => days.map((day) => (day === '' ? null : day));

/** A week in words, grouped by kind: "Office: Mon, Tue; Home: Wed; Follow shift: Sat, Sun". */
export function scheduleSummary(t: TFunction, days: Days): string {
  return ([...KINDS, null] as const)
    .map((kind) => ({
      kind,
      names: WEEKDAYS.filter((weekday) => (days[weekday] ?? null) === kind).map((weekday) =>
        t(`weekdayShort.${weekday}`),
      ),
    }))
    .filter((group) => group.names.length > 0)
    .map(
      (group) =>
        `${t(group.kind ? `schedule.kind.${group.kind}` : 'schedule.followShift')}: ${group.names.join(', ')}`,
    )
    .join('; ');
}

function Editor({ employeeId, schedule }: { employeeId: number; schedule: Schedule }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [today] = useState(todayIst);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Starts from the week in force today, or "follow the shift" when there is none yet.
  const current = schedule.rows
    .filter((row) => row.effective_from <= today)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      effective_from: today,
      days: WEEKDAYS.map((weekday) => current?.days[weekday] ?? ''),
    },
  });

  const save = useMutation({
    mutationFn: (values: Values) =>
      unwrap(
        proxyApi().PUT('/api/v1/admin/employees/{employee_id}/schedule', {
          params: { path: { employee_id: employeeId } },
          body: { effective_from: values.effective_from, days: toDays(values.days) },
        }),
      ),
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    setSaved(false);
    try {
      await save.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ['employees', employeeId, 'schedule'] });
      setSaved(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SCHEDULE_BACKDATED') {
        setError('effective_from', { message: 'errors.SCHEDULE_BACKDATED' });
      } else {
        setServerError(errorMessage(t, error));
      }
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <h3 className="text-large font-semibold">{t('schedule.editTitle')}</h3>
      <div className="grid gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {WEEKDAYS.map((weekday) => (
          <Field key={weekday} id={`day-${weekday}`} label={t(`weekday.${weekday}`)}>
            <Select id={`day-${weekday}`} {...register(`days.${weekday}`)}>
              <option value="">{t('schedule.followShift')}</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`schedule.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          id="effective_from"
          label={t('schedule.effectiveFrom')}
          error={errors.effective_from?.message}
        >
          <Input
            id="effective_from"
            type="date"
            min={today}
            className="w-44"
            invalid={!!errors.effective_from}
            {...register('effective_from')}
          />
        </Field>
        <Button type="submit" disabled={save.isPending}>
          {t('schedule.save')}
        </Button>
        {saved && (
          <p role="status" className="flex h-9 items-center gap-1.5 text-small text-success">
            <CircleCheck aria-hidden="true" className="size-4" />
            {t('schedule.saved')}
          </p>
        )}
      </div>
      {serverError && (
        <p role="alert" className="text-small text-danger">
          {serverError}
        </p>
      )}
    </form>
  );
}

export function ScheduleCard({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  // No dates sent: the server resolves the next 14 days from its own "today".
  const schedule = useQuery({
    queryKey: ['employees', employeeId, 'schedule'],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/employees/{employee_id}/schedule', {
          params: { path: { employee_id: employeeId } },
        }),
      ),
  });
  if (schedule.error instanceof ApiError && schedule.error.status === 403) return <NoAccess />;

  const history = [...(schedule.data?.rows ?? [])].sort((a, b) =>
    b.effective_from.localeCompare(a.effective_from),
  );
  return (
    <Card role="region" aria-label={t('schedule.title')} className="grid gap-5">
      <h2 className="text-h3">{t('schedule.title')}</h2>
      {schedule.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, schedule.error)}
        </p>
      )}
      {schedule.isPending && (
        <div role="status">
          <span className="sr-only">{t('common.loading')}</span>
          <Skeleton className="h-48 w-full rounded-md" />
        </div>
      )}
      {schedule.data && (
        <>
          <Table aria-label={t('schedule.next')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('schedule.col.date')}</TableHead>
                <TableHead>{t('schedule.col.weekday')}</TableHead>
                <TableHead>{t('schedule.col.kind')}</TableHead>
                <TableHead>{t('schedule.col.reason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedule.data.resolved.map((day) => (
                <TableRow key={day.date}>
                  <TableCell>{formatDate(day.date)}</TableCell>
                  <TableCell>{t(`weekday.${weekdayOf(day.date)}`)}</TableCell>
                  <TableCell>
                    <StatusBadge
                      testId={`kind-${day.kind}`}
                      tone={KIND[day.kind].tone}
                      icon={KIND[day.kind].icon}
                      label={t(`schedule.kind.${day.kind}`)}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t(`schedule.reason.${day.reason}`)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Editor employeeId={employeeId} schedule={schedule.data} />

          <section aria-label={t('schedule.history')} className="grid gap-2">
            <h3 className="text-large font-semibold">{t('schedule.history')}</h3>
            {history.length === 0 ? (
              <p className="text-small text-muted-foreground">{t('schedule.noHistory')}</p>
            ) : (
              <ul className="grid gap-1 text-small">
                {history.map((row) => (
                  <li key={row.id} className="flex flex-wrap gap-x-3">
                    <span className="font-medium tabular-nums">
                      {t('schedule.from', { date: formatDate(row.effective_from) })}
                    </span>
                    <span className="text-muted-foreground">{scheduleSummary(t, row.days)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Card>
  );
}
