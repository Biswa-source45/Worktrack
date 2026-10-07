import Image from 'next/image';
import { cn } from '@/lib/utils';

// One file per theme: a logo with dark text never goes on a dark surface and the reverse. Both are
// in the page and CSS shows the one for the current theme (no flash, no script). The width and
// height of each file are given so the layout does not jump.
const FILES = {
  full: {
    light: { src: '/brand/logo-light.png', width: 640, height: 132 },
    dark: { src: '/brand/logo-dark.png', width: 640, height: 131 },
  },
  compact: {
    light: { src: '/brand/logo-compact-light.png', width: 480, height: 96 },
    dark: { src: '/brand/logo-compact-dark.png', width: 480, height: 94 },
  },
  mark: {
    light: { src: '/brand/mark-light.png', width: 256, height: 162 },
    dark: { src: '/brand/mark-dark.png', width: 256, height: 158 },
  },
} as const;

type Props = {
  /** full: with the tagline (sign-in pages); compact: no tagline (sidebar); mark: the W alone. */
  variant: keyof typeof FILES;
  /** What a screen reader says for the logo. */
  label: string;
  /** Sets the width (for example `w-40`); the height follows. */
  className?: string;
};

export function BrandLogo({ variant, label, className }: Props) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('inline-block max-w-full shrink-0', className)}
    >
      {(['light', 'dark'] as const).map((theme) => (
        <Image
          key={theme}
          {...FILES[variant][theme]}
          alt=""
          aria-hidden="true"
          // Already sized for the screen: the image optimizer would only add a server dependency.
          unoptimized
          className={cn('h-auto w-full', theme === 'light' ? 'dark:hidden' : 'hidden dark:block')}
        />
      ))}
    </span>
  );
}
