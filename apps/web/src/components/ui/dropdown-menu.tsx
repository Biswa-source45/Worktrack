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
          'z-50 min-w-40 animate-in rounded-md border bg-popover p-1 text-popover-foreground shadow-md duration-150 ease-out outline-none fade-in zoom-in-96',
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
        // The highlighted fill is the focus indicator inside the menu.
        'flex cursor-default items-center rounded-sm px-2 py-1.5 text-small outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-raised',
        className,
      )}
      {...props}
    />
  );
}
