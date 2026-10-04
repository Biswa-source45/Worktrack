import { clsx, type ClassValue } from 'clsx';
import { typography } from 'design-tokens';
import { extendTailwindMerge } from 'tailwind-merge';

// Without this, text-h1 and friends are taken for text colours and dropped next to a real one.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: Object.keys(typography.web) } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
