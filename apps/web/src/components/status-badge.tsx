import { CircleCheck, CircleMinus, CircleX, Clock, MapPin, type LucideIcon } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/badge';

// docs/DESIGN.md section 3: each status meaning has one fixed icon. Neutral is "inactive", not an alert.
const ICON: Record<Tone, LucideIcon> = {
  success: CircleCheck,
  warning: Clock,
  danger: CircleX,
  info: MapPin,
  neutral: CircleMinus,
};

type Props = { tone: Tone; label: string; testId?: string; icon?: LucideIcon };

// Status is never conveyed by colour alone: every badge pairs an icon with its text label.
export function StatusBadge({ tone, label, testId, icon: Icon = ICON[tone] }: Props) {
  return (
    <Badge tone={tone} data-testid={testId}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}
