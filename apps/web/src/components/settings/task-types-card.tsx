'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';

type TaskType = Schemas['TaskTypeOut'];
type Draft = { name: string; proof_photo_required: boolean; proof_kind: TaskType['proof_kind'] };

const BLANK: Draft = { name: '', proof_photo_required: true, proof_kind: 'photo' };

/** Add or change one task type: its name and what the person must show when completing it. */
function TypeForm({ type, onDone }: { type?: TaskType; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(
    type
      ? {
          name: type.name,
          proof_photo_required: type.proof_photo_required,
          proof_kind: type.proof_kind,
        }
      : BLANK,
  );
  const [active, setActive] = useState(type?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      type
        ? unwrap(
            proxyApi().PATCH('/api/v1/admin/task-types/{type_id}', {
              params: { path: { type_id: type.id } },
              body: { ...draft, name: draft.name.trim(), is_active: active },
            }),
          )
        : unwrap(
            proxyApi().POST('/api/v1/admin/task-types', {
              body: { ...draft, name: draft.name.trim() },
            }),
          ),
    onSuccess: async () => {
      // The task form and the filters read the active list too.
      await queryClient.invalidateQueries({ queryKey: ['task-types'] });
      onDone();
    },
    onError: (e) => setError(errorMessage(t, e, 'settings.taskTypes')),
  });

  const id = type ? `type-${type.id}` : 'type-new';
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.name.trim() === '') return setError(t('validation.required'));
        setError(null);
        save.mutate();
      }}
      className="grid gap-3 rounded-md border bg-raised p-3 sm:grid-cols-2"
    >
      <Field id={`${id}-name`} label={t('settings.taskTypes.name')}>
        <Input
          id={`${id}-name`}
          maxLength={80}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </Field>
      <Field id={`${id}-kind`} label={t('settings.taskTypes.proofKind')}>
        <Select
          id={`${id}-kind`}
          value={draft.proof_kind}
          onChange={(e) =>
            setDraft({ ...draft, proof_kind: e.target.value as Draft['proof_kind'] })
          }
        >
          <option value="photo">{t('settings.taskTypes.kind.photo')}</option>
          <option value="receipt">{t('settings.taskTypes.kind.receipt')}</option>
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-small">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={draft.proof_photo_required}
          onChange={(e) => setDraft({ ...draft, proof_photo_required: e.target.checked })}
        />
        {t('settings.taskTypes.proofRequired')}
      </label>
      {type && (
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          {t('settings.taskTypes.active')}
        </label>
      )}
      {error && (
        <p role="alert" className="text-small text-danger sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

export function TaskTypesCard({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  // A type id being edited, "new" for the add form, or nothing.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const types = useQuery({
    queryKey: ['task-types', 'admin'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/admin/task-types')),
  });

  return (
    <Card role="group" aria-label={t('settings.taskTypes.title')} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3">{t('settings.taskTypes.title')}</h2>
        {canManage && editing !== 'new' && (
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            {t('settings.taskTypes.add')}
          </Button>
        )}
      </div>
      <p className="text-small text-muted-foreground">{t('settings.taskTypes.hint')}</p>
      {editing === 'new' && <TypeForm onDone={() => setEditing(null)} />}
      {types.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, types.error)}
        </p>
      )}
      {types.isPending && !types.error && <Skeleton className="h-24 w-full" />}
      <ul className="grid gap-2">
        {(types.data ?? []).map((type) =>
          editing === type.id ? (
            <li key={type.id}>
              <TypeForm type={type} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li
              key={type.id}
              className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
            >
              <span className="mr-auto font-medium">{type.name}</span>
              <Badge tone="neutral">
                {type.proof_photo_required
                  ? t(`settings.taskTypes.kind.${type.proof_kind}`)
                  : t('settings.taskTypes.noProof')}
              </Badge>
              {!type.is_active && <Badge tone="warning">{t('common.inactive')}</Badge>}
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('settings.taskTypes.edit', { name: type.name })}
                  onClick={() => setEditing(type.id)}
                >
                  {t('common.edit')}
                </Button>
              )}
            </li>
          ),
        )}
      </ul>
    </Card>
  );
}
