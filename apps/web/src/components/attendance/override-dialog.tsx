'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
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
import { Select, Textarea } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import { formatDate } from '@/lib/ist';

const KINDS = ['leave', 'work_from_home', 'on_duty'] as const;
// Mirrors the server (5 to 255 characters after trimming); the server stays the authority.
const schema = z.object({
  kind: z.enum(KINDS),
  reason: z.string().trim().min(5, 'validation.overrideReason').max(255, 'validation.tooLong'),
});
type Values = z.infer<typeof schema>;

/** Marks one employee's day as leave, work from home or on duty. The punches stay; the reason is kept. */
export function OverrideDialog({
  employee,
  date,
  onClose,
}: {
  employee: Schemas['EmployeeBrief'];
  date: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { kind: 'leave', reason: '' },
  });

  const save = useMutation({
    mutationFn: (values: Values) =>
      unwrap(
        proxyApi().POST('/api/v1/admin/attendance/overrides', {
          body: { user_id: employee.id, date, kind: values.kind, reason: values.reason },
        }),
      ),
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      await save.mutateAsync(values);
    } catch (error) {
      setServerError(errorMessage(t, error, 'attendance'));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['attendance', 'register'] });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{t('attendance.overrideTitle')}</DialogTitle>
        <DialogDescription>
          {t('attendance.overrideFor', {
            name: employee.name,
            code: employee.emp_code,
            date: formatDate(date),
          })}
        </DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <Field id="override-kind" label={t('attendance.overrideKindLabel')}>
            <Select id="override-kind" {...register('kind')}>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`attendance.overrideKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id="override-reason"
            label={t('attendance.overrideReason')}
            error={errors.reason?.message}
          >
            <Textarea
              id="override-reason"
              maxLength={255}
              invalid={!!errors.reason}
              {...register('reason')}
            />
          </Field>
          <p className="text-caption text-muted-foreground">{t('attendance.overrideNote')}</p>
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
              {t('attendance.overrideSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
