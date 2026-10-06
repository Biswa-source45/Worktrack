import { useTranslation } from 'react-i18next';
import { AttendanceCalendar } from '@/components/attendance-calendar';
import { AppText } from '@/components/ui/app-text';
import { Screen } from '@/components/ui/screen';

export default function AttendanceScreen() {
  const { t } = useTranslation();

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <AppText variant="h1" accessibilityRole="header">
        {t('attendance.title')}
      </AppText>
      <AttendanceCalendar />
    </Screen>
  );
}
