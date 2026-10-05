import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { TriangleAlert } from '@/components/icons';
import { FACE_KEY } from '@/components/face-enrollment-card';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { api } from '@/lib/api';
import { errorText, unwrap } from '@/lib/api-error';
import { useTheme } from '@/lib/theme';

const POINTS = ['collected', 'why', 'who', 'kept', 'deleted'] as const;

// FR-FACE-04: the notice must be accepted before any photo. The server records the time.
export default function FaceConsentScreen() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function agree() {
    setBusy(true);
    setFailure(null);
    try {
      await unwrap(api.POST('/api/v1/me/face-enrollment/consent'));
      await queryClient.invalidateQueries({ queryKey: FACE_KEY });
      router.replace('/face/capture');
    } catch (error) {
      setFailure(errorText(t, error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll>
      <BackButton />
      <AppText variant="h1" accessibilityRole="header">
        {t('face.consent.title')}
      </AppText>
      <AppText color="muted">{t('face.consent.intro')}</AppText>
      <Card>
        {POINTS.map((point) => (
          <View key={point} style={{ gap: space[1] }}>
            <AppText weight={600}>{t(`face.consent.${point}.title`)}</AppText>
            <AppText variant="small" color="muted">
              {t(`face.consent.${point}.body`)}
            </AppText>
          </View>
        ))}
      </Card>
      {failure ? <Banner status="danger" icon={TriangleAlert} message={failure} /> : null}
      <Button label={t('face.consent.agree')} onPress={() => void agree()} loading={busy} />
      <Button variant="ghost" label={t('face.consent.notNow')} onPress={() => router.back()} />
    </Screen>
  );
}
