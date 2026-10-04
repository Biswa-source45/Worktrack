import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Button, ScrollView, Text } from 'react-native';
import { z } from 'zod';
import { FormField } from '@/components/form-field';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';

// Messages are i18n keys, translated when rendered. The length mirrors the backend minimum (10);
// the server enforces it too.
const schema = z
  .object({
    current: z.string().min(1, 'validation.required'),
    next: z.string().min(10, 'validation.passwordMin'),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, {
    path: ['confirm'],
    message: 'validation.passwordMismatch',
  });
type Values = z.infer<typeof schema>;

const FIELDS = [
  { name: 'current', label: 'changePassword.current' },
  { name: 'next', label: 'changePassword.new' },
  { name: 'confirm', label: 'changePassword.confirm' },
] as const;

export default function ChangePasswordScreen() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { current: '', next: '', confirm: '' },
  });

  const submit = handleSubmit(async ({ current, next }) => {
    setFailure(null);
    try {
      const { data, error } = await api.POST('/api/v1/auth/change-password', {
        body: { current_password: current, new_password: next },
      });
      // The response carries a new token pair; /me then reports must_change_password=false and
      // the route gate moves on to home.
      if (data) await signIn(data);
      else setFailure(apiErrorMessage(t, error));
    } catch {
      setFailure(t('errors.network'));
    }
  });

  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 16, padding: 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: '600' }}>
        {t('changePassword.title')}
      </Text>
      <Text>{t('changePassword.intro')}</Text>
      {FIELDS.map(({ name, label }) => (
        <Controller
          key={name}
          control={control}
          name={name}
          render={({ field }) => (
            <FormField
              label={t(label)}
              error={errors[name] && t(errors[name].message ?? 'validation.required')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              secureTextEntry
              textContentType={name === 'current' ? 'password' : 'newPassword'}
            />
          )}
        />
      ))}
      {failure ? <Text style={{ color: '#b00020' }}>{failure}</Text> : null}
      {isSubmitting ? (
        <ActivityIndicator />
      ) : (
        <Button title={t('changePassword.submit')} onPress={() => void submit()} />
      )}
    </ScrollView>
  );
}
