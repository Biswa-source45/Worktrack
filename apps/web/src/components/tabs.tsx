import { useId } from 'react';
import { ActiveIndicator } from '@/components/active-indicator';
import { cn } from '@/lib/utils';

type Tab<T extends string> = { id: T; label: string; count?: number };

type Props<T extends string> = {
  label: string;
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
};

/** The pill tab strip of the Devices page, for screens that switch between two lists. */
export function Tabs<T extends string>({ label, tabs, value, onChange }: Props<T>) {
  const group = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 rounded-full border bg-card p-1 shadow-sm"
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative inline-flex h-8 items-center gap-1 rounded-full px-3 text-small font-medium transition-transform active:scale-(--wt-press-scale)',
              selected
                ? 'font-semibold text-primary-foreground'
                : 'text-muted-foreground hover:bg-raised hover:text-foreground',
            )}
          >
            {selected && <ActiveIndicator id={group} className="bg-primary" />}
            <span className="relative">{tab.label}</span>
            {tab.count !== undefined && (
              <span
                data-testid={`count-${tab.id}`}
                className={cn(
                  'relative rounded-full px-1.5 text-caption tabular-nums',
                  !selected && 'bg-raised text-foreground',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
