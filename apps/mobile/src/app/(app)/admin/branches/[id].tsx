import { useQuery } from '@tanstack/react-query';
import { CircleCheck, RefreshCw, TriangleAlert } from '@/components/icons';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { BranchStatus } from '@/components/admin/branches-section';
import { useAdminAction } from '@/components/admin/use-admin-action';
import { LocateButton, useCurrentFix } from '@/components/locate-button';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DetailRow } from '@/components/ui/detail-row';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { errorText, unwrap } from '@/lib/api-error';
import { useTheme } from '@/lib/theme';

export default function BranchScreen() {
  const { t } = useTranslation();
  const run = useAdminAction();
  const { space } = useTheme();
  const path = { branch_id: Number(useLocalSearchParams<{ id: string }>().id) };
  const location = useCurrentFix();
  const [moved, setMoved] = useState(false);

  const query = useQuery({
    queryKey: ['admin', 'branch', path.branch_id],
    queryFn: () => unwrap(api.GET('/api/v1/admin/branches/{branch_id}', { params: { path } })),
    // No silent retries: a 403 shows at once, and Retry is on screen.
    retry: false,
  });
  const branch = query.data;
  const { fix } = location;

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <BackButton />

      {query.isPending ? (
        <Card>
          <Skeleton width="60%" height={space[6]} accessibilityLabel={t('common.loading')} />
          <Skeleton />
          <Skeleton width="80%" />
        </Card>
      ) : null}
      {query.isError ? (
        <Banner status="danger" icon={TriangleAlert} message={errorText(t, query.error)}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void query.refetch()}
            disabled={query.isFetching}
          />
        </Banner>
      ) : null}

      {branch ? (
        <>
          <AppText variant="h2" accessibilityRole="header">
            {branch.name}
          </AppText>
          <BranchStatus branch={branch} />

          <Card>
            <DetailRow
              label={t('branches.address')}
              value={branch.address ?? t('branches.noAddress')}
            />
            <DetailRow
              label={t('branches.radius')}
              value={t('branches.metres', { count: branch.radius_m })}
            />
            <DetailRow
              label={t('branches.centre')}
              value={`${branch.lat.toFixed(5)}, ${branch.lng.toFixed(5)}`}
            />
          </Card>

          {/* The action sits last, low on the screen, in reach of the thumb. */}
          <View style={{ flexGrow: 1, justifyContent: 'flex-end', gap: space[3] }}>
            {moved ? (
              <Banner status="success" icon={CircleCheck} message={t('branches.moved')} />
            ) : null}
            <LocateButton state={location} label={t('location.useCurrent')} />
          </View>

          {fix ? (
            <ConfirmDialog
              title={t('branches.moveTitle')}
              message={t('branches.moveConfirm', {
                name: branch.name,
                accuracy: Math.round(fix.accuracyM),
              })}
              confirmLabel={t('branches.move')}
              onConfirm={async () => {
                setMoved(false);
                await run(
                  api.PATCH('/api/v1/admin/branches/{branch_id}', {
                    params: { path },
                    body: { lat: fix.lat, lng: fix.lng },
                  }),
                );
                setMoved(true);
              }}
              onClose={location.clear}
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
