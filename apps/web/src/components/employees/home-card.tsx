'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/field';
import { GeofenceMap, PinPicker } from '@/components/map/pin-picker';
import { NoAccess } from '@/components/require-permission';
import { useSettings } from '@/components/settings/use-settings';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import {
  latitude,
  longitude,
  markRejected,
  optionalRadius,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
} from '@/lib/form';
import i18n from '@/lib/i18n';
import { formatIst } from '@/lib/ist';
import { ReviewDialog } from './home-requests';

type Home = Schemas['AdminHomeOut'];

// No coordinates in the key: keys show up in devtools and logs.
const homeKey = (employeeId: number) => ['employees', employeeId, 'home-location'];

const schema = z.object({ lat: latitude, lng: longitude, radius_m: optionalRadius });
type Values = z.infer<typeof schema>;

function HomeDialog({
  employeeId,
  approved,
  defaultRadius,
  onClose,
}: {
  employeeId: number;
  approved: Home['approved'];
  defaultRadius?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      lat: approved ? String(approved.lat) : '',
      lng: approved ? String(approved.lng) : '',
      radius_m: String(approved?.radius_m ?? defaultRadius ?? ''),
    },
  });
  const [lat, lng, radiusM] = useWatch({ control, name: ['lat', 'lng', 'radius_m'] });

  // gcTime 0: neither the pin sent nor the one returned stays in the mutation cache.
  const save = useMutation({
    gcTime: 0,
    mutationFn: (v: Values) =>
      unwrap(
        proxyApi().PUT('/api/v1/admin/employees/{employee_id}/home-location', {
          params: { path: { employee_id: employeeId } },
          body: {
            lat: Number(v.lat),
            lng: Number(v.lng),
            ...(v.radius_m.trim() === '' ? {} : { radius_m: Number(v.radius_m) }),
          },
        }),
      ),
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      await save.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: homeKey(employeeId) });
      onClose();
    } catch (error) {
      markRejected(error, values, setError);
      setServerError(errorMessage(t, error, 'home'));
    }
  }

  function movePin(nextLat: string, nextLng: string) {
    setValue('lat', nextLat, { shouldDirty: true, shouldValidate: !!errors.lat });
    setValue('lng', nextLng, { shouldDirty: true, shouldValidate: !!errors.lng });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t(approved ? 'home.changeTitle' : 'home.setTitle')}</DialogTitle>
        <DialogDescription>{t('home.dialogHint')}</DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <PinPicker
            lat={lat}
            lng={lng}
            radiusM={Number(radiusM)}
            errors={{ lat: errors.lat?.message, lng: errors.lng?.message }}
            onChange={movePin}
          />
          <Field id="radius_m" label={t('home.radius')} error={errors.radius_m?.message}>
            <Input
              id="radius_m"
              type="number"
              min={RADIUS_MIN_M}
              max={RADIUS_MAX_M}
              invalid={!!errors.radius_m}
              {...register('radius_m')}
            />
          </Field>
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

type Open = 'set' | 'remove' | 'review';

/** The approved home work location and any pending request. Privacy-sensitive: see homeKey. */
export function HomeCard({ employeeId, name }: { employeeId: number; name: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [open, setOpen] = useState<Open | null>(null);
  // gcTime 0: the coordinates of someone's home must not linger in the cache.
  const home = useQuery({
    queryKey: homeKey(employeeId),
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/employees/{employee_id}/home-location', {
          params: { path: { employee_id: employeeId } },
        }),
      ),
    gcTime: 0,
  });
  if (home.error instanceof ApiError && home.error.status === 403) return <NoAccess />;

  async function remove() {
    await unwrap(
      proxyApi().DELETE('/api/v1/admin/employees/{employee_id}/home-location', {
        params: { path: { employee_id: employeeId } },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: homeKey(employeeId) });
  }

  const approved = home.data?.approved ?? null;
  const pending = home.data?.pending ?? null;
  const sourceKey = `home.source.${approved?.source}`;
  // Waits for Settings so the dialog opens with the organisation's default home radius.
  const setButton = (
    <Button
      variant={approved ? 'outline' : 'default'}
      onClick={() => setOpen('set')}
      disabled={settings.isLoading}
    >
      {t(approved ? 'home.change' : 'home.set')}
    </Button>
  );
  const close = () => setOpen(null);

  return (
    <Card role="region" aria-label={t('home.title')} className="grid gap-4">
      <h2 className="text-h3">{t('home.title')}</h2>
      {home.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, home.error)}
        </p>
      )}
      {home.isPending && (
        <div role="status">
          <span className="sr-only">{t('common.loading')}</span>
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
      )}
      {home.data && !approved && <EmptyState text={t('home.none')} action={setButton} />}
      {approved && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge testId="home-approved" tone="success" label={t('home.approved')} />
            <span className="mr-auto" />
            {setButton}
            <Button variant="destructive" onClick={() => setOpen('remove')}>
              {t('home.remove')}
            </Button>
          </div>
          <GeofenceMap
            center={{ lat: approved.lat, lng: approved.lng }}
            radiusM={approved.radius_m}
          />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-small sm:grid-cols-4">
            <dt className="text-muted-foreground">{t('home.radius')}</dt>
            <dd>{t('home.metres', { value: approved.radius_m })}</dd>
            <dt className="text-muted-foreground">{t('home.sourceLabel')}</dt>
            <dd>{i18n.exists(sourceKey) ? t(sourceKey) : approved.source}</dd>
            <dt className="text-muted-foreground">{t('home.coordinates')}</dt>
            <dd className="tabular-nums">{`${approved.lat}, ${approved.lng}`}</dd>
            <dt className="text-muted-foreground">{t('home.decidedAt')}</dt>
            <dd>{approved.decided_at ? formatIst(approved.decided_at) : t('home.notRecorded')}</dd>
          </dl>
        </>
      )}
      {pending && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <StatusBadge testId="home-pending" tone="warning" label={t('home.pending')} />
          <span className="mr-auto text-small text-muted-foreground">
            {t('home.pendingSince', { when: formatIst(pending.created_at) })}
          </span>
          <Button size="sm" onClick={() => setOpen('review')}>
            {t('home.reviewRequest')}
          </Button>
        </div>
      )}

      {open === 'set' && (
        <HomeDialog
          employeeId={employeeId}
          approved={approved}
          defaultRadius={settings.data?.home_default_radius_m}
          onClose={close}
        />
      )}
      {open === 'remove' && (
        <ConfirmDialog
          title={t('home.remove')}
          description={t('home.removeConfirm', { name })}
          confirmLabel={t('home.remove')}
          destructive
          onConfirm={remove}
          onClose={close}
        />
      )}
      {open === 'review' && pending && <ReviewDialog requestId={pending.id} onClose={close} />}
    </Card>
  );
}
