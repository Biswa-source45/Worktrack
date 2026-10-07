'use client';

import { useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Input, Select, Textarea } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';
import {
  changed,
  isIntBetween,
  latitude,
  longitude,
  markRejected,
  optionalRadius,
  RADIUS_MAX_M,
  RADIUS_MIN_M,
} from '@/lib/form';
import { fromIstLocal, toIstLocal } from '@/lib/ist';
import { AssigneePicker } from './assignee-picker';
import { BRIEF_ACCEPT, BRIEF_MAX_BYTES, newKey, postForm } from './task-api';

type Task = Schemas['TaskDetail'];

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const MAX_BRIEFS = 10;

const optionalText = (max: number) => z.string().trim().max(max, 'validation.tooLong');

// A new task needs someone to do it; an edit has no assignee list.
const schema = (needsAssignees: boolean) =>
  z.object({
    title: z.string().trim().min(1, 'validation.required').max(200, 'validation.tooLong'),
    type_id: z.string().min(1, 'validation.required'),
    client_name: z.string().trim().min(1, 'validation.required').max(200, 'validation.tooLong'),
    priority: z.enum(PRIORITIES),
    scheduled_at: z.string().min(1, 'validation.required'),
    expected_minutes: z
      .string()
      .refine((v) => v.trim() === '' || isIntBetween(1, 1440)(v), 'tasks.form.durationInvalid'),
    description: optionalText(2000),
    contact_name: optionalText(120),
    // The server normalises the number; this only catches what is plainly not one.
    contact_phone: z.string().refine((v) => {
      const digits = v.replace(/\D/g, '').length;
      return v.trim() === '' || (digits >= 10 && digits <= 15);
    }, 'validation.mobile'),
    address: z.string().trim().min(1, 'validation.required').max(500, 'validation.tooLong'),
    lat: latitude,
    lng: longitude,
    radius_m: optionalRadius,
    assignee_ids: z
      .array(z.number())
      .min(needsAssignees ? 1 : 0, 'tasks.form.assigneesRequired')
      .max(20, 'tasks.form.tooManyAssignees'),
  });
type Values = z.infer<ReturnType<typeof schema>>;

/** The next whole hour, as an IST `datetime-local` value: a sensible time to start from. */
function nextHour() {
  const local = toIstLocal(new Date(Date.now() + 3_600_000).toISOString());
  return `${local.slice(0, 13)}:00`;
}

function initialValues(task?: Task): Values {
  if (!task) {
    return {
      title: '',
      type_id: '',
      client_name: '',
      priority: 'normal',
      scheduled_at: nextHour(),
      expected_minutes: '',
      description: '',
      contact_name: '',
      contact_phone: '',
      address: '',
      lat: '',
      lng: '',
      radius_m: '',
      assignee_ids: [],
    };
  }
  return {
    title: task.title,
    type_id: String(task.type.id),
    client_name: task.client_name,
    priority: task.priority,
    scheduled_at: toIstLocal(task.scheduled_at),
    expected_minutes: task.expected_minutes === null ? '' : String(task.expected_minutes),
    description: task.description ?? '',
    contact_name: task.contact_name ?? '',
    contact_phone: task.contact_phone ?? '',
    address: task.site.address,
    lat: String(task.site.lat),
    lng: String(task.site.lng),
    radius_m: String(task.site.radius_m),
    assignee_ids: [],
  };
}

function fields(v: Values) {
  return {
    title: v.title.trim(),
    type_id: Number(v.type_id),
    client_name: v.client_name.trim(),
    site: {
      address: v.address.trim(),
      lat: Number(v.lat),
      lng: Number(v.lng),
      ...(v.radius_m.trim() === '' ? {} : { radius_m: Number(v.radius_m) }),
    },
    contact_name: v.contact_name.trim() || null,
    contact_phone: v.contact_phone.trim() || null,
    priority: v.priority,
    scheduled_at: fromIstLocal(v.scheduled_at),
    expected_minutes: v.expected_minutes.trim() === '' ? null : Number(v.expected_minutes),
    description: v.description.trim() || null,
  };
}

