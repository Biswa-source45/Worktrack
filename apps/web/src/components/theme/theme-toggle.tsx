'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useTheme } from './theme-provider';

const OPTIONS = [
  { theme: 'light', Icon: Sun },
  { theme: 'dark', Icon: Moon },
  { theme: 'system', Icon: Monitor },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="group"
      aria-label={t('theme.label')}
      className={cn('inline-flex rounded-full border bg-surface p-0.5', className)}
    >
      {OPTIONS.map(({ theme: option, Icon }) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-caption font-medium transition-transform active:scale-(--wt-press-scale)',
            theme === option
              ? // The raised fill alone is too faint to mark the choice (about 1.1:1), so the
                // selected segment also gets a control-strength edge (3:1).
                'bg-raised font-semibold text-foreground ring-1 ring-input'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          {/* Narrow screens show the icon alone; the accessible name stays. */}
          <span className="sr-only xl:not-sr-only">{t(`theme.${option}`)}</span>
        </button>
      ))}
    </div>
  );
}
