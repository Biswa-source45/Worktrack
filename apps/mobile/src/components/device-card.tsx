import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleMinus, CircleX, Clock } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DetailRow } from '@/components/ui/detail-row';
import { AppText } from '@/components/ui/app-text';
import { getDeviceInfo } from '@/lib/token-store';

const LOOKS = {
  active: { badge: 'success', icon: CircleCheck },
  pending: { badge: 'warning', icon: Clock },
  revoked: { badge: 'danger', icon: CircleX },
  unregistered: { badge: 'neutral', icon: CircleMinus },
} as const;
type Status = keyof typeof LOOKS;

// Status is the server's verdict (me.device); model/OS/version are read locally. The device id is
// deliberately not shown.
export function DeviceCard({ status }: { status: string | undefined }) {
  const { t } = useTranslation();
  const { data: info } = useQuery({ queryKey: ['device-info'], queryFn: getDeviceInfo });
  const known: Status = status && status in LOOKS ? (status as Status) : 'unregistered';
  const label = t(`home.deviceStatus.${known}`);
  const rows: [string, string | undefined][] = [
    [t('home.deviceModel'), info?.model],
    [t('home.deviceOs'), info?.os],
    [t('home.deviceVersion'), info?.app_version],
  ];

  return (
    <Card testID="device-card">
      <AppText variant="h3" accessibilityRole="header">
        {t('home.deviceTitle')}
      </AppText>
      <Badge
        testID="device-status"
        iconTestID={`device-status-icon-${known}`}
        status={LOOKS[known].badge}
        icon={LOOKS[known].icon}
        label={label}
        accessibilityLabel={t('home.deviceStatusA11y', { status: label })}
      />
      {known === 'pending' ? (
        <AppText variant="small" color="muted">
          {t('home.deviceCannotPunch')}
        </AppText>
      ) : null}
      {rows.map(([name, value]) => (
        <DetailRow key={name} label={name} value={value ?? '…'} />
      ))}
    </Card>
  );
}
