import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Button, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
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

  const failing = data ? COMPONENTS.filter((name) => data.checks[name] !== 'ok') : [];

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
      <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: '600' }}>
        {t('app.title')}
      </Text>
      {isPending ? (
        <ActivityIndicator accessibilityLabel={t('health.loading')} />
      ) : (
        <Text style={{ fontSize: 18 }}>
          {data?.status === 'ok' ? t('health.connected') : t('health.unreachable')}
        </Text>
      )}
      {failing.length > 0 && (
        <Text>
          {t('health.failing', {
            components: failing.map((name) => t(`health.components.${name}`)).join(', '),
          })}
        </Text>
      )}
      <Button title={t('health.retry')} onPress={() => void refetch()} disabled={isFetching} />
    </View>
  );
}
