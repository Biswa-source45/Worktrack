import * as React from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export const TableHeader = (props: React.ComponentProps<'thead'>) => (
  <thead className="[&_tr]:border-b" {...props} />
);

export const TableBody = (props: React.ComponentProps<'tbody'>) => (
  <tbody className="[&_tr:last-child]:border-0" {...props} />
);

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr className={cn('border-b transition-colors hover:bg-muted/50', className)} {...props} />
  );
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn('h-9 px-2 text-left align-middle font-medium whitespace-nowrap', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('p-2 align-middle whitespace-nowrap', className)} {...props} />;
}
