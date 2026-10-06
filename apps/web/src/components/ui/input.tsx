import * as React from 'react';
import { cn } from '@/lib/utils';

const controlClass =
  'h-9 w-full min-w-0 rounded-md border border-input bg-raised px-3 text-body text-foreground placeholder:text-muted-foreground file:mr-3 file:h-full file:border-0 file:bg-transparent file:font-medium file:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger';

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

function Textarea({
  className,
  invalid,
  ...props
}: React.ComponentProps<'textarea'> & ControlProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlClass, 'h-auto min-h-20 py-2', className)}
      {...describe(props.id, invalid)}
      {...props}
    />
  );
}

export { Input, Select, Textarea };
