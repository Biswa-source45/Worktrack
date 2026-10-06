import type { LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import {
  Briefcase,
  CalendarOff,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  ClockAlert,
  Contrast,
  Flag,
  Hourglass,
  House,
  TriangleAlert,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import type { BadgeStatus } from '@/components/ui/badge';

type Look = { status: BadgeStatus; icon: LucideIcon };

// One look per day status, shared by the Home card and the history: colour + icon + label.
const LOOKS = {
  working: { status: 'info', icon: Clock },
  present: { status: 'success', icon: CircleCheck },
  half_day: { status: 'warning', icon: Contrast },
  short_hours: { status: 'warning', icon: ClockAlert },
  pending: { status: 'warning', icon: Hourglass },
  absent: { status: 'danger', icon: CircleX },
  missed_punch_out: { status: 'danger', icon: TriangleAlert },
  holiday: { status: 'neutral', icon: Flag },
  weekly_off: { status: 'neutral', icon: CircleMinus },
  leave: { status: 'info', icon: CalendarOff },
  work_from_home: { status: 'info', icon: House },
  on_duty: { status: 'info', icon: Briefcase },
} as const satisfies Record<string, Look>;

type Known = keyof typeof LOOKS;
const NONE: Look = { status: 'neutral', icon: CircleMinus };

/** The status as the app knows it; one it has never heard of is shown as "No record". */
export function dayStatus(status: string | null): Known | 'none' {
  return status !== null && status in LOOKS ? (status as Known) : 'none';
}

export const dayLook = (status: Known | 'none'): Look => (status === 'none' ? NONE : LOOKS[status]);

export function AttendanceBadge({ status, testID }: { status: string | null; testID?: string }) {
  const { t } = useTranslation();
  const key = dayStatus(status);
  const { status: tone, icon } = dayLook(key);
  return <Badge testID={testID} status={tone} icon={icon} label={t(`attendance.status.${key}`)} />;
}
