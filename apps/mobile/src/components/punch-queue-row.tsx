import type { TFunction } from 'i18next';
import { CircleCheck, CircleX, Clock, RefreshCw } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatIst } from '@/lib/ist';
import type { QueueRow, QueueStatus } from '@/lib/punch-queue';

const LOOKS = {
  queued: { status: 'warning', icon: Clock },
  syncing: { status: 'info', icon: RefreshCw },
  synced: { status: 'success', icon: CircleCheck },
  failed: { status: 'danger', icon: CircleX },
} as const satisfies Record<QueueStatus, object>;

/** Why a punch was not sent, in the server's own words when it gave any. */
export function queueReason(t: TFunction, row: QueueRow): string | null {
  if (row.error_code === null) return null;
  if (row.error_message && row.error_message !== row.error_code) return row.error_message;
  return t([`queue.errors.${row.error_code}`, `punch.errors.${row.error_code}`], {
    defaultValue: row.error_code,
  });
}

type Props = {
  row: QueueRow;
  t: TFunction;
  onRetry: () => void;
  onDiscard: () => void;
};

export function PunchQueueRow({ row, t, onRetry, onDiscard }: Props) {
  const look = LOOKS[row.status];
  const kind = t(`queue.kind.${row.kind}`);
  const when = formatIst(row.created_at);
  const reason = row.status === 'failed' ? queueReason(t, row) : null;

  return (
    <Card testID={`queue-row-${row.id}`}>
      <AppText weight={600}>{kind}</AppText>
      <AppText variant="small" color="muted">
        {when}
      </AppText>
      <Badge status={look.status} icon={look.icon} label={t(`queue.status.${row.status}`)} />
      {reason ? (
        <AppText variant="small" color="dangerFg" accessibilityRole="alert">
          {t('queue.failedBecause', { reason })}
        </AppText>
      ) : null}
      {row.status === 'failed' ? (
        <Button
          variant="secondary"
          label={t('queue.retry')}
          accessibilityLabel={t('queue.retryA11y', { kind, time: when })}
          onPress={onRetry}
        />
      ) : null}
      {row.status !== 'synced' ? (
        <Button
          variant="destructive"
          label={t('queue.discard')}
          accessibilityLabel={t('queue.discardA11y', { kind, time: when })}
          onPress={onDiscard}
          disabled={row.status === 'syncing'}
        />
      ) : null}
    </Card>
  );
}
