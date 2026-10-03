'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage, postJson } from '@/lib/api-client';

const schema = z.object({
  identifier: z.string().trim().min(1, 'validation.required'),
  password: z.string().min(1, 'validation.required'),
});
type Values = z.infer<typeof schema>;

export function LoginForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      const { must_change_password } = await postJson<{ must_change_password: boolean }>(
        '/api/auth/login',
        values,
      );
      router.replace(must_change_password ? '/change-password' : '/');
    } catch (error) {
      setServerError(errorMessage(t, error));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <h1 className="text-2xl font-semibold">{t('login.title')}</h1>
      <Field id="identifier" label={t('login.identifier')} error={errors.identifier?.message}>
        <Input
          id="identifier"
          autoComplete="username"
          invalid={!!errors.identifier}
          {...register('identifier')}
        />
      </Field>
      <Field id="password" label={t('login.password')} error={errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          invalid={!!errors.password}
          {...register('password')}
        />
      </Field>
      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {t('login.submit')}
      </Button>
    </form>
  );
}
