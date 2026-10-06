import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { CircleX } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { taskErrorDetail, taskErrorText } from '@/lib/tasks';

// The limits mirror the server's (3-200 characters); the server enforces them too.
const schema = z.object({
  reason: z.string().trim().min(3, 'tasks.reason.min').max(200, 'tasks.reason.max'),
});
type Values = z.infer<typeof schema>;

type Props = {
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
};

/** Asks for a short reason (decline, hold). A failure stays in the dialog, in the server's words. */
export function ReasonDialog({
  title,
  confirmLabel,
  destructive = false,
  onSubmit,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<{ message: string; detail: string } | null>(null);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });

  const submit = handleSubmit(async ({ reason }) => {
    setFailure(null);
    try {
      await onSubmit(reason);
      onClose();
    } catch (error) {
      setFailure({ message: taskErrorText(t, error), detail: taskErrorDetail(error) });
    }
  });

  return (
    <Dialog title={title} onRequestClose={() => (isSubmitting ? undefined : onClose())}>
      <Controller
        control={control}
        name="reason"
        render={({ field }) => (
          <Field
            label={t('tasks.reason.label')}
            error={errors.reason && t(errors.reason.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            autoCapitalize="sentences"
            maxLength={200}
          />
        )}
      />
      {failure ? (
        <>
          <Banner status="danger" icon={CircleX} message={failure.message} />
          <AppText variant="caption" color="muted" selectable>
            {failure.detail}
          </AppText>
        </>
      ) : null}
      <Button
        variant={destructive ? 'destructive' : 'primary'}
        label={confirmLabel}
        onPress={() => void submit()}
        loading={isSubmitting}
      />
      <Button
        variant="ghost"
        label={t('common.cancel')}
        onPress={onClose}
        disabled={isSubmitting}
      />
    </Dialog>
  );
}
