import type { ComponentProps, ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

type IconName = 'check-circle' | 'clock' | 'x-circle' | 'minus-circle';

// Status is never conveyed by colour alone: every badge pairs one of these icons with its text label.
const PATHS: Record<IconName, ReactNode> = {
  'check-circle': <path d="m5 8.2 2 2L11 6" />,
  clock: <path d="M8 4.5V8l2.2 1.4" />,
  'x-circle': <path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" />,
  'minus-circle': <path d="M5.2 8h5.6" />,
};

export function StatusIcon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="mr-1 size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="6" />
      {PATHS[name]}
    </svg>
  );
}

type Props = {
  testId: string;
  icon: IconName;
  label: string;
  variant?: ComponentProps<typeof Badge>['variant'];
};

export function StatusBadge({ testId, icon, label, variant }: Props) {
  return (
    <Badge variant={variant} data-testid={testId}>
      <StatusIcon name={icon} />
      {label}
    </Badge>
  );
}
