import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';
import {
  CircleCheck,
  CircleX,
  FileText,
  Flag,
  MessageSquare,
  Navigation,
  Phone,
  RefreshCw,
  TriangleAlert,
} from '@/components/icons';
import { SavedActionsBanner } from '@/components/saved-actions-banner';
import { SiteMap } from '@/components/site-map';
import { TaskActionsCard } from '@/components/task-actions-card';
import { TaskStatusBadge } from '@/components/task-card';
import { AppText } from '@/components/ui/app-text';
import { BackButton } from '@/components/ui/back-button';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DetailRow } from '@/components/ui/detail-row';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { errorDetail } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { formatIst } from '@/lib/ist';
import { callNumber, openNavigation } from '@/lib/task-links';
import { absoluteUrl, fetchTask, statusLabel, taskErrorText, taskKey } from '@/lib/tasks';
import type { AssigneeOut, TaskDetail } from '@/lib/tasks';
import { useTheme } from '@/lib/theme';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';

/** What the employee reads of their own Reached: never a score, never the word mismatch. */
function ReachSummary({ reach }: { reach: NonNullable<AssigneeOut['reach']> }) {
  const { t } = useTranslation();
  const { space } = useTheme();
  const decided = reach.review === 'approved' || reach.review === 'rejected';
  // "Sent for review" only while nobody has decided: after a decision the result replaces it.
  const waiting = !decided && (reach.flags.length > 0 || reach.review === 'pending');
  const approved = reach.review === 'approved';
  return (
    <View style={{ gap: space[1] }}>
      <AppText variant="small" color="muted">
        {t('tasks.reached.title')}
      </AppText>
      <AppText weight={500}>
        {t('tasks.reached.at', { time: formatIst(reach.at) })}
        {waiting ? ` · ${t('tasks.reached.review')}` : ''}
      </AppText>
      {decided ? (
        <>
          <Badge
            status={approved ? 'success' : 'danger'}
            icon={approved ? CircleCheck : CircleX}
            label={t(approved ? 'tasks.reached.approved' : 'tasks.reached.rejected')}
          />
          {reach.reviewed_by ? (
            <AppText variant="small" color="muted">
              {t('tasks.reached.by', { name: reach.reviewed_by.name })}
            </AppText>
          ) : null}
          {reach.review_remarks ? (
            <AppText variant="small" color={approved ? undefined : 'dangerFg'}>
              {reach.review_remarks}
            </AppText>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function Assignees({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const { space } = useTheme();
  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('tasks.assignees')}
      </AppText>
      {task.assignees.map((assignee) => (
        <View
          key={assignee.user.id}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' }}
        >
          <AppText style={{ flex: 1 }}>
            {assignee.user.name} ({assignee.user.emp_code})
          </AppText>
          <TaskStatusBadge status={assignee.status} />
        </View>
      ))}
    </Card>
  );
}

function Updates({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  if (task.events.length === 0) return null;
  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('tasks.updates')}
      </AppText>
      {task.events.map((event) => (
        <View key={event.id}>
          <AppText weight={500}>
            {t(`tasks.event.${event.event}`, { defaultValue: event.event })}
            {event.subject && event.subject.id !== event.actor?.id
              ? ` · ${event.subject.name}`
              : ''}
          </AppText>
          <AppText variant="small" color="muted">
            {event.actor?.name ?? t('tasks.system')} · {formatIst(event.at)}
            {event.offline ? ` · ${t('tasks.sentLater')}` : ''}
          </AppText>
          {event.note ? <AppText variant="small">{event.note}</AppText> : null}
        </View>
      ))}
    </Card>
  );
}

function Comments({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('tasks.comments')}
      </AppText>
      {task.comments.length === 0 ? <AppText color="muted">{t('tasks.noComments')}</AppText> : null}
      {task.comments.map((comment) => (
        <View key={comment.id}>
          <AppText variant="small" color="muted">
            {comment.author.name} · {formatIst(comment.created_at)}
          </AppText>
          {comment.body ? <AppText>{comment.body}</AppText> : null}
          {comment.attachment ? (
            <Button
              variant="ghost"
              icon={FileText}
              label={t('tasks.openPhoto')}
              onPress={() => void Linking.openURL(absoluteUrl(comment.attachment!.url))}
            />
          ) : null}
        </View>
      ))}
      <Button
        variant="secondary"
        icon={MessageSquare}
        label={t('tasks.addComment')}
        onPress={() => router.push(`/tasks/${task.id}/compose?mode=comment` as Href)}
      />
    </Card>
  );
}

export default function TaskDetailScreen() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const { me } = useAuth();
  const id = Number(useLocalSearchParams<{ id: string }>().id);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const query = useQuery({
    queryKey: taskKey(id),
    queryFn: () => fetchTask(id),
    // No silent retries: a 404 or a 403 shows at once, and Retry is on screen.
    retry: false,
  });
  useRefetchOnFocus(query.refetch);
  const task = query.data;
  const mine = task?.assignees.find((assignee) => assignee.user.id === me?.id);

  async function open(action: () => Promise<unknown>) {
    setLinkProblem(null);
    try {
      await action();
    } catch (error) {
      console.warn('[task-links]', error);
      setLinkProblem(t('tasks.noApp'));
    }
  }

  return (
    <Screen scroll>
      <BackButton />
      <SavedActionsBanner />
      {query.isPending ? (
        <Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {query.isError && !task ? (
        <Banner status="danger" icon={TriangleAlert} message={taskErrorText(t, query.error)}>
          <AppText variant="caption" color="muted" selectable>
            {errorDetail(query.error)}
          </AppText>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void query.refetch()}
            disabled={query.isFetching}
          />
        </Banner>
      ) : null}
      {task ? (
        <>
          <View style={{ gap: space[1] }}>
            <AppText variant="small" color="muted">
              {task.code} · {task.type.name}
            </AppText>
            <AppText variant="h1" accessibilityRole="header">
              {task.title}
            </AppText>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <TaskStatusBadge testID="task-status" status={mine?.status ?? task.status} />
            {task.priority === 'urgent' || task.priority === 'high' ? (
              <Badge
                status={task.priority === 'urgent' ? 'danger' : 'warning'}
                icon={Flag}
                label={t(`tasks.priority.${task.priority}`)}
              />
            ) : null}
          </View>
          {mine && mine.status !== task.status ? (
            <AppText variant="small" color="muted">
              {t('tasks.taskStatus', { status: statusLabel(t, task.status) })}
            </AppText>
          ) : null}
          {mine?.status === 'declined' && mine.declined_reason ? (
            <AppText color="muted">
              {t('tasks.youDeclined', { reason: mine.declined_reason })}
            </AppText>
          ) : null}
          {mine ? <TaskActionsCard task={task} mine={mine} /> : null}

          <Card>
            <DetailRow label={t('tasks.client')} value={task.client_name} />
            <DetailRow label={t('tasks.scheduled')} value={formatIst(task.scheduled_at)} />
            {task.expected_minutes ? (
              <DetailRow
                label={t('tasks.expected')}
                value={t('tasks.minutes', { count: task.expected_minutes })}
              />
            ) : null}
            {task.description ? (
              <DetailRow label={t('tasks.description')} value={task.description} />
            ) : null}
            {mine?.reach ? <ReachSummary reach={mine.reach} /> : null}
          </Card>

          <Card>
            <AppText variant="h3" accessibilityRole="header">
              {t('tasks.site.title')}
            </AppText>
            <SiteMap
              lat={task.site.lat}
              lng={task.site.lng}
              radiusM={task.site.radius_m}
              address={task.site.address}
            />
            <AppText variant="small" color="muted">
              {t('tasks.site.radius', { count: task.site.radius_m })}
            </AppText>
            <Button
              icon={Navigation}
              label={t('tasks.navigate')}
              onPress={() =>
                void open(() => openNavigation(task.site.lat, task.site.lng, task.site.address))
              }
            />
            {task.contact_phone ? (
              <Button
                variant="secondary"
                icon={Phone}
                label={t('tasks.call', { name: task.contact_name ?? task.contact_phone })}
                onPress={() => void open(() => callNumber(task.contact_phone!))}
              />
            ) : null}
            {linkProblem ? (
              <Banner status="warning" icon={TriangleAlert} message={linkProblem} />
            ) : null}
          </Card>

          {task.attachments.some((file) => file.kind === 'brief') ? (
            <Card>
              <AppText variant="h3" accessibilityRole="header">
                {t('tasks.brief')}
              </AppText>
              {task.attachments
                .filter((file) => file.kind === 'brief')
                .map((file) => (
                  <Button
                    key={file.id}
                    variant="secondary"
                    icon={FileText}
                    label={file.filename ?? t('tasks.openFile')}
                    onPress={() => void open(() => Linking.openURL(absoluteUrl(file.url)))}
                  />
                ))}
            </Card>
          ) : null}

          {!mine || task.assignees.length > 1 ? <Assignees task={task} /> : null}
          <Updates task={task} />
          <Comments task={task} />
        </>
      ) : null}
    </Screen>
  );
}
