import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  CircleCheck,
  CircleX,
  Clock,
  RefreshCw,
  ScanFace,
  TriangleAlert,
} from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { formatIst } from '@/lib/ist';
import { useTheme } from '@/lib/theme';

export const FACE_KEY = ['my-face-enrollment'];
const WAITING_REFRESH_MS = 15_000;

/** How long to wait before asking again: only while an admin still has to decide. */
export const waitingRefresh = (status: string | undefined) =>
  status === 'pending' ? WAITING_REFRESH_MS : false;

const LOOK = {
  none: { status: 'neutral', icon: ScanFace },
  consented: { status: 'warning', icon: Clock },
  pending: { status: 'warning', icon: Clock },
  approved: { status: 'success', icon: CircleCheck },
  rejected: { status: 'danger', icon: CircleX },
  reset: { status: 'warning', icon: TriangleAlert },
} as const;

/** Where the employee's face enrollment stands, and the next step when there is one. */
export function FaceEnrollmentCard() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const router = useRouter();
  const enrollment = useQuery({
    queryKey: FACE_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/face-enrollment')),
    // No silent retries: the card shows its own Retry.
    retry: false,
    // While an admin has to decide, look again now and then: the phone is usually in hand while
    // the admin acts on the web, and nothing else would tell the employee.
    refetchInterval: (query) => waitingRefresh(query.state.data?.status),
  });
  const data = enrollment.data;
  const look = data ? LOOK[data.status] : null;

  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('face.title')}
      </AppText>
      {enrollment.isPending ? (
        <Skeleton height={space[12]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {enrollment.isError ? (
        <Banner status="danger" icon={TriangleAlert} message={t('face.loadFailed')}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void enrollment.refetch()}
            disabled={enrollment.isFetching}
          />
        </Banner>
      ) : null}
      {data && look ? (
        <>
          <Badge
            status={look.status}
            icon={look.icon}
            label={t(`face.status.${data.status}`)}
            testID="face-status"
          />
          {data.status === 'none' ? (
            <AppText variant="small" color="muted">
              {t('face.intro')}
            </AppText>
          ) : null}
          {data.status === 'consented' ? (
            <AppText variant="small" color="muted">
              {t('face.consentedBody')}
            </AppText>
          ) : null}
          {data.status === 'pending' && data.submitted_at ? (
            <AppText variant="small" color="muted">
              {t('face.pendingBody', { when: formatIst(data.submitted_at) })}
            </AppText>
          ) : null}
          {data.status === 'approved' ? (
            <AppText variant="small" color="muted">
              {t('face.approvedBody')}
            </AppText>
          ) : null}
          {data.status === 'rejected' || data.status === 'reset' ? (
            <Banner
              status={data.status === 'rejected' ? 'danger' : 'warning'}
              icon={data.status === 'rejected' ? CircleX : TriangleAlert}
              message={
                data.reason
                  ? t(`face.${data.status}Because`, { reason: data.reason })
                  : t(`face.${data.status}`)
              }
            />
          ) : null}
          {data.status === 'none' ? (
            <Button
              icon={ScanFace}
              label={t('face.setUp')}
              onPress={() => router.push('/face/consent')}
            />
          ) : null}
          {data.status === 'consented' ? (
            <Button label={t('face.continue')} onPress={() => router.push('/face/capture')} />
          ) : null}
          {data.status === 'rejected' || data.status === 'reset' ? (
            <Button label={t('face.again')} onPress={() => router.push('/face/consent')} />
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
