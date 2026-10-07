import * as React from 'react';
import { m } from 'motion/react';
import { cn } from '@/lib/utils';

// Dense admin table (docs/DESIGN.md section 6): 13/20 text and 40px rows inside a rounded card.
export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto rounded-lg border bg-card shadow-sm">
      <table className={cn('w-full caption-bottom text-small', className)} {...props} />
    </div>
  );
}

export const TableHeader = (props: React.ComponentProps<'thead'>) => (
  <thead className="bg-raised [&_tr]:border-t-0" {...props} />
);

export const TableBody = (props: React.ComponentProps<'tbody'>) => <tbody {...props} />;

// A motion row, so a list can stagger its rows in (DataTable); without motion props it is a plain tr.
export function TableRow({ className, ...props }: React.ComponentProps<typeof m.tr>) {
  return <m.tr className={cn('h-10 border-t', className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'px-3 text-left align-middle text-caption font-semibold whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      className={cn('px-3 py-0.5 align-middle whitespace-nowrap tabular-nums', className)}
      {...props}
    />
  );
}
