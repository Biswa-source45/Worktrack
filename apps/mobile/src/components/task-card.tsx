import { ChevronRight, Flag, MapPin } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatIst } from '@/lib/ist';
import { statusLabel, statusLook } from '@/lib/tasks';
import type { MyTask, TaskBrief } from '@/lib/tasks';
import { useTheme } from '@/lib/theme';

/** The task status badge: icon, label and colour. */
export function TaskStatusBadge({ status, testID }: { status: string; testID?: string }) {
  const { t } = useTranslation();
  const { status: tone, icon } = statusLook(status);
  return <Badge testID={testID} status={tone} icon={icon} label={statusLabel(t, status)} />;
}

type Props = { task: MyTask | TaskBrief; onOpen: () => void };

/** One task in a list. Mine show my own status; the ones I assigned show the task status. */
export function TaskCard({ task, onOpen }: Props) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const status = 'my' in task ? task.my.status : task.status;
  const urgent = task.priority === 'urgent' || task.priority === 'high';
  const people = 'assignees' in task ? task.assignees.map((a) => a.user.name).join(', ') : null;
  const spoken = [
    `${task.code}, ${task.title}`,
    statusLabel(t, status),
    task.client_name,
    formatIst(task.scheduled_at),
    urgent ? t(`tasks.priority.${task.priority}`) : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={onOpen}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card testID={`task-${task.id}`} style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, gap: space[1] }}>
          <AppText variant="small" color="muted">
            {task.code} · {task.type.name}
          </AppText>
          <AppText weight={600}>{task.title}</AppText>
          <AppText variant="small" color="muted">
            {task.client_name} · {formatIst(task.scheduled_at)}
          </AppText>
          <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'center' }}>
            <MapPin size={16} strokeWidth={1.75} color={colors.muted} />
            <AppText variant="small" color="muted" style={{ flex: 1 }} numberOfLines={2}>
              {task.site.address}
            </AppText>
          </View>
          {people ? (
            <AppText variant="small" color="muted">
              {people}
            </AppText>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <TaskStatusBadge status={status} />
            {urgent ? (
              <Badge
                status={task.priority === 'urgent' ? 'danger' : 'warning'}
                icon={Flag}
                label={t(`tasks.priority.${task.priority}`)}
              />
            ) : null}
          </View>
        </View>
        <ChevronRight size={20} strokeWidth={1.75} color={colors.muted} />
      </Card>
    </Pressable>
  );
}
