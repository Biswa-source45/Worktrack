'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Info } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Page, PageHeader } from '@/components/page';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import {
  changed,
  isIntBetween,
  isNumberBetween,
  markRejected,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
} from '@/lib/form';
import { useMe } from '@/lib/me';
import { useSettings } from './use-settings';
import { TaskTypesCard } from './task-types-card';

type Settings = Schemas['OrgSettings'];
type Name = keyof Settings;

// Bounds mirror the server's OrgSettings; the server remains the authority. Whole numbers,
// except the face scores, sharpness and confidence, which are decimals. The cut-off is a time.
const NUMBERS = {
  geofence_default_radius_m: [RADIUS_MIN_M, RADIUS_MAX_M],
  home_default_radius_m: [RADIUS_MIN_M, RADIUS_MAX_M],
  gps_max_accuracy_m: [5, 500],
  geofence_accuracy_buffer_cap_m: [0, 100],
  punch_out_approval_levels: [1, 2],
  regularization_approval_levels: [1, 2],
  face_verify_threshold: [0.2, 0.9, 'decimal'],
  face_review_threshold: [0.1, 0.8, 'decimal'],
  face_min_detection_confidence: [0.5, 0.99, 'decimal'],
  face_min_face_px: [40, 400],
  face_min_sharpness: [1, 2000, 'decimal'],
  face_min_brightness: [0, 254],
  face_max_brightness: [1, 255],
  face_retention_days_after_exit: [0, 365],
  punch_reminder_after_shift_end_min: [0, 240],
  punch_out_request_expiry_hours: [1, 240],
  punch_max_speed_kmh: [20, 1000],
  offline_punch_max_age_hours: [1, 24],
  task_default_site_radius_m: [RADIUS_MIN_M, RADIUS_MAX_M],
  task_accept_escalation_minutes: [5, 1440],
} as const satisfies Partial<Record<Name, readonly [number, number, 'decimal'?]>>;
type NumberName = keyof typeof NUMBERS;
const NUMBER_NAMES = Object.keys(NUMBERS) as NumberName[];

const GROUPS: { id: string; fields: Name[] }[] = [
  {
    id: 'geofence',
    fields: [
      'geofence_default_radius_m',
      'home_default_radius_m',
      'gps_max_accuracy_m',
      'geofence_accuracy_buffer_cap_m',
    ],
  },
  { id: 'approvals', fields: ['punch_out_approval_levels', 'regularization_approval_levels'] },
  { id: 'app', fields: ['min_app_version'] },
  {
    id: 'face',
    fields: [
      'face_verify_threshold',
      'face_review_threshold',
      'face_min_detection_confidence',
      'face_min_face_px',
      'face_min_sharpness',
      'face_min_brightness',
      'face_max_brightness',
      'face_retention_days_after_exit',
    ],
  },
  {
    id: 'attendance',
    fields: [
      'attendance_cutoff_time',
      'punch_reminder_after_shift_end_min',
      'punch_out_request_expiry_hours',
      'punch_max_speed_kmh',
      'offline_punch_max_age_hours',
    ],
  },
  { id: 'tasks', fields: ['task_default_site_radius_m', 'task_accept_escalation_minutes'] },
];
// Cards that hold many fields run the full width, in a grid of their own.
const WIDE: Record<string, string> = {
  face: 'sm:grid-cols-2 lg:grid-cols-4',
  attendance: 'sm:grid-cols-2 lg:grid-cols-5',
};
const LEVELS: Name[] = ['punch_out_approval_levels', 'regularization_approval_levels'];

const isDecimal = (name: NumberName) => (NUMBERS[name] as readonly unknown[])[2] === 'decimal';
const numberField = (name: NumberName) => {
  const [min, max] = NUMBERS[name];
  return isDecimal(name)
    ? z.string().refine(isNumberBetween(min, max), 'validation.decimalRange')
    : z.string().refine(isIntBetween(min, max), 'validation.range');
};
const schema = z
  .object({
    geofence_default_radius_m: numberField('geofence_default_radius_m'),
    home_default_radius_m: numberField('home_default_radius_m'),
    gps_max_accuracy_m: numberField('gps_max_accuracy_m'),
    geofence_accuracy_buffer_cap_m: numberField('geofence_accuracy_buffer_cap_m'),
    punch_out_approval_levels: numberField('punch_out_approval_levels'),
    regularization_approval_levels: numberField('regularization_approval_levels'),
    face_verify_threshold: numberField('face_verify_threshold'),
    face_review_threshold: numberField('face_review_threshold'),
    face_min_detection_confidence: numberField('face_min_detection_confidence'),
    face_min_face_px: numberField('face_min_face_px'),
    face_min_sharpness: numberField('face_min_sharpness'),
    face_min_brightness: numberField('face_min_brightness'),
    face_max_brightness: numberField('face_max_brightness'),
    face_retention_days_after_exit: numberField('face_retention_days_after_exit'),
    attendance_cutoff_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.cutoffTime'),
    punch_reminder_after_shift_end_min: numberField('punch_reminder_after_shift_end_min'),
    punch_out_request_expiry_hours: numberField('punch_out_request_expiry_hours'),
    punch_max_speed_kmh: numberField('punch_max_speed_kmh'),
    offline_punch_max_age_hours: numberField('offline_punch_max_age_hours'),
    task_default_site_radius_m: numberField('task_default_site_radius_m'),
    task_accept_escalation_minutes: numberField('task_accept_escalation_minutes'),
    min_app_version: z
      .string()
      .trim()
      .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'validation.appVersion'),
  })
  // The same two rules the server applies to the stored values.
  .superRefine((v, ctx) => {
    if (Number(v.face_review_threshold) >= Number(v.face_verify_threshold)) {
      ctx.addIssue({
        code: 'custom',
        path: ['face_review_threshold'],
        message: 'validation.reviewBelowVerify',
      });
    }
    if (Number(v.face_min_brightness) >= Number(v.face_max_brightness)) {
      ctx.addIssue({
        code: 'custom',
        path: ['face_min_brightness'],
        message: 'validation.brightnessOrder',
      });
    }
  });
