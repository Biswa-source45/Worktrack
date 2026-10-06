import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react-native';
import {
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleX,
  MapPinCheck,
  MessageSquare,
  TriangleAlert,
  UserRoundCheck,
  WifiOff,
} from '@/components/icons';
import { ReasonDialog } from '@/components/reason-dialog';
import { AppText } from '@/components/ui/app-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getIntegrity } from '@/lib/integrity';
import { LocationError, getCurrentFix } from '@/lib/location';
import { startReach } from '@/lib/task-flow';
import { stepsFor, taskErrorDetail, taskErrorText } from '@/lib/tasks';
import type { AssigneeOut, Step, TaskDetail } from '@/lib/tasks';
import { useTaskAction } from '@/lib/use-task-action';

const LOOK: Record<Step, { icon: LucideIcon; variant: 'primary' | 'secondary' | 'destructive' }> = {
  accept: { icon: UserRoundCheck, variant: 'primary' },
  decline: { icon: CircleX, variant: 'destructive' },
  reach: { icon: MapPinCheck, variant: 'primary' },
  start: { icon: CirclePlay, variant: 'primary' },
  hold: { icon: CirclePause, variant: 'secondary' },
  resume: { icon: CirclePlay, variant: 'primary' },
  note: { icon: MessageSquare, variant: 'secondary' },
  complete: { icon: CircleCheck, variant: 'primary' },
};

type Problem = { message: string; detail?: string };

/** What the assignee can do next, from their own status. Every button shows the server's real answer. */
export function TaskActionsCard({ task, mine }: { task: TaskDetail; mine: AssigneeOut }) {
  const { t } = useTranslation();
  const router = useRouter();
  const run = useTaskAction(task.id);
  const [busy, setBusy] = useState<Step | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState(false);
  const [asking, setAsking] = useState<'decline' | 'hold' | null>(null);
  const steps = stepsFor(mine.status);
  if (steps.length === 0) return null;

  async function send(step: 'accept' | 'start' | 'resume') {
    setBusy(step);
    setProblem(null);
    try {
      if ((await run(step)).type === 'queued') setSaved(true);
    } catch (error) {
      setProblem({ message: taskErrorText(t, error), detail: taskErrorDetail(error) });
    } finally {
      setBusy(null);
    }
  }

  async function reach() {
    setBusy('reach');
    setProblem(null);
    try {
      const fix = await getCurrentFix();
      const integrity = await getIntegrity();
      startReach({ taskId: task.id, fix, integrity });
      router.push(`/tasks/${task.id}/reach` as Href);
    } catch (error) {
      setProblem(
        error instanceof LocationError
          ? { message: t(`location.errors.${error.code}`) }
          : { message: taskErrorText(t, error), detail: taskErrorDetail(error) },
      );
    } finally {
      setBusy(null);
    }
  }

  async function withReason(action: 'decline' | 'hold', reason: string) {
    // A failure is thrown to the dialog, which shows it and stays open.
    if ((await run(action, { reason })).type === 'queued') setSaved(true);
  }

  function press(step: Step) {
    if (step === 'accept' || step === 'start' || step === 'resume') void send(step);
    else if (step === 'reach') void reach();
    else if (step === 'decline' || step === 'hold') setAsking(step);
    else
      router.push(
        `/tasks/${task.id}/compose?mode=${step === 'note' ? 'note' : 'complete'}` as Href,
      );
  }

  return (
    <Card testID="task-actions">
      <AppText variant="h3" accessibilityRole="header">
        {t('tasks.next')}
      </AppText>
      {saved ? <Banner status="info" icon={WifiOff} message={t('tasks.savedHere')} /> : null}
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
      {steps.map((step) => (
        <Button
          key={step}
          icon={LOOK[step].icon}
          variant={LOOK[step].variant}
          label={t(`tasks.actions.${step}`)}
          onPress={() => press(step)}
          loading={busy === step}
          disabled={busy !== null && busy !== step}
        />
      ))}
      {busy ? (
        <AppText variant="small" color="muted" accessibilityLiveRegion="polite">
          {t(busy === 'reach' ? 'tasks.checkingLocation' : 'tasks.working')}
        </AppText>
      ) : null}
      {asking ? (
        <ReasonDialog
          title={t(`tasks.${asking}Title`)}
          confirmLabel={t(`tasks.actions.${asking}`)}
          destructive={asking === 'decline'}
          onSubmit={(reason) => withReason(asking, reason)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </Card>
  );
}
