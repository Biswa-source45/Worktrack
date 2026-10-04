import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'expo-router';
import { TriangleAlert, WifiOff } from '@/components/icons';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { AuthShell } from '@/components/auth-shell';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PasswordField } from '@/components/ui/password-field';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
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
  const { colors, space, text, minTouchTarget } = useTheme();
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
    <AuthShell
      title={t('login.title')}
      footer={
        <>
          <Button label={t('login.submit')} onPress={() => void submit()} loading={isSubmitting} />
          {process.env.EXPO_PUBLIC_APP_ENV === 'development' ? (
            <Link
              href="/health"
              style={[
                text('small', 500),
                {
                  color: colors.primaryText,
                  textAlign: 'center',
                  minHeight: minTouchTarget,
                  paddingVertical: space[3],
                },
              ]}
            >
              {t('health.open')}
            </Link>
          ) : null}
        </>
      }
    >
      <Controller
        control={control}
        name="identifier"
        render={({ field }) => (
          <Field
            label={t('login.identifier')}
            error={errors.identifier && t(errors.identifier.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            textContentType="username"
            autoComplete="username"
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <PasswordField
            label={t('login.password')}
            error={errors.password && t(errors.password.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
          />
        )}
      />
      {failure ? <Banner status="danger" icon={TriangleAlert} message={failure} /> : null}
      {offline ? (
        <Banner status="danger" icon={WifiOff} message={t('errors.network')}>
          <Button
            variant="secondary"
            label={t('login.retry')}
            onPress={() => void submit()}
            disabled={isSubmitting}
          />
        </Banner>
      ) : null}
    </AuthShell>
  );
}
