import { useQuery } from '@tanstack/react-query';
import { LogOut, Monitor, Moon, Sun } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { HeroDecor } from '@/components/decor/hero-decor';
import { HomeLocationCard } from '@/components/home-location-card';
import { MySessionsCard } from '@/components/my-sessions-card';
import { AppText } from '@/components/ui/app-text';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DetailRow } from '@/components/ui/detail-row';
import { Screen } from '@/components/ui/screen';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { getDeviceInfo } from '@/lib/token-store';

export default function ProfileScreen() {
  const { t } = useTranslation();
  const { me, signOut } = useAuth();
  const { choice, setChoice, space, radius } = useTheme();
  const { data: info } = useQuery({ queryKey: ['device-info'], queryFn: getDeviceInfo });

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      {me ? (
        <>
          <Card corner="xl" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <HeroDecor corner={radius.xl} />
            <Avatar name={me.name} size={64} />
            <AppText variant="h2" accessibilityRole="header" style={{ flex: 1 }}>
              {me.name}
            </AppText>
          </Card>
          <Card>
            <AppText variant="h3" accessibilityRole="header">
              {t('profile.details')}
            </AppText>
            <DetailRow label={t('profile.employeeCode')} value={me.emp_code} />
            <DetailRow label={t('profile.designation')} value={me.designation.name} />
            <DetailRow label={t('profile.role')} value={me.role.name} />
            <DetailRow
              label={t('profile.department')}
              value={me.department?.name ?? t('profile.noDepartment')}
            />
          </Card>
        </>
      ) : null}
      <Card>
        <AppText variant="h3" accessibilityRole="header">
          {t('theme.title')}
        </AppText>
        <SegmentedControl
          value={choice}
          onChange={setChoice}
          options={[
            { value: 'light', label: t('theme.light'), icon: Sun },
            { value: 'dark', label: t('theme.dark'), icon: Moon },
            { value: 'system', label: t('theme.system'), icon: Monitor },
          ]}
        />
      </Card>
      {me ? (
        <>
          <HomeLocationCard />
          <MySessionsCard />
        </>
      ) : null}
      {/* Sign out sits last, low on the screen, in reach of the thumb. */}
      <View style={{ flexGrow: 1, justifyContent: 'flex-end', gap: space[3] }}>
        {info ? (
          <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
            {t('app.version', { version: info.app_version })}
          </AppText>
        ) : null}
        <Button
          variant="destructive"
          icon={LogOut}
          label={t('common.signOut')}
          onPress={() => void signOut()}
        />
      </View>
    </Screen>
  );
}
