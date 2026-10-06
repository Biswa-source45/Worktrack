'use client';

import {
  Ban,
  CheckCheck,
  CircleCheck,
  CircleX,
  Lock,
  MapPinCheck,
  Pause,
  Play,
  Send,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@/components/status-badge';
import { Badge, type Tone } from '@/components/ui/badge';

/** The columns of the board, left to right; closed and cancelled tasks sit behind a toggle. */
export const BOARD_STATUSES = [
  'assigned',
  'accepted',
  'reached',
  'in_progress',
  'on_hold',
  'completed',
  'declined',
] as const;
export const CLOSED_STATUSES = ['closed', 'cancelled'] as const;
export const ALL_STATUSES = [...BOARD_STATUSES, ...CLOSED_STATUSES];

// Waiting = warning, under way = info, done = success, refused = danger, over = neutral
// (docs/DESIGN.md section 3); every status also has its own icon and label.
const META: Record<string, { tone: Tone; icon: LucideIcon }> = {
  assigned: { tone: 'warning', icon: Send },
  accepted: { tone: 'info', icon: CircleCheck },
  reached: { tone: 'info', icon: MapPinCheck },
  in_progress: { tone: 'info', icon: Play },
  on_hold: { tone: 'warning', icon: Pause },
  completed: { tone: 'success', icon: CheckCheck },
  declined: { tone: 'danger', icon: CircleX },
  cancelled: { tone: 'neutral', icon: Ban },
  closed: { tone: 'neutral', icon: Lock },
};

export function TaskStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const meta = META[status] ?? { tone: 'neutral' as const, icon: Ban };
  return (
    <StatusBadge
      testId={`task-status-${status}`}
      tone={meta.tone}
      icon={meta.icon}
      label={t(`tasks.status.${status}`, { defaultValue: status })}
    />
  );
}

const PRIORITY_TONE: Record<string, Tone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export function PriorityBadge({ priority }: { priority: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{t(`tasks.priority.${priority}`)}</Badge>
  );
}
