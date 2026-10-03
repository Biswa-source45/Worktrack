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

// Mirrors the server rule (SRS: 10 to 128 characters); the server stays the authority.
const schema = z
  .object({
    current_password: z.string().min(1, 'validation.required'),
    new_password: z.string().min(10, 'validation.passwordMin').max(128, 'validation.passwordMax'),
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, {
    path: ['confirm'],
    message: 'validation.passwordMismatch',
  });
type Values = z.infer<typeof schema>;

export function ChangePasswordForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit({ current_password, new_password }: Values) {
    setServerError(null);
    try {
      await postJson('/api/auth/change-password', { current_password, new_password });
      router.replace('/');
    } catch (error) {
      setServerError(errorMessage(t, error));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <h1 className="text-2xl font-semibold">{t('changePassword.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('changePassword.intro')}</p>
      <Field
        id="current_password"
        label={t('changePassword.current')}
        error={errors.current_password?.message}
      >
        <Input
          id="current_password"
          type="password"
          autoComplete="current-password"
          invalid={!!errors.current_password}
          {...register('current_password')}
        />
      </Field>
      <Field id="new_password" label={t('changePassword.new')} error={errors.new_password?.message}>
        <Input
          id="new_password"
          type="password"
          autoComplete="new-password"
          invalid={!!errors.new_password}
          {...register('new_password')}
        />
      </Field>
      <Field id="confirm" label={t('changePassword.confirm')} error={errors.confirm?.message}>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          invalid={!!errors.confirm}
          {...register('confirm')}
        />
      </Field>
      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {t('changePassword.submit')}
      </Button>
    </form>
  );
}
