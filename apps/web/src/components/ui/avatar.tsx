import { cn } from '@/lib/utils';

/** First letters of the first and last word of a name, at most two. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => word[0].toUpperCase()).join('');
}

// Decoration beside a name that is always shown as text, so it is hidden from assistive
// technology and the letters are drawn by CSS: the cell's text stays exactly the name.
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-initials={initials(name)}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-caption font-semibold text-foreground before:content-[attr(data-initials)]',
        className,
      )}
    />
  );
}
