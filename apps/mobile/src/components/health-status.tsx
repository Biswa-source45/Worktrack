import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, RefreshCw, TriangleAlert } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { HeroDecor } from '@/components/decor/hero-decor';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { api } from '@/lib/api';

const COMPONENTS = ['database', 'redis', 'storage'] as const;

const LOOKS = {
  connected: { badge: 'success', icon: CircleCheck, label: 'health.connected' },
  checking: { badge: 'warning', icon: Clock, label: 'health.loading' },
  // The backend answered but a part of it is down: same wording, a warning rather than an error.
  degraded: { badge: 'warning', icon: TriangleAlert, label: 'health.unreachable' },
  unreachable: { badge: 'danger', icon: CircleX, label: 'health.unreachable' },
} as const;

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

  const failing = data ? COMPONENTS.filter((name) => data.checks[name] !== 'ok') : [];
  const state = isPending
    ? 'checking'
    : data?.status === 'ok'
      ? 'connected'
      : data
        ? 'degraded'
        : 'unreachable';
  const look = LOOKS[state];

  return (
    <Screen contentStyle={{ alignItems: 'center', justifyContent: 'center' }}>
      <HeroDecor />
      <AppText variant="h1" accessibilityRole="header">
        {t('app.title')}
      </AppText>
      <Badge
        testID="health-state"
        iconTestID={`health-icon-${state}`}
        status={look.badge}
        icon={look.icon}
        label={t(look.label)}
      />
      {failing.length > 0 && (
        <AppText color="muted" style={{ textAlign: 'center' }}>
          {t('health.failing', {
            components: failing.map((name) => t(`health.components.${name}`)).join(', '),
          })}
        </AppText>
      )}
      <Button
        variant="secondary"
        icon={RefreshCw}
        label={t('health.retry')}
        onPress={() => void refetch()}
        disabled={isFetching}
      />
    </Screen>
  );
}
