'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
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
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { changed, isIntBetween, markRejected } from '@/lib/form';
import { toOffRows, toWeeklyOffs, WEEKDAYS, WEEKS } from './weekly-offs';

type Shift = Schemas['ShiftOut'];

// More than 0, at most 24, up to two decimals: the server's rule for day lengths.
const hours = z
  .string()
  .refine(
    (v) => /^\d{1,2}(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0 && Number(v) <= 24,
    'validation.hours',
  );

const schema = z
  .object({
    name: z.string().trim().min(1, 'validation.required').max(64, 'validation.tooLong'),
    start_time: z.string().min(1, 'validation.required'),
    end_time: z.string().min(1, 'validation.required'),
    grace_min: z.string().refine(isIntBetween(0, 120), 'validation.grace'),
    half_day_hours: hours,
    full_day_hours: hours,
    offs: z.array(
      z.object({ mode: z.enum(['work', 'every', 'weeks']), weeks: z.array(z.boolean()) }),
    ),
  })
  .superRefine((v, ctx) => {
    // "HH:MM" strings compare like times. Overnight shifts are not supported.
    if (v.start_time && v.end_time && v.end_time <= v.start_time) {
      ctx.addIssue({ code: 'custom', path: ['end_time'], message: 'validation.endAfterStart' });
    }
    if (Number(v.half_day_hours) > Number(v.full_day_hours)) {
      ctx.addIssue({
        code: 'custom',
        path: ['half_day_hours'],
        message: 'validation.halfOverFull',
      });
    }
    v.offs.forEach((row, weekday) => {
      if (row.mode === 'weeks' && !row.weeks.some(Boolean)) {
        ctx.addIssue({
          code: 'custom',
          path: ['offs', weekday, 'weeks'],
          message: 'validation.weeksRequired',
        });
      }
    });
  });
type Values = z.infer<typeof schema>;

const toValues = (shift?: Shift): Values => ({
  name: shift?.name ?? '',
  // The server sends "09:30:00"; a time input holds "09:30".
  start_time: shift?.start_time.slice(0, 5) ?? '',
  end_time: shift?.end_time.slice(0, 5) ?? '',
  grace_min: String(shift?.grace_min ?? ''),
  half_day_hours: String(shift?.half_day_hours ?? ''),
  full_day_hours: String(shift?.full_day_hours ?? ''),
  offs: toOffRows(shift?.weekly_offs ?? []),
});

function toBody(v: Values): Schemas['ShiftCreate'] {
  return {
    name: v.name.trim(),
    start_time: v.start_time,
    end_time: v.end_time,
    grace_min: Number(v.grace_min),
    half_day_hours: Number(v.half_day_hours),
    full_day_hours: Number(v.full_day_hours),
    weekly_offs: toWeeklyOffs(v.offs),
  };
}

export function ShiftDialog({ shift, onClose }: { shift?: Shift; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(shift) });
  const offs = useWatch({ control, name: 'offs' });

  const save = useMutation({
    mutationFn: async (values: Values) => {
      if (!shift) {
        return unwrap(proxyApi().POST('/api/v1/admin/shifts', { body: toBody(values) }));
      }
      const body = changed(toBody(values), toBody(toValues(shift)));
      if (Object.keys(body).length === 0) return shift;
      return unwrap(
        proxyApi().PATCH('/api/v1/admin/shifts/{shift_id}', {
          params: { path: { shift_id: shift.id } },
          body,
        }),
      );
    },
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      await save.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
      onClose();
    } catch (error) {
      markRejected(error, values, setError);
      setServerError(errorMessage(t, error, 'shifts'));
    }
  }

  const field = (name: Exclude<keyof Values, 'offs'>) => ({
    invalid: !!errors[name],
    ...register(name),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{shift ? t('shifts.editTitle') : t('shifts.createTitle')}</DialogTitle>
        <DialogDescription>{t('shifts.dialogHint')}</DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="name" label={t('shifts.form.name')} error={errors.name?.message}>
              <Input id="name" {...field('name')} />
            </Field>
            <Field id="grace_min" label={t('shifts.form.grace')} error={errors.grace_min?.message}>
              <Input id="grace_min" type="number" min={0} max={120} {...field('grace_min')} />
            </Field>
            <Field
              id="start_time"
              label={t('shifts.form.start')}
              error={errors.start_time?.message}
            >
              <Input id="start_time" type="time" {...field('start_time')} />
            </Field>
            <Field id="end_time" label={t('shifts.form.end')} error={errors.end_time?.message}>
              <Input id="end_time" type="time" {...field('end_time')} />
            </Field>
            <Field
              id="half_day_hours"
              label={t('shifts.form.halfDay')}
              error={errors.half_day_hours?.message}
            >
              <Input id="half_day_hours" type="number" step="0.25" {...field('half_day_hours')} />
            </Field>
            <Field
              id="full_day_hours"
              label={t('shifts.form.fullDay')}
              error={errors.full_day_hours?.message}
            >
              <Input id="full_day_hours" type="number" step="0.25" {...field('full_day_hours')} />
            </Field>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-small font-medium">{t('shifts.form.weeklyOffs')}</legend>
            {WEEKDAYS.map((weekday) => {
              const day = t(`weekday.${weekday}`);
              // The checkboxes are registered as weeks.0..4, so the form files this error under `root`.
              const weeksError = errors.offs?.[weekday]?.weeks?.root?.message;
              return (
                <div
                  key={weekday}
                  className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[5.5rem_13.5rem_1fr]"
                >
                  <label htmlFor={`off-${weekday}`} className="text-small">
                    {day}
                  </label>
                  <Select id={`off-${weekday}`} {...register(`offs.${weekday}.mode`)}>
                    <option value="work">{t('shifts.offs.work')}</option>
                    <option value="every">{t('shifts.offs.every')}</option>
                    <option value="weeks">{t('shifts.offs.weeks')}</option>
                  </Select>
                  {offs[weekday]?.mode === 'weeks' && (
                    <div
                      role="group"
                      aria-label={t('shifts.offs.weeksOf', { day })}
                      className="flex flex-wrap items-center gap-3"
                    >
                      {WEEKS.map((week) => (
                        <label key={week} className="flex items-center gap-1.5 text-small">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            {...register(`offs.${weekday}.weeks.${week - 1}`)}
                          />
                          {t(`ordinal.${week}`)}
                        </label>
                      ))}
                      {weeksError && (
                        <p role="alert" className="text-caption text-danger">
                          {t(weeksError)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>

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
