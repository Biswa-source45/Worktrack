import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { WifiOff } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { usePunchQueue } from '@/lib/punch-sync';

/** Punches saved on this phone; nothing is shown while there are none. */
export function PunchQueueCard() {
  const { t } = useTranslation();
  const router = useRouter();
  const { me } = useAuth();
  const { rows } = usePunchQueue(me?.id);
  if (!rows || rows.length === 0) return null;

  const waiting = rows.filter((row) => row.status === 'queued' || row.status === 'syncing').length;
  const failed = rows.filter((row) => row.status === 'failed').length;

  return (
    <Card testID="punch-queue-card">
      <AppText variant="h3" accessibilityRole="header">
        {t('queue.title')}
      </AppText>
      {waiting > 0 ? (
        <AppText variant="small">{t('queue.cardBody', { count: waiting })}</AppText>
      ) : null}
      {failed > 0 ? (
        <AppText variant="small" color="dangerFg">
          {t('queue.cardFailed', { count: failed })}
        </AppText>
      ) : null}
      <Button
        variant="secondary"
        icon={WifiOff}
        label={t('queue.open')}
        onPress={() => router.push('/punch/queue')}
      />
    </Card>
  );
}
