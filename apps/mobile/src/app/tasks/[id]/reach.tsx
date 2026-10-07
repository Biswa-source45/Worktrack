import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { z } from 'zod';
import {
  Camera,
  CircleCheck,
  Info,
  MapPin,
  RefreshCw,
  TriangleAlert,
  WifiOff,
} from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { cameraAvailable } from '@/lib/camera';
import { deletePhotos } from '@/lib/face-upload';
import { currentReach, endReach } from '@/lib/task-flow';
import { taskErrorDetail, taskErrorText } from '@/lib/tasks';
import type { TaskDetail } from '@/lib/tasks';
import { useTheme } from '@/lib/theme';
import { useTaskAction } from '@/lib/use-task-action';

// Loaded on demand, like the punch camera: Expo Go has no native camera module.
const FaceCamera = lazy(
  async () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/components/face-camera') as typeof import('@/components/face-camera'),
);

const schema = z.object({
  reason: z.string().trim().min(3, 'tasks.reason.min').max(200, 'tasks.reason.max'),
});
type Values = z.infer<typeof schema>;

type View_ =
  | { type: 'camera' }
  | { type: 'sending' }
  | { type: 'failed'; message: string; detail: string; retry: boolean; retake: boolean }
  | { type: 'outside'; distance: number | null; radius: number | null }
  | { type: 'done'; saved: boolean; review: boolean };

const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);

/** Whether the server sent this Reached for review (a far position or a face to check). */
function needsReview(task: TaskDetail, userId: number) {
  const reach = task.assignees.find((assignee) => assignee.user.id === userId)?.reach;
  return !!reach && (reach.flags.length > 0 || reach.review === 'pending');
}

