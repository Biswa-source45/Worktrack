import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Image, View } from 'react-native';
import { z } from 'zod';
import { ImagePlus, Send, TriangleAlert, X } from '@/components/icons';
import { PhotoCamera } from '@/components/photo-camera';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { deletePhotos } from '@/lib/face-upload';
import type { TaskAction } from '@/lib/punch-queue';
import { fetchTask, taskErrorDetail, taskErrorText, taskKey } from '@/lib/tasks';
import { useTheme } from '@/lib/theme';
import { useTaskAction } from '@/lib/use-task-action';

type Mode = 'note' | 'comment' | 'complete';

// What each form sends: the server's action, the text field it expects, the photo part and the
// most photos it takes. The limits mirror the server's; the server enforces them too.
const MODES: Record<
  Mode,
  { action: TaskAction; field: string; part: string; maxPhotos: number; maxText: number }
> = {
  note: { action: 'notes', field: 'note', part: 'photo', maxPhotos: 1, maxText: 1000 },
  comment: { action: 'comments', field: 'body', part: 'photo', maxPhotos: 1, maxText: 2000 },
  complete: { action: 'complete', field: 'remarks', part: 'photos', maxPhotos: 5, maxText: 1000 },
};

const schema = z.object({ text: z.string().trim().min(1, 'validation.required') });
type Values = z.infer<typeof schema>;

/** Writes a note, a comment or the completion remarks, with photos taken on the spot. */
export default function ComposeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { space, radius, colors } = useTheme();
  const params = useLocalSearchParams<{ id: string; mode: string }>();
  const id = Number(params.id);
  const mode: Mode = params.mode === 'comment' || params.mode === 'complete' ? params.mode : 'note';
  const spec = MODES[mode];
  const run = useTaskAction(id);
  const task = useQuery({ queryKey: taskKey(id), queryFn: () => fetchTask(id), retry: false });
  // The task type's proof rule: completing may need at least one proof or receipt photo.
  const proofKind = task.data?.type.proof_kind ?? 'photo';
  const minPhotos = mode === 'complete' && task.data?.type.proof_photo_required ? 1 : 0;

  const [photos, setPhotos] = useState<string[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [problem, setProblem] = useState<{ message: string; detail?: string } | null>(null);
  // The photos on this phone until they are sent, sealed into the queue, removed or left behind.
  const latest = useRef<string[]>([]);
  useEffect(() => {
    latest.current = photos;
  }, [photos]);
  useEffect(
    () => () => {
      deletePhotos(latest.current);
    },
    [],
  );

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { text: '' } });

  function add(uri: string) {
    setPhotos((list) => [...list, uri]);
    setCapturing(false);
  }
  function remove(uri: string) {
    deletePhotos([uri]);
    setPhotos((list) => list.filter((item) => item !== uri));
  }

  const submit = handleSubmit(async ({ text }) => {
    setProblem(null);
    if (photos.length < minPhotos) {
      setProblem({
        message: t(
          proofKind === 'receipt' ? 'tasks.errors.receiptRequired' : 'tasks.errors.proofRequired',
        ),
      });
      return;
    }
    try {
      await run(
        spec.action,
        { [spec.field]: text },
        photos.map((uri) => ({ part: spec.part, uri })),
      );
      // Sent or saved on the phone: either way the cache copies are done with.
      deletePhotos(photos);
      setPhotos([]);
      router.back();
    } catch (error) {
      // The photos stay, and a retry is the same send under the same key.
      console.warn('[task-compose]', error);
      setProblem({ message: taskErrorText(t, error), detail: taskErrorDetail(error) });
    }
  });

  if (capturing) return <PhotoCamera onPhoto={add} onCancel={() => setCapturing(false)} />;

  const photoLabel = t(
    proofKind === 'receipt' && mode === 'complete'
      ? 'tasks.compose.receipts'
      : 'tasks.compose.photos',
  );
  return (
    <Screen scroll>
      <BackButton />
      <AppText variant="h1" accessibilityRole="header">
        {t(`tasks.compose.${mode}.title`)}
      </AppText>
      {task.data ? (
        <AppText color="muted">
          {task.data.code} · {task.data.title}
        </AppText>
      ) : null}
      <Controller
        control={control}
        name="text"
        render={({ field }) => (
          <Field
            label={t(`tasks.compose.${mode}.label`)}
            error={errors.text && t(errors.text.message ?? 'validation.required')}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            autoCapitalize="sentences"
            multiline
            maxLength={spec.maxText}
          />
        )}
      />
      <View style={{ gap: space[2] }}>
        <AppText variant="small" weight={500}>
          {photoLabel}
          {minPhotos > 0 ? ` (${t('tasks.compose.required')})` : ''}
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
          {photos.map((uri, index) => (
            <View key={uri} style={{ gap: space[1], alignItems: 'center' }}>
              <Image
                source={{ uri }}
                accessibilityLabel={t('tasks.compose.photoN', { n: index + 1 })}
                style={{
                  width: space[16] + space[8],
                  height: space[16] + space[8],
                  borderRadius: radius.md,
                  backgroundColor: colors.raised,
                }}
              />
              <Button
                variant="ghost"
                icon={X}
                label={t('tasks.compose.remove')}
                accessibilityLabel={t('tasks.compose.removeN', { n: index + 1 })}
                onPress={() => remove(uri)}
                disabled={isSubmitting}
              />
            </View>
          ))}
        </View>
        {photos.length < spec.maxPhotos ? (
          <Button
            variant="secondary"
            icon={ImagePlus}
            label={t('tasks.compose.addPhoto')}
            onPress={() => setCapturing(true)}
            disabled={isSubmitting}
          />
        ) : null}
      </View>
      {problem ? (
        <>
          <Banner status="danger" icon={TriangleAlert} message={problem.message} />
          {problem.detail ? (
            <AppText variant="caption" color="muted" selectable>
              {problem.detail}
            </AppText>
          ) : null}
        </>
      ) : null}
      <Button
        icon={Send}
        label={t(`tasks.compose.${mode}.send`)}
        onPress={() => void submit()}
        loading={isSubmitting}
      />
      {isSubmitting ? (
        <AppText variant="small" color="muted" accessibilityLiveRegion="polite">
          {t('tasks.working')}
        </AppText>
      ) : null}
    </Screen>
  );
}
