'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@/components/status-badge';
import type { Tone } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap, type Schemas } from '@/lib/api-client';

type Status = Schemas['Candidate']['status'];

// What the person is doing today, so an assigner does not hand a task to someone who is off.
const TONE: Record<Status, Tone> = {
  in_office: 'success',
  on_task: 'info',
  punched_out: 'neutral',
  not_punched_in: 'warning',
  off_day: 'neutral',
};

type Props = {
  value: number[];
  onChange: (ids: number[]) => void;
  /** People already on the task. */
  exclude?: number[];
  /** An i18n key, as zod reports it. */
  error?: string;
};

/** Everyone who can be assigned, with today's status, filtered by a search box; ticks are the choice. */
export function AssigneePicker({ value, onChange, exclude = [], error }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const candidates = useQuery({
    queryKey: ['tasks', 'candidates'],
    queryFn: async () => (await unwrap(proxyApi().GET('/api/v1/tasks/candidates'))).items,
  });
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (candidates.data ?? []).filter(
      (c) =>
        !exclude.includes(c.id) &&
        (needle === '' ||
          c.name.toLowerCase().includes(needle) ||
          c.emp_code.toLowerCase().includes(needle)),
    );
  }, [candidates.data, exclude, search]);

  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <fieldset className="grid gap-2">
      <legend className="text-small font-medium">{t('tasks.form.assignees')}</legend>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label={t('tasks.form.assigneeSearch')}
          placeholder={t('tasks.form.assigneeSearch')}
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {candidates.error && (
        <p role="alert" className="text-caption text-danger">
          {errorMessage(t, candidates.error, 'tasks')}
        </p>
      )}
      <ul className="max-h-56 overflow-y-auto rounded-md border">
        {candidates.isPending && (
          <li className="px-3 py-2 text-small text-muted-foreground">{t('common.loading')}</li>
        )}
        {candidates.data && shown.length === 0 && (
          <li className="px-3 py-2 text-small text-muted-foreground">
            {t('tasks.form.noCandidates')}
          </li>
        )}
        {shown.map((c) => (
          <li key={c.id} className="border-t first:border-t-0">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-raised">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={value.includes(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="min-w-0 flex-1 truncate text-small">
                {c.name} <span className="text-muted-foreground">({c.emp_code})</span>
              </span>
              <StatusBadge tone={TONE[c.status]} label={t(`tasks.candidate.${c.status}`)} />
            </label>
          </li>
        ))}
      </ul>
      <p className="text-caption text-muted-foreground">
        {t('tasks.form.assigneesChosen', { count: value.length })}
      </p>
      {error && (
        <p role="alert" className="text-caption text-danger">
          {t(error)}
        </p>
      )}
    </fieldset>
  );
}