/** The selfie at the site, sent with the position. Outside the radius the reason is asked for. */
export default function ReachScreen() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const router = useRouter();
  const { me } = useAuth();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const flow = currentReach();
  const run = useTaskAction(id);
  const [view, setView] = useState<View_>({ type: 'camera' });
  // The selfie on this phone until it is sent, sealed into the queue, retaken or left behind.
  const [selfie, setSelfie] = useState<string | null>(null);
  // Whenever the selfie changes or the screen closes, the file it was is deleted (D68).
  useEffect(
    () => () => {
      if (selfie) deletePhotos([selfie]);
    },
    [selfie],
  );
  useEffect(() => endReach, []);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });

  // Opened without a Reached in progress (a restored screen): back to the task, where it starts.
  const orphaned = !flow || flow.taskId !== id;
  useEffect(() => {
    if (orphaned) router.replace(`/tasks/${id}` as Href);
  }, [id, orphaned, router]);

  if (!cameraAvailable) {
    return (
      <Screen>
        <BackButton />
        <Banner status="info" icon={Info} message={t('tasks.reach.devBuild')} />
        <AppText variant="h3" accessibilityRole="header">
          {t('face.devBuild.title')}
        </AppText>
      </Screen>
    );
  }
  if (orphaned || !me) return null;

  async function send(uri: string, mismatchReason?: string) {
    if (!flow || !me) return;
    setView({ type: 'sending' });
    const { fix, integrity } = flow;
    try {
      const sent = await run(
        'reached',
        {
          lat: String(fix.lat),
          lng: String(fix.lng),
          accuracy_m: String(fix.accuracyM),
          mocked: String(fix.mocked),
          emulator: String(integrity.emulator),
          rooted: String(integrity.rooted),
          ...(mismatchReason ? { mismatch_reason: mismatchReason } : {}),
        },
        [{ part: 'selfie', uri }],
      );
      setSelfie(null);
      setView({
        type: 'done',
        saved: sent.type === 'queued',
        review: sent.type === 'sent' && needsReview(sent.task, me.id),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OUTSIDE_SITE') {
        const details = (error.details ?? {}) as Record<string, unknown>;
        setView({
          type: 'outside',
          distance: asNumber(details.distance_m),
          radius: asNumber(details.radius_m),
        });
        return;
      }
      console.warn('[task-reach]', error);
      // The server said no for good (4xx): the selfie is not needed any more. A failing server or
      // an unexpected error keeps it, and a retry is the same Reached under the same key.
      const final = error instanceof ApiError && error.status < 500;
      if (final) setSelfie(null);
      setView({
        type: 'failed',
        message: taskErrorText(t, error),
        detail: taskErrorDetail(error),
        retry: !final,
        // Only a bad photo is cured by another one; any other refusal would answer the same again.
        retake: !final || (error instanceof ApiError && error.code === 'FACE_RETAKE'),
      });
    }
  }

  function onPhoto(uri: string) {
    setSelfie(uri);
    void send(uri);
  }

  const submitMismatch = handleSubmit(({ reason }) => {
    if (selfie) void send(selfie, reason);
  });

  const back = () => router.back();

  if (view.type === 'camera') {
    return (
      <Suspense fallback={<Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />}>
        <FaceCamera single onPhoto={onPhoto} />
      </Suspense>
    );
  }

  if (view.type === 'sending') {
    return (
      <Screen contentStyle={{ justifyContent: 'center' }}>
        <AppText variant="large" weight={600} accessibilityLiveRegion="polite">
          {t('tasks.reach.sending')}
        </AppText>
        <Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />
        <AppText variant="small" color="muted">
          {t('tasks.working')}
        </AppText>
      </Screen>
    );
  }

  if (view.type === 'done') {
    return (
      <Screen contentStyle={{ justifyContent: 'center' }}>
        <Banner
          status={view.saved ? 'info' : view.review ? 'warning' : 'success'}
          icon={view.saved ? WifiOff : view.review ? TriangleAlert : CircleCheck}
          message={t(
            view.saved
              ? 'tasks.reach.saved'
              : view.review
                ? 'tasks.reach.review'
                : 'tasks.reach.done',
          )}
        />
        <Button label={t('tasks.reach.backToTask')} onPress={back} />
      </Screen>
    );
  }

  if (view.type === 'outside') {
    return (
      <Screen scroll>
        <BackButton />
        <Banner
          status="warning"
          icon={MapPin}
          message={
            view.distance !== null && view.radius !== null
              ? t('tasks.reach.outside', {
                  distance: Math.round(view.distance),
                  radius: view.radius,
                })
              : t('tasks.reach.outsideNoNumbers')
          }
        />
        <AppText color="muted">{t('tasks.reach.outsideHelp')}</AppText>
        <Controller
          control={control}
          name="reason"
          render={({ field }) => (
            <Field
              label={t('tasks.reach.reasonLabel')}
              error={errors.reason && t(errors.reason.message ?? 'validation.required')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              autoCapitalize="sentences"
              maxLength={200}
            />
          )}
        />
        <Button
          icon={Camera}
          label={t('tasks.reach.submitOutside')}
          onPress={() => void submitMismatch()}
        />
        <Button variant="ghost" label={t('tasks.reach.backToTask')} onPress={back} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <BackButton />
      <Banner status="danger" icon={TriangleAlert} message={view.message} />
      <AppText variant="caption" color="muted" selectable>
        {view.detail}
      </AppText>
      <View style={{ gap: space[3] }}>
        {view.retry && selfie ? (
          <Button
            icon={RefreshCw}
            label={t('punch.capture.tryAgain')}
            onPress={() => void send(selfie)}
          />
        ) : null}
        {view.retake ? (
          <Button
            variant={view.retry ? 'secondary' : 'primary'}
            icon={Camera}
            label={t('punch.result.takeAgain')}
            onPress={() => {
              setSelfie(null);
              setView({ type: 'camera' });
            }}
          />
        ) : null}
        <Button variant="ghost" label={t('tasks.reach.backToTask')} onPress={back} />
      </View>
    </Screen>
  );
}
