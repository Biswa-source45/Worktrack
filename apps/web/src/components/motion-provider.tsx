'use client';

import type { ReactNode } from 'react';
import { domMax, LazyMotion, MotionConfig } from 'motion/react';

// domMax, not domAnimation: the sliding indicators use `layoutId`, a layout feature that
// domAnimation leaves out. `reducedMotion="user"` makes every motion component honour the OS setting.
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
