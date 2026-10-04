import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-card p-5 shadow-sm', className)} {...props} />;
}
