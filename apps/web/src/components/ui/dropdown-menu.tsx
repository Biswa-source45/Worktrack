import * as React from 'react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        align="end"
        sideOffset={4}
        className={cn(
          'z-50 min-w-40 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}
