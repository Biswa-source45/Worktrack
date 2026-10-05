import { zodResolver } from '@hookform/resolvers/zod';
import { CircleCheck, TriangleAlert } from '@/components/icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useAdminAction } from '@/components/admin/use-admin-action';
import { LocateButton, useCurrentFix } from '@/components/locate-button';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { api } from '@/lib/api';
import { ApiError, errorText } from '@/lib/api-error';

// Messages are i18n keys, translated when rendered. The limits mirror the backend's; the server
// enforces them too. An empty radius means the organisation's default (Settings).
const schema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(120, 'branches.nameTooLong'),
  address: z.string().trim().max(255, 'branches.addressTooLong'),
  radius: z
    .string()
    .trim()
    .refine(
      (value) => value === '' || (/^\d+$/.test(value) && +value >= 30 && +value <= 500),
      'branches.radiusRange',
    ),
});
type Values = z.infer<typeof schema>;

const FIELDS = [
  { name: 'name', label: 'branches.name' },
  { name: 'address', label: 'branches.addressOptional' },
  { name: 'radius', label: 'branches.radiusOptional' },
] as const;

// The form field each refused request field belongs to.
const SERVER_FIELDS: Record<string, keyof Values> = {
  name: 'name',
  address: 'address',
  radius_m: 'radius',
};
const refusedFields = z.array(z.object({ loc: z.array(z.unknown()), message: z.string() }));

export default function NewBranchScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const run = useAdminAction();
  const location = useCurrentFix();
  const { fix } = location;
  const [failure, setFailure] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', address: '', radius: '' },
  });

  /** Puts a server refusal next to its field; true when every part of it found one. */
  function showOnFields(error: ApiError): boolean {
    if (error.code === 'DUPLICATE') {
      setError('name', { type: 'server', message: error.message });
      return true;
    }
    const refused = refusedFields.safeParse(error.details);
    if (error.code !== 'VALIDATION_ERROR' || !refused.success) return false;
    const placed = refused.data.map(({ loc, message }) => {
      const field = SERVER_FIELDS[String(loc.at(-1))];
      if (field) setError(field, { type: 'server', message });
      return field !== undefined;
    });
    return placed.length > 0 && placed.every(Boolean);
  }

  const submit = handleSubmit(async ({ name, address, radius }) => {
    if (!fix) return;
    setFailure(null);
    try {
      await run(
        api.POST('/api/v1/admin/branches', {
          body: {
            name,
            address: address || undefined,
            lat: fix.lat,
            lng: fix.lng,
            radius_m: radius ? Number(radius) : undefined,
          },
        }),
      );
      router.back();
    } catch (error) {
      if (!(error instanceof ApiError && showOnFields(error))) setFailure(errorText(t, error));
    }
  });

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <BackButton />
      <AppText variant="h2" accessibilityRole="header">
        {t('branches.newHere')}
      </AppText>
      <AppText color="muted">{t('branches.newIntro')}</AppText>

      {FIELDS.map(({ name, label }) => (
        <Controller
          key={name}
          control={control}
          name={name}
          render={({ field }) => {
            const error = errors[name];
            return (
              <Field
                label={t(label)}
                // A server message is already text; the form's own messages are i18n keys.
                error={
                  error &&
                  (error.type === 'server'
                    ? error.message
                    : t(error.message ?? 'validation.required'))
                }
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                autoCapitalize={name === 'radius' ? 'none' : 'words'}
                keyboardType={name === 'radius' ? 'number-pad' : 'default'}
              />
            );
          }}
        />
      ))}

      {fix ? (
        <Banner
          status="success"
          icon={CircleCheck}
          message={t('branches.locationReady', { accuracy: Math.round(fix.accuracyM) })}
        />
      ) : null}
      <LocateButton state={location} label={t('location.useCurrent')} variant="secondary" />
      {failure ? <Banner status="danger" icon={TriangleAlert} message={failure} /> : null}
      <Button
        label={t('branches.save')}
        onPress={() => void submit()}
        loading={isSubmitting}
        disabled={!fix}
      />
    </Screen>
  );
}
