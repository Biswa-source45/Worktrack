'use client';

import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, TriangleAlert } from 'lucide-react';
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

// Icon, label and status colour together, so the state is never conveyed by colour alone.
const STATE = {
  checking: { Icon: Clock, tone: 'text-warning' },
  connected: { Icon: CircleCheck, tone: 'text-success' },
  degraded: { Icon: TriangleAlert, tone: 'text-warning' },
  unreachable: { Icon: CircleX, tone: 'text-danger' },
} as const;

export function HealthIndicator() {
  const { t } = useTranslation();
  const { data, isPending } = useHealth();
  const state = isPending
    ? 'checking'
    : data
      ? data.status === 'ok'
        ? 'connected'
        : 'degraded'
      : 'unreachable';
  const { Icon, tone } = STATE[state];

  return (
    <span
      role="status"
      data-testid="health-indicator"
      data-state={state}
      className={cn('inline-flex items-center gap-1 text-caption font-medium', tone)}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`health.${state}`)}
    </span>
  );
}
