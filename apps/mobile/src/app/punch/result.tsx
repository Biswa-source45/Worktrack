import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Camera, CircleCheck, CircleX, TriangleAlert, WifiOff } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { formatIstTime } from '@/lib/ist';
import { currentOutcome, endFlow, punchErrorText } from '@/lib/punch-flow';
import type { Outcome } from '@/lib/punch-flow';
import { useTheme } from '@/lib/theme';
import type { ColorRole } from '@/lib/theme';

type Tone = 'success' | 'warning' | 'danger' | 'info';
type Look = { tone: Tone; icon: LucideIcon; title: string; lines: string[] };

/** What the screen says about an outcome. Never a face score, never the word mismatch. */
function describe(t: ReturnType<typeof useTranslation>['t'], outcome: Outcome): Look {
  if (outcome.type === 'queued') {
    return {
      tone: 'info',
      icon: WifiOff,
      title: t('punch.result.queuedTitle'),
      lines: [t('punch.result.queued')],
    };
  }
  if (outcome.type === 'rejected') {
    return {
      tone: 'danger',
      icon: CircleX,
      title: t('punch.result.rejectedTitle'),
      lines: [punchErrorText(t, outcome.error)],
    };
  }
  const { kind, result } = outcome;
  if (kind === 'request') {
    return {
      tone: 'warning',
      icon: TriangleAlert,
      title: t('punch.result.requestTitle'),
      lines: [t('punch.result.request')],
    };
  }
  if (result.result === 'in_review') {
    return {
      tone: 'warning',
      icon: TriangleAlert,
      title: t('punch.result.reviewTitle'),
      lines: [t('punch.result.review')],
    };
  }
  const lines = [t('punch.result.countedAt', { time: formatIstTime(result.punch.time) })];
  if (result.punch.place.type === 'task' && result.punch.place.task) {
    lines.push(t('punch.fieldPunch', { code: result.punch.place.task }));
  }
  if (kind === 'in' && result.day.late_minutes > 0) {
    lines.push(t('punch.result.late', { minutes: result.day.late_minutes }));
  }
  return {
    tone: 'success',
    icon: CircleCheck,
    title: t(`punch.result.verified_${kind}`),
    lines,
  };
}

export default function PunchResultScreen() {
  const { t } = useTranslation();
  const { colors, space, radius } = useTheme();
  const router = useRouter();
  const outcome = currentOutcome();
  // "Take it again" goes to the camera with the same punch in progress: it must outlive this screen.
  const retaking = useRef(false);
  useEffect(
    () => () => {
      if (!retaking.current) endFlow();
    },
    [],
  );
  // Opened without an outcome (a restored screen): back to Home.
  useEffect(() => {
    if (!outcome) router.replace('/');
  }, [outcome, router]);
  if (!outcome) return null;

  const { tone, icon: Icon, title, lines } = describe(t, outcome);
  const ink: ColorRole = `${tone}Fg`;
  const retake = outcome.type === 'rejected' && outcome.error.code === 'FACE_RETAKE';

  return (
    <Screen contentStyle={{ justifyContent: 'center' }}>
      <View
        style={{
          alignItems: 'center',
          gap: space[3],
          padding: space[5],
          borderRadius: radius.xl,
          backgroundColor: colors[`${tone}Subtle`],
        }}
      >
        <Icon size={48} strokeWidth={1.75} color={colors[ink]} />
        <AppText
          variant="h2"
          color={ink}
          accessibilityRole="header"
          style={{ textAlign: 'center' }}
        >
          {title}
        </AppText>
        {lines.map((line) => (
          <AppText key={line} accessibilityRole="alert" style={{ textAlign: 'center' }}>
            {line}
          </AppText>
        ))}
        {outcome.type === 'rejected' ? (
          <AppText variant="caption" color="muted" selectable>
            {`${outcome.error.status} ${outcome.error.code}`}
          </AppText>
        ) : null}
      </View>
      {retake ? (
        <Button
          icon={Camera}
          label={t('punch.result.takeAgain')}
          onPress={() => {
            retaking.current = true;
            router.replace('/punch/capture');
          }}
        />
      ) : null}
      {outcome.type === 'queued' ? (
        <Button
          variant="secondary"
          label={t('punch.result.seeSaved')}
          onPress={() => router.replace('/punch/queue')}
        />
      ) : null}
      <Button
        variant={retake || outcome.type === 'queued' ? 'ghost' : 'primary'}
        label={t('punch.result.done')}
        onPress={() => router.replace('/')}
      />
    </Screen>
  );
}
