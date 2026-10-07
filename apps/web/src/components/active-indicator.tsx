'use client';

import { m } from 'motion/react';
import { slide } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * The fill behind the selected item of a pill group: it slides from the previous selection to the
 * new one. `id` must be unique per group (use `useId`). The parent is `relative` and its content
 * sits in a `relative` wrapper so it paints above the fill.
 */
export function ActiveIndicator({ id, className }: { id: string; className?: string }) {
  return (
    <m.span
      layoutId={id}
      transition={slide}
      aria-hidden="true"
      className={cn('absolute inset-0 rounded-full', className)}
    />
  );
}
