import * as React from 'react';
import { cn } from '@/lib/utils';

const controlClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20';

type ControlProps = { invalid?: boolean };

// `invalid` links the control to the error text rendered by Field (`<id>-error`).
function describe(id: string | undefined, invalid?: boolean) {
  return invalid ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {};
}

function Input({ className, invalid, ...props }: React.ComponentProps<'input'> & ControlProps) {
  return (
    <input
      data-slot="input"
      className={cn(controlClass, className)}
      {...describe(props.id, invalid)}
      {...props}
    />
  );
}

function Select({ className, invalid, ...props }: React.ComponentProps<'select'> & ControlProps) {
  return (
    <select
      data-slot="select"
      className={cn(controlClass, 'pr-6', className)}
      {...describe(props.id, invalid)}
      {...props}
    />
  );
}

export { Input, Select };
