'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { errorMessage } from '@/lib/api-client';
import { fromIstLocal } from '@/lib/ist';

const schema = z.object({
  time: z.string(),
  remarks: z.string().trim().max(255, 'validation.tooLong'),
});
type Values = z.infer<typeof schema>;

export type Decision = {
  decision: 'approve' | 'reject';
  remarks?: string;
  /** ISO time with its zone; present only when the approver changed the time. */
  time?: string;
};

type Props = {
  /** Without it the dialog is read-only: only Close shows. */
  canDecide: boolean;
  /** An approver may change the time: `initial` and `date` are IST values for a datetime-local input. */
  time?: { label: string; initial: string; date: string; toggleLabel?: string; keepLabel?: string };
  submit: (decision: Decision) => Promise<unknown>;
  onClose: () => void;
};

/**
 * Remarks, an optional time edit, Reject and Approve: what the punch-out request and the punch
 * review dialogs share. Every decision refreshes the attendance lists, also a failed one
 * ("already decided" means the lists on screen are out of date).
 */
export function DecisionForm({ canDecide, time, submit, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  // With a toggle label the time field starts hidden behind that button.
  const [editing, setEditing] = useState(false);
  const {
    register,
    getValues,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { time: time?.initial ?? '', remarks: '' },
  });
  const decide = useMutation({ mutationFn: submit });
  const showTime = canDecide && time !== undefined && (!time.toggleLabel || editing);

  async function run(decision: Decision['decision']) {
    setServerError(null);
    const remarks = getValues('remarks').trim();
    if (decision === 'reject' && remarks === '') {
      setError('remarks', { message: 'validation.reasonRequired' });
      return;
    }
    const picked = getValues('time');
    let changedTime: string | undefined;
    if (decision === 'approve' && showTime && time && picked !== time.initial) {
      // The picker limits the day, but a typed value can still stray; the server checks as well.
      if (!picked.startsWith(`${time.date}T`)) {
        setError('time', { message: 'validation.timeSameDay' });
        return;
      }
      changedTime = fromIstLocal(picked);
    }
    let failed = false;
    try {
      await decide.mutateAsync({ decision, remarks: remarks || undefined, time: changedTime });
    } catch (error) {
      failed = true;
      setServerError(errorMessage(t, error, 'attendance'));
    }
    await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    if (!failed) onClose();
  }

  return (
    <form onSubmit={(event) => event.preventDefault()} noValidate className="grid gap-4">
      {canDecide && (
        <>
          {showTime && time && (
            <Field id="decision-time" label={time.label} error={errors.time?.message}>
              <Input
                id="decision-time"
                type="datetime-local"
                min={`${time.date}T00:00`}
                max={`${time.date}T23:59`}
                invalid={!!errors.time}
                {...register('time')}
              />
            </Field>
          )}
          <Field
            id="decision-remarks"
            label={t('attendance.remarksField')}
            error={errors.remarks?.message}
          >
            <Textarea
              id="decision-remarks"
              maxLength={255}
              invalid={!!errors.remarks}
              {...register('remarks')}
            />
          </Field>
        </>
      )}
      {serverError && (
        <p role="alert" className="text-small text-danger">
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('common.close')}
        </Button>
        {canDecide && (
          <>
            {time?.toggleLabel && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing((on) => !on)}
                disabled={decide.isPending}
              >
                {editing ? time.keepLabel : time.toggleLabel}
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              onClick={() => void run('reject')}
              disabled={decide.isPending}
            >
              {t('attendance.reject')}
            </Button>
            <Button type="button" onClick={() => void run('approve')} disabled={decide.isPending}>
              {t('attendance.approve')}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}
