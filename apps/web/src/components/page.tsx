'use client';

import type { ReactNode } from 'react';
import { m } from 'motion/react';
import { pageEnter } from '@/lib/motion';

/** One screen inside the shell: its content fades up 8px on arrival. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <m.section {...pageEnter()} className="space-y-4">
      {children}
    </m.section>
  );
}

/** Title on the left, the page's controls on the right; wraps on narrow screens. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="mr-auto text-h1">{title}</h1>
      {children}
    </div>
  );
}
