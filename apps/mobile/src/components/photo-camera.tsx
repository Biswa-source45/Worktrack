import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { cameraAvailable } from '@/lib/camera';
import { useTheme } from '@/lib/theme';

// Loaded on demand: Expo Go has no native camera module.
const PhotoCameraView = lazy(
  async () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/components/photo-camera-native') as typeof import('@/components/photo-camera-native'),
);

type Props = {
  /** A file in this phone's cache. Whoever receives it deletes it (deletePhotos) once it is sent. */
  onPhoto: (uri: string) => void;
};

/** Full-screen back camera with a shutter button, for task photos. */
export function PhotoCamera({ onPhoto }: Props) {
  const { t } = useTranslation();
  const { space } = useTheme();
  if (!cameraAvailable) {
    return (
      <Screen>
        <BackButton />
        <Banner status="info" icon={Info} message={t('photo.devBuild')} />
        <AppText variant="h3" accessibilityRole="header">
          {t('face.devBuild.title')}
        </AppText>
      </Screen>
    );
  }
  return (
    <Suspense fallback={<Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />}>
      <PhotoCameraView onPhoto={onPhoto} />
    </Suspense>
  );
}
