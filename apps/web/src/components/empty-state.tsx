import type { ReactNode } from 'react';
import { DotPattern, HalfCircles } from '@/components/decor/decor';

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center whitespace-normal">
      <div className="relative h-16 w-32">
        <DotPattern className="absolute inset-0 size-full text-muted-foreground/40" />
        <HalfCircles className="absolute inset-x-4 bottom-0 text-primary/30" />
      </div>
      <p className="max-w-sm text-body text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}
