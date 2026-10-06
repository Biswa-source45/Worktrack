import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Camera } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { addReason, currentFlow } from '@/lib/punch-flow';

// Messages are i18n keys, translated when rendered. The limits mirror the server's (3-200 and
// at most 500 characters); the server enforces them too.
const schema = z.object({
  reason: z.string().trim().min(3, 'punch.request.reasonMin').max(200, 'punch.request.reasonMax'),
  note: z.string().trim().max(500, 'punch.request.noteMax'),
});
type Values = z.infer<typeof schema>;

/** Why the employee is punching out away from a work location, asked before the selfie. */
export default function PunchRequestScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const flow = currentFlow();
  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { reason: '', note: '' },
  });

  // Opened without a punch in progress (a restored screen): back to Home, where it starts.
  const orphaned = flow?.kind !== 'request';
  useEffect(() => {
    if (orphaned) router.replace('/');
  }, [orphaned, router]);
  if (orphaned) return null;

  const submit = handleSubmit(({ reason, note }) => {
    addReason(reason, note || undefined);
    router.replace('/punch/capture');
  });

  return (
    <Screen scroll>
      <BackButton />
      <AppText variant="h1" accessibilityRole="header">
        {t('punch.request.title')}
      </AppText>
      <AppText color="muted">{t('punch.request.intro')}</AppText>
      <Controller
        control={control}
        name="reason"
        render={({ field }) => (
          <Field
            label={t('punch.request.reason')}
            error={errors.reason && t(errors.reason.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            autoCapitalize="sentences"
            maxLength={200}
          />
        )}
      />
      <Controller
        control={control}
        name="note"
        render={({ field }) => (
          <Field
            label={t('punch.request.note')}
            error={errors.note && t(errors.note.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            autoCapitalize="sentences"
            multiline
            maxLength={500}
          />
        )}
      />
      <Button icon={Camera} label={t('punch.request.continue')} onPress={() => void submit()} />
    </Screen>
  );
}
