import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, View } from 'react-native';
import { CircleCheck, Info, TriangleAlert } from '@/components/icons';
import { FACE_KEY } from '@/components/face-enrollment-card';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorDetail, errorText } from '@/lib/api-error';
import { cameraAvailable } from '@/lib/camera';
import type { Step, Turn } from '@/lib/face-guidance';
import { sendPhotos } from '@/lib/face-upload';
import { useTheme } from '@/lib/theme';

// Loaded on demand: the module pulls in the native camera, which Expo Go does not have, so
// nothing may evaluate it until the camera is really needed. `require` runs when called;
// a dynamic import() would also work in Metro but not in Jest.
const FaceCamera = lazy(
  async () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/components/face-camera') as typeof import('@/components/face-camera'),
);

const PHOTOS = 3;
type Photos = (string | null)[];
const EMPTY: Photos = Array<string | null>(PHOTOS).fill(null);
const ISSUES = [
  'NO_FACE',
  'MULTIPLE_FACES',
  'LOW_CONFIDENCE',
  'FACE_TOO_SMALL',
  'BLURRY',
  'TOO_DARK',
  'TOO_BRIGHT',
  'UNREADABLE_IMAGE',
];

/** The photos the server named: `{ photos: [{ index, code }] }` from a FACE_QUALITY answer. */
function flaggedPhotos(error: ApiError): Record<number, string> {
  const photos = (error.details as { photos?: { index: number; code: string }[] } | null)?.photos;
  return Object.fromEntries((photos ?? []).map(({ index, code }) => [index, code]));
}

export default function FaceCaptureScreen() {
  const { t } = useTranslation();
  const { space, colors, radius } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [photos, setPhotos] = useState<Photos>(EMPTY);
  const [firstTurn, setFirstTurn] = useState<Turn>(0);
  const [flagged, setFlagged] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The status or error behind a failure the app cannot explain better, for the employee to report.
  const [detail, setDetail] = useState<string | null>(null);
  // The three photos did not look like one person: only retaking all of them helps.
  const [inconsistent, setInconsistent] = useState(false);
  const [sent, setSent] = useState(false);

  if (!cameraAvailable) {
    return (
      <Screen>
        <BackButton />
        <Banner status="info" icon={Info} message={t('face.devBuild.body')} />
        <AppText variant="h3" accessibilityRole="header">
          {t('face.devBuild.title')}
        </AppText>
      </Screen>
    );
  }

  const next = photos.findIndex((uri) => uri === null);
  const retake = (index: number) => {
    setPhotos((all) => all.map((uri, i) => (i === index ? null : uri)));
    setFlagged(({ [index]: _gone, ...rest }) => rest);
    setFailure(null);
  };
  const retakeAll = () => {
    setPhotos(EMPTY);
    setFirstTurn(0);
    setFlagged({});
    setFailure(null);
    setInconsistent(false);
  };

  async function send() {
    setBusy(true);
    setFailure(null);
    setDetail(null);
    setInconsistent(false);
    try {
      await sendPhotos(photos as string[]);
      await queryClient.invalidateQueries({ queryKey: FACE_KEY });
      setSent(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FACE_QUALITY') {
        const marked = flaggedPhotos(error);
        setFlagged(marked);
        // Without a photo to point at, say what the server said instead of an empty instruction.
        setFailure(
          Object.keys(marked).length > 0 ? t('face.review.fixPhotos') : errorText(t, error),
        );
      } else if (error instanceof ApiError && error.code === 'FACE_INCONSISTENT') {
        setInconsistent(true);
        setFailure(t('face.review.inconsistent'));
      } else if (error instanceof ApiError && error.code === 'CONSENT_REQUIRED') {
        router.replace('/face/consent');
      } else {
        setFailure(errorText(t, error));
        setDetail(errorDetail(error));
        console.warn('[face-send]', error);
      }
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Screen>
        <Banner status="success" icon={CircleCheck} message={t('face.review.sent')} />
        <Button label={t('face.review.done')} onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  if (next !== -1) {
    return (
      <Suspense fallback={<Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />}>
        <FaceCamera
          step={next as Step}
          firstTurn={firstTurn}
          onPhoto={(uri, turn) => {
            setPhotos((all) => all.map((existing, i) => (i === next ? uri : existing)));
            if (next === 1) setFirstTurn(turn);
          }}
        />
      </Suspense>
    );
  }

  const hasFlags = Object.keys(flagged).length > 0;
  return (
    <Screen scroll>
      <BackButton />
      <AppText variant="h1" accessibilityRole="header">
        {t('face.review.title')}
      </AppText>
      <AppText color="muted">{t('face.review.intro')}</AppText>
      {failure ? <Banner status="danger" icon={TriangleAlert} message={failure} /> : null}
      {detail ? (
        <AppText variant="caption" color="muted" selectable>
          {detail}
        </AppText>
      ) : null}
      {photos.map((uri, index) => (
        <Card key={index}>
          <View style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
            <Image
              source={{ uri: uri ?? undefined }}
              accessibilityLabel={t('face.review.photoLabel', { n: index + 1 })}
              style={{
                width: 96,
                height: 96,
                borderRadius: radius.md,
                backgroundColor: colors.raised,
              }}
            />
            <View style={{ flex: 1, gap: space[1] }}>
              <AppText weight={600}>{t('face.review.photoLabel', { n: index + 1 })}</AppText>
              {flagged[index] ? (
                <AppText variant="small" color="dangerFg" accessibilityRole="alert">
                  {t(
                    `face.issue.${ISSUES.includes(flagged[index]) ? flagged[index] : 'UNREADABLE_IMAGE'}`,
                  )}
                </AppText>
              ) : null}
            </View>
          </View>
          <Button
            variant="secondary"
            label={t('face.review.retake')}
            accessibilityLabel={t('face.review.retakeN', { n: index + 1 })}
            onPress={() => retake(index)}
            disabled={busy}
          />
        </Card>
      ))}
      {inconsistent ? (
        <Button variant="secondary" label={t('face.review.retakeAll')} onPress={retakeAll} />
      ) : null}
      <Button
        label={t('face.review.send')}
        onPress={() => void send()}
        loading={busy}
        disabled={hasFlags}
      />
    </Screen>
  );
}
