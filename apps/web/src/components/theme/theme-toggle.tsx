'use client';

import { useId } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActiveIndicator } from '@/components/active-indicator';
import { cn } from '@/lib/utils';
import { useTheme } from './theme-provider';

const OPTIONS = [
  { theme: 'light', Icon: Sun },
  { theme: 'dark', Icon: Moon },
  { theme: 'system', Icon: Monitor },
] as const;

export function ThemeToggle({
  className,
  compact,
  vertical,
}: {
  className?: string;
  compact?: boolean;
  /** A column of icons, for the collapsed sidebar rail. */
  vertical?: boolean;
}) {
  const group = useId();
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="group"
      aria-label={t('theme.label')}
      className={cn(
        'inline-flex rounded-full border bg-surface p-0.5',
        vertical && 'flex-col',
        className,
      )}
    >
      {OPTIONS.map(({ theme: option, Icon }) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
          className={cn(
            'relative inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-caption font-medium transition-transform active:scale-(--wt-press-scale)',
            theme === option
              ? 'font-semibold text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {/* The raised fill alone is too faint to mark the choice (about 1.1:1), so the sliding
              fill also gets a control-strength edge (3:1). */}
          {theme === option && (
            <ActiveIndicator id={group} className="bg-raised ring-1 ring-input" />
          )}
          <Icon aria-hidden="true" className="relative size-4" />
          {/* Narrow screens (and a `compact` toggle, as in the full header) show the icon alone;
              the accessible name stays. */}
          <span className={compact ? 'sr-only' : 'sr-only xl:not-sr-only'}>
            {t(`theme.${option}`)}
          </span>
        </button>
      ))}
    </div>
  );
}