type Props = {
  /** Omitted: a new task. */
  task?: Task;
  onClose: () => void;
};

export function TaskDialog({ task, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [briefs, setBriefs] = useState<File[]>([]);
  const [briefError, setBriefError] = useState<string | null>(null);
  // One key per attempt: a double click or a retry after a network drop cannot make two tasks.
  const key = useRef(newKey());
  // Set once the task exists, so a retry after a failed upload only sends the files left.
  const createdId = useRef<number | null>(task?.id ?? null);
  // Once someone has reached the site it is fixed; the server refuses a change (TASK_SITE_LOCKED).
  const siteLocked = task?.assignees.some((a) => a.reach !== null) ?? false;

  const types = useQuery({
    queryKey: ['task-types'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/task-types')),
  });
  const initial = initialValues(task);
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema(!task)), defaultValues: initial });
  const [lat, lng, radiusM, assigneeIds] = useWatch({
    control,
    name: ['lat', 'lng', 'radius_m', 'assignee_ids'],
  });

  const save = useMutation({
    mutationFn: async (values: Values) => {
      if (createdId.current !== null && !task) return createdId.current;
      if (!task) {
        const result = await unwrap(
          proxyApi().POST('/api/v1/tasks', {
            params: { header: { 'Idempotency-Key': key.current } },
            body: { ...fields(values), assignee_ids: values.assignee_ids },
          }),
        );
        createdId.current = result.task.id;
        return result.task.id;
      }
      const body = changed(fields(values), fields(initial));
      if (Object.keys(body).length > 0) {
        await unwrap(
          proxyApi().PATCH('/api/v1/tasks/{task_id}', {
            params: { path: { task_id: task.id }, header: { 'Idempotency-Key': newKey() } },
            body,
          }),
        );
      }
      return task.id;
    },
  });

  async function onSubmit(values: Values) {
    setServerError(null);
    let id: number;
    try {
      id = await save.mutateAsync(values);
    } catch (error) {
      markRejected(error, values, setError);
      setServerError(errorMessage(t, error, 'tasks'));
      return;
    }
    // The briefs go after the task exists; any that fail stay in the list for another try.
    const left: File[] = [];
    for (const file of briefs) {
      const form = new FormData();
      form.append('file', file);
      try {
        await postForm(`/tasks/${id}/attachments`, form, newKey());
      } catch {
        left.push(file);
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    if (left.length > 0) {
      setBriefs(left);
      setServerError(t('tasks.form.uploadFailed', { names: left.map((f) => f.name).join(', ') }));
      return;
    }
    onClose();
  }

  function movePin(nextLat: string, nextLng: string, name?: string) {
    setValue('lat', nextLat, { shouldDirty: true, shouldValidate: !!errors.lat });
    setValue('lng', nextLng, { shouldDirty: true, shouldValidate: !!errors.lng });
    if (name && getValues('address').trim() === '')
      setValue('address', name, { shouldDirty: true });
  }

  function addBriefs(list: FileList | null) {
    setBriefError(null);
    const chosen = [...(list ?? [])];
    const tooBig = chosen.find((f) => f.size > BRIEF_MAX_BYTES);
    if (tooBig) return setBriefError(t('tasks.form.briefTooBig', { name: tooBig.name }));
    const next = [...briefs, ...chosen];
    if (next.length > MAX_BRIEFS) return setBriefError(t('tasks.form.briefTooMany'));
    setBriefs(next);
  }

  const field = (name: keyof Values) => ({ invalid: !!errors[name], ...register(name) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>{task ? t('tasks.form.editTitle') : t('tasks.form.createTitle')}</DialogTitle>
        <DialogDescription>{t('tasks.form.hint')}</DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="title" label={t('tasks.form.title')} error={errors.title?.message}>
              <Input id="title" {...field('title')} />
            </Field>
            <Field id="type_id" label={t('tasks.form.type')} error={errors.type_id?.message}>
              <Select id="type_id" {...field('type_id')}>
                <option value="">{t('common.select')}</option>
                {/* An old task keeps its type even after the type was switched off. */}
                {task && !(types.data ?? []).some((x) => x.id === task.type.id) && (
                  <option value={task.type.id}>{task.type.name}</option>
                )}
                {(types.data ?? []).map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="client_name"
              label={t('tasks.form.client')}
              error={errors.client_name?.message}
            >
              <Input id="client_name" {...field('client_name')} />
            </Field>
            <Field id="priority" label={t('tasks.form.priority')} error={errors.priority?.message}>
              <Select id="priority" {...field('priority')}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`tasks.priority.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="scheduled_at"
              label={t('tasks.form.scheduled')}
              error={errors.scheduled_at?.message}
            >
              <Input id="scheduled_at" type="datetime-local" {...field('scheduled_at')} />
            </Field>
            <Field
              id="expected_minutes"
              label={t('tasks.form.duration')}
              error={errors.expected_minutes?.message}
            >
              <Input
                id="expected_minutes"
                type="number"
                min={1}
                max={1440}
                {...field('expected_minutes')}
              />
            </Field>
            <Field
              id="contact_name"
              label={t('tasks.form.contactName')}
              error={errors.contact_name?.message}
            >
              <Input id="contact_name" {...field('contact_name')} />
            </Field>
            <Field
              id="contact_phone"
              label={t('tasks.form.contactPhone')}
              error={errors.contact_phone?.message}
            >
              <Input id="contact_phone" type="tel" {...field('contact_phone')} />
            </Field>
          </div>
          <Field
            id="description"
            label={t('tasks.form.description')}
            error={errors.description?.message}
          >
            <Textarea id="description" {...field('description')} />
          </Field>

          <fieldset className="grid gap-4" disabled={siteLocked}>
            <legend className="mb-2 text-h3">{t('tasks.form.site')}</legend>
            {siteLocked && (
              <p className="text-small text-muted-foreground">{t('tasks.form.siteLocked')}</p>
            )}
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <Field id="address" label={t('tasks.form.address')} error={errors.address?.message}>
                <Input id="address" {...field('address')} />
              </Field>
              <Field id="radius_m" label={t('tasks.form.radius')} error={errors.radius_m?.message}>
                <Input
                  id="radius_m"
                  type="number"
                  min={RADIUS_MIN_M}
                  max={RADIUS_MAX_M}
                  {...field('radius_m')}
                />
                <span className="text-caption text-muted-foreground">
                  {t('tasks.form.radiusHint')}
                </span>
              </Field>
            </div>
            <PinPicker
              lat={lat}
              lng={lng}
              radiusM={Number(radiusM) || RADIUS_MIN_M}
              errors={{ lat: errors.lat?.message, lng: errors.lng?.message }}
              onChange={movePin}
            />
          </fieldset>

          {!task && (
            <AssigneePicker
              value={assigneeIds}
              onChange={(ids) =>
                setValue('assignee_ids', ids, { shouldValidate: !!errors.assignee_ids })
              }
              error={errors.assignee_ids?.message}
            />
          )}

          <div className="grid gap-1.5">
            <label htmlFor="briefs" className="text-small font-medium">
              {t('tasks.form.briefs')}
            </label>
            <Input
              id="briefs"
              type="file"
              multiple
              accept={BRIEF_ACCEPT}
              onChange={(e) => {
                addBriefs(e.target.files);
                e.target.value = '';
              }}
            />
            <span className="text-caption text-muted-foreground">{t('tasks.form.briefsHint')}</span>
            {briefError && (
              <p role="alert" className="text-caption text-danger">
                {briefError}
              </p>
            )}
            {briefs.length > 0 && (
              <ul aria-label={t('tasks.form.briefsChosen')} className="grid gap-1">
                {briefs.map((file, i) => (
                  <li
                    key={`${file.name}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-md bg-raised px-3 py-1 text-small"
                  >
                    <span className="truncate">{file.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setBriefs(briefs.filter((_, j) => j !== i))}
                    >
                      {t('tasks.form.removeBrief', { name: file.name })}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

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
              {task ? t('common.save') : t('tasks.form.createAction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