type Values = z.infer<typeof schema>;

const toValues = (settings: Settings): Values => ({
  ...(Object.fromEntries(NUMBER_NAMES.map((name) => [name, String(settings[name])])) as Record<
    NumberName,
    string
  >),
  attendance_cutoff_time: settings.attendance_cutoff_time,
  min_app_version: settings.min_app_version,
});

const toBody = (values: Values): Settings => ({
  ...(Object.fromEntries(NUMBER_NAMES.map((name) => [name, Number(values[name])])) as Record<
    NumberName,
    number
  >),
  attendance_cutoff_time: values.attendance_cutoff_time,
  min_app_version: values.min_app_version.trim(),
});

function SettingsForm({ settings, canManage }: { settings: Settings; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(settings) });

  const save = useMutation({
    // The body type is the whole settings object, but the server changes only the fields sent.
    mutationFn: (body: Partial<Settings>) =>
      unwrap(proxyApi().PATCH('/api/v1/admin/settings', { body: body as Settings })),
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    setSaved(false);
    try {
      const next = await save.mutateAsync(changed(toBody(values), settings));
      queryClient.setQueryData(['settings'], next);
      reset(toValues(next));
      setSaved(true);
    } catch (error) {
      markRejected(error, values, setError);
      setServerError(errorMessage(t, error));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      {!canManage && (
        <p className="flex items-start gap-2 text-small text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('settings.readOnly')}
        </p>
      )}
      {/* A disabled fieldset disables every control inside it. */}
      <fieldset disabled={!canManage} className="grid gap-4 lg:grid-cols-3">
        {GROUPS.map((group) => (
          <Card
            key={group.id}
            role="group"
            aria-label={t(`settings.group.${group.id}`)}
            className={group.id in WIDE ? 'lg:col-span-3' : undefined}
          >
            <h2 className="mb-4 text-h3">{t(`settings.group.${group.id}`)}</h2>
            <div className={group.id in WIDE ? `grid gap-4 ${WIDE[group.id]}` : 'grid gap-4'}>
              {group.fields.map((name) => (
                <Field
                  key={name}
                  id={name}
                  label={t(`settings.field.${name}`)}
                  error={errors[name]?.message}
                >
                  {LEVELS.includes(name) ? (
                    <Select
                      id={name}
                      invalid={!!errors[name]}
                      onInput={() => setSaved(false)}
                      {...register(name)}
                    >
                      <option value="1">{t('settings.levels.1')}</option>
                      <option value="2">{t('settings.levels.2')}</option>
                    </Select>
                  ) : (
                    <Input
                      id={name}
                      type={name === 'attendance_cutoff_time' ? 'time' : undefined}
                      inputMode={
                        name === 'min_app_version' || name === 'attendance_cutoff_time'
                          ? 'text'
                          : isDecimal(name as NumberName)
                            ? 'decimal'
                            : 'numeric'
                      }
                      invalid={!!errors[name]}
                      onInput={() => setSaved(false)}
                      {...register(name)}
                    />
                  )}
                  <span className="text-caption text-muted-foreground">
                    {t(`settings.help.${name}`)}
                  </span>
                </Field>
              ))}
            </div>
          </Card>
        ))}
      </fieldset>
      {serverError && (
        <p role="alert" className="text-small text-danger">
          {serverError}
        </p>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!isDirty || save.isPending}>
            {t('common.save')}
          </Button>
          {saved && (
            <p role="status" className="flex items-center gap-1.5 text-small text-success">
              <CircleCheck aria-hidden="true" className="size-4" />
              {t('settings.saved')}
            </p>
          )}
        </div>
      )}
    </form>
  );
}

function SettingsView() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const settings = useSettings();
  return (
    <Page>
      <PageHeader title={t('settings.title')} />
      {settings.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, settings.error)}
        </p>
      )}
      {settings.isPending && !settings.error && (
        <div role="status" className="grid gap-4 lg:grid-cols-3">
          <span className="sr-only">{t('common.loading')}</span>
          {GROUPS.map((group) => (
            <Skeleton
              key={group.id}
              className={group.id in WIDE ? 'h-48 rounded-lg lg:col-span-3' : 'h-64 rounded-lg'}
            />
          ))}
        </div>
      )}
      {settings.data && (
        <SettingsForm
          settings={settings.data}
          canManage={me?.permissions.includes('settings.manage') ?? false}
        />
      )}
      <TaskTypesCard canManage={me?.permissions.includes('settings.manage') ?? false} />
    </Page>
  );
}

export function SettingsPage() {
  return (
    <RequirePermission permission="settings.view">
      <SettingsView />
    </RequirePermission>
  );
}
