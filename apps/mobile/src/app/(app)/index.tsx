import { CircleX, Clock, LogOut, RefreshCw, TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { DeviceCard } from '@/components/device-card';
import { FaceEnrollmentCard } from '@/components/face-enrollment-card';
import { PunchCard } from '@/components/punch-card';
import { PunchQueueCard } from '@/components/punch-queue-card';
import { AppText } from '@/components/ui/app-text';
import { Avatar } from '@/components/ui/avatar';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

export default function HomeScreen() {
  const { t } = useTranslation();
  const { me, meError, refetchMe, signOut } = useAuth();
  const { space } = useTheme();
  const [checking, setChecking] = useState(false);

  async function checkAgain() {
    setChecking(true);
    try {
      await refetchMe();
    } finally {
      setChecking(false);
    }
  }

  if (!me) {
    return (
      <Screen edges={['top', 'left', 'right']} contentStyle={{ justifyContent: 'center' }}>
        {meError ? (
          <Banner status="danger" icon={TriangleAlert} message={t('home.loadFailed')} />
        ) : (
          <Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />
        )}
        <Button
          icon={RefreshCw}
          label={t('common.retry')}
          onPress={() => void checkAgain()}
          disabled={checking}
        />
        <Button variant="ghost" label={t('common.signOut')} onPress={() => void signOut()} />
      </Screen>
    );
  }

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <Avatar name={me.name} />
        <View style={{ flex: 1 }}>
          <AppText variant="small" color="muted">
            {t('home.greeting')}
          </AppText>
          <AppText variant="h2" accessibilityRole="header">
            {me.name}
          </AppText>
        </View>
      </View>
      {me.device?.status === 'pending' ? (
        <Banner
          status="warning"
          icon={Clock}
          message={
            me.device.pending_reason === 'phone_in_use'
              ? t('home.devicePendingInUse')
              : t('home.devicePending')
          }
        >
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('home.checkAgain')}
            onPress={() => void checkAgain()}
            disabled={checking}
          />
        </Banner>
      ) : null}
      {me.device?.status === 'revoked' ? (
        <Banner status="danger" icon={CircleX} message={t('home.deviceRevoked')}>
          <Button
            variant="destructive"
            icon={LogOut}
            label={t('common.signOut')}
            onPress={() => void signOut()}
          />
        </Banner>
      ) : null}
      <DeviceCard status={me.device?.status} />
      <PunchCard />
      <PunchQueueCard />
      <FaceEnrollmentCard />
    </Screen>
  );
}
