import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, RefreshCw, TriangleAlert } from '@/components/icons';
import { MONTH_KEY } from '@/components/attendance-calendar';
import { TODAY_KEY } from '@/components/punch-card';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorDetail, errorText } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { cameraAvailable } from '@/lib/camera';
import { deletePhotos } from '@/lib/face-upload';
import { newRequestId, submitPunch } from '@/lib/punch';
import { currentFlow, finishAttempt, punchErrorText } from '@/lib/punch-flow';
import type { Attempt } from '@/lib/punch-queue';
import { useTheme } from '@/lib/theme';

// Loaded on demand, like the enrollment camera: Expo Go has no native camera module.
const FaceCamera = lazy(
  async () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/components/face-camera') as typeof import('@/components/face-camera'),
);

type Failure = { message: string; detail: string | null };

/** The punch selfie: one photo, sent at once, then the result screen. */
export default function PunchCaptureScreen() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const flow = currentFlow();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The selfie on this phone until it is sent, sealed into the queue, retaken or left behind.
  const held = useRef<string[]>([]);
  const discard = (uri: string) => {
    held.current = held.current.filter((held) => held !== uri);
    deletePhotos([uri]);
  };
  useEffect(
    () => () => {
      deletePhotos(held.current);
    },
    [],
  );

  // Opened without a punch in progress (a restored screen): back to Home, where it starts.
  useEffect(() => {
    if (!flow) router.replace('/');
  }, [flow, router]);

  if (!cameraAvailable) {
    return (
      <Screen>
        <BackButton />
        <Banner status="info" icon={Info} message={t('punch.devBuild.body')} />
        <AppText variant="h3" accessibilityRole="header">
          {t('face.devBuild.title')}
        </AppText>
      </Screen>
    );
  }
  if (!flow || !me) return null;

  async function send(current: Attempt) {
    setSending(true);
    setFailure(null);
    try {
      const sent = await submitPunch(current);
      discard(current.selfieUri);
      finishAttempt(
        sent.type === 'sent'
          ? { type: 'sent', kind: current.kind, result: sent.result }
          : { type: 'queued', kind: current.kind },
      );
      // Home and the history read the new state when they are shown; no need to wait for it.
      void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
      void queryClient.invalidateQueries({ queryKey: MONTH_KEY });
      router.replace('/punch/result');
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        // The server said no: nothing more to send, the result screen shows its words.
        discard(current.selfieUri);
        finishAttempt({ type: 'rejected', error });
        router.replace('/punch/result');
        return;
      }
      // A failing server or an unexpected error: the photo and the key are kept, so a retry
      // is the same punch and cannot count twice.
      setFailure({
        message: error instanceof ApiError ? punchErrorText(t, error) : errorText(t, error),
        detail: errorDetail(error),
      });
      console.warn('[punch-send]', error);
    } finally {
      setSending(false);
    }
  }

  function onPhoto(uri: string) {
    if (!flow || !me) return;
    held.current.push(uri);
    const taken: Attempt = {
      id: newRequestId(),
      userId: me.id,
      kind: flow.kind,
      selfieUri: uri,
      lat: flow.fix.lat,
      lng: flow.fix.lng,
      accuracyM: flow.fix.accuracyM,
      mocked: flow.fix.mocked,
      emulator: flow.integrity.emulator,
      rooted: flow.integrity.rooted,
      // The moment the photo was taken, on the phone's clock: kept for the audit, and the time an
      // offline punch carries. The server's own clock decides what counts.
      deviceTime: new Date().toISOString(),
      reason: flow.reason,
      note: flow.note,
    };
    setAttempt(taken);
    void send(taken);
  }

  if (attempt && failure && !sending) {
    return (
      <Screen scroll>
        <BackButton />
        <Banner status="danger" icon={TriangleAlert} message={failure.message} />
        {failure.detail ? (
          <AppText variant="caption" color="muted" selectable>
            {failure.detail}
          </AppText>
        ) : null}
        <Button
          icon={RefreshCw}
          label={t('punch.capture.tryAgain')}
          onPress={() => void send(attempt)}
        />
        <Button
          variant="secondary"
          label={t('punch.capture.retake')}
          onPress={() => {
            discard(attempt.selfieUri);
            setAttempt(null);
            setFailure(null);
          }}
        />
      </Screen>
    );
  }

  if (attempt) {
    return (
      <Screen contentStyle={{ justifyContent: 'center' }}>
        <AppText variant="large" weight={600} accessibilityLiveRegion="polite">
          {t('punch.capture.sending')}
        </AppText>
        <Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />
      </Screen>
    );
  }

  return (
    <Suspense fallback={<Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />}>
      <FaceCamera single onPhoto={onPhoto} />
    </Suspense>
  );
}
