import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { getDeviceInfo } from '@/lib/token-store';

const GLYPHS = { active: '✓', pending: '⏳', revoked: '✕' } as const;
type Status = keyof typeof GLYPHS;

// Status is the server's verdict (me.device); model/OS/version are read locally. The device id is
// deliberately not shown.
export function DeviceCard({ status }: { status: string | undefined }) {
  const { t } = useTranslation();
  const { data: info } = useQuery({ queryKey: ['device-info'], queryFn: getDeviceInfo });
  const known = status && status in GLYPHS ? (status as Status) : null;
  const label = known ? t(`home.deviceStatus.${known}`) : t('home.deviceStatus.unregistered');
  const rows: [string, string | undefined][] = [
    [t('home.deviceModel'), info?.model],
    [t('home.deviceOs'), info?.os],
    [t('home.deviceVersion'), info?.app_version],
  ];

  return (
    <View
      testID="device-card"
      style={{ borderWidth: 1, borderColor: '#ccc', padding: 12, borderRadius: 6, gap: 8 }}
    >
      <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '600' }}>
        {t('home.deviceTitle')}
      </Text>
      <Text
        testID="device-status"
        accessibilityLabel={t('home.deviceStatusA11y', { status: label })}
        style={{ fontWeight: '600' }}
      >
        {known ? `${GLYPHS[known]} ${label}` : label}
      </Text>
      {known === 'pending' ? <Text>{t('home.deviceCannotPunch')}</Text> : null}
      {rows.map(([name, value]) => (
        <View key={name}>
          <Text style={{ color: '#666' }}>{name}</Text>
          <Text style={{ fontSize: 18 }}>{value ?? '…'}</Text>
        </View>
      ))}
    </View>
  );
}
