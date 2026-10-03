'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

const COMPONENTS = ['database', 'redis', 'storage'] as const;

async function fetchHealth() {
  const { data, error, response } = await api.GET('/health');
  if (data) return data;
  // /health answers 503 with the same body shape, so a degraded backend still shows which part failed.
  if (response.status === 503 && error) return error;
  throw new Error(`Unexpected /health response: ${response.status}`);
}

export function HealthStatus() {
  const { t } = useTranslation();
  const { data, isPending, isFetching, refetch } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
  });

  let summary = t('health.unreachable');
  if (isPending) summary = t('health.loading');
  else if (data) summary = data.status === 'ok' ? t('health.ok') : t('health.degraded');

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('app.title')}</h1>
      <h2 className="text-lg font-medium">{t('health.heading')}</h2>
      <p role="status">{summary}</p>
      {data && (
        <ul className="space-y-1">
          {COMPONENTS.map((name) => (
            <li key={name} data-testid={`check-${name}`}>
              {t(`health.components.${name}`)}: {t(`health.state.${data.checks[name]}`)}
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
        {t('health.retry')}
      </Button>
    </section>
  );
}
