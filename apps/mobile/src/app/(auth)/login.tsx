import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Button, ScrollView, Text, View } from 'react-native';
import { z } from 'zod';
import { FormField } from '@/components/form-field';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { getDeviceInfo } from '@/lib/token-store';

// Messages are i18n keys, translated when rendered.
const schema = z.object({
  identifier: z.string().trim().min(1, 'validation.required'),
  password: z.string().min(1, 'validation.required'),
});
type Values = z.infer<typeof schema>;

export default function LoginScreen() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: '', password: '' },
  });

  const submit = handleSubmit(async ({ identifier, password }) => {
    setFailure(null);
    setOffline(false);
    try {
      const { data, error } = await api.POST('/api/v1/auth/login', {
        body: { identifier, password, client: 'mobile', device: await getDeviceInfo() },
      });
      if (data) await signIn(data);
      else setFailure(apiErrorMessage(t, error));
    } catch {
      // fetch rejects only when the server cannot be reached.
      setOffline(true);
    }
  });

  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 16, padding: 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: '600' }}>
        {t('login.title')}
      </Text>
      <Controller
        control={control}
        name="identifier"
        render={({ field }) => (
          <FormField
            label={t('login.identifier')}
            error={errors.identifier && t(errors.identifier.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            textContentType="username"
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <FormField
            label={t('login.password')}
            error={errors.password && t(errors.password.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            secureTextEntry
            textContentType="password"
          />
        )}
      />
      {failure ? <Text style={{ color: '#b00020' }}>{failure}</Text> : null}
      {offline ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: '#b00020' }}>{t('errors.network')}</Text>
          <Button title={t('login.retry')} onPress={() => void submit()} disabled={isSubmitting} />
        </View>
      ) : null}
      {isSubmitting ? (
        <ActivityIndicator />
      ) : (
        <Button title={t('login.submit')} onPress={() => void submit()} />
      )}
      {process.env.EXPO_PUBLIC_APP_ENV === 'development' ? (
        <Link href="/health" style={{ textAlign: 'center' }}>
          {t('health.open')}
        </Link>
      ) : null}
    </ScrollView>
  );
}
