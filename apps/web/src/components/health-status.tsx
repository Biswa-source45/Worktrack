'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const POLL_MS = 30_000;

async function fetchHealth() {
  const { data, error, response } = await api.GET('/health');
  if (data) return data;
  // /health answers 503 with the same body shape, so a degraded backend is told apart from an unreachable one.
  if (response.status === 503 && error) return error;
  throw new Error(`Unexpected /health response: ${response.status}`);
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
    refetchInterval: POLL_MS,
  });
}

const TONE = {
  connected: 'text-muted-foreground',
  degraded: 'text-foreground',
  unreachable: 'text-destructive',
} as const;

// Text plus a dot icon, so the state is never conveyed by colour alone.
export function HealthIndicator() {
  const { t } = useTranslation();
  const { data, isPending } = useHealth();
  const state = data ? (data.status === 'ok' ? 'connected' : 'degraded') : 'unreachable';

  return (
    <span
      role="status"
      data-testid="health-indicator"
      data-state={isPending ? 'checking' : state}
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        isPending ? 'text-muted-foreground' : TONE[state],
      )}
    >
      <svg aria-hidden="true" viewBox="0 0 8 8" className="size-2">
        {state === 'connected' && !isPending ? (
          <circle cx="4" cy="4" r="4" fill="currentColor" />
        ) : (
          <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
      {isPending ? t('health.checking') : t(`health.${state}`)}
    </span>
  );
}
