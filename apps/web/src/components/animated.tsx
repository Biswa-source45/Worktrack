'use client';

import type { ComponentProps } from 'react';
import { m } from 'motion/react';
import { fadeIn } from '@/lib/motion';

/** Content that replaces a skeleton: fades in instead of popping. */
export function Reveal(props: ComponentProps<typeof m.div>) {
  return <m.div {...fadeIn()} {...props} />;
}

/** A tab's panel: fades in when its tab is chosen. */
export function TabPanel(props: ComponentProps<typeof m.div>) {
  return <m.div role="tabpanel" {...fadeIn()} {...props} />;
}
