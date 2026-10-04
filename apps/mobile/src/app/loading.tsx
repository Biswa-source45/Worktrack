import { useTranslation } from 'react-i18next';
import { HeroDecor } from '@/components/decor/hero-decor';
import { AppText } from '@/components/ui/app-text';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { useTheme } from '@/lib/theme';

export default function LoadingScreen() {
  const { t } = useTranslation();
  const { space } = useTheme();
  return (
    <Screen contentStyle={{ alignItems: 'center', justifyContent: 'center' }}>
      <HeroDecor />
      <AppText variant="h2">{t('app.title')}</AppText>
      <Skeleton width={space[16] * 2} height={space[2]} accessibilityLabel={t('common.loading')} />
    </Screen>
  );
}
