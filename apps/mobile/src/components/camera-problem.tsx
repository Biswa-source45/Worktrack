import { useTranslation } from 'react-i18next';
import { TriangleAlert } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';

type Props = {
  /** What the camera library reported, so a failure can be told to someone who can fix it. */
  detail: string;
  onRetry: () => void;
  /** What the back arrow does when it is not just leaving the screen. */
  onBack?: () => void;
};

/** Shown instead of a black camera when the camera does not start or stops with an error. */
export function CameraProblem({ detail, onRetry, onBack }: Props) {
  const { t } = useTranslation();
  return (
    <Screen>
      <BackButton onPress={onBack} />
      <Banner status="danger" icon={TriangleAlert} message={t('face.camera.problemTitle')} />
      <AppText color="muted">{t('face.camera.problemBody')}</AppText>
      {detail ? (
        <AppText variant="caption" color="muted" selectable>
          {detail}
        </AppText>
      ) : null}
      <Button label={t('face.camera.tryAgain')} onPress={onRetry} />
    </Screen>
  );
}
