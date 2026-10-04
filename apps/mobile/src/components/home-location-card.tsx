import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, RefreshCw, TriangleAlert } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { LocateButton, useCurrentFix } from '@/components/locate-button';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { formatIst } from '@/lib/ist';
import { useTheme } from '@/lib/theme';

const KEY = ['my-home-location'];

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/**
 * The place the employee works from at home: its state, and a request to set it from where the
 * phone is now. The position goes to the server once and is never shown or kept.
 */
export function HomeLocationCard() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const queryClient = useQueryClient();
  const location = useCurrentFix();
  const { fix } = location;
  const home = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/home-location')),
    // No silent retries: the card shows its own Retry.
    retry: false,
  });
  const { approved, pending, last_rejected: rejected } = home.data ?? {};
  // A rejection is old news once a newer request is waiting or was approved.
  const showRejected =
    rejected &&
    time(rejected.decided_at) >= Math.max(time(pending?.created_at), time(approved?.decided_at));

  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('homeLocation.title')}
      </AppText>
      {home.isPending ? (
        <Skeleton height={space[12]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {home.isError ? (
        <Banner status="danger" icon={TriangleAlert} message={t('homeLocation.loadFailed')}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void home.refetch()}
            disabled={home.isFetching}
          />
        </Banner>
      ) : null}
      {home.data ? (
        <>
          {approved ? (
            <>
              <Badge status="success" icon={CircleCheck} label={t('homeLocation.approved')} />
              <AppText variant="small" color="muted">
                {t('homeLocation.radius', { count: approved.radius_m })}
              </AppText>
            </>
          ) : null}
          {pending ? (
            <>
              <Badge status="warning" icon={Clock} label={t('homeLocation.pending')} />
              <AppText variant="small" color="muted">
                {t('homeLocation.requested', { when: formatIst(pending.created_at) })}
              </AppText>
            </>
          ) : null}
          {approved || pending ? null : <AppText color="muted">{t('homeLocation.notSet')}</AppText>}
          {showRejected ? (
            <Banner
              status="danger"
              icon={CircleX}
              message={
                rejected.reason
                  ? t('homeLocation.rejectedBecause', { reason: rejected.reason })
                  : t('homeLocation.rejected')
              }
            />
          ) : null}
          <AppText variant="small" color="muted">
            {t('homeLocation.intro')}
          </AppText>
          <LocateButton
            state={location}
            label={t(approved || pending ? 'homeLocation.sendNew' : 'location.useCurrent')}
          />
        </>
      ) : null}
      {fix ? (
        <ConfirmDialog
          title={t('homeLocation.title')}
          message={t('homeLocation.confirm', { accuracy: Math.round(fix.accuracyM) })}
          confirmLabel={t('homeLocation.send')}
          onConfirm={async () => {
            await unwrap(
              api.POST('/api/v1/me/home-location-requests', {
                body: { lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracyM },
              }),
            );
            await queryClient.invalidateQueries({ queryKey: KEY });
          }}
          onClose={location.clear}
        />
      ) : null}
    </Card>
  );
}
