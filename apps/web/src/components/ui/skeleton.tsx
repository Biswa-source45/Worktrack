'use client';

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-sm bg-raised', className)} />;
}

const BAR_WIDTHS = ['w-20', 'w-40', 'w-28', 'w-24', 'w-16'];

// Built from divs, not table rows, so nothing counts it as data while the list loads.
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <span className="sr-only">{t('common.loading')}</span>
      <div className="h-10 bg-raised" />
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex h-10 items-center gap-8 border-t px-3">
          {BAR_WIDTHS.map((width) => (
            <Skeleton key={width} className={cn('h-3', width)} />
          ))}
        </div>
      ))}
    </div>
  );
}
