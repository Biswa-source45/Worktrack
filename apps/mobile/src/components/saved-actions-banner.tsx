import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from '@/components/icons';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { isTaskKind } from '@/lib/punch-queue';
import { usePunchQueue } from '@/lib/punch-sync';
import { TASKS_KEY } from '@/lib/tasks';

/**
 * Task actions saved on this phone and not yet sent. When one of them gets sent the task screens
 * reload, so the new status shows without a pull.
 */
export function SavedActionsBanner() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const { rows } = usePunchQueue(me?.id);
  const saved = rows?.filter((row) => isTaskKind(row.kind) && row.status !== 'synced') ?? [];
  const waiting = saved.filter((row) => row.status !== 'failed').length;
  const failed = saved.length - waiting;
  const before = useRef(0);

  useEffect(() => {
    if (before.current > waiting) void queryClient.invalidateQueries({ queryKey: TASKS_KEY });
    before.current = waiting;
  }, [queryClient, waiting]);

  if (saved.length === 0) return null;
  return (
    <Banner
      status={failed > 0 ? 'danger' : 'info'}
      icon={WifiOff}
      message={
        failed > 0
          ? t('tasks.saved.failed', { count: failed })
          : t('tasks.saved.waiting', { count: waiting })
      }
    >
      <Button
        variant="secondary"
        label={t('tasks.saved.open')}
        onPress={() => router.push('/punch/queue')}
      />
    </Banner>
  );
}
