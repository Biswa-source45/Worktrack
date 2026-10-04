import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent font-semibold whitespace-nowrap transition-transform select-none active:scale-(--wt-press-scale) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:shadow-md',
        outline: 'border-input bg-surface text-foreground hover:bg-raised aria-expanded:bg-raised',
        ghost: 'text-foreground hover:bg-raised aria-expanded:bg-raised',
        destructive: 'border-danger/40 bg-danger-subtle text-danger hover:border-danger',
        link: 'rounded-sm text-primary-text underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-small',
        sm: 'h-8 px-3 text-small',
        xs: 'h-7 px-2.5 text-caption',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
