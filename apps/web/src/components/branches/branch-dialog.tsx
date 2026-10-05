'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/field';
import { PinPicker } from '@/components/map/pin-picker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import {
  changed,
  latitude,
  longitude,
  markRejected,
  optionalRadius,
  radius,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
} from '@/lib/form';

type Branch = Schemas['BranchOut'];

const base = {
  name: z.string().trim().min(1, 'validation.required').max(120, 'validation.tooLong'),
  address: z.string().trim().max(255, 'validation.tooLong'),
  lat: latitude,
  lng: longitude,
};
// A new branch may leave the radius to the organisation default; a stored one always has it.
const createSchema = z.object({ ...base, radius_m: optionalRadius });
const editSchema = z.object({ ...base, radius_m: radius });
type Values = z.infer<typeof createSchema>;

function toBody(v: Values): Schemas['BranchCreate'] {
  return {
    name: v.name.trim(),
    address: v.address.trim() || null,
    lat: Number(v.lat),
    lng: Number(v.lng),
    ...(v.radius_m.trim() === '' ? {} : { radius_m: Number(v.radius_m) }),
  };
}

type Props = {
  branch?: Branch; // omitted: create
  /** From Settings; absent when the user may not read them. */
  defaultRadius?: number;
  onClose: () => void;
};

export function BranchDialog({ branch, defaultRadius, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const initial: Values = {
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    lat: branch ? String(branch.lat) : '',
    lng: branch ? String(branch.lng) : '',
    radius_m: String(branch?.radius_m ?? defaultRadius ?? ''),
  };
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(branch ? editSchema : createSchema),
    defaultValues: initial,
  });
  const [lat, lng, radiusM] = useWatch({ control, name: ['lat', 'lng', 'radius_m'] });

  const save = useMutation({
    mutationFn: async (values: Values) => {
      if (!branch) {
        return unwrap(proxyApi().POST('/api/v1/admin/branches', { body: toBody(values) }));
      }
      const body = changed(toBody(values), toBody(initial));
      if (Object.keys(body).length === 0) return branch;
      return unwrap(
        proxyApi().PATCH('/api/v1/admin/branches/{branch_id}', {
          params: { path: { branch_id: branch.id } },
          body,
        }),
      );
    },
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      await save.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ['branches'] });
      onClose();
    } catch (error) {
      markRejected(error, values, setError);
      setServerError(errorMessage(t, error, 'branches'));
    }
  }

  function movePin(nextLat: string, nextLng: string, name?: string) {
    setValue('lat', nextLat, { shouldDirty: true, shouldValidate: !!errors.lat });
    setValue('lng', nextLng, { shouldDirty: true, shouldValidate: !!errors.lng });
    if (name && getValues('name').trim() === '') setValue('name', name, { shouldDirty: true });
  }

  const field = (name: keyof Values) => ({ invalid: !!errors[name], ...register(name) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{branch ? t('branches.editTitle') : t('branches.createTitle')}</DialogTitle>
        <DialogDescription>{t('branches.dialogHint')}</DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="name" label={t('branches.form.name')} error={errors.name?.message}>
              <Input id="name" {...field('name')} />
            </Field>
            <Field id="radius_m" label={t('branches.form.radius')} error={errors.radius_m?.message}>
              <Input
                id="radius_m"
                type="number"
                min={RADIUS_MIN_M}
                max={RADIUS_MAX_M}
                {...field('radius_m')}
              />
              {!branch && defaultRadius === undefined && (
                <span className="text-caption text-muted-foreground">
                  {t('branches.form.radiusHint')}
                </span>
              )}
            </Field>
          </div>
          <Field id="address" label={t('branches.form.address')} error={errors.address?.message}>
            <Input id="address" {...field('address')} />
          </Field>
          <PinPicker
            lat={lat}
            lng={lng}
            radiusM={Number(radiusM)}
            errors={{ lat: errors.lat?.message, lng: errors.lng?.message }}
            onChange={movePin}
          />
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
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
