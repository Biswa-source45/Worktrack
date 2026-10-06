import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, TriangleAlert } from '@/components/icons';
import { PunchQueueRow } from '@/components/punch-queue-row';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { errorDetail } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { formatIst } from '@/lib/ist';
import { discardRow, retryRow } from '@/lib/punch-queue';
import type { QueueRow } from '@/lib/punch-queue';
import { requestSync, usePunchQueue } from '@/lib/punch-sync';
import { useTheme } from '@/lib/theme';

/** Every punch saved on this phone, with what happened to it. */
export default function PunchQueueScreen() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const { me } = useAuth();
  const { rows, error } = usePunchQueue(me?.id);
  const [syncing, setSyncing] = useState(false);
  const [discarding, setDiscarding] = useState<QueueRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true);
    try {
      await requestSync({ force: true });
    } finally {
      setSyncing(false);
    }
  }

  async function retry(row: QueueRow) {
    setProblem(null);
    try {
      await retryRow(row.id);
      void requestSync({ force: true });
    } catch (failure) {
      setProblem(errorDetail(failure));
    }
  }

  return (
    <Screen scroll>
      <BackButton />
      <AppText variant="h1" accessibilityRole="header">
        {t('queue.title')}
      </AppText>
      <Button
        icon={RefreshCw}
        label={t('queue.syncNow')}
        onPress={() => void syncNow()}
        loading={syncing}
      />
      {error ? (
        <Banner status="danger" icon={TriangleAlert} message={t('queue.loadFailed')}>
          <AppText variant="small" color="muted" selectable>
            {errorDetail(error)}
          </AppText>
        </Banner>
      ) : null}
      {problem ? <Banner status="danger" icon={TriangleAlert} message={problem} /> : null}
      {rows === null && !error ? (
        <Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {rows?.length === 0 ? <EmptyState message={t('queue.empty')} /> : null}
      {rows?.map((row) => (
        <PunchQueueRow
          key={row.id}
          row={row}
          t={t}
          onRetry={() => void retry(row)}
          onDiscard={() => setDiscarding(row)}
        />
      ))}
      {discarding ? (
        <ConfirmDialog
          title={t('queue.discardTitle')}
          message={t('queue.discardConfirm', {
            kind: t(`queue.kind.${discarding.kind}`),
            time: formatIst(discarding.created_at),
          })}
          confirmLabel={t('queue.discard')}
          destructive
          onConfirm={() => discardRow(discarding.id)}
          onClose={() => setDiscarding(null)}
        />
      ) : null}
    </Screen>
  );
}
